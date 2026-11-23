
import os
import random
import hmac
import hashlib
import json
import asyncio
import math
import time
import uuid
import httpx
from typing import Dict, List
from decimal import Decimal, InvalidOperation
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    Request,
    Query,
    Header,
    HTTPException,
    UploadFile,
    File,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

app = FastAPI(title="AXIOM Game Backend")

# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://casino-axiom.vercel.app",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# SUPABASE
# ============================================================

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"

if not SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY == "PEGA_AQUI_TU_CLAVE_ACTUAL":
    raise RuntimeError("Falta configurar la SUPABASE_SERVICE_ROLE_KEY.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)

lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, dict] = {}


# ============================================================
# FUNCIONES GENERALES
# ============================================================

async def send_error(websocket: WebSocket, message: str):
    """Envía errores con un formato uniforme sin romper la conexión."""
    try:
        await websocket.send_json({
            "type": "ERROR",
            "message": str(message)
        })
    except Exception as exc:
        print(f"ERROR enviando mensaje WebSocket: {exc!r}")


def verify_user_token(access_token: str, expected_user_id: str) -> bool:
    if not access_token or not expected_user_id:
        return False

    try:
        response = supabase.auth.get_user(access_token)
        authenticated_user = getattr(response, "user", None)

        return bool(
            authenticated_user
            and str(authenticated_user.id) == str(expected_user_id)
        )

    except Exception as exc:
        print(f"ERROR verificando token Supabase: {exc!r}")
        return False


def rpc_json(name: str, params: dict) -> dict:
    response = supabase.rpc(name, params).execute()
    result = response.data

    if isinstance(result, list) and result:
        result = result[0]

    if not isinstance(result, dict):
        raise RuntimeError(
            f"Respuesta inesperada de la función SQL {name}: {result!r}"
        )

    return result


def deduct_balance(
    user_id: str,
    bet: float,
    wallet: str,
    room_id: str,
    transaction_key: str
):
    if not user_id:
        return False, "No se recibió el ID del usuario."

    if wallet not in ("play", "bonus"):
        return False, "Tipo de saldo no válido."

    try:
        result = rpc_json("debit_game_balance", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_amount": round(float(bet), 2),
        })

        return (
            bool(result.get("success")),
            str(result.get("message", "No se pudo descontar el saldo."))
        )

    except Exception as exc:
        print(f"ERROR debit_game_balance: {exc!r}")
        return False, "No se pudo descontar la apuesta."


# ============================================================
# INGRESO SNAKE CON COMISIÓN DEL 6%
# ============================================================

def enter_snake_game(
    user_id: str,
    bet: float,
    wallet: str,
    room_id: str,
    transaction_key: str
):
    if not user_id:
        return False, "No se recibió el ID del usuario.", 0

    if wallet not in ("play", "bonus"):
        return False, "Tipo de saldo no válido.", 0

    try:
        result = rpc_json("enter_snake_game", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_amount": round(float(bet), 2),
        })

        if not result.get("success"):
            return (
                False,
                str(result.get("message", "No se pudo procesar la entrada.")),
                0
            )

        playable_amount = float(result.get("playable_amount", 0))

        if not math.isfinite(playable_amount) or playable_amount <= 0:
            return (
                False,
                "El saldo inicial de Snake no es válido.",
                0
            )

        playable_micros = round(playable_amount * 1_000_000)

        return (
            True,
            str(result.get("message", "Entrada procesada correctamente.")),
            playable_micros
        )

    except Exception as exc:
        print(f"ERROR enter_snake_game: {exc!r}")
        return False, "No se pudo procesar la entrada a Snake.", 0


def settle_snake_cashout(
    user_id: str,
    room_id: str,
    wallet: str,
    refund: float,
    payout: float,
    transaction_key: str
):
    try:
        result = rpc_json("settle_snake_cashout", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_refund_amount": round(float(refund), 2),
            "p_payout_amount": round(float(payout), 2),
        })

        return (
            bool(result.get("success")),
            str(result.get("message", "No se pudo procesar el retiro."))
        )

    except Exception as exc:
        print(f"ERROR settle_snake_cashout: {exc!r}")
        return False, "No se pudo procesar el retiro."


def credit_winner(user_id: str, prize: float, room_id: str):
    try:
        result = rpc_json("credit_game_winner", {
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_amount": round(float(prize), 2),
        })

        return (
            bool(result.get("success")),
            str(result.get("message", "No se pudo acreditar el premio."))
        )

    except Exception as exc:
        print(f"ERROR credit_game_winner: {exc!r}")
        return False, "No se pudo acreditar el premio."


# ============================================================
# ADMINISTRADOR DE CONEXIONES Y LOBBY
# ============================================================

class GameManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    def calculate_commission(self, total_pot: float) -> float:
        if total_pot < 0.25:
            return 0.02
        return round(total_pot * 0.05, 2)

    async def broadcast_lobby(self):
        room_list = [
            {
                "room_id": room_id,
                "creator": room["creator"],
                "bet": room["bet"],
                "is_public": room["is_public"],
                "players_count": len(room["players"]),
            }
            for room_id, room in list(lobbies.items())
            if len(room["players"]) < 2 and not room.get("finished", False)
        ]

        for ws in list(self.active_connections.get("lobby", [])):
            try:
                await ws.send_json({
                    "type": "LOBBY_UPDATE",
                    "rooms": room_list
                })
            except Exception:
                pass


manager = GameManager()


# ============================================================
# X VS O
# El frontend actual realiza el débito, la comisión y el premio.
# Este backend administra únicamente salas, conexiones y movimientos.
# ============================================================

def xo_player(user_id: str, wallet: str, bet: float, creator: str, is_host: bool):
    return {
        "user_id": user_id,
        "wallet": wallet,
        "bet": bet,
        "creator": creator,
        "symbol": "X" if is_host else "O",
        "is_host": is_host,
        "connected": False,
        "websocket": None,
    }


def xo_winner(board):
    lines = (
        (0, 1, 2), (3, 4, 5), (6, 7, 8),
        (0, 3, 6), (1, 4, 7), (2, 5, 8),
        (0, 4, 8), (2, 4, 6),
    )

    for a, b, c in lines:
        if board[a] is not None and board[a] == board[b] == board[c]:
            return board[a]

    return "DRAW" if all(cell is not None for cell in board) else None


async def xo_send(player: dict, payload: dict):
    ws = player.get("websocket")

    if ws is not None:
        try:
            await ws.send_json(payload)
        except Exception:
            pass


async def xo_remove_room(room_id: str):
    lobbies.pop(room_id, None)
    room_locks.pop(room_id, None)
    await manager.broadcast_lobby()


@app.get("/")
async def root():
    return {"status": "ok", "service": "AXIOM Game Backend"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


# ============================================================
# DEPÓSITOS POR TRANSFERENCIA BANCARIA
# ============================================================

DEPOSIT_BUCKET = "deposit-receipts"
DEPOSIT_MIN_AMOUNT = Decimal("10.00")
DEPOSIT_MAX_AMOUNT = Decimal("10000.00")
DEPOSIT_MAX_FILE_SIZE = 5 * 1024 * 1024

DEPOSIT_ALLOWED_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
}


class DepositRequestBody(BaseModel):
    amount: float


# ============================================================
# AUTENTICACIÓN DE DEPÓSITOS
# Corrección: validar el token directamente contra Supabase Auth.
# ============================================================

def get_authenticated_user_id(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail="Debes iniciar sesión."
        )

    parts = authorization.strip().split(None, 1)

    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Token de autenticación no válido."
        )

    access_token = parts[1].strip()

    if not access_token:
        raise HTTPException(
            status_code=401,
            detail="No se recibió el token de sesión."
        )

    try:
        response = httpx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
            timeout=15.0,
        )

        if response.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail="Tu sesión expiró o no es válida. Inicia sesión nuevamente."
            )

        if response.status_code != 200:
            print(
                "ERROR verificando sesión de depósito:",
                response.status_code,
                response.text
            )
            raise HTTPException(
                status_code=503,
                detail="No se pudo comprobar tu sesión con Supabase."
            )

        user_data = response.json()
        authenticated_user_id = user_data.get("id")

        if not authenticated_user_id:
            raise HTTPException(
                status_code=401,
                detail="Supabase no devolvió un usuario válido."
            )

        return str(authenticated_user_id)

    except HTTPException:
        raise

    except httpx.RequestError as exc:
        print(f"ERROR de conexión verificando depósito: {exc!r}")
        raise HTTPException(
            status_code=503,
            detail="No se pudo conectar con Supabase para verificar tu sesión."
        )

    except Exception as exc:
        print(f"ERROR autenticando depósito: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="Ocurrió un error al verificar tu sesión."
        )


@app.post("/deposits/request")
async def create_deposit_request(
    body: DepositRequestBody,
    authorization: str | None = Header(default=None),
):
    user_id = get_authenticated_user_id(authorization)

    try:
        amount = Decimal(str(body.amount))

        if not amount.is_finite():
            raise ValueError("Monto no finito.")

        amount = amount.quantize(Decimal("0.01"))

    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail="El monto del depósito no es válido."
        )

    if amount < DEPOSIT_MIN_AMOUNT or amount > DEPOSIT_MAX_AMOUNT:
        raise HTTPException(
            status_code=400,
            detail="El depósito debe ser mínimo de $10 y máximo de $10.000."
        )

    reference = f"AXIOM-{uuid.uuid4().hex[:12].upper()}"

    try:
        response = (
            supabase.table("deposit_requests")
            .insert({
                "user_id": user_id,
                "amount": float(amount),
                "method": "transfer",
                "status": "pendiente",
                "provider_reference": reference,
            })
            .execute()
        )

        rows = response.data or []

        if not rows:
            raise RuntimeError(
                "Supabase no devolvió la solicitud creada."
            )

        deposit = rows[0]

        return {
            "success": True,
            "message": "Solicitud de depósito creada correctamente.",
            "deposit_id": deposit["id"],
            "amount": float(amount),
            "reference": reference,
            "status": "pendiente",
        }

    except Exception as exc:
        print(f"ERROR creando solicitud de depósito: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="No se pudo crear la solicitud de depósito."
        )


@app.post("/deposits/{deposit_id}/receipt")
async def upload_deposit_receipt(
    deposit_id: int,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
):
    user_id = get_authenticated_user_id(authorization)

    content_type = (file.content_type or "").lower()

    if content_type not in DEPOSIT_ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Formato no permitido. Sube JPG, PNG, WEBP o PDF."
        )

    content = await file.read(DEPOSIT_MAX_FILE_SIZE + 1)

    if not content:
        raise HTTPException(
            status_code=400,
            detail="El comprobante está vacío."
        )

    if len(content) > DEPOSIT_MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail="El comprobante no puede superar los 5 MB."
        )

    try:
        response = (
            supabase.table("deposit_requests")
            .select("id,user_id,status,receipt_path")
            .eq("id", deposit_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )

        rows = response.data or []

        if not rows:
            raise HTTPException(
                status_code=404,
                detail="No se encontró tu solicitud de depósito."
            )

        deposit = rows[0]

        if deposit.get("status") != "pendiente":
            raise HTTPException(
                status_code=400,
                detail="Esta solicitud ya no está pendiente."
            )

        if deposit.get("receipt_path"):
            raise HTTPException(
                status_code=409,
                detail="Esta solicitud ya tiene un comprobante."
            )

        extension = DEPOSIT_ALLOWED_TYPES[content_type]

        file_name = (
            f"{user_id}/{deposit_id}/"
            f"{uuid.uuid4().hex}.{extension}"
        )

        supabase.storage.from_(DEPOSIT_BUCKET).upload(
            file_name,
            content,
            file_options={
                "content-type": content_type,
                "upsert": "false",
            },
        )

        (
            supabase.table("deposit_requests")
            .update({
                "receipt_path": file_name,
            })
            .eq("id", deposit_id)
            .eq("user_id", user_id)
            .execute()
        )

        return {
            "success": True,
            "message": "Comprobante subido correctamente.",
            "deposit_id": deposit_id,
            "status": "pendiente",
        }

    except HTTPException:
        raise

    except Exception as exc:
        print(f"ERROR subiendo comprobante: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="No se pudo guardar el comprobante."
        )

    finally:
        await file.close()


# ============================================================
# DEPÓSITOS CRIPTO - NOWPAYMENTS
# ============================================================

NOWPAYMENTS_API_URL = "https://api.nowpayments.io/v1"
NOWPAYMENTS_API_KEY = os.getenv("NOWPAYMENTS_API_KEY", "").strip()
NOWPAYMENTS_IPN_SECRET = os.getenv("NOWPAYMENTS_IPN_SECRET", "").strip()

NOWPAYMENTS_IPN_URL = (
    "https://casino-axiom.ethiodeploy.app/crypto/deposits/ipn"
)

CRYPTO_DEPOSIT_MIN = Decimal("10.00")
CRYPTO_DEPOSIT_MAX = Decimal("10000.00")
CRYPTO_PAY_CURRENCY = "usdttrc20"


class CryptoDepositBody(BaseModel):
    amount: float


def sort_nowpayments_payload(data):
    if isinstance(data, dict):
        return {
            key: sort_nowpayments_payload(data[key])
            for key in sorted(data)
        }

    if isinstance(data, list):
        return [
            sort_nowpayments_payload(item)
            for item in data
        ]

    return data


def verify_nowpayments_signature(payload: dict, signature: str) -> bool:
    if not NOWPAYMENTS_IPN_SECRET or not signature:
        return False

    sorted_payload = sort_nowpayments_payload(payload)

    message = json.dumps(
        sorted_payload,
        separators=(",", ":"),
        ensure_ascii=False
    )

    expected_signature = hmac.new(
        NOWPAYMENTS_IPN_SECRET.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha512
    ).hexdigest()

    return hmac.compare_digest(
        expected_signature.lower(),
        signature.strip().lower()
    )



@app.post("/crypto/deposits/create")
async def create_crypto_deposit(
    body: CryptoDepositBody,
    authorization: str | None = Header(default=None),
):
    user_id = get_authenticated_user_id(authorization)

    if not NOWPAYMENTS_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="NOWPayments todavía no está configurado."
        )

    try:
        amount = Decimal(str(body.amount))

        if not amount.is_finite():
            raise ValueError("Monto no válido.")

        amount = amount.quantize(Decimal("0.01"))

    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail="El monto del depósito no es válido."
        )

    if amount < CRYPTO_DEPOSIT_MIN or amount > CRYPTO_DEPOSIT_MAX:
        raise HTTPException(
            status_code=400,
            detail="El depósito debe ser mínimo de $10 y máximo de $10.000."
        )

    # 1. Consultar el mínimo actual de NOWPayments
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            min_response = await client.get(
                f"{NOWPAYMENTS_API_URL}/min-amount",
                headers={
                    "x-api-key": NOWPAYMENTS_API_KEY,
                },
                params={
                    "currency_from": "usd",
                    "currency_to": CRYPTO_PAY_CURRENCY,
                    "fiat_equivalent": "usd",
                },
            )

        if min_response.status_code != 200:
            print(
                "ERROR consultando mínimo NOWPayments:",
                min_response.status_code,
                min_response.text
            )
            raise HTTPException(
                status_code=503,
                detail="No se pudo consultar el mínimo de NOWPayments. Intenta nuevamente."
            )

        min_data = min_response.json()
        minimum_usd = Decimal(str(min_data.get("fiat_equivalent") or "0"))

        if not minimum_usd.is_finite() or minimum_usd <= 0:
            print("RESPUESTA MÍNIMO NOWPayments:", min_data)
            raise HTTPException(
                status_code=503,
                detail="NOWPayments no devolvió un mínimo válido."
            )

        required_minimum = (
            minimum_usd * Decimal("1.02")
        ).quantize(Decimal("0.01"))

        if amount < required_minimum:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"El depósito mínimo actual es de "
                    f"${required_minimum:.2f} USD. "
                    "Aumenta el monto e intenta nuevamente."
                )
            )

    except HTTPException:
        raise

    except Exception as exc:
        print(f"ERROR consultando mínimo NOWPayments: {exc!r}")
        raise HTTPException(
            status_code=503,
            detail="No se pudo verificar el mínimo de NOWPayments."
        )

    order_id = f"AXIOM-CRYPTO-{uuid.uuid4().hex[:16].upper()}"

    try:
        supabase.table("crypto_deposits").insert({
            "user_id": user_id,
            "order_id": order_id,
            "amount": float(amount),
            "price_currency": "usd",
            "pay_currency": CRYPTO_PAY_CURRENCY,
            "payment_status": "waiting",
        }).execute()

        payload = {
            "price_amount": str(amount),
            "price_currency": "usd",
            "pay_currency": CRYPTO_PAY_CURRENCY,
            "ipn_callback_url": NOWPAYMENTS_IPN_URL,
            "order_id": order_id,
            "order_description": "Depósito AXIOM - Saldo para jugar",
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{NOWPAYMENTS_API_URL}/payment",
                headers={
                    "x-api-key": NOWPAYMENTS_API_KEY,
                    "Content-Type": "application/json",
                },
                json=payload,
            )

        if response.status_code not in (200, 201):
            print(
                "ERROR NOWPayments creando pago:",
                response.status_code,
                response.text
            )

            supabase.table("crypto_deposits").update({
                "payment_status": "failed",
                "updated_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                    time.gmtime()
                ),
            }).eq("order_id", order_id).execute()

            error_data = response.json() if response.content else {}

            if error_data.get("code") == "AMOUNT_MINIMAL_ERROR":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "NOWPayments aumentó su mínimo de depósito. "
                        "Intenta con un monto superior."
                    )
                )

            raise HTTPException(
                status_code=502,
                detail="NOWPayments no pudo crear el pago. Intenta nuevamente."
            )

        payment_data = response.json()

        payment_id = payment_data.get("payment_id")
        pay_address = payment_data.get("pay_address")
        pay_amount = payment_data.get("pay_amount")

        if not payment_id or not pay_address or pay_amount is None:
            raise RuntimeError(
                "NOWPayments devolvió una respuesta incompleta."
            )

        supabase.table("crypto_deposits").update({
            "payment_id": str(payment_id),
            "pay_address": str(pay_address),
            "pay_amount": str(pay_amount),
            "payment_status": str(
                payment_data.get("payment_status") or "waiting"
            ).lower(),
            "updated_at": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime()
            ),
        }).eq("order_id", order_id).execute()

        return {
            "success": True,
            "order_id": order_id,
            "payment_id": str(payment_id),
            "amount_usd": float(amount),
            "pay_currency": CRYPTO_PAY_CURRENCY,
            "pay_amount": str(pay_amount),
            "pay_address": str(pay_address),
            "payment_status": str(
                payment_data.get("payment_status") or "waiting"
            ).lower(),
            "message": "Pago creado. Envía el monto exacto a la dirección indicada.",
        }

    except HTTPException:
        raise

    except httpx.RequestError as exc:
        print(f"ERROR conectando con NOWPayments: {exc!r}")
        raise HTTPException(
            status_code=502,
            detail="No se pudo conectar con NOWPayments."
        )

    except Exception as exc:
        print(f"ERROR creando depósito cripto: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="No se pudo crear el depósito cripto."
        )


def _credit_crypto_deposit_to_user(
    user_id: str,
    order_id: str,
    amount_usd: float,
    payment_id: str | None = None,
):
    """
    Acredita el saldo al cliente de forma segura.
    Si creas una función RPC en Supabase (ej. `credit_crypto_deposit`),
    úsala aquí para garantizar atomicidad e idempotencia.
    """
    profile_res = (
        supabase.table("profiles")
        .select("id,balance")
        .eq("id", user_id)
        .limit(1)
        .execute()
    )
    rows = profile_res.data or []
    if not rows:
        raise RuntimeError(f"Perfil no encontrado para user_id={user_id}")

    current_balance = Decimal(str(rows[0].get("balance") or "0"))
    new_balance = float((current_balance + Decimal(str(amount_usd))).quantize(Decimal("0.01")))

    (
        supabase.table("profiles")
        .update({"balance": new_balance})
        .eq("id", user_id)
        .execute()
    )
    return {"success": True, "new_balance": new_balance}


@app.post("/crypto/deposits/ipn")
async def nowpayments_ipn(
    request: Request,
    x_nowpayments_sig: str | None = Header(default=None),
):
    raw_body = await request.body()

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="JSON inválido.")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload inválido.")

    if not verify_nowpayments_signature(payload, x_nowpayments_sig or ""):
        print("ALERTA IPN: Firma de NOWPayments inválida.")
        raise HTTPException(status_code=401, detail="Firma IPN no válida.")

    order_id = str(payload.get("order_id") or "").strip()
    payment_id = str(payload.get("payment_id") or "").strip()
    payment_status = str(payload.get("payment_status") or "").strip().lower()

    if not order_id:
        raise HTTPException(status_code=400, detail="Falta order_id.")

    dep_res = (
        supabase.table("crypto_deposits")
        .select("id,user_id,order_id,amount,payment_status,credited_at")
        .eq("order_id", order_id)
        .limit(1)
        .execute()
    )
    dep_rows = dep_res.data or []

    if not dep_rows:
        raise HTTPException(status_code=404, detail="Depósito no encontrado.")

    deposit = dep_rows[0]
    user_id = str(deposit["user_id"])
    amount_usd = float(deposit["amount"])

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    update_fields = {
        "payment_status": payment_status or deposit.get("payment_status"),
        "updated_at": now_iso,
    }
    if payment_id:
        update_fields["payment_id"] = payment_id

    final_statuses = {"finished"}
    already_credited = bool(deposit.get("credited_at"))

    if payment_status in final_statuses and not already_credited:
        _credit_crypto_deposit_to_user(
            user_id=user_id,
            order_id=order_id,
            amount_usd=amount_usd,
            payment_id=payment_id or None,
        )
        update_fields["credited_at"] = now_iso

    (
        supabase.table("crypto_deposits")
        .update(update_fields)
        .eq("order_id", order_id)
        .execute()
    )

    return {"ok": True, "order_id": order_id, "status": payment_status}


@app.get("/crypto/deposits/{order_id}")
async def get_crypto_deposit_status(
    order_id: str,
    authorization: str | None = Header(default=None),
):
    user_id = get_authenticated_user_id(authorization)
    clean_order_id = order_id.strip()

    if not clean_order_id:
        raise HTTPException(status_code=400, detail="order_id no válido.")

    res = (
        supabase.table("crypto_deposits")
        .select(
            "order_id,amount,pay_currency,pay_amount,pay_address,"
            "payment_status,credited_at,created_at,updated_at"
        )
        .eq("order_id", clean_order_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )

    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Depósito no encontrado.")

    row = rows[0]
    return {
        "success": True,
        "order_id": row["order_id"],
        "amount_usd": float(row["amount"]),
        "pay_currency": row.get("pay_currency") or "usdttrc20",
        "pay_amount": row.get("pay_amount"),
        "pay_address": row.get("pay_address"),
        "payment_status": str(row.get("payment_status") or "waiting").lower(),
        "credited": bool(row.get("credited_at")),
        "credited_at": row.get("credited_at"),
    }


# ============================================================
# WEBSOCKET LOBBY X VS O
# ============================================================

@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query(""),
):
    await websocket.accept()

    if not user_id:
        await send_error(websocket, "No se recibió el usuario.")
        await websocket.close()
        return

    manager.active_connections.setdefault("lobby", []).append(websocket)
    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict) or data.get("type") != "CREATE_ROOM":
                continue

            creator_id = str(data.get("user_id") or "")

            if creator_id != str(user_id):
                await send_error(websocket, "Usuario no autorizado.")
                continue

            wallet = str(data.get("wallet", "play")).lower()

            if wallet not in ("play", "bonus"):
                await send_error(websocket, "Billetera no válida.")
                continue

            try:
                bet = round(float(data.get("bet", 0)), 2)
            except (TypeError, ValueError):
                await send_error(websocket, "La apuesta no es válida.")
                continue

            if not math.isfinite(bet) or bet < 0.25 or bet > 10000:
                await send_error(websocket, "La apuesta mínima es $0.25.")
                continue

            already_active = any(
                str(creator_id) in room.get("players", {})
                and not room.get("finished", False)
                for room in lobbies.values()
            )

            if already_active:
                await send_error(websocket, "Ya tienes una sala activa.")
                continue

            is_public = bool(data.get("is_public", True))
            password = "" if is_public else str(data.get("password") or "").strip()

            if not is_public and not password:
                await send_error(
                    websocket,
                    "Debes establecer una contraseña para la sala privada."
                )
                continue

            room_id = uuid.uuid4().hex[:12]
            creator_name = str(data.get("creator") or "Jugador").strip()[:40] or "Jugador"
            host = xo_player(creator_id, wallet, bet, creator_name, True)

            lobbies[room_id] = {
                "room_id": room_id,
                "creator": creator_name,
                "creator_id": creator_id,
                "bet": bet,
                "is_public": is_public,
                "password": password,
                "players": {creator_id: host},
                "board": [None] * 9,
                "turn": "X",
                "status": "WAITING",
                "finished": False,
                "settling": False,
                "created_at": time.time(),
            }

            room_locks[room_id] = asyncio.Lock()

            await websocket.send_json({
                "type": "ROOM_CREATED",
                "room_id": room_id,
                "password": password,
            })

            await manager.broadcast_lobby()

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR lobby XvO: {exc!r}")

    finally:
        connections = manager.active_connections.get("lobby", [])

        if websocket in connections:
            connections.remove(websocket)


# ============================================================
# WEBSOCKET PARTIDA X VS O
# ============================================================

@app.websocket("/ws/game/{room_id}")
async def game_endpoint(
    websocket: WebSocket,
    room_id: str,
    password: str = Query(""),
    wallet: str = Query("play"),
    user_id: str = Query(""),
    access_token: str = Query(""),
):
    await websocket.accept()

    if not user_id:
        await send_error(websocket, "No se recibió el usuario.")
        await websocket.close()
        return

    wallet = str(wallet).lower()

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    room = lobbies.get(room_id)
    lock = room_locks.get(room_id)

    if room is None or lock is None:
        await send_error(websocket, "La sala no existe o ya fue cerrada.")
        await websocket.close()
        return

    player = None

    try:
        async with lock:
            if room.get("finished"):
                await send_error(websocket, "La partida ya terminó.")
                await websocket.close()
                return

            if (
                not room.get("is_public", True)
                and str(room.get("password", "")) != str(password)
            ):
                await send_error(websocket, "Contraseña incorrecta.")
                await websocket.close()
                return

            player = room["players"].get(str(user_id))

            if player is None:
                if len(room["players"]) >= 2:
                    await send_error(websocket, "La sala está llena.")
                    await websocket.close()
                    return

                if str(user_id) == str(room["creator_id"]):
                    await send_error(websocket, "No puedes entrar dos veces a tu propia sala.")
                    await websocket.close()
                    return

                if any(
                    str(user_id) in other.get("players", {})
                    and not other.get("finished", False)
                    for rid, other in lobbies.items()
                    if rid != room_id
                ):
                    await send_error(websocket, "Ya tienes otra partida activa.")
                    await websocket.close()
                    return

                player = xo_player(
                    str(user_id),
                    wallet,
                    float(room["bet"]),
                    "Jugador",
                    False
                )

                room["players"][str(user_id)] = player

            if player.get("connected"):
                await send_error(websocket, "Ya tienes una conexión activa.")
                await websocket.close()
                return

            player["wallet"] = wallet
            player["connected"] = True
            player["websocket"] = websocket

            if len(room["players"]) == 2:
                host = room["players"].get(str(room["creator_id"]))

                guest = next(
                    (
                        p for uid, p in room["players"].items()
                        if uid != str(room["creator_id"])
                    ),
                    None
                )

                if host is None or guest is None:
                    await send_error(websocket, "No se pudieron identificar los jugadores.")
                    await websocket.close()
                    return

                host["symbol"] = "X"
                guest["symbol"] = "O"
                room["status"] = "PLAYING"

            await websocket.send_json({
                "type": "INIT",
                "room_id": room_id,
                "symbol": player["symbol"],
                "is_host": bool(player.get("is_host")),
                "board": list(room["board"]),
                "turn": room["turn"],
                "status": room["status"],
                "bet": room["bet"],
                "players_count": len(room["players"]),
            })

            if room["status"] == "PLAYING":
                for p in room["players"].values():
                    await xo_send(p, {
                        "type": "START",
                        "board": list(room["board"]),
                        "turn": room["turn"],
                    })

        await manager.broadcast_lobby()

        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = str(data.get("type", "")).upper()

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type == "MOVE":
                async with lock:
                    if room.get("finished") or room.get("status") != "PLAYING":
                        continue

                    if room["players"].get(str(user_id)) is not player:
                        await send_error(websocket, "Jugador no válido.")
                        continue

                    if data.get("symbol") not in (None, player.get("symbol")):
                        await send_error(websocket, "Ficha no válida.")
                        continue

                    if room["turn"] != player.get("symbol"):
                        await send_error(websocket, "No es tu turno.")
                        continue

                    try:
                        index = int(data.get("index", -1))
                    except (TypeError, ValueError):
                        continue

                    if index < 0 or index > 8 or room["board"][index] is not None:
                        await send_error(websocket, "Movimiento no válido.")
                        continue

                    symbol = player["symbol"]
                    room["board"][index] = symbol

                    result = xo_winner(room["board"])
                    room["turn"] = "O" if symbol == "X" else "X"

                    move_payload = {
                        "type": "MOVE_MADE",
                        "board": list(room["board"]),
                        "next_turn": room["turn"],
                        "turn": room["turn"],
                        "symbol": symbol,
                        "index": index,
                    }

                    for p in room["players"].values():
                        await xo_send(p, move_payload)

                    if result is not None:
                        room["finished"] = True
                        room["status"] = "FINISHED"

                        winner_id = None

                        if result != "DRAW":
                            winner_id = next(
                                uid for uid, candidate in room["players"].items()
                                if candidate.get("symbol") == result
                            )

                        for p in room["players"].values():
                            await xo_send(p, {
                                "type": "GAME_FINISHED",
                                "result": "draw" if result == "DRAW" else "win",
                                "winner_id": winner_id,
                                "abandoner_id": None,
                            })

                await manager.broadcast_lobby()
                continue

            if msg_type == "CLOSE_ROOM":
                if not player.get("is_host"):
                    await send_error(websocket, "Solo el creador puede cerrar la sala.")
                    continue

                break

            if msg_type in ("LEAVE", "ABANDON"):
                break

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR WebSocket XvO {room_id}: {exc!r}")
        await send_error(websocket, "Ocurrió un error en la partida.")

    finally:
        if room is not None and lock is not None:
            remove_room = False
            lobby_changed = False

            async with lock:
                current = room.get("players", {}).get(str(user_id))

                if current is player and current.get("websocket") is websocket:
                    current["connected"] = False
                    current["websocket"] = None

                    if room.get("finished"):
                        remove_room = True

                    elif room.get("status") == "PLAYING":
                        winner_id = None
                        winner_player = None

                        for uid, other in room["players"].items():
                            if uid != str(user_id):
                                winner_id = uid
                                winner_player = other
                                break

                        room["finished"] = True
                        room["status"] = "FINISHED"

                        if winner_player is not None:
                            await xo_send(winner_player, {
                                "type": "GAME_FINISHED",
                                "result": "win",
                                "winner_id": winner_id,
                                "abandoner_id": str(user_id),
                                "reason": "abandonment",
                            })

                        await xo_send(current, {
                            "type": "GAME_FINISHED",
                            "result": "lose",
                            "winner_id": winner_id,
                            "abandoner_id": str(user_id),
                            "reason": "abandonment",
                        })

                        remove_room = True
                        lobby_changed = True

                    elif current.get("is_host"):
                        room["finished"] = True
                        room["status"] = "FINISHED"

                        for uid, other in list(room["players"].items()):
                            if uid != str(user_id):
                                await xo_send(other, {
                                    "type": "ROOM_CLOSED_BY_HOST"
                                })

                        remove_room = True
                        lobby_changed = True

                    else:
                        room["players"].pop(str(user_id), None)
                        room["board"] = [None] * 9
                        room["turn"] = "X"
                        room["status"] = "WAITING"

                        host = room["players"].get(str(room["creator_id"]))

                        if host:
                            await xo_send(host, {
                                "type": "INIT",
                                "room_id": room_id,
                                "symbol": "X",
                                "is_host": True,
                                "board": list(room["board"]),
                                "turn": "X",
                                "status": "WAITING",
                                "bet": room["bet"],
                                "players_count": 1,
                            })

                        lobby_changed = True

            if remove_room:
                await xo_remove_room(room_id)
            elif lobby_changed:
                await manager.broadcast_lobby()


# ============================================================
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 4300
WORLD_HEIGHT = 4300

SNAKE_SPEED = 7.5
SNAKE_BOOST_SPEED = 12.0

SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16

SNAKE_BETS = {
    "snake_020": 200_000,
    "snake_1000": 10_000_000,
    "snake_5000": 50_000_000,
}

SNAKE_COIN_VALUES = {
    "snake_020": 10_000,
    "snake_1000": 500_000,
    "snake_5000": 2_500_000,
}

BOOST_COIN_INTERVAL = 0.25
CASHOUT_COUNTDOWN_SECONDS = 20

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 200
MAX_SNAKE_PLAYERS = 30

FOOD_GROWTH = 3
FOOD_RADIUS_GROWTH = 0.30
SNAKE_MAX_RADIUS = 21.0

BOOST_RADIUS_MULTIPLIER = 0.10

FOOD_COLORS = [
    "#ff3b30",
    "#ff9500",
    "#ffcc00",
    "#34c759",
    "#00c7be",
    "#32ade6",
    "#007aff",
    "#af52de",
    "#ff2d55",
    "#ffffff",
]


def money_from_micros(value: int) -> float:
    return int(value) / 1_000_000


def create_snake_body(x: float, y: float, angle: float):
    return [
        {
            "x": x - math.cos(angle) * i * SNAKE_SEGMENT_DISTANCE,
            "y": y - math.sin(angle) * i * SNAKE_SEGMENT_DISTANCE,
        }
        for i in range(SNAKE_INITIAL_LENGTH)
    ]


def safe_color(color: str) -> str:
    if isinstance(color, str) and len(color) == 7 and color.startswith("#"):
        try:
            int(color[1:], 16)
            return color
        except ValueError:
            pass

    return "#34d399"


# ============================================================
# CONTROL GLOBAL DE SALAS SNAKE
# ============================================================

snake_rooms_lock = asyncio.Lock()


def get_snake_bet_category(bet: float):
    try:
        bet_micros = round(float(bet) * 1_000_000)
    except (ValueError, TypeError, OverflowError):
        return None

    for category, amount in SNAKE_BETS.items():
        if bet_micros == amount:
            return category

    return None


def get_available_snake_room_locked(category: str):
    available_rooms = []

    for room_id, room in snake_rooms.items():
        if not room_id.startswith(category + "_"):
            continue

        if room.bet_micros != SNAKE_BETS[category]:
            continue

        if len(room.connections) < MAX_SNAKE_PLAYERS:
            available_rooms.append(room)

    if available_rooms:
        available_rooms.sort(
            key=lambda room: len(room.connections),
            reverse=True
        )
        return available_rooms[0]

    number = 1

    while f"{category}_{number}" in snake_rooms:
        number += 1

    new_room_id = f"{category}_{number}"

    room = SnakeRoom(new_room_id)
    snake_rooms[new_room_id] = room

    print(
        f"NUEVA SALA SNAKE: {new_room_id} "
        f"APUESTA: ${room.bet:.2f}"
    )

    return room


# ============================================================
# SALAS SNAKE
# ============================================================

class SnakeRoom:

    def __init__(self, room_id: str):
        self.room_id = room_id

        category = room_id.rsplit("_", 1)[0]

        if category not in SNAKE_BETS:
            raise ValueError(f"Categoría Snake inválida: {room_id}")

        self.category = category
        self.bet_micros = SNAKE_BETS[category]
        self.bet = money_from_micros(self.bet_micros)

        self.connections: Dict[str, WebSocket] = {}
        self.snakes: Dict[str, dict] = {}

        self.foods: List[dict] = []
        self.coins: List[dict] = []

        self.is_running = False
        self.lock = asyncio.Lock()

        self.spawn_food(FOOD_INITIAL_COUNT)

    def get_coin_value(self) -> int:
        return SNAKE_COIN_VALUES.get(
            self.category,
            10_000
        )

    def get_snake_radius(self, snake: dict) -> float:
        radius = float(snake.get("radius", 7.0))

        if snake.get("boosting"):
            radius *= BOOST_RADIUS_MULTIPLIER

        return radius

    def spawn_food(self, amount: int = 1):
        for _ in range(amount):
            self.foods.append({
                "id": f"food_{uuid.uuid4().hex}",
                "x": random.uniform(30, WORLD_WIDTH - 30),
                "y": random.uniform(30, WORLD_HEIGHT - 30),
                "color": random.choice(FOOD_COLORS),
                "radius": FOOD_RADIUS,
                "growth": FOOD_GROWTH,
            })

    def create_spawn(self):
        positions = [
            (150, 150, 0),
            (850, 850, math.pi),
            (850, 150, math.pi),
            (150, 850, 0),
            (500, 150, math.pi / 2),
            (500, 850, -math.pi / 2),
        ]

        occupied = [
            (
                snake["body"][0]["x"],
                snake["body"][0]["y"]
            )
            for snake in self.snakes.values()
            if snake.get("alive") and snake.get("body")
        ]

        available = [
            (x, y, angle)
            for x, y, angle in positions
            if all(
                math.hypot(x - ox, y - oy) > 100
                for ox, oy in occupied
            )
        ]

        if available:
            return random.choice(available)

        for _ in range(50):
            x = random.uniform(100, WORLD_WIDTH - 100)
            y = random.uniform(100, WORLD_HEIGHT - 100)

            if all(
                math.hypot(x - ox, y - oy) > 100
                for ox, oy in occupied
            ):
                return x, y, random.uniform(-math.pi, math.pi)

        return (
            random.uniform(100, WORLD_WIDTH - 100),
            random.uniform(100, WORLD_HEIGHT - 100),
            random.uniform(-math.pi, math.pi)
        )

    def add_snake(
        self,
        user_id: str,
        bet: float,
        wallet: str,
        color: str,
        session_id: str,
        playable_micros: int
    ):
        x, y, angle = self.create_spawn()

        bet_micros = self.bet_micros

        playable_micros = max(0, int(playable_micros))
        playable_amount = money_from_micros(playable_micros)

        self.snakes[user_id] = {
            "session_id": session_id,
            "body": create_snake_body(x, y, angle),
            "angle": angle,
            "radius": 7.0,
            "max_radius": SNAKE_MAX_RADIUS,
            "score": 0,
            "kills": 0,
            "color": safe_color(color),
            "wallet": wallet,
            "bet": money_from_micros(bet_micros),
            "bet_micros": bet_micros,
            "balance_micros": playable_micros,
            "entry_remaining_micros": playable_micros,
            "collected_micros": 0,
            "earned_micros": 0,
            "earned": 0.0,
            "balance": playable_amount,
            "alive": True,
            "ready": False,
            "cashed_out": False,
            "boosting": False,
            "next_boost_coin_at": 0.0,
            "boost_spent_micros": 0,
            "grow_pending": 0,
            "cashout_pending": False,
            "cashout_pending_until": 0.0,
            "cashout_task_id": None,
            "created_at": time.time(),
        }

    def update_balance(self, snake: dict):
        balance = max(
            0,
            int(snake.get("balance_micros", 0))
        )

        snake["balance_micros"] = balance
        snake["balance"] = money_from_micros(balance)

        earned = max(
            0,
            int(snake.get("collected_micros", 0))
        )

        snake["earned_micros"] = earned
        snake["earned"] = money_from_micros(earned)

    def drop_coins(self, snake: dict):
        if not snake.get("body"):
            return

        head = snake["body"][0]

        balance = max(
            0,
            int(snake.get("balance_micros", 0))
        )

        if balance <= 0:
            return

        coin_value = self.get_coin_value()
        remaining = balance

        while remaining > 0:
            value = min(
                coin_value,
                remaining
            )

            angle = random.uniform(0, math.pi * 2)
            distance = random.uniform(15, 50)

            x = max(
                COIN_RADIUS,
                min(
                    WORLD_WIDTH - COIN_RADIUS,
                    head["x"] + math.cos(angle) * distance
                )
            )

            y = max(
                COIN_RADIUS,
                min(
                    WORLD_HEIGHT - COIN_RADIUS,
                    head["y"] + math.sin(angle) * distance
                )
            )

            self.coins.append({
                "id": f"coin_{uuid.uuid4().hex}",
                "x": x,
                "y": y,
                "value_micros": value,
                "value": money_from_micros(value),
            })

            remaining -= value

        snake["balance_micros"] = 0
        snake["entry_remaining_micros"] = 0

        self.update_balance(snake)

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return

        snake["alive"] = False
        snake["boosting"] = False
        snake["cashout_pending"] = False
        snake["cashout_pending_until"] = 0.0

        self.drop_coins(snake)

    def drop_boost_coin(self, snake: dict) -> bool:
        coin_value = self.get_coin_value()

        balance = int(snake.get("balance_micros", 0))

        if balance < coin_value:
            snake["boosting"] = False
            return False

        body = snake.get("body", [])

        if not body:
            snake["boosting"] = False
            return False

        snake["balance_micros"] -= coin_value
        snake["boost_spent_micros"] += coin_value

        entry_remaining = int(
            snake.get("entry_remaining_micros", 0)
        )

        snake["entry_remaining_micros"] = max(
            0,
            entry_remaining - coin_value
        )

        self.update_balance(snake)

        tail = body[-1]
        angle = snake.get("angle", 0) + math.pi
        distance = random.uniform(15, 30)

        x = max(
            COIN_RADIUS,
            min(
                WORLD_WIDTH - COIN_RADIUS,
                tail["x"] + math.cos(angle) * distance
            )
        )

        y = max(
            COIN_RADIUS,
            min(
                WORLD_HEIGHT - COIN_RADIUS,
                tail["y"] + math.sin(angle) * distance
            )
        )

        self.coins.append({
            "id": f"coin_{uuid.uuid4().hex}",
            "x": x,
            "y": y,
            "value_micros": coin_value,
            "value": money_from_micros(coin_value),
        })

        return True

    def collect_coins(self, snake: dict, head: dict):
        collected = []

        for coin in list(self.coins):
            distance = math.hypot(
                head["x"] - coin["x"],
                head["y"] - coin["y"]
            )

            if distance <= COIN_RADIUS + 8:
                collected.append(coin)

        for coin in collected:
            if coin not in self.coins:
                continue

            self.coins.remove(coin)

            value = int(coin["value_micros"])

            snake["balance_micros"] += value
            snake["collected_micros"] += value
            snake["score"] += 1
            snake["grow_pending"] = (
                snake.get("grow_pending", 0) + 1
            )

            current_radius = float(
                snake.get("radius", 7.0)
            )

            max_radius = float(
                snake.get("max_radius", SNAKE_MAX_RADIUS)
            )

            snake["radius"] = min(
                max_radius,
                current_radius + 0.15
            )

        self.update_balance(snake)

    def collect_food(self, snake: dict, head: dict):
        collected = []

        for food in list(self.foods):
            distance = math.hypot(
                head["x"] - food["x"],
                head["y"] - food["y"]
            )

            if distance <= FOOD_RADIUS + 8:
                collected.append(food)

        for food in collected:
            if food not in self.foods:
                continue

            self.foods.remove(food)

            growth = max(
                1,
                int(food.get("growth", FOOD_GROWTH))
            )

            snake["grow_pending"] += growth
            snake["score"] += growth

            current_radius = float(
                snake.get("radius", 7.0)
            )

            max_radius = float(
                snake.get("max_radius", SNAKE_MAX_RADIUS)
            )

            snake["radius"] = min(
                max_radius,
                current_radius + (FOOD_RADIUS_GROWTH * growth)
            )

    def check_collision(
        self,
        user_id: str,
        new_head: dict
    ):
        if (
            new_head["x"] < 8
            or new_head["x"] > WORLD_WIDTH - 8
            or new_head["y"] < 8
            or new_head["y"] > WORLD_HEIGHT - 8
        ):
            return "wall"

        current_snake = self.snakes.get(user_id)

        current_radius = (
            self.get_snake_radius(current_snake)
            if current_snake else 7.0
        )

        for other_uid, other_snake in self.snakes.items():
            if other_uid == user_id:
                continue

            if not other_snake.get("alive"):
                continue

            other_radius = self.get_snake_radius(other_snake)

            collision_distance = current_radius + other_radius

            for segment in other_snake.get("body", []):
                if math.hypot(
                    new_head["x"] - segment["x"],
                    new_head["y"] - segment["y"]
                ) < collision_distance:
                    return other_uid

        return None

    def update_snake(self, user_id: str):
        snake = self.snakes[user_id]

        if not snake.get("alive") or not snake.get("ready"):
            return

        if not snake.get("body"):
            self.kill_snake(snake)
            return

        now = time.monotonic()

        if snake.get("boosting"):
            if now >= snake.get("next_boost_coin_at", 0):
                if self.drop_boost_coin(snake):
                    snake["next_boost_coin_at"] = (
                        now + BOOST_COIN_INTERVAL
                    )

        speed = (
            SNAKE_BOOST_SPEED
            if snake.get("boosting")
            else SNAKE_SPEED
        )

        head = snake["body"][0]
        angle = snake.get("angle", 0)

        new_head = {
            "x": head["x"] + math.cos(angle) * speed,
            "y": head["y"] + math.sin(angle) * speed,
        }

        collision = self.check_collision(
            user_id,
            new_head
        )

        if collision:
            if collision != "wall":
                killer = self.snakes.get(collision)

                if killer and killer.get("alive"):
                    killer["kills"] = int(
                        killer.get("kills", 0)
                    ) + 1

            self.kill_snake(snake)
            return

        snake["body"].insert(0, new_head)

        self.collect_food(snake, new_head)
        self.collect_coins(snake, new_head)

        if snake.get("grow_pending", 0) > 0:
            snake["grow_pending"] -= 1
        else:
            snake["body"].pop()

    def public_state(self):
        public_snakes = {}

        now = time.monotonic()

        for uid, snake in self.snakes.items():
            cashout_seconds = 0

            if snake.get("cashout_pending"):
                cashout_seconds = max(
                    0,
                    math.ceil(
                        snake.get("cashout_pending_until", 0) - now
                    )
                )

            public_snakes[uid] = {
                "body": snake["body"],
                "angle": snake["angle"],
                "radius": self.get_snake_radius(snake),
                "score": snake["score"],
                "kills": snake["kills"],
                "color": snake["color"],
                "wallet": snake["wallet"],
                "bet": snake["bet"],
                "balance": snake["balance"],
                "balance_micros": snake["balance_micros"],
                "earned": snake["earned"],
                "earned_micros": snake["earned_micros"],
                "alive": snake["alive"],
                "ready": snake["ready"],
                "boosting": snake["boosting"],
                "cashout_pending": snake.get(
                    "cashout_pending",
                    False
                ),
                "cashout_seconds": cashout_seconds,
            }

        return {
            "type": "GAME_STATE",
            "room_id": self.room_id,
            "bet": self.bet,
            "players_count": len(self.connections),
            "max_players": MAX_SNAKE_PLAYERS,
            "snakes": public_snakes,
            "foods": self.foods,
            "coins": self.coins,
            "world": {
                "width": WORLD_WIDTH,
                "height": WORLD_HEIGHT,
            },
        }

    async def broadcast(self):
        message = self.public_state()

        for uid, ws in list(self.connections.items()):
            try:
                await ws.send_json(message)
            except Exception:
                pass

    async def game_loop(self):
        if self.is_running:
            return

        self.is_running = True

        try:
            while self.is_running and self.connections:
                async with self.lock:
                    for uid in list(self.snakes.keys()):
                        self.update_snake(uid)

                    missing_food = (
                        FOOD_INITIAL_COUNT - len(self.foods)
                    )

                    if missing_food > 0:
                        self.spawn_food(
                            min(missing_food, 5)
                        )

                await self.broadcast()
                await asyncio.sleep(GAME_TICK)

        except Exception as exc:
            print(
                f"ERROR en Snake game_loop "
                f"{self.room_id}: {exc!r}"
            )

        finally:
            self.is_running = False


# ============================================================
# WEBSOCKET SNAKE
# ============================================================

@app.websocket("/ws/snake/{room_id}")
async def snake_game_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str = Query(""),
    access_token: str = Query(""),
    bet: float = Query(0.20),
    wallet: str = Query("play"),
    color: str = Query("#34d399")
):
    await websocket.accept()

    if not user_id or not access_token:
        await send_error(
            websocket,
            "Debes iniciar sesión para jugar."
        )
        await websocket.close()
        return

    if not verify_user_token(access_token, user_id):
        await send_error(
            websocket,
            "La sesión no es válida. Inicia sesión nuevamente."
        )
        await websocket.close()
        return

    wallet = str(wallet).lower()

    if wallet not in ("play", "bonus"):
        await send_error(
            websocket,
            "La billetera seleccionada no es válida."
        )
        await websocket.close()
        return

    category = get_snake_bet_category(bet)

    if category is None:
        await send_error(
            websocket,
            "Apuesta no permitida. Solo puedes jugar con $0.20, $10 o $50."
        )
        await websocket.close()
        return

    bet_micros = SNAKE_BETS[category]
    bet = money_from_micros(bet_micros)

    if room_id not in (category, "snake_public"):
        await send_error(
            websocket,
            "La categoría de sala no corresponde a la apuesta."
        )
        await websocket.close()
        return

    room = None
    reserved = False

    async with snake_rooms_lock:
        already_playing = any(
            user_id in existing_room.connections
            for existing_room in snake_rooms.values()
        )

        if already_playing:
            await send_error(
                websocket,
                "Ya tienes una conexión activa en Snake."
            )
            await websocket.close()
            return

        room = get_available_snake_room_locked(category)

        async with room.lock:
            if len(room.connections) >= MAX_SNAKE_PLAYERS:
                await send_error(
                    websocket,
                    "No se pudo reservar el espacio. Intenta nuevamente."
                )
                await websocket.close()
                return

            if user_id in room.connections:
                await send_error(
                    websocket,
                    "Ya tienes una conexión activa en esta sala."
                )
                await websocket.close()
                return

            session_id = uuid.uuid4().hex

            transaction_key = (
                f"snake-entry:{room.room_id}:{user_id}:{session_id}"
            )

            success, message, playable_micros = enter_snake_game(
                user_id,
                bet,
                wallet,
                room.room_id,
                transaction_key
            )

            if not success:
                await send_error(websocket, message)
                await websocket.close()
                return

            room.add_snake(
                user_id,
                bet,
                wallet,
                color,
                session_id,
                playable_micros
            )

            room.connections[user_id] = websocket

            reserved = True

    if not reserved or room is None:
        try:
            await websocket.close()
        except Exception:
            pass
        return

    try:
        await websocket.send_json(room.public_state())

    except Exception as exc:
        print(
            f"ERROR enviando estado inicial Snake: {exc!r}"
        )

    if not room.is_running:
        asyncio.create_task(room.game_loop())

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = str(
                data.get("type", "")
            ).upper()

            if msg_type == "PING":
                await websocket.send_json({
                    "type": "PONG"
                })

            elif msg_type == "READY":
                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if snake and snake["alive"]:
                        snake["ready"] = True

                await room.broadcast()

            elif msg_type == "STEER":
                try:
                    angle = float(data.get("angle", 0))

                    if not math.isfinite(angle):
                        continue

                    async with room.lock:
                        snake = room.snakes.get(user_id)

                        if (
                            snake
                            and snake["alive"]
                            and snake["ready"]
                        ):
                            snake["angle"] = angle

                except (ValueError, TypeError):
                    pass

            elif msg_type == "BOOST_START":
                async with room.lock:
                    snake = room.snakes.get(user_id)

                    coin_value = room.get_coin_value()

                    if (
                        snake
                        and snake["alive"]
                        and snake["ready"]
                        and not snake.get("cashout_pending")
                        and snake["balance_micros"] >= coin_value
                    ):
                        if not snake.get("boosting"):
                            snake["boosting"] = True
                            snake["next_boost_coin_at"] = (
                                time.monotonic()
                            )

                await room.broadcast()

            elif msg_type == "BOOST_STOP":
                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if snake:
                        snake["boosting"] = False

                await room.broadcast()

            elif msg_type == "CASH_OUT":
                cashout_task_id = None

                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if (
                        snake
                        and snake["alive"]
                        and snake["ready"]
                        and not snake.get("cashed_out", False)
                        and not snake.get("cashout_pending", False)
                    ):
                        cashout_task_id = uuid.uuid4().hex

                        snake["cashout_pending"] = True

                        snake["cashout_pending_until"] = (
                            time.monotonic()
                            + CASHOUT_COUNTDOWN_SECONDS
                        )

                        snake["cashout_task_id"] = cashout_task_id
                        snake["boosting"] = False

                if cashout_task_id:
                    await websocket.send_json({
                        "type": "CASHOUT_PENDING",
                        "seconds": CASHOUT_COUNTDOWN_SECONDS,
                        "message": (
                            "Tienes 20 segundos para sobrevivir. "
                            "Puedes moverte y recoger monedas. "
                            "Si mueres, perderás el saldo acumulado."
                        )
                    })

                    await room.broadcast()

                    async def finish_cashout(
                        target_user_id: str,
                        target_task_id: str
                    ):
                        await asyncio.sleep(
                            CASHOUT_COUNTDOWN_SECONDS
                        )

                        cashout_data = None
                        no_balance = False
                        cashout_cancelled = False

                        async with room.lock:
                            current_snake = room.snakes.get(
                                target_user_id
                            )

                            if (
                                current_snake
                                and current_snake.get("alive")
                                and current_snake.get("cashout_pending")
                                and current_snake.get("cashout_task_id")
                                == target_task_id
                            ):
                                balance_micros = max(
                                    0,
                                    int(
                                        current_snake.get(
                                            "balance_micros",
                                            0
                                        )
                                    )
                                )

                                if balance_micros <= 0:
                                    current_snake["cashout_pending"] = False
                                    current_snake["cashout_pending_until"] = 0
                                    current_snake["cashout_task_id"] = None
                                    current_snake["boosting"] = False
                                    no_balance = True

                                else:
                                    gross_amount = money_from_micros(
                                        balance_micros
                                    )

                                    transaction_key = (
                                        f"snake-cashout:{room.room_id}:"
                                        f"{target_user_id}:"
                                        f"{current_snake['session_id']}"
                                    )

                                    current_snake["alive"] = False
                                    current_snake["boosting"] = False
                                    current_snake["cashed_out"] = True
                                    current_snake["cashout_pending"] = False
                                    current_snake["cashout_pending_until"] = 0

                                    cashout_data = {
                                        "gross": gross_amount,
                                        "wallet": current_snake["wallet"],
                                        "transaction_key": transaction_key,
                                    }

                            else:
                                cashout_cancelled = True

                        if no_balance:
                            try:
                                await send_error(
                                    websocket,
                                    "No tienes saldo disponible para retirar. Recoge monedas para acumular saldo."
                                )
                            except Exception:
                                pass

                            await room.broadcast()
                            return

                        if cashout_data is None:
                            if cashout_cancelled:
                                try:
                                    await websocket.send_json({
                                        "type": "CASHOUT_CANCELLED",
                                        "message": (
                                            "El retiro fue cancelado porque "
                                            "la serpiente murió antes de "
                                            "terminar la cuenta regresiva."
                                        )
                                    })
                                except Exception:
                                    pass

                            await room.broadcast()
                            return

                        paid, payment_message = settle_snake_cashout(
                            user_id=target_user_id,
                            room_id=room.room_id,
                            wallet=cashout_data["wallet"],
                            refund=0,
                            payout=cashout_data["gross"],
                            transaction_key=cashout_data["transaction_key"]
                        )

                        async with room.lock:
                            current_snake = room.snakes.get(
                                target_user_id
                            )

                            if current_snake:
                                if paid:
                                    current_snake["balance_micros"] = 0
                                    current_snake["entry_remaining_micros"] = 0
                                    current_snake["cashout_pending"] = False
                                    current_snake["cashout_pending_until"] = 0
                                    current_snake["cashout_task_id"] = None
                                    room.update_balance(current_snake)

                                else:
                                    current_snake["alive"] = True
                                    current_snake["cashed_out"] = False
                                    current_snake["cashout_pending"] = False
                                    current_snake["cashout_pending_until"] = 0
                                    current_snake["cashout_task_id"] = None

                        try:
                            if paid:
                                net_payout = round(
                                    cashout_data["gross"] * 0.94,
                                    2
                                )

                                await websocket.send_json({
                                    "type": "CASHOUT_SUCCESS",
                                    "payout": net_payout,
                                    "gross": cashout_data["gross"],
                                    "commission": round(
                                        cashout_data["gross"] * 0.06,
                                        2
                                    ),
                                    "refund": 0,
                                    "wallet": "withdraw",
                                    "message": (
                                        "¡Retiro realizado correctamente!"
                                    )
                                })

                            else:
                                await send_error(
                                    websocket,
                                    payment_message
                                )

                        except Exception as exc:
                            print(
                                f"ERROR notificando retiro Snake: {exc!r}"
                            )

                        await room.broadcast()

                    asyncio.create_task(
                        finish_cashout(
                            user_id,
                            cashout_task_id
                        )
                    )

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(
            f"ERROR WebSocket Snake {room.room_id}: {exc!r}"
        )

    finally:
        async with room.lock:
            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            snake = room.snakes.get(user_id)

            if snake and snake.get("alive"):
                room.kill_snake(snake)

            if not room.connections:
                room.is_running = False
                room.snakes.clear()
                room.coins.clear()
                room.foods.clear()
                room.spawn_food(FOOD_INITIAL_COUNT)

                print(
                    f"SALA SNAKE DISPONIBLE: {room.room_id}"
                )


# ============================================================
# PARCHÍS: CONFIGURACIÓN Y LÓGICA
# ============================================================

PARCHIS_BETS = (0.25, 1.00, 10.00)
PARCHIS_TRACK_LEN = 68
PARCHIS_HOME_STRETCH_LEN = 8
PARCHIS_SAFE_SPOTS = {0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63}
PARCHIS_START_SPOTS = {0: 5, 1: 22, 2: 39, 3: 56}
PARCHIS_COMMISSION_RATE = Decimal("0.06")

parchis_rooms: Dict[str, dict] = {}
parchis_locks: Dict[str, asyncio.Lock] = {}
parchis_rooms_lock = asyncio.Lock()


class CreateParchisRoomBody(BaseModel):
    bet: float
    max_players: int = 4
    wallet: str = "play"
    is_private: bool = False
    password: str = ""


def _normalize_parchis_bet(bet: float) -> float | None:
    try:
        dec = Decimal(str(bet)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError):
        return None
    val = float(dec)
    return val if val in PARCHIS_BETS else None


def _parchis_seat_order_for_max_players(max_players: int) -> tuple[int, ...]:
    # En 2 jugadores van en esquinas opuestas: 0 (Verde) y 2 (Azul)
    if max_players == 2:
        return (0, 2)
    if max_players == 3:
        return (0, 1, 2)
    return (0, 1, 2, 3)


def _parchis_team_for_seat(seat_index: int, max_players: int) -> str | None:
    if max_players == 4:
        return "A" if seat_index in (0, 2) else "B"
    return None


def _parchis_new_pieces() -> list[dict]:
    return [
        {"id": i, "stage": -1, "pos": -1, "steps_walked": 0}
        for i in range(4)
    ]


def _parchis_commission(pot: float) -> float:
    dec_pot = Decimal(str(pot)).quantize(Decimal("0.01"))
    return float((dec_pot * PARCHIS_COMMISSION_RATE).quantize(Decimal("0.01")))


def _parchis_public_rooms() -> list[dict]:
    items = []
    for rid, room in parchis_rooms.items():
        if room.get("status") != "waiting" or room.get("is_private"):
            continue
        if len(room["players"]) >= room["max_players"]:
            continue
        items.append({
            "room_id": rid,
            "bet": room["bet"],
            "max_players": room["max_players"],
            "players_count": len(room["players"]),
            "team_mode": room["team_mode"],
            "is_private": False,
        })
    return items


async def _parchis_broadcast(room: dict):
    payload = {
        "type": "PARCHIS_STATE",
        "room_id": room["room_id"],
        "bet": room["bet"],
        "max_players": room["max_players"],
        "team_mode": room["team_mode"],
        "is_private": room["is_private"],
        "room_code": room["room_code"] if room["is_private"] else None,
        "status": room["status"],
        "turn_seat": room["turn_seat"],
        "dice": sum(room.get("dice_remaining") or []) if room.get("dice_remaining") else None,
        "dice_pair": room.get("dice_pair"),
        "dice_remaining": room.get("dice_remaining", []),
        "double_count": room.get("double_count", 0),
        "penalty_pending": room.get("penalty_pending", False),
        "must_move": room["must_move"],
        "pot_total": round(room["bet"] * len(room["players"]), 2),
        "winners": room.get("winners", []),
        "last_event": room.get("last_event", ""),
        "players": [
            {
                "user_id": uid,
                "seat_index": p["seat_index"],
                "team": p["team"],
                "wallet": p["wallet"],
                "connected": p["connected"],
                "player_name": p.get("player_name", "Jugador"),
                "pieces": p["pieces"],
            }
            for uid, p in sorted(
                room["players"].items(),
                key=lambda kv: kv[1]["seat_index"],
            )
        ],
    }

    for p in list(room["players"].values()):
        ws = p.get("websocket")
        if ws is not None:
            try:
                await ws.send_json(payload)
            except Exception:
                pass


def _parchis_can_exit_with_pair_sum(dice_values: list[int]) -> bool:
    return len(dice_values) == 2 and sum(dice_values) == 5


def _parchis_can_move_piece(
    piece: dict,
    dice: int,
    dice_values: list[int] | None = None,
) -> bool:
    if not isinstance(dice, int) or dice < 1 or dice > 6:
        return False

    stage = piece.get("stage", -1)
    if stage == -1:
        if dice == 5:
            return True
        if dice_values and _parchis_can_exit_with_pair_sum(dice_values):
            return True
        return False
    if stage == 0:
        return piece.get("steps_walked", 0) + dice <= (
            63 + PARCHIS_HOME_STRETCH_LEN - 1
        )
    if stage == 100:
        return piece.get("pos", 0) + dice < PARCHIS_HOME_STRETCH_LEN
    return False


def _parchis_has_any_move(pieces: list[dict], dice_values: list[int]) -> bool:
    if _parchis_can_exit_with_pair_sum(dice_values) and any(
        pc.get("stage", -1) == -1 for pc in pieces
    ):
        return True
    return any(
        _parchis_can_move_piece(piece, die, dice_values)
        for piece in pieces
        for die in dice_values
    )


def _parchis_next_turn(room: dict, current_seat: int):
    seats_sorted = sorted(
        p["seat_index"] for p in room["players"].values()
    )
    if not seats_sorted:
        return
    if room.get("extra_turn"):
        room["turn_seat"] = current_seat
        room["extra_turn"] = False
        room["last_event"] += " Doble: vuelves a lanzar."
        return
    try:
        cur_idx = seats_sorted.index(current_seat)
    except ValueError:
        cur_idx = -1
    room["turn_seat"] = seats_sorted[(cur_idx + 1) % len(seats_sorted)]


def _parchis_apply_move(
    room: dict,
    actor_uid: str,
    piece_id: int,
    dice: int,
    use_pair_sum_five: bool = False,
) -> tuple[bool, str]:
    actor = room["players"].get(actor_uid)
    if not actor:
        return False, "Jugador no encontrado."

    piece = next(
        (pc for pc in actor["pieces"] if pc["id"] == piece_id),
        None,
    )
    if not piece:
        return False, "Ficha no encontrada."

    seat = actor["seat_index"]
    start_spot = PARCHIS_START_SPOTS.get(seat, 5)
    captured_msg = ""

    if piece["stage"] == -1:
        if not use_pair_sum_five and dice != 5:
            return False, "Necesitas un 5 o una suma de 5 para sacar ficha."
        piece["stage"] = 0
        piece["pos"] = start_spot
        piece["steps_walked"] = 0
        captured_msg = (
            f"Asiento {seat + 1} sacó ficha con suma 5."
            if use_pair_sum_five
            else f"Asiento {seat + 1} sacó ficha con el 5."
        )
    else:
        if not _parchis_can_move_piece(piece, dice):
            return False, "Movimiento no válido para esa ficha y ese dado."
        if piece["stage"] == 0:
            new_walked = piece["steps_walked"] + dice
            piece["steps_walked"] = new_walked
            if new_walked >= 63:
                piece["stage"] = 100
                piece["pos"] = new_walked - 63
            else:
                piece["pos"] = (start_spot + new_walked) % PARCHIS_TRACK_LEN
        elif piece["stage"] == 100:
            piece["pos"] += dice

        if piece["stage"] == 0 and piece["pos"] not in PARCHIS_SAFE_SPOTS:
            for other_uid, other_p in room["players"].items():
                if other_uid == actor_uid:
                    continue
                if (
                    room["team_mode"] == "2v2"
                    and other_p["team"] == actor["team"]
                ):
                    continue
                for opc in other_p["pieces"]:
                    if opc["stage"] == 0 and opc["pos"] == piece["pos"]:
                        opc["stage"] = -1
                        opc["pos"] = -1
                        opc["steps_walked"] = 0
                        captured_msg = (
                            f"¡Asiento {seat + 1} capturó una ficha "
                            f"del asiento {other_p['seat_index'] + 1}!"
                        )

    winner_uids: list[str] = []
    if room["team_mode"] == "2v2":
        for team_name in ("A", "B"):
            team_members = [
                p for p in room["players"].values()
                if p["team"] == team_name
            ]
            if team_members and all(
                pc["stage"] == 100
                and pc["pos"] == PARCHIS_HOME_STRETCH_LEN - 1
                for member in team_members
                for pc in member["pieces"]
            ):
                winner_uids = [member["user_id"] for member in team_members]
                break
    elif all(
        pc["stage"] == 100
        and pc["pos"] == PARCHIS_HOME_STRETCH_LEN - 1
        for pc in actor["pieces"]
    ):
        winner_uids = [actor_uid]

    room["last_event"] = (
        captured_msg
        or f"Asiento {seat + 1} avanzó {dice}."
    )

    if winner_uids:
        room["status"] = "finished"
        room["winners"] = winner_uids
        room["must_move"] = False
        room["dice_remaining"] = []
        return True, "WIN"

    return True, "OK"


async def _parchis_settle_winners(room: dict, winner_uids: list[str]):
    if room.get("settled"):
        return
    room["settled"] = True

    total_pot = round(room["bet"] * len(room["players"]), 2)
    commission = _parchis_commission(total_pot)
    net_pot = round(max(0.0, total_pot - commission), 2)

    winners_payload = []
    if winner_uids:
        share = round(net_pot / len(winner_uids), 2)
        for uid in winner_uids:
            p = room["players"].get(uid)
            wallet = p["wallet"] if p else "play"
            winners_payload.append({
                "user_id": uid,
                "wallet": wallet,
                "amount": share,
            })

    tx_key = f"parchis-settle:{room['room_id']}"
    try:
        rpc_json("settle_parchis_game", {
            "p_transaction_key": tx_key,
            "p_room_id": room["room_id"],
            "p_winners": winners_payload,
            "p_commission": commission,
        })
    except Exception as exc:
        print(f"ERROR settle_parchis_game {room['room_id']}: {exc!r}")


@app.get("/parchis/rooms")
async def list_parchis_rooms(bet: float | None = None):
    rooms = _parchis_public_rooms()
    if bet is not None:
        norm = _normalize_parchis_bet(bet)
        if norm is not None:
            rooms = [r for r in rooms if r["bet"] == norm]
    return {"rooms": rooms}


@app.post("/parchis/rooms/create")
async def create_parchis_room(
    body: CreateParchisRoomBody,
    authorization: str | None = Header(default=None),
):
    user_id = get_authenticated_user_id(authorization)

    norm_bet = _normalize_parchis_bet(body.bet)
    if norm_bet is None:
        raise HTTPException(
            status_code=400,
            detail="Apuesta inválida. Solo $0.25, $1.00 o $10.00.",
        )

    if body.max_players not in (2, 3, 4):
        raise HTTPException(
            status_code=400,
            detail="La sala debe ser de 2, 3 o 4 jugadores.",
        )

    wallet = (body.wallet or "play").strip().lower()
    if wallet not in ("play", "bonus"):
        raise HTTPException(status_code=400, detail="Billetera inválida.")

    is_private = bool(body.is_private)
    room_code = (body.password or "").strip()
    if is_private and not room_code:
        room_code = uuid.uuid4().hex[:6].upper()

    room_id = f"parchis_{uuid.uuid4().hex[:10]}"
    team_mode = "2v2" if body.max_players == 4 else "ffa"

    async with parchis_rooms_lock:
        parchis_rooms[room_id] = {
            "room_id": room_id,
            "creator_id": user_id,
            "bet": norm_bet,
            "max_players": body.max_players,
            "team_mode": team_mode,
            "is_private": is_private,
            "room_code": room_code,
            "status": "waiting",
            "turn_seat": 0,
            "dice": None,
            "dice_pair": None,
            "dice_remaining": [],
            "double_count": 0,
            "penalty_pending": False,
            "extra_turn": False,
            "must_move": False,
            "players": {},
            "winners": [],
            "settled": False,
            "last_event": "Sala creada. Esperando jugadores...",
        }
        parchis_locks[room_id] = asyncio.Lock()

        try:
            supabase.table("parchis_matches").insert({
                "id": room_id,
                "creator_id": user_id,
                "bet_amount": norm_bet,
                "max_players": body.max_players,
                "team_mode": team_mode,
                "is_private": is_private,
                "room_code": room_code if is_private else None,
                "status": "waiting",
                "pot_total": 0.00,
                "commission_amount": 0.00,
            }).execute()
        except Exception as exc:
            print(f"ERROR insert parchis_matches {room_id}: {exc!r}")

    return {
        "success": True,
        "room_id": room_id,
        "bet": norm_bet,
        "max_players": body.max_players,
        "team_mode": team_mode,
        "is_private": is_private,
        "room_code": room_code if is_private else None,
    }


@app.websocket("/ws/parchis/{room_id}")
async def parchis_ws_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str = Query(""),
    access_token: str = Query(""),
    bet: float = Query(0.25),
    max_players: int = Query(4),
    wallet: str = Query("play"),
    password: str = Query(""),
    player_name: str = Query("Jugador"),
):
    await websocket.accept()

    if not user_id or not access_token or not verify_user_token(access_token, user_id):
        await send_error(websocket, "Sesión no válida.")
        await websocket.close()
        return

    wallet = (wallet or "play").strip().lower()
    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    norm_bet = _normalize_parchis_bet(bet)
    if norm_bet is None:
        await send_error(websocket, "Apuesta no permitida ($0.25, $1.00 o $10.00).")
        await websocket.close()
        return

    if max_players not in (2, 3, 4):
        await send_error(websocket, "Cantidad de jugadores no válida (2, 3 o 4).")
        await websocket.close()
        return

    async with parchis_rooms_lock:
        room = parchis_rooms.get(room_id)
        if room is None:
            if room_id == "matchmake":
                matching = [
                    r for r in parchis_rooms.values()
                    if r["status"] == "waiting"
                    and not r["is_private"]
                    and r["bet"] == norm_bet
                    and r["max_players"] == max_players
                    and len(r["players"]) < r["max_players"]
                ]
                if matching:
                    room = matching[0]
                else:
                    new_rid = f"parchis_{uuid.uuid4().hex[:10]}"
                    team_mode = "2v2" if max_players == 4 else "ffa"
                    room = {
                        "room_id": new_rid,
                        "creator_id": user_id,
                        "bet": norm_bet,
                        "max_players": max_players,
                        "team_mode": team_mode,
                        "is_private": False,
                        "room_code": "",
                        "status": "waiting",
                        "turn_seat": 0,
                        "dice": None,
                        "dice_pair": None,
                        "dice_remaining": [],
                        "double_count": 0,
                        "penalty_pending": False,
                        "extra_turn": False,
                        "must_move": False,
                        "players": {},
                        "winners": [],
                        "settled": False,
                        "last_event": "Sala abierta. Esperando rivales...",
                    }
                    parchis_rooms[new_rid] = room
                    parchis_locks[new_rid] = asyncio.Lock()
                    try:
                        supabase.table("parchis_matches").insert({
                            "id": new_rid,
                            "creator_id": user_id,
                            "bet_amount": norm_bet,
                            "max_players": max_players,
                            "team_mode": team_mode,
                            "is_private": False,
                            "room_code": None,
                            "status": "waiting",
                        }).execute()
                    except Exception as exc:
                        print(f"ERROR insert matchmake parchis {new_rid}: {exc!r}")
            else:
                await send_error(websocket, "La sala de Parchís no existe.")
                await websocket.close()
                return

        lock = parchis_locks[room["room_id"]]

    async with lock:
        if room["status"] == "finished":
            await send_error(websocket, "La partida ya finalizó.")
            await websocket.close()
            return

        if room["is_private"] and str(room.get("room_code") or "") != str(password or "").strip():
            await send_error(websocket, "Código o contraseña de sala privada incorrecta.")
            await websocket.close()
            return

        existing = room["players"].get(user_id)
        if existing is None:
            if room["status"] != "waiting":
                await send_error(websocket, "La partida ya comenzó.")
                await websocket.close()
                return
            if len(room["players"]) >= room["max_players"]:
                await send_error(websocket, "La sala está llena.")
                await websocket.close()
                return

            tx_key = f"parchis-entry:{room['room_id']}:{user_id}"
            try:
                res = rpc_json("enter_parchis_game", {
                    "p_transaction_key": tx_key,
                    "p_room_id": room["room_id"],
                    "p_user_id": user_id,
                    "p_wallet": wallet,
                    "p_amount": room["bet"],
                })
            except Exception as exc:
                print(f"ERROR enter_parchis_game: {exc!r}")
                await send_error(websocket, "No se pudo procesar el ingreso.")
                await websocket.close()
                return

            if not res.get("success"):
                await send_error(websocket, res.get("message") or "No se pudo descontar la apuesta.")
                await websocket.close()
                return

            taken_seats = {p["seat_index"] for p in room["players"].values()}
            seat_candidates = _parchis_seat_order_for_max_players(room["max_players"])
            seat_index = next(i for i in seat_candidates if i not in taken_seats)
            team = _parchis_team_for_seat(seat_index, room["max_players"])

            room["players"][user_id] = {
                "user_id": user_id,
                "seat_index": seat_index,
                "team": team,
                "wallet": wallet,
                "player_name": (player_name or "Jugador").strip()[:40],
                "connected": True,
                "websocket": websocket,
                "pieces": _parchis_new_pieces(),
            }

            try:
                supabase.table("parchis_players").insert({
                    "match_id": room["room_id"],
                    "user_id": user_id,
                    "wallet": wallet,
                    "seat_index": seat_index,
                    "team": team,
                    "pieces_json": room["players"][user_id]["pieces"],
                    "is_connected": True,
                }).execute()
            except Exception as exc:
                print(f"ERROR insert parchis_players: {exc!r}")

            if len(room["players"]) == room["max_players"]:
                room["status"] = "playing"
                room["turn_seat"] = min(p["seat_index"] for p in room["players"].values())
                room["last_event"] = "¡Sala completa! Inicia el turno."
                try:
                    supabase.table("parchis_matches").update({"status": "playing"}).eq("id", room["room_id"]).execute()
                except Exception:
                    pass
        else:
            existing["connected"] = True
            existing["websocket"] = websocket

        await _parchis_broadcast(room)

    try:
        while True:
            data = await websocket.receive_json()
            if not isinstance(data, dict):
                continue

            msg_type = str(data.get("type") or "").upper()

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            async with lock:
                if room["status"] != "playing":
                    continue

                actor = room["players"].get(user_id)
                if not actor or actor["seat_index"] != room["turn_seat"]:
                    await send_error(websocket, "No es tu turno.")
                    continue

                if msg_type == "ROLL_DICE":
                    if room.get("penalty_pending"):
                        await send_error(websocket, "Elige la ficha que regresará a casa.")
                        continue
                    if room["must_move"]:
                        await send_error(
                            websocket,
                            "Debes usar los dados disponibles antes de volver a lanzar.",
                        )
                        continue

                    die_one = random.randint(1, 6)
                    die_two = random.randint(1, 6)
                    room["dice_pair"] = [die_one, die_two]
                    room["dice_remaining"] = [die_one, die_two]
                    room["dice"] = die_one + die_two
                    room["extra_turn"] = die_one == die_two
                    if die_one == die_two:
                        room["double_count"] = room.get("double_count", 0) + 1
                    else:
                        room["double_count"] = 0

                    # 3 oportunidades de par; al 4.º par consecutivo regresa ficha a casa
                    if room["double_count"] >= 4:
                        active_pieces = [
                            pc for pc in actor["pieces"]
                            if pc.get("stage", -1) != -1
                        ]
                        room["extra_turn"] = False
                        room["double_count"] = 0
                        room["must_move"] = False
                        room["dice_remaining"] = []
                        room["dice"] = None

                        if len(active_pieces) == 1:
                            only_pc = active_pieces[0]
                            only_pc.update({"stage": -1, "pos": -1, "steps_walked": 0})
                            room["penalty_pending"] = False
                            room["last_event"] = "¡Cuarto par seguido! Tu ficha regresó al inicio."
                            try:
                                supabase.table("parchis_players").update({"pieces_json": actor["pieces"]}).eq("match_id", room["room_id"]).eq("user_id", user_id).execute()
                            except Exception:
                                pass
                            _parchis_next_turn(room, actor["seat_index"])
                        elif len(active_pieces) > 1:
                            room["penalty_pending"] = True
                            room["last_event"] = "¡Cuarto par seguido! Elige una ficha para regresarla al inicio."
                        else:
                            room["penalty_pending"] = False
                            room["last_event"] = "¡Cuarto par seguido! Pierdes el turno."
                            _parchis_next_turn(room, actor["seat_index"])

                        await _parchis_broadcast(room)
                        continue

                    has_valid = _parchis_has_any_move(
                        actor["pieces"],
                        room["dice_remaining"],
                    )

                    if not has_valid:
                        room["must_move"] = False
                        room["last_event"] = (
                            f"Asiento {actor['seat_index'] + 1} sacó "
                            f"{die_one} y {die_two}; no tiene movimientos."
                        )
                        room["dice_remaining"] = []
                        room["dice"] = None
                        _parchis_next_turn(room, actor["seat_index"])
                    else:
                        room["must_move"] = True
                        room["last_event"] = (
                            f"Asiento {actor['seat_index'] + 1} sacó "
                            f"{die_one} y {die_two}."
                        )

                    await _parchis_broadcast(room)

                elif msg_type == "SELECT_PENALTY_PIECE":
                    if not room.get("penalty_pending"):
                        await send_error(websocket, "No hay penalización pendiente.")
                        continue
                    try:
                        penalty_piece_id = int(data.get("piece_id", -1))
                    except (TypeError, ValueError):
                        await send_error(websocket, "Ficha inválida.")
                        continue
                    penalty_piece = next((pc for pc in actor["pieces"] if pc["id"] == penalty_piece_id), None)
                    if not penalty_piece or penalty_piece.get("stage") == -1:
                        await send_error(websocket, "Elige una ficha que esté fuera de casa.")
                        continue
                    penalty_piece.update({"stage": -1, "pos": -1, "steps_walked": 0})
                    room["penalty_pending"] = False
                    room["double_count"] = 0
                    room["must_move"] = False
                    room["dice_remaining"] = []
                    room["dice"] = None
                    room["last_event"] = f"La ficha {penalty_piece_id + 1} regresó al inicio por cuarto par."
                    try:
                        supabase.table("parchis_players").update({"pieces_json": actor["pieces"]}).eq("match_id", room["room_id"]).eq("user_id", user_id).execute()
                    except Exception:
                        pass
                    _parchis_next_turn(room, actor["seat_index"])
                    await _parchis_broadcast(room)

                elif msg_type == "MOVE_PIECE":
                    dice_remaining = room.get("dice_remaining") or []
                    if not room["must_move"] or not dice_remaining:
                        await send_error(websocket, "Primero lanza los dados.")
                        continue

                    try:
                        piece_id = int(data.get("piece_id", -1))
                        raw_die = data.get("dice_value", data.get("steps_moved", 0))
                        requested_die = int(raw_die)
                        raw_used = data.get("used_dice_values")
                    except (TypeError, ValueError):
                        await send_error(websocket, "Ficha o dado inválido.")
                        continue

                    piece = next(
                        (pc for pc in actor["pieces"] if pc["id"] == piece_id),
                        None,
                    )
                    if not piece:
                        await send_error(websocket, "Ficha no encontrada.")
                        continue

                    use_pair_sum_five = (
                        piece.get("stage", -1) == -1
                        and requested_die == 5
                        and 5 not in dice_remaining
                        and _parchis_can_exit_with_pair_sum(dice_remaining)
                    )

                    if not use_pair_sum_five:
                        if requested_die not in dice_remaining:
                            requested_die = next(
                                (
                                    die for die in dice_remaining
                                    if _parchis_can_move_piece(piece, die, dice_remaining)
                                ),
                                0,
                            )

                        if requested_die not in dice_remaining:
                            await send_error(
                                websocket,
                                "Ese dado ya fue utilizado o no permite ese movimiento.",
                            )
                            continue

                    ok, status_code = _parchis_apply_move(
                        room,
                        user_id,
                        piece_id,
                        requested_die,
                        use_pair_sum_five=use_pair_sum_five,
                    )
                    if not ok:
                        await send_error(websocket, status_code)
                        continue

                    if use_pair_sum_five:
                        room["dice_remaining"] = []
                    elif (
                        isinstance(raw_used, list)
                        and len(raw_used) == 2
                        and sum(int(x) for x in raw_used) == 5
                        and piece.get("stage", -1) == 0
                        and piece.get("steps_walked", 0) == 0
                    ):
                        room["dice_remaining"] = []
                    else:
                        room["dice_remaining"].remove(requested_die)

                    try:
                        supabase.table("parchis_players").update({
                            "pieces_json": actor["pieces"],
                        }).eq("match_id", room["room_id"]).eq("user_id", user_id).execute()
                    except Exception:
                        pass

                    if status_code == "WIN":
                        await _parchis_settle_winners(room, room["winners"])
                    else:
                        remaining = room.get("dice_remaining") or []
                        if remaining and _parchis_has_any_move(
                            actor["pieces"],
                            remaining,
                        ):
                            room["must_move"] = True
                        else:
                            room["must_move"] = False
                            room["dice_remaining"] = []
                            room["dice"] = None
                            _parchis_next_turn(room, actor["seat_index"])

                    await _parchis_broadcast(room)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR WebSocket Parchís {room_id}: {exc!r}")
    finally:
        async with lock:
            p = room["players"].get(user_id)
            if p and p.get("websocket") is websocket:
                p["connected"] = False
                p["websocket"] = None

# ============================================================
# ADMINISTRADOR AXIOM - NUEVO PANEL
# Secciones: Resumen, Clientes, Bonos, Retiros y Depósitos
# ============================================================

from fastapi import Header, HTTPException


def _admin_require(authorization: str):
    """Verifica el token y que el usuario sea administrador habilitado."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Debes iniciar sesión.")

    token = authorization.split(" ", 1)[1].strip()

    try:
        auth_response = supabase.auth.get_user(token)
        auth_user = getattr(auth_response, "user", None)

        if not auth_user:
            raise HTTPException(status_code=401, detail="Sesión no válida.")

        admin_id = str(auth_user.id)

        admin_response = (
            supabase.table("admin_users")
            .select("user_id")
            .eq("user_id", admin_id)
            .eq("enabled", True)
            .limit(1)
            .execute()
        )

        if not admin_response.data:
            raise HTTPException(
                status_code=403,
                detail="No tienes permisos de administrador."
            )

        return admin_id

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="No se pudo verificar la sesión.")


def _admin_all_rows(table_name: str, columns: str = "*"):
    """Obtiene todos los registros por páginas."""
    results = []
    start = 0
    page_size = 1000

    while True:
        response = (
            supabase.table(table_name)
            .select(columns)
            .range(start, start + page_size - 1)
            .execute()
        )

        rows = response.data or []
        results.extend(rows)

        if len(rows) < page_size:
            break

        start += page_size

    return results


def _admin_attach_clients(rows):
    """Agrega los datos del perfil a solicitudes de depósitos o retiros."""
    user_ids = list({
        row.get("user_id")
        for row in rows
        if row.get("user_id")
    })

    if not user_ids:
        return rows

    profiles = (
        supabase.table("profiles")
        .select(
            "id,first_name,middle_name,last_name,second_last_name,"
            "doc_type,doc_number,phone"
        )
        .in_("id", user_ids)
        .execute()
    )

    profile_map = {
        str(profile["id"]): profile
        for profile in (profiles.data or [])
    }

    for row in rows:
        row["client"] = profile_map.get(str(row.get("user_id")))

    return rows


# ------------------------------------------------------------
# 1. RESUMEN GENERAL
# ------------------------------------------------------------

@app.get("/admin/summary")
def admin_summary(authorization: str = Header(None)):
    _admin_require(authorization)

    admin_rows = _admin_all_rows("admin_users", "user_id")
    admin_ids = {
        str(row["user_id"])
        for row in admin_rows
        if row.get("user_id")
    }

    profiles = _admin_all_rows(
        "profiles",
        "id,balance,withdraw_balance,bonus_balance"
    )

    clients = [
        profile for profile in profiles
        if str(profile.get("id")) not in admin_ids
    ]

    commissions = _admin_all_rows(
        "comisiones",
        "comision_axiom"
    )

    return {
        "total_clients": len(clients),
        "money_play": round(sum(
            float(p.get("balance") or 0) for p in clients
        ), 2),
        "money_withdraw": round(sum(
            float(p.get("withdraw_balance") or 0) for p in clients
        ), 2),
        "money_bonus": round(sum(
            float(p.get("bonus_balance") or 0) for p in clients
        ), 2),
        "axiom_commission": round(sum(
            float(c.get("comision_axiom") or 0) for c in commissions
        ), 2)
    }


# ------------------------------------------------------------
# 2. CLIENTES
# ------------------------------------------------------------

@app.get("/admin/clients")
def admin_clients(
    q: str = "",
    limit: int = 100,
    offset: int = 0,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)

    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    admin_rows = _admin_all_rows("admin_users", "user_id")
    admin_ids = {
        str(row["user_id"])
        for row in admin_rows
        if row.get("user_id")
    }

    profiles = _admin_all_rows("profiles")

    profiles = [
        p for p in profiles
        if str(p.get("id")) not in admin_ids
    ]

    if q.strip():
        term = q.strip().lower()

        def matches(profile):
            fields = [
                profile.get("first_name"),
                profile.get("middle_name"),
                profile.get("last_name"),
                profile.get("second_last_name"),
                profile.get("doc_number"),
                profile.get("phone"),
                profile.get("referral_code")
            ]

            return any(
                term in str(value or "").lower()
                for value in fields
            )

        profiles = [p for p in profiles if matches(p)]

    total = len(profiles)

    return {
        "total": total,
        "clients": profiles[offset:offset + limit]
    }


@app.patch("/admin/clients/{user_id}")
def admin_update_client(
    user_id: str,
    payload: dict,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)

    admin_check = (
        supabase.table("admin_users")
        .select("user_id")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )

    if admin_check.data:
        raise HTTPException(
            status_code=400,
            detail="No se pueden modificar cuentas administrativas."
        )

    allowed_fields = {
        "first_name",
        "middle_name",
        "last_name",
        "second_last_name",
        "doc_type",
        "doc_number",
        "phone",
        "birth_date",
        "bonus_code",
        "referral_code",
        "referred_by"
    }

    changes = {
        key: value
        for key, value in payload.items()
        if key in allowed_fields
    }

    if not changes:
        raise HTTPException(
            status_code=400,
            detail="No hay datos válidos para modificar."
        )

    result = (
        supabase.table("profiles")
        .update(changes)
        .eq("id", user_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Cliente no encontrado.")

    return {"success": True, "client": result.data[0]}


@app.post("/admin/clients/{user_id}/balance")
def admin_adjust_client_balance(
    user_id: str,
    payload: dict,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)

    wallet = payload.get("wallet")
    amount = payload.get("amount")

    if wallet not in ("play", "withdraw", "bonus"):
        raise HTTPException(
            status_code=400,
            detail="Billetera no válida. Usa play, withdraw o bonus."
        )

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Monto no válido.")

    if amount == 0:
        raise HTTPException(
            status_code=400,
            detail="El ajuste no puede ser cero."
        )

    return rpc_json(
        "admin_adjust_client_balance",
        {
            "p_admin_user_id": admin_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_amount": amount
        }
    )


# ------------------------------------------------------------
# 3. BONOS
# ------------------------------------------------------------

@app.get("/admin/bonuses")
def admin_bonuses(authorization: str = Header(None)):
    _admin_require(authorization)

    bonuses = _admin_all_rows("bonus_codes")
    bonuses.sort(
        key=lambda item: item.get("id") or 0,
        reverse=True
    )

    return {"bonuses": bonuses}


@app.post("/admin/bonuses")
def admin_create_bonus(
    payload: dict,
    authorization: str = Header(None)
):
    _admin_require(authorization)

    code = str(payload.get("code") or "").strip().upper()
    amount = payload.get("amount")
    max_uses = payload.get("max_uses")
    starts_at = payload.get("starts_at")
    expires_at = payload.get("expires_at")

    if not code:
        raise HTTPException(status_code=400, detail="Código obligatorio.")

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Monto no válido.")

    if amount <= 0:
        raise HTTPException(
            status_code=400,
            detail="El monto del bono debe ser mayor que cero."
        )

    if max_uses is not None:
        try:
            max_uses = int(max_uses)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="El máximo de usos no es válido."
            )

        if max_uses <= 0:
            raise HTTPException(
                status_code=400,
                detail="El máximo de usos debe ser mayor que cero."
            )

    existing = (
        supabase.table("bonus_codes")
        .select("id")
        .eq("code", code)
        .limit(1)
        .execute()
    )

    if existing.data:
        raise HTTPException(
            status_code=409,
            detail="Ese código de bono ya existe."
        )

    new_bonus = {
        "code": code,
        "amount": amount,
        "is_active": bool(payload.get("is_active", True)),
        "starts_at": starts_at,
        "expires_at": expires_at,
        "max_uses": max_uses,
        "uses_count": 0
    }

    result = (
        supabase.table("bonus_codes")
        .insert(new_bonus)
        .execute()
    )

    return {"success": True, "bonus": result.data[0]}


@app.patch("/admin/bonuses/{bonus_id}")
def admin_update_bonus(
    bonus_id: int,
    payload: dict,
    authorization: str = Header(None)
):
    _admin_require(authorization)

    allowed_fields = {
        "amount",
        "is_active",
        "starts_at",
        "expires_at",
        "max_uses"
    }

    changes = {
        key: value
        for key, value in payload.items()
        if key in allowed_fields
    }

    if not changes:
        raise HTTPException(
            status_code=400,
            detail="No hay datos válidos para modificar."
        )

    if "amount" in changes:
        try:
            changes["amount"] = float(changes["amount"])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Monto no válido.")

        if changes["amount"] <= 0:
            raise HTTPException(
                status_code=400,
                detail="El monto debe ser mayor que cero."
            )

    if "max_uses" in changes and changes["max_uses"] is not None:
        try:
            changes["max_uses"] = int(changes["max_uses"])
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="Máximo de usos no válido."
            )

        if changes["max_uses"] <= 0:
            raise HTTPException(
                status_code=400,
                detail="El máximo de usos debe ser mayor que cero."
            )

    result = (
        supabase.table("bonus_codes")
        .update(changes)
        .eq("id", bonus_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Bono no encontrado.")

    return {"success": True, "bonus": result.data[0]}


# ------------------------------------------------------------
# 4. RETIROS
# ------------------------------------------------------------

@app.get("/admin/withdrawals")
def admin_withdrawals(
    status: str = "",
    limit: int = 100,
    offset: int = 0,
    authorization: str = Header(None)
):
    _admin_require(authorization)

    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    query = (
        supabase.table("withdrawal_requests")
        .select("*")
        .order("created_at", desc=True)
    )

    if status:
        query = query.eq("status", status)

    result = query.range(offset, offset + limit - 1).execute()
    rows = _admin_attach_clients(result.data or [])

    return {
        "withdrawals": rows,
        "count": len(rows)
    }


@app.post("/admin/withdrawals/{withdrawal_id}/approve")
def admin_approve_withdrawal(
    withdrawal_id: str,
    payload: dict = None,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)
    note = (payload or {}).get("admin_note")

    return rpc_json(
        "admin_approve_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": note
        }
    )


@app.post("/admin/withdrawals/{withdrawal_id}/reject")
def admin_reject_withdrawal(
    withdrawal_id: str,
    payload: dict = None,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)
    note = (payload or {}).get("admin_note")

    return rpc_json(
        "admin_reject_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": note
        }
    )


@app.post("/admin/withdrawals/{withdrawal_id}/complete")
def admin_complete_withdrawal(
    withdrawal_id: str,
    payload: dict = None,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)
    note = (payload or {}).get("admin_note")

    return rpc_json(
        "admin_complete_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": note
        }
    )


# ------------------------------------------------------------
# 5. DEPÓSITOS
# ------------------------------------------------------------

@app.get("/admin/deposits")
def admin_deposits(
    status: str = "",
    limit: int = 100,
    offset: int = 0,
    authorization: str = Header(None)
):
    _admin_require(authorization)

    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    query = (
        supabase.table("deposit_requests")
        .select("*")
        .order("created_at", desc=True)
    )

    if status:
        query = query.eq("status", status)

    result = query.range(offset, offset + limit - 1).execute()
    rows = _admin_attach_clients(result.data or [])

    return {
        "deposits": rows,
        "count": len(rows)
    }


@app.post("/admin/deposits/{deposit_id}/approve")
def admin_approve_deposit(
    deposit_id: int,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)

    return rpc_json(
        "admin_approve_deposit",
        {
            "p_admin_user_id": admin_id,
            "p_deposit_id": deposit_id
        }
    )


@app.post("/admin/deposits/{deposit_id}/reject")
def admin_reject_deposit(
    deposit_id: int,
    payload: dict = None,
    authorization: str = Header(None)
):
    admin_id = _admin_require(authorization)
    note = (payload or {}).get("admin_note")

    return rpc_json(
        "admin_reject_deposit",
        {
            "p_admin_user_id": admin_id,
            "p_deposit_id": deposit_id,
            "p_admin_note": note
        }
    )
