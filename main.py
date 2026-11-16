import os
import random
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
    allow_origins=["*"],
    allow_credentials=False,
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

            # El frontend ya ejecuta el débito antes de CREATE_ROOM.
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

                # El frontend ya descontó la apuesta al unirse.
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

            # El cierre voluntario se procesa en finally.
            # Si la partida ya comenzó, el rival gana por abandono.
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

                # Evita que una conexión vieja desconecte una conexión nueva.
                if current is player and current.get("websocket") is websocket:
                    current["connected"] = False
                    current["websocket"] = None

                    # Si la partida ya terminó normalmente, no se declara
                    # otro ganador por la desconexión posterior.
                    if room.get("finished"):
                        remove_room = True

                    # PARTIDA EN CURSO:
                    # el jugador que permanece conectado gana por abandono.
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

                        # También se intenta informar al jugador que abandona.
                        await xo_send(current, {
                            "type": "GAME_FINISHED",
                            "result": "lose",
                            "winner_id": winner_id,
                            "abandoner_id": str(user_id),
                            "reason": "abandonment",
                        })

                        remove_room = True
                        lobby_changed = True

                    # SALA EN ESPERA:
                    # si se va el creador, se elimina la sala sin ganador.
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

                    # SALA EN ESPERA:
                    # si se va el invitado, se libera el espacio y el
                    # creador puede seguir esperando a otro jugador.
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

# ÚNICAS APUESTAS PERMITIDAS
SNAKE_BETS = {
    "snake_020": 200_000,
    "snake_1000": 10_000_000,
    "snake_5000": 50_000_000,
}

# VALOR DE LAS MONEDAS SEGÚN LA SALA
SNAKE_COIN_VALUES = {
    "snake_020": 10_000,
    "snake_1000": 500_000,
    "snake_5000": 2_500_000,
}

# Una moneda cada cuarto de segundo mientras se mantiene el impulso.
BOOST_COIN_INTERVAL = 0.25

# Tiempo de supervivencia para completar el retiro.
CASHOUT_COUNTDOWN_SECONDS = 20

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 200
MAX_SNAKE_PLAYERS = 30

# CRECIMIENTO AL COMER
FOOD_GROWTH = 3
FOOD_RADIUS_GROWTH = 0.30
SNAKE_MAX_RADIUS = 21.0

# REDUCCIÓN DE TAMAÑO AL IMPULSARSE
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
    """
    Esta función debe llamarse teniendo adquirido
    snake_rooms_lock.
    """

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

    # ========================================================
    # VALOR DE MONEDA SEGÚN LA SALA
    # ========================================================

    def get_coin_value(self) -> int:
        return SNAKE_COIN_VALUES.get(
            self.category,
            10_000
        )

    # ========================================================
    # TAMAÑO ACTUAL DE LA SERPIENTE
    # ========================================================

    def get_snake_radius(self, snake: dict) -> float:
        radius = float(snake.get("radius", 7.0))

        # Al impulsarse reduce temporalmente su grosor un 20%.
        if snake.get("boosting"):
            radius *= BOOST_RADIUS_MULTIPLIER

        return radius

    # ========================================================
    # COMIDA
    # ========================================================

    def spawn_food(self, amount: int = 1):
        for _ in range(amount):
            self.foods.append({
                "id": f"food_{uuid.uuid4().hex}",
                "x": random.uniform(30, WORLD_WIDTH - 30),
                "y": random.uniform(30, WORLD_HEIGHT - 30),
                "color": random.choice(FOOD_COLORS),
                "radius": FOOD_RADIUS,

                # Cada comida agrega 4 segmentos.
                "growth": FOOD_GROWTH,
            })

    # ========================================================
    # POSICIÓN INICIAL
    # ========================================================

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

    # ========================================================
    # CREAR SERPIENTE
    # ========================================================

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

            # Grosor inicial y máximo.
            "radius": 7.0,
            "max_radius": SNAKE_MAX_RADIUS,

            "score": 0,
            "kills": 0,

            "color": safe_color(color),
            "wallet": wallet,

            "bet": money_from_micros(bet_micros),
            "bet_micros": bet_micros,

            # El 100% de la apuesta queda disponible.
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

            # Estado del retiro.
            "cashout_pending": False,
            "cashout_pending_until": 0.0,
            "cashout_task_id": None,

            "created_at": time.time(),
        }

    # ========================================================
    # ACTUALIZAR SALDO
    # ========================================================

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

    # ========================================================
    # SOLTAR MONEDAS AL MORIR
    # ========================================================

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

        # Todo el saldo se convierte en monedas.
        snake["balance_micros"] = 0
        snake["entry_remaining_micros"] = 0

        self.update_balance(snake)

    # ========================================================
    # MORIR
    # ========================================================

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return

        snake["alive"] = False
        snake["boosting"] = False

        # Cancela el retiro si muere durante la cuenta regresiva.
        snake["cashout_pending"] = False
        snake["cashout_pending_until"] = 0.0

        self.drop_coins(snake)

    # ========================================================
    # SOLTAR MONEDA AL IMPULSARSE
    # ========================================================

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

        # Descuenta exactamente el valor de la moneda.
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

    # ========================================================
    # RECOGER MONEDAS Y CRECER
    # ========================================================

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

            # Aumentar el saldo.
            snake["balance_micros"] += value
            snake["collected_micros"] += value

            # Aumentar puntuación.
            snake["score"] += 1

            # Una unidad de largo por cada moneda.
            snake["grow_pending"] = (
                snake.get("grow_pending", 0) + 1
            )

            # Aumentar ligeramente el grosor.
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

    # ========================================================
    # COMER COMIDA Y CRECER
    # ========================================================

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

            # CRECIMIENTO DE LARGO.
            snake["grow_pending"] += growth
            snake["score"] += growth

            # CRECIMIENTO DE ANCHO Y ALTO.
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

    # ========================================================
    # COLISIONES
    # ========================================================

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

    # ========================================================
    # ACTUALIZAR MOVIMIENTO
    # ========================================================

    def update_snake(self, user_id: str):
        snake = self.snakes[user_id]

        if not snake.get("alive") or not snake.get("ready"):
            return

        if not snake.get("body"):
            self.kill_snake(snake)
            return

        now = time.monotonic()

        # Mientras impulsa, suelta monedas cada 0.25 segundos.
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

    # ========================================================
    # ESTADO PÚBLICO
    # ========================================================

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

                # Envía el tamaño real, reducido durante el impulso.
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

    # ========================================================
    # TRANSMITIR ESTADO
    # ========================================================

    async def broadcast(self):
        message = self.public_state()

        for uid, ws in list(self.connections.items()):
            try:
                await ws.send_json(message)
            except Exception:
                pass

    # ========================================================
    # BUCLE DEL JUEGO
    # ========================================================

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

    # ========================================================
    # ASIGNACIÓN Y RESERVA ATÓMICA
    # ========================================================

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

            # La función SQL procesa la entrada.
            # El saldo jugable devuelto se utiliza como saldo inicial.
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

    # ========================================================
    # MENSAJES DEL JUGADOR
    # ========================================================

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = str(
                data.get("type", "")
            ).upper()

            # ------------------------------------------------
            # PING
            # ------------------------------------------------

            if msg_type == "PING":
                await websocket.send_json({
                    "type": "PONG"
                })

            # ------------------------------------------------
            # READY
            # ------------------------------------------------

            elif msg_type == "READY":
                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if snake and snake["alive"]:
                        snake["ready"] = True

                await room.broadcast()

            # ------------------------------------------------
            # STEER
            # ------------------------------------------------

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
                            # Durante el retiro puede seguir girando.
                            snake["angle"] = angle

                except (ValueError, TypeError):
                    pass

            # ------------------------------------------------
            # BOOST START
            # ------------------------------------------------

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

                            # Primera moneda al comenzar el impulso.
                            snake["next_boost_coin_at"] = (
                                time.monotonic()
                            )

                await room.broadcast()

            # ------------------------------------------------
            # BOOST STOP
            # ------------------------------------------------

            elif msg_type == "BOOST_STOP":
                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if snake:
                        snake["boosting"] = False

                await room.broadcast()

            # ------------------------------------------------
            # CASH OUT
            # ------------------------------------------------

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

                        # No puede seguir impulsándose durante
                        # el proceso de retiro.
                        # Sí puede moverse y recoger monedas.
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

                    # ========================================
                    # PROCESAR RETIRO DESPUÉS DE 20 SEGUNDOS
                    # ========================================

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

                                # COMPROBAR SI EXISTE SALDO PARA RETIRAR.
                                if balance_micros <= 0:

                                    # No se mata la serpiente.
                                    # El jugador puede continuar jugando.
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

                                    # La serpiente termina su partida.
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

                        # ====================================================
                        # SI NO TIENE SALDO, NO SE PROCESA NINGÚN RETIRO.
                        # ====================================================

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

                        # ====================================================
                        # SI MURIÓ O SE CANCELÓ ANTES DE TERMINAR LOS 20 SEG.
                        # ====================================================

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

                        # ====================================================
                        # PROCESAR LIQUIDACIÓN EN SUPABASE.
                        # LA FUNCIÓN SQL CALCULA EL 6% DE COMISIÓN.
                        # EL JUGADOR RECIBE EL 94% NETO.
                        # ====================================================

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
                                    # Si falla la liquidación,
                                    # el jugador puede continuar jugando.
                                    current_snake["alive"] = True
                                    current_snake["cashed_out"] = False

                                    current_snake["cashout_pending"] = False
                                    current_snake["cashout_pending_until"] = 0
                                    current_snake["cashout_task_id"] = None

                        # ====================================================
                        # NOTIFICAR RESULTADO DEL RETIRO.
                        # ====================================================

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

    # ========================================================
    # DESCONECTAR JUGADOR
    # ========================================================

    finally:
        async with room.lock:
            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            snake = room.snakes.get(user_id)

            # Si se desconecta vivo, muere y su saldo cae
            # en monedas. Si ya retiró, no se vuelve a liquidar.
            if snake and snake.get("alive"):
                room.kill_snake(snake)

            # La sala queda disponible para nuevos jugadores.
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
# AXIOM - OPERACIONES ADMINISTRATIVAS COMPLETAS
# ============================================================

def admin_audit(admin_id, action, target_user_id=None, details=None):
    try:
        supabase.table("admin_audit_logs").insert({
            "admin_user_id": admin_id,
            "action": action,
            "target_user_id": target_user_id,
            "details": details or {}
        }).execute()
    except Exception as exc:
        print(f"ERROR auditoría administrativa: {exc!r}")


def admin_update_row(table, filters, values):
    query = supabase.table(table).update(values)
    for field, value in filters.items():
        query = query.eq(field, value)
    return query.execute()


# ============================================================
# CLIENTES: CREAR
# ============================================================

@app.post("/admin/clients")
async def admin_create_client(
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")

    if not email or not password:
        raise HTTPException(400, "Correo y contraseña son obligatorios.")

    if len(password) < 8:
        raise HTTPException(400, "La contraseña debe tener al menos 8 caracteres.")

    try:
        created = supabase.auth.admin.create_user({
            "email": email,
            "password": password,
            "email_confirm": True
        })

        auth_user = getattr(created, "user", None)
        if auth_user is None and isinstance(created, dict):
            auth_user = created.get("user")

        user_id = getattr(auth_user, "id", None)
        if not user_id and isinstance(auth_user, dict):
            user_id = auth_user.get("id")

        if not user_id:
            raise Exception("Supabase no devolvió el ID del usuario creado.")

        profile = {
            "id": user_id,
            "first_name": payload.get("first_name"),
            "middle_name": payload.get("middle_name"),
            "last_name": payload.get("last_name"),
            "second_last_name": payload.get("second_last_name"),
            "doc_type": payload.get("doc_type"),
            "doc_number": payload.get("doc_number"),
            "phone": payload.get("phone"),
            "birth_date": payload.get("birth_date"),
            "balance": 0,
            "withdraw_balance": 0,
            "bonus_balance": 0
        }

        profile = {k: v for k, v in profile.items() if v is not None}

        supabase.table("profiles").insert(profile).execute()

        admin_audit(
            admin_id,
            "client_created",
            user_id,
            {"email": email}
        )

        return {"success": True, "user_id": user_id}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR creando cliente: {exc!r}")
        raise HTTPException(500, "No se pudo crear el cliente.")


# ============================================================
# CLIENTES: EDITAR DATOS
# ============================================================

@app.put("/admin/clients/{user_id}")
async def admin_edit_client(
    user_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    allowed = {
        "first_name",
        "middle_name",
        "last_name",
        "second_last_name",
        "doc_type",
        "doc_number",
        "phone",
        "birth_date"
    }

    changes = {
        key: value
        for key, value in payload.items()
        if key in allowed
    }

    if not changes:
        raise HTTPException(400, "No hay campos válidos para actualizar.")

    try:
        response = (
            supabase.table("profiles")
            .update(changes)
            .eq("id", user_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Cliente no encontrado.")

        admin_audit(admin_id, "client_updated", user_id, changes)

        return {"success": True, "client": response.data[0]}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR editando cliente: {exc!r}")
        raise HTTPException(500, "No se pudo actualizar el cliente.")


# ============================================================
# CLIENTES: ELIMINAR
# ============================================================

@app.delete("/admin/clients/{user_id}")
async def admin_delete_client(
    user_id: str,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    if user_id == admin_id:
        raise HTTPException(400, "No puedes eliminar tu propia cuenta administrativa.")

    try:
        existing = (
            supabase.table("profiles")
            .select("id")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )

        if not existing.data:
            raise HTTPException(404, "Cliente no encontrado.")

        admin_audit(admin_id, "client_deleted", user_id, {})

        supabase.auth.admin.delete_user(user_id)

        return {"success": True}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR eliminando cliente: {exc!r}")
        raise HTTPException(
            500,
            "No se pudo eliminar el usuario. Comprueba si existen registros relacionados que impidan su eliminación."
        )


# ============================================================
# CLIENTES: MODIFICAR SALDOS
# ============================================================

@app.post("/admin/clients/{user_id}/wallet")
async def admin_adjust_client_wallet(
    user_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    wallet = payload.get("wallet")
    mode = payload.get("mode")
    amount = payload.get("amount")

    if wallet not in ("balance", "withdraw_balance", "bonus_balance"):
        raise HTTPException(400, "Billetera no válida.")

    if mode not in ("add", "subtract", "set"):
        raise HTTPException(400, "Operación no válida.")

    try:
        amount = float(amount)
        if amount < 0:
            raise ValueError()
    except (TypeError, ValueError):
        raise HTTPException(400, "Monto no válido.")

    return rpc_json(
        "admin_adjust_wallet",
        {
            "p_admin_user_id": admin_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_mode": mode,
            "p_amount": amount,
            "p_reason": payload.get("reason")
        }
    )


# ============================================================
# CLIENTES: VERIFICAR / DESVERIFICAR
# ============================================================

@app.post("/admin/clients/{user_id}/verification")
async def admin_set_client_verification(
    user_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    verified = payload.get("is_verified")
    if not isinstance(verified, bool):
        raise HTTPException(400, "is_verified debe ser verdadero o falso.")

    try:
        response = (
            supabase.table("profiles")
            .update({"is_verified": verified})
            .eq("id", user_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Cliente no encontrado.")

        admin_audit(
            admin_id,
            "client_verification_changed",
            user_id,
            {"is_verified": verified}
        )

        return {"success": True, "is_verified": verified}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR verificando cliente: {exc!r}")
        raise HTTPException(500, "No se pudo cambiar la verificación.")


# ============================================================
# CLIENTES: SUSPENDER / REACTIVAR
# ============================================================

@app.post("/admin/clients/{user_id}/suspension")
async def admin_set_client_suspension(
    user_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    suspended = payload.get("is_suspended")
    if not isinstance(suspended, bool):
        raise HTTPException(400, "is_suspended debe ser verdadero o falso.")

    if user_id == admin_id and suspended:
        raise HTTPException(400, "No puedes suspender tu propia cuenta administrativa.")

    note = payload.get("admin_status_note")

    try:
        response = (
            supabase.table("profiles")
            .update({
                "is_suspended": suspended,
                "admin_status_note": note
            })
            .eq("id", user_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Cliente no encontrado.")

        admin_audit(
            admin_id,
            "client_suspension_changed",
            user_id,
            {
                "is_suspended": suspended,
                "note": note
            }
        )

        return {"success": True, "is_suspended": suspended}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR cambiando suspensión: {exc!r}")
        raise HTTPException(500, "No se pudo cambiar el estado del cliente.")


# ============================================================
# BONOS: CREAR CÓDIGO
# ============================================================

@app.post("/admin/bonuses")
async def admin_create_bonus(
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    code = str(payload.get("code") or "").strip().upper()

    try:
        amount = float(payload.get("amount"))
        if amount <= 0:
            raise ValueError()
    except (TypeError, ValueError):
        raise HTTPException(400, "El monto del bono debe ser mayor que cero.")

    values = {
        "code": code,
        "amount": amount,
        "is_active": bool(payload.get("is_active", True)),
        "starts_at": payload.get("starts_at"),
        "expires_at": payload.get("expires_at"),
        "max_uses": payload.get("max_uses")
    }

    if not code:
        raise HTTPException(400, "El código es obligatorio.")

    if values["max_uses"] is not None:
        try:
            values["max_uses"] = int(values["max_uses"])
            if values["max_uses"] < 1:
                raise ValueError()
        except (TypeError, ValueError):
            raise HTTPException(400, "max_uses debe ser un entero positivo.")

    values = {k: v for k, v in values.items() if v is not None}

    try:
        response = supabase.table("bonus_codes").insert(values).execute()

        admin_audit(admin_id, "bonus_created", None, values)

        return {"success": True, "bonus": response.data[0]}

    except Exception as exc:
        print(f"ERROR creando bono: {exc!r}")
        raise HTTPException(500, "No se pudo crear el código de bono.")


# ============================================================
# BONOS: EDITAR
# ============================================================

@app.put("/admin/bonuses/{bonus_id}")
async def admin_edit_bonus(
    bonus_id: int,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    allowed = {
        "code",
        "amount",
        "is_active",
        "starts_at",
        "expires_at",
        "max_uses"
    }

    changes = {
        key: value
        for key, value in payload.items()
        if key in allowed
    }

    if "code" in changes:
        changes["code"] = str(changes["code"]).strip().upper()

    if "amount" in changes:
        try:
            changes["amount"] = float(changes["amount"])
            if changes["amount"] <= 0:
                raise ValueError()
        except (TypeError, ValueError):
            raise HTTPException(400, "Monto de bono no válido.")

    if "max_uses" in changes and changes["max_uses"] is not None:
        try:
            changes["max_uses"] = int(changes["max_uses"])
            if changes["max_uses"] < 1:
                raise ValueError()
        except (TypeError, ValueError):
            raise HTTPException(400, "Límite de usos no válido.")

    if not changes:
        raise HTTPException(400, "No hay cambios para guardar.")

    try:
        response = (
            supabase.table("bonus_codes")
            .update(changes)
            .eq("id", bonus_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Código no encontrado.")

        admin_audit(admin_id, "bonus_updated", None, {
            "bonus_id": bonus_id,
            "changes": changes
        })

        return {"success": True, "bonus": response.data[0]}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR editando bono: {exc!r}")
        raise HTTPException(500, "No se pudo actualizar el bono.")


# ============================================================
# BONOS: ACTIVAR / DESACTIVAR
# ============================================================

@app.post("/admin/bonuses/{bonus_id}/status")
async def admin_set_bonus_status(
    bonus_id: int,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    active = payload.get("is_active")
    if not isinstance(active, bool):
        raise HTTPException(400, "is_active debe ser verdadero o falso.")

    try:
        response = (
            supabase.table("bonus_codes")
            .update({"is_active": active})
            .eq("id", bonus_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Código no encontrado.")

        admin_audit(
            admin_id,
            "bonus_status_changed",
            None,
            {"bonus_id": bonus_id, "is_active": active}
        )

        return {"success": True, "is_active": active}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR cambiando estado del bono: {exc!r}")
        raise HTTPException(500, "No se pudo cambiar el estado del bono.")


# ============================================================
# BONOS: ELIMINAR
# ============================================================

@app.delete("/admin/bonuses/{bonus_id}")
async def admin_delete_bonus(
    bonus_id: int,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    try:
        used = (
            supabase.table("bonus_redemptions")
            .select("id")
            .eq("bonus_code_id", bonus_id)
            .limit(1)
            .execute()
        )

        if used.data:
            raise HTTPException(
                409,
                "Este bono ya tiene redenciones. Desactívalo en lugar de eliminarlo."
            )

        response = (
            supabase.table("bonus_codes")
            .delete()
            .eq("id", bonus_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Código no encontrado.")

        admin_audit(
            admin_id,
            "bonus_deleted",
            None,
            {"bonus_id": bonus_id}
        )

        return {"success": True}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR eliminando bono: {exc!r}")
        raise HTTPException(500, "No se pudo eliminar el bono.")


# ============================================================
# REFERIDOS: CAMBIAR REFERENTE DE UN CLIENTE
# ============================================================

@app.put("/admin/referrals/{user_id}")
async def admin_change_referrer(
    user_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    referrer_id = payload.get("referred_by")

    if referrer_id == user_id:
        raise HTTPException(400, "Un cliente no puede referirse a sí mismo.")

    try:
        if referrer_id:
            referrer = (
                supabase.table("profiles")
                .select("id")
                .eq("id", referrer_id)
                .limit(1)
                .execute()
            )

            if not referrer.data:
                raise HTTPException(404, "El referente no existe.")

        response = (
            supabase.table("profiles")
            .update({"referred_by": referrer_id})
            .eq("id", user_id)
            .execute()
        )

        if not response.data:
            raise HTTPException(404, "Cliente no encontrado.")

        admin_audit(
            admin_id,
            "referral_changed",
            user_id,
            {"referred_by": referrer_id}
        )

        return {"success": True, "referred_by": referrer_id}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR cambiando referido: {exc!r}")
        raise HTTPException(500, "No se pudo actualizar el referente.")


# ============================================================
# DEPÓSITOS: APROBAR / RECHAZAR
# ============================================================

@app.post("/admin/deposits/{deposit_id}/approve")
async def admin_approve_deposit(
    deposit_id: int,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    return rpc_json(
        "admin_confirm_deposit",
        {
            "p_admin_user_id": admin_id,
            "p_deposit_id": deposit_id,
            "p_admin_note": payload.get("admin_note")
        }
    )


@app.post("/admin/deposits/{deposit_id}/reject")
async def admin_reject_deposit(
    deposit_id: int,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    return rpc_json(
        "admin_reject_deposit",
        {
            "p_admin_user_id": admin_id,
            "p_deposit_id": deposit_id,
            "p_admin_note": payload.get("admin_note")
        }
    )


# ============================================================
# RETIROS: APROBAR / RECHAZAR / COMPLETAR
# ============================================================

@app.post("/admin/withdrawals/{withdrawal_id}/approve")
async def admin_approve_withdrawal(
    withdrawal_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    return rpc_json(
        "admin_approve_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": payload.get("admin_note")
        }
    )


@app.post("/admin/withdrawals/{withdrawal_id}/reject")
async def admin_reject_withdrawal(
    withdrawal_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    return rpc_json(
        "admin_reject_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": payload.get("admin_note")
        }
    )


@app.post("/admin/withdrawals/{withdrawal_id}/complete")
async def admin_complete_withdrawal(
    withdrawal_id: str,
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    return rpc_json(
        "admin_complete_withdrawal",
        {
            "p_admin_user_id": admin_id,
            "p_withdrawal_id": withdrawal_id,
            "p_admin_note": payload.get("admin_note")
        }
    )


# ============================================================
# FINANZAS: CONSULTAR ESTADÍSTICAS
# ============================================================

@app.get("/admin/finance")
async def admin_finance(
    date_from: str | None = None,
    date_to: str | None = None,
    game: str | None = None,
    referrer_id: str | None = None,
    authorization: str | None = Header(default=None)
):
    require_admin(authorization)

    try:
        resets = (
            supabase.table("admin_finance_resets")
            .select("reset_at")
            .order("reset_at", desc=True)
            .limit(1)
            .execute()
        )

        reset_at = resets.data[0]["reset_at"] if resets.data else None

        commissions = admin_table_data(
            "comisiones",
            """
            id,user_id,room_id,game,monto_retiro,porcentaje,
            comision,monto_jugador,transaction_key,created_at,
            referente_id,comision_referente,comision_axiom
            """,
            10000
        )

        deposits = admin_table_data(
            "deposit_requests",
            "id,user_id,amount,status,created_at",
            10000
        )

        withdrawals = admin_table_data(
            "withdrawal_requests",
            "id,user_id,amount,net_amount,status,created_at,completed_at",
            10000
        )

        bets = admin_table_data(
            "game_bet_debits",
            "transaction_key,room_id,user_id,wallet,amount,created_at",
            10000
        )

        payouts = admin_table_data(
            "game_payouts",
            "room_id,winner_user_id,amount,created_at",
            10000
        )

        def in_period(row):
            created = str(row.get("created_at") or "")
            if reset_at and created < str(reset_at):
                return False
            if date_from and created[:10] < date_from[:10]:
                return False
            if date_to and created[:10] > date_to[:10]:
                return False
            return True

        commissions = [x for x in commissions if in_period(x)]
        deposits = [x for x in deposits if in_period(x)]
        withdrawals = [x for x in withdrawals if in_period(x)]
        bets = [x for x in bets if in_period(x)]
        payouts = [x for x in payouts if in_period(x)]

        if game:
            commissions = [
                x for x in commissions
                if str(x.get("game") or "").lower() == game.lower()
            ]

        if referrer_id:
            commissions = [
                x for x in commissions
                if str(x.get("referente_id") or "") == referrer_id
            ]

        axiom_income = sum(
            float(x.get("comision_axiom") or 0)
            for x in commissions
        )

        referral_commissions = sum(
            float(x.get("comision_referente") or 0)
            for x in commissions
        )

        total_commissions = sum(
            float(x.get("comision") or 0)
            for x in commissions
        )

        total_bets = sum(float(x.get("amount") or 0) for x in bets)
        total_payouts = sum(float(x.get("amount") or 0) for x in payouts)

        confirmed_deposits = sum(
            float(x.get("amount") or 0)
            for x in deposits
            if str(x.get("status") or "").lower() in ("confirmado", "approved", "completed")
        )

        completed_withdrawals = sum(
            float(x.get("net_amount") or x.get("amount") or 0)
            for x in withdrawals
            if str(x.get("status") or "").lower() in ("completado", "completed")
        )

        return {
            "success": True,
            "reset_at": reset_at,
            "filters": {
                "date_from": date_from,
                "date_to": date_to,
                "game": game,
                "referrer_id": referrer_id
            },
            "income": {
                "axiom_commissions": round(axiom_income, 2),
                "referral_commissions": round(referral_commissions, 2),
                "total_commissions": round(total_commissions, 2),
                "deposits": round(confirmed_deposits, 2)
            },
            "outflows": {
                "payouts": round(total_payouts, 2),
                "completed_withdrawals": round(completed_withdrawals, 2),
                "referral_commissions": round(referral_commissions, 2)
            },
            "totals": {
                "bets": round(total_bets, 2),
                "payouts": round(total_payouts, 2),
                "deposits": round(confirmed_deposits, 2),
                "withdrawals": round(completed_withdrawals, 2),
                "axiom_income": round(axiom_income, 2),
                "referral_commissions": round(referral_commissions, 2),
                "net_axiom_commissions": round(axiom_income, 2)
            }
        }

    except HTTPException:
        raise
    except Exception as exc:
        print(f"ERROR estadísticas financieras: {exc!r}")
        raise HTTPException(500, "No se pudieron calcular las estadísticas financieras.")


# ============================================================
# FINANZAS: REINICIAR ESTADÍSTICAS SIN BORRAR HISTORIAL
# ============================================================

@app.post("/admin/finance/reset")
async def admin_reset_finance(
    payload: dict,
    authorization: str | None = Header(default=None)
):
    admin_id = require_admin(authorization)

    confirmation = str(payload.get("confirmation") or "").strip().upper()
    if confirmation != "REINICIAR":
        raise HTTPException(
            400,
            "Escribe REINICIAR para confirmar el reinicio de estadísticas."
        )

    try:
        response = supabase.table("admin_finance_resets").insert({
            "admin_user_id": admin_id
        }).execute()

        reset = response.data[0]

        admin_audit(
            admin_id,
            "finance_statistics_reset",
            None,
            {
                "reset_at": reset.get("reset_at"),
                "history_deleted": False
            }
        )

        return {
            "success": True,
            "reset_at": reset.get("reset_at"),
            "history_deleted": False
        }

    except Exception as exc:
        print(f"ERROR reiniciando estadísticas: {exc!r}")
        raise HTTPException(500, "No se pudieron reiniciar las estadísticas.")