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
                        continue
                    idx = data.get("index")
                    symbol = data.get("symbol")
                    if not isinstance(idx, int) or idx < 0 or idx > 8:
                        continue
                    expected_symbol = "X" if room["players"][0]["ws"] is websocket else "O"
                    if symbol != expected_symbol or room["turn"] != expected_symbol or room["board"][idx] is not None:
                        continue

                    room["board"][idx] = expected_symbol
                    room["turn"] = "O" if expected_symbol == "X" else "X"
                    winning_lines = [
                        [0, 1, 2], [3, 4, 5], [6, 7, 8],
                        [0, 3, 6], [1, 4, 7], [2, 5, 8],
                        [0, 4, 8], [2, 4, 6],
                    ]
                    winner_symbol = next((room["board"][a] for a, b, c in winning_lines
                                          if room["board"][a] and room["board"][a] == room["board"][b] == room["board"][c]), None)
                    draw = winner_symbol is None and all(cell is not None for cell in room["board"])
                    total_pot = round(room["bet"] * 2, 2)
                    commission = 0.02 if total_pot < 0.25 else round(total_pot * 0.05, 2)
                    net_prize = round(total_pot - commission, 2)

                    if winner_symbol or draw:
                        room["finished"] = True
                        room["settled"] = True
                        if winner_symbol:
                            winner_index = 0 if winner_symbol == "X" else 1
                            winner_uid = room["players"][winner_index]["user_id"]
                            paid, payout_message = credit_winner(winner_uid, net_prize, room_id)
                            if not paid:
                                print(f"ALERTA: partida {room_id} terminó pero el premio no se acreditó: {payout_message}")
                        else:
                            refund_results = []
                            for player in room["players"]:
                                key = f"create:{room_id}:{player['user_id']}" if player["user_id"] == room["creator_user_id"] else f"join:{room_id}:{player['user_id']}"
                                try:
                                    refund_results.append(rpc_json("refund_game_bet", {"p_transaction_key": key}))
                                except Exception as exc:
                                    refund_results.append({"success": False, "message": str(exc)})
                            print(f"EMPATE {room_id}, devoluciones: {refund_results}")

                    outcome_payload = {
                        "type": "MOVE_MADE", "index": idx, "symbol": expected_symbol,
                        "board": room["board"], "next_turn": room["turn"],
                        "net_prize": net_prize, "commission": commission,
                        "winner": winner_symbol, "draw": draw,
                    }

                for player in list(room["players"]):
                    try:
                        await player["ws"].send_json(outcome_payload)
                        if outcome_payload["winner"] or outcome_payload["draw"]:
                            await player["ws"].send_json({
                                "type": "GAME_SETTLED",
                                "winner": outcome_payload["winner"],
                                "draw": outcome_payload["draw"],
                                "net_prize": outcome_payload["net_prize"],
                            })
                    except Exception:
                        pass

            elif data.get("type") == "CLOSE_ROOM":
                if is_host:
                    async with lock:
                        room["finished"] = True
                        for player in list(room["players"]):
                            try:
                                await player["ws"].send_json({"type": "ROOM_CLOSED_BY_HOST"})
                                await player["ws"].close()
                            except Exception:
                                pass
                        lobbies.pop(room_id, None)
                        room_locks.pop(room_id, None)
                    await manager.broadcast_lobby()
                    break

    except WebSocketDisconnect:
        async with lock:
            room["players"] = [p for p in room["players"] if p["ws"] is not websocket]
            if len(room["players"]) == 0 and not room.get("started"):
                lobbies.pop(room_id, None)
                room_locks.pop(room_id, None)
        await manager.broadcast_lobby()


# ==========================================
# ENDPOINT DE SNAKE ARENA (NUEVO Y COMPLETO)
# ==========================================

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
                    if not other_snake["alive"]:
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

    spawn_x = random.randint(200, 1600)
    spawn_y = random.randint(200, 800)
    room.snakes[user_id] = {
        "body": [{"x": spawn_x - (i * 10), "y": spawn_y} for i in range(8)],
        "angle": 0,
        "score": 0,
        "color": color,
        "wallet": wallet,
        "alive": True
    }

    if not room.is_running:
        asyncio.create_task(room.game_loop())

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "STEER":
                if user_id in room.snakes and room.snakes[user_id]["alive"]:
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
