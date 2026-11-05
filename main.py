import os
import random
import asyncio
import math
from typing import Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from supabase import create_client, Client

app = FastAPI(title="AXIOM Game Backend")

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, dict] = {}


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
            for room_id, room in lobbies.items()
            if len(room["players"]) < 2 and not room.get("finished", False)
        ]
        for ws in list(self.active_connections.get("lobby", [])):
            try:
                await ws.send_json({"type": "LOBBY_UPDATE", "rooms": room_list})
            except Exception:
                pass


manager = GameManager()


def verify_user_token(access_token: str, expected_user_id: str) -> bool:
    """Comprueba el JWT de Supabase antes de aceptar operaciones de dinero."""
    if not access_token or not expected_user_id:
        return False
    try:
        response = supabase.auth.get_user(access_token)
        authenticated_user = getattr(response, "user", None)
        return bool(authenticated_user and str(authenticated_user.id) == str(expected_user_id))
    except Exception as exc:
        print(f"ERROR verificando token Supabase: {exc!r}")
        return False


def rpc_json(name: str, params: dict) -> dict:
    """Ejecuta una función SQL y normaliza la respuesta JSON de Supabase."""
    response = supabase.rpc(name, params).execute()
    result = response.data
    if isinstance(result, list) and result:
        result = result[0]
    if not isinstance(result, dict):
        raise RuntimeError(f"Respuesta inesperada de la función SQL {name}: {result!r}")
    return result


def deduct_balance(user_id: str, bet: float, wallet: str, room_id: str, transaction_key: str):
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
        print(f"DEBIT {transaction_key}: {result}")
        return bool(result.get("success")), str(result.get("message", "No se pudo descontar el saldo."))
    except Exception as exc:
        print(f"ERROR debit_game_balance: {exc!r}")
        return False, "No se pudo descontar la apuesta. Revisa la configuración SQL y los registros del servidor."


def credit_winner(user_id: str, prize: float, room_id: str):
    try:
        result = rpc_json("credit_game_winner", {
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_amount": round(float(prize), 2),
        })
        print(f"PAYOUT {room_id}: {result}")
        return bool(result.get("success")), str(result.get("message", "No se pudo acreditar el premio."))
    except Exception as exc:
        print(f"ERROR credit_game_winner: {exc!r}")
        return False, "No se pudo acreditar el premio en saldo retirable."


def refund_player(room_id: str, user_id: str):
    try:
        result = rpc_json("refund_game_bet", {"p_transaction_key": f"join:{room_id}:{user_id}"})
        print(f"REFUND join:{room_id}:{user_id}: {result}")
        return bool(result.get("success")), str(result.get("message", "No se pudo devolver la apuesta."))
    except Exception as exc:
        print(f"ERROR refund jugador {user_id}: {exc!r}")
        return False, "No se pudo devolver la apuesta."


# ==========================================
# ENDPOINTS DE X VS O (INTACTOS)
# ==========================================

@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query(""),
):
    await websocket.accept()
    manager.active_connections.setdefault("lobby", []).append(websocket)
    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "CREATE_ROOM":
                continue

            try:
                bet = round(float(data.get("bet", 0)), 2)
            except (TypeError, ValueError):
                await websocket.send_json({"type": "ERROR", "message": "La apuesta no es válida."})
                continue

            wallet = data.get("wallet", "play")
            creator_uid = data.get("user_id") or user_id
            if creator_uid != user_id or not verify_user_token(access_token, creator_uid):
                await websocket.send_json({"type": "ERROR", "message": "Tu sesión no es válida. Cierra sesión y vuelve a entrar."})
                continue
            if bet < 0.10:
                await websocket.send_json({"type": "ERROR", "message": "La apuesta mínima es de $0.10."})
                continue
            if wallet not in ("play", "bonus"):
                await websocket.send_json({"type": "ERROR", "message": "Tipo de saldo no válido."})
                continue
            if not creator_uid:
                await websocket.send_json({"type": "ERROR", "message": "No se identificó tu usuario. Cierra sesión y vuelve a entrar."})
                continue

            room_id = f"room_{random.randint(10000, 99999)}_{random.randint(100, 999)}"
            success, message = deduct_balance(
                creator_uid, bet, wallet, room_id, f"create:{room_id}:{creator_uid}"
            )
            if not success:
                await websocket.send_json({"type": "ERROR", "message": message})
                continue

            is_public = bool(data.get("is_public", True))
            password = "" if is_public else str(data.get("password", ""))
            if not is_public and not password.strip():
                try:
                    rpc_json("refund_game_bet", {"p_transaction_key": f"create:{room_id}:{creator_uid}"})
                except Exception as exc:
                    print(f"ERROR devolviendo apuesta de sala inválida: {exc!r}")
                await websocket.send_json({"type": "ERROR", "message": "Debes establecer una contraseña para la sala privada."})
                continue

            lobbies[room_id] = {
                "creator": str(data.get("creator") or "Jugador"),
                "creator_user_id": creator_uid,
                "creator_wallet": wallet,
                "bet": bet,
                "is_public": is_public,
                "password": password,
                "players": [],
                "board": [None] * 9,
                "turn": "X",
                "settled": False,
                "finished": False,
            }
            room_locks[room_id] = asyncio.Lock()
            print(f"SALA CREADA {room_id}: creador={creator_uid}, apuesta={bet}, cartera={wallet}")
            await manager.broadcast_lobby()
            await websocket.send_json({"type": "ROOM_CREATED", "room_id": room_id, "password": password})

    except WebSocketDisconnect:
        pass
    finally:
        if websocket in manager.active_connections.get("lobby", []):
            manager.active_connections["lobby"].remove(websocket)


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
    if not verify_user_token(access_token, user_id):
        await websocket.send_json({"type": "ERROR", "message": "Tu sesión no es válida. Vuelve a iniciar sesión."})
        await websocket.close()
        return
    room = lobbies.get(room_id)
    if not room:
        await websocket.send_json({"type": "ERROR", "message": "La sala no existe o ya fue cerrada."})
        await websocket.close()
        return

    lock = room_locks.setdefault(room_id, asyncio.Lock())
    async with lock:
        if room["finished"] or len(room["players"]) >= 2:
            await websocket.send_json({"type": "ERROR", "message": "La sala ya está llena o finalizada."})
            await websocket.close()
            return

        joining_second = len(room["players"]) == 1
        if joining_second:
            if not room["is_public"] and room["password"] and password != room["password"]:
                await websocket.send_json({"type": "ERROR", "message": "Contraseña incorrecta."})
                await websocket.close()
                return
            if not user_id:
                await websocket.send_json({"type": "ERROR", "message": "No se recibió el ID de tu usuario."})
                await websocket.close()
                return
            if user_id == room["creator_user_id"]:
                await websocket.send_json({"type": "ERROR", "message": "No puedes unirte a tu propia sala con la misma cuenta."})
                await websocket.close()
                return
            if wallet not in ("play", "bonus"):
                await websocket.send_json({"type": "ERROR", "message": "Tipo de saldo no válido."})
                await websocket.close()
                return

            success, message = deduct_balance(
                user_id, room["bet"], wallet, room_id, f"join:{room_id}:{user_id}"
            )
            if not success:
                await websocket.send_json({"type": "ERROR", "message": message})
                await websocket.close()
                return
        else:
            if user_id != room["creator_user_id"]:
                await websocket.send_json({"type": "ERROR", "message": "Esta sala está reservada para quien la creó."})
                await websocket.close()
                return
            wallet = room["creator_wallet"]

        player = {"ws": websocket, "user_id": user_id, "wallet": wallet}
        room["players"].append(player)
        player_index = len(room["players"]) - 1
        is_host = player_index == 0
        player_symbol = "X" if is_host else "O"

    await manager.broadcast_lobby()
    await websocket.send_json({
        "type": "INIT", "symbol": player_symbol, "is_host": is_host,
        "board": room["board"], "turn": room["turn"], "bet": room["bet"],
    })
    if len(room["players"]) == 2:
        room["started"] = True
        for player in room["players"]:
            try:
                await player["ws"].send_json({"type": "START", "turn": room["turn"]})
            except Exception:
                pass

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "MOVE":
                outcome_payload = None
                async with lock:
                    if room["finished"] or len(room["players"]) != 2:
