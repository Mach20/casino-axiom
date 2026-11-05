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
        return bool(result.get("success")), str(result.get("message", "No se pudo descontar el saldo."))
    except Exception as exc:
        print(f"ERROR debit_game_balance: {exc!r}")
        return False, "No se pudo descontar la apuesta."


def credit_winner(user_id: str, prize: float, room_id: str):
    try:
        result = rpc_json("credit_game_winner", {
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_amount": round(float(prize), 2),
        })
        return bool(result.get("success")), str(result.get("message", "No se pudo acreditar el premio."))
    except Exception as exc:
        print(f"ERROR credit_game_winner: {exc!r}")
        return False, "No se pudo acreditar el premio."


@app.websocket("/ws/lobby")
async def lobby_endpoint(websocket: WebSocket, user_id: str = Query(""), access_token: str = Query("")):
    await websocket.accept()
    manager.active_connections.setdefault("lobby", []).append(websocket)
    await manager.broadcast_lobby()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "CREATE_ROOM":
                continue
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in manager.active_connections.get("lobby", []):
            manager.active_connections["lobby"].remove(websocket)


@app.websocket("/ws/game/{room_id}")
async def game_endpoint(websocket: WebSocket, room_id: str, password: str = Query(""), wallet: str = Query("play"), user_id: str = Query(""), access_token: str = Query("")):
    await websocket.accept()
    await websocket.close()


class SnakeRoom:
    def __init__(self, room_id: str, bet_amount: float):
        self.room_id = room_id
        self.bet_amount = bet_amount
        self.connections: Dict[str, WebSocket] = {}
        self.snakes: Dict[str, dict] = {}
        self.foods = [{"x": random.randint(50, 1850), "y": random.randint(50, 1000)} for _ in range(60)]
        self.is_running = False

    async def broadcast(self, message: dict):
        for ws in list(self.connections.values()):
            try:
                await ws.send_json(message)
            except Exception:
                pass

    async def game_loop(self):
        self.is_running = True
        while self.is_running and len(self.connections) > 0:
            for uid, snake in self.snakes.items():
                if not snake["alive"]:
                    continue

                if not snake.get("ready", False):
                    spawn_x = 960
                    spawn_y = 540
                    snake["body"] = [{"x": spawn_x - (i * 10), "y": spawn_y} for i in range(8)]
                    snake["alive"] = True  # Forzar que nazca vivo y inmune antes del READY
                    continue

                head = snake["body"][0]
                angle = snake.get("angle", 0)
                speed = 4.0

                new_x = head["x"] + math.cos(angle) * speed
                new_y = head["y"] + math.sin(angle) * speed

                if new_x < 0 or new_x > 1920 or new_y < 0 or new_y > 1080:
                    snake["alive"] = False
                    continue

                new_head = {"x": new_x, "y": new_y}
                snake["body"].insert(0, new_head)

                eaten = False
                for food in self.foods[:]:
                    if math.hypot(new_x - food["x"], new_y - food["y"]) < 18:
                        self.foods.remove(food)
                        self.foods.append({"x": random.randint(50, 1850), "y": random.randint(50, 1000)})
                        snake["score"] += 1
                        eaten = True
                        break

                if not eaten:
                    snake["body"].pop()

                for other_uid, other_snake in self.snakes.items():
                    if not other_snake["alive"] or other_uid == uid:
                        continue
                    for segment in other_snake["body"][2:]:
                        if math.hypot(new_x - segment["x"], new_y - segment["y"]) < 14:
                            snake["alive"] = False
                            break

            await self.broadcast({
                "type": "GAME_STATE",
                "snakes": self.snakes,
                "foods": self.foods
            })
            await asyncio.sleep(0.033)


@app.websocket("/ws/snake/{room_id}")
async def snake_game_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str = Query(""),
    access_token: str = Query(""),
    bet: float = Query(1.00),
    wallet: str = Query("play"),
    color: str = Query("#34d399")
):
    await websocket.accept()

    if not user_id:
        await websocket.send_json({"type": "ERROR", "message": "Identificador de usuario faltante."})
        await websocket.close()
        return

    success, message = deduct_balance(user_id, bet, wallet, room_id, f"snake:{room_id}:{user_id}:{random.randint(1000,9999)}")
    if not success:
        await websocket.send_json({"type": "ERROR", "message": message})
        await websocket.close()
        return

    if room_id not in snake_rooms:
        snake_rooms[room_id] = SnakeRoom(room_id, bet)

    room = snake_rooms[room_id]
    room.connections[user_id] = websocket

    spawn_x = 960
    spawn_y = 540
    
    room.snakes[user_id] = {
        "body": [{"x": spawn_x - (i * 10), "y": spawn_y} for i in range(8)],
        "angle": 0,
        "score": 0,
        "color": color,
        "wallet": wallet,
        "alive": True,
        "ready": False
    }

    if not room.is_running:
        asyncio.create_task(room.game_loop())

    try:
        await websocket.send_json({
            "type": "GAME_STATE",
            "snakes": room.snakes,
            "foods": room.foods
        })
    except Exception as e:
        print(f"Error al enviar estado inicial: {e}")

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "READY":
                if user_id in room.snakes:
                    room.snakes[user_id]["ready"] = True

            elif msg_type == "STEER":
                if user_id in room.snakes and room.snakes[user_id]["alive"] and room.snakes[user_id]["ready"]:
                    room.snakes[user_id]["angle"] = data.get("angle", 0)

            elif msg_type == "CASH_OUT":
                if user_id in room.snakes and room.snakes[user_id]["alive"]:
                    snake = room.snakes[user_id]
                    snake["alive"] = False
                    earned_prize = round(room.bet_amount + (snake["score"] * 0.05), 2)
                    credit_winner(user_id, earned_prize, room_id)
                    await websocket.send_json({"type": "CASHOUT_SUCCESS", "payout": earned_prize})

    except WebSocketDisconnect:
        if user_id in room.connections:
            del room.connections[user_id]
        if user_id in room.snakes:
            room.snakes[user_id]["alive"] = False
        if len(room.connections) == 0:
            room.is_running = False
            snake_rooms.pop(room_id, None)
