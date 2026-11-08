import os
import random
import asyncio
import math
import time
import uuid
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from supabase import create_client, Client

app = FastAPI(title="AXIOM Game Backend")

# ============================================================
# SUPABASE
# ============================================================

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"


if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Falta configurar SUPABASE_SERVICE_ROLE_KEY.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)

lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, object] = {}


# ============================================================
# ADMINISTRADOR
# ============================================================

class GameManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def broadcast_lobby(self):
        rooms = [
            {
                "room_id": room_id,
                "creator": room["creator"],
                "bet": room["bet"],
                "is_public": room["is_public"],
                "players_count": len(room["players"]),
            }
            for room_id, room in lobbies.items()
            if (
                not room.get("finished")
                and room.get("is_public")
                and len(room["players"]) < 2
            )
        ]

        for ws in list(self.active_connections.get("lobby", [])):
            try:
                await ws.send_json({
                    "type": "LOBBY_UPDATE",
                    "rooms": rooms
                })
            except Exception:
                pass


manager = GameManager()


# ============================================================
# FUNCIONES GENERALES
# ============================================================

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
        print(f"ERROR verificando token: {exc!r}")
        return False


def rpc_json(name: str, params: dict) -> dict:
    response = supabase.rpc(name, params).execute()
    result = response.data

    if isinstance(result, list) and result:
        result = result[0]

    if not isinstance(result, dict):
        raise RuntimeError(
            f"Respuesta inesperada de {name}: {result!r}"
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
        return False, "Billetera no válida."

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


def settle_xo_match(
    room_id: str,
    result_type: str,
    players: list,
    winner_id: Optional[str] = None,
    abandoner_id: Optional[str] = None
):
    try:
        result = rpc_json("settle_xo_match", {
            "p_transaction_key": f"xo-settlement:{room_id}",
            "p_room_id": room_id,
            "p_result": result_type,
            "p_winner_id": winner_id,
            "p_abandoner_id": abandoner_id,
            "p_players": players,
        })

        return (
            bool(result.get("success")),
            str(result.get("message", "No se pudo liquidar la partida."))
        )

    except Exception as exc:
        print(f"ERROR liquidando XvO: {exc!r}")
        return False, "Error al liquidar la partida."


async def send_error(websocket: WebSocket, message: str):
    try:
        await websocket.send_json({
            "type": "ERROR",
            "message": message
        })
    except Exception:
        pass


# ============================================================
# X VS O
# ============================================================

def create_xo_player(
    user_id: str,
    wallet: str,
    bet: float,
    creator: str
):
    return {
        "user_id": user_id,
        "wallet": wallet,
        "bet": bet,
        "creator": creator,
        "symbol": None,
        "connected": False,
        "websocket": None,
    }


def xo_check_winner(board: list):
    combinations = [
        (0, 1, 2), (3, 4, 5), (6, 7, 8),
        (0, 3, 6), (1, 4, 7), (2, 5, 8),
        (0, 4, 8), (2, 4, 6),
    ]

    for a, b, c in combinations:
        if board[a] and board[a] == board[b] == board[c]:
            return board[a]

    if all(board):
        return "DRAW"

    return None


async def broadcast_xo_room(room: dict):
    message = {
        "type": "GAME_STATE",
        "board": room["board"],
        "turn": room["turn"],
        "status": room["status"],
    }

    for player in room["players"].values():
        ws = player.get("websocket")
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                pass


async def finish_xo_room(
    room_id: str,
    result_type: str,
    winner_id: Optional[str] = None,
    abandoner_id: Optional[str] = None
):
    room = lobbies.get(room_id)
    if not room:
        return False

    lock = room_locks[room_id]

    async with lock:
        if room.get("finished") or room.get("settling"):
            return False

        if len(room["players"]) != 2:
            return False

        room["settling"] = True

        players = [
            {
                "user_id": p["user_id"],
                "wallet": p["wallet"],
                "bet": p["bet"],
            }
            for p in room["players"].values()
        ]

    paid, message = settle_xo_match(
        room_id=room_id,
        result_type=result_type,
        players=players,
        winner_id=winner_id,
        abandoner_id=abandoner_id,
    )

    async with lock:
        if not paid:
            room["settling"] = False
            for player in room["players"].values():
                ws = player.get("websocket")
                if ws:
                    await send_error(ws, message)
            return False

        room["finished"] = True
        room["settling"] = False
        room["status"] = "FINISHED"

        for player in room["players"].values():
            ws = player.get("websocket")
            if ws:
                try:
                    await ws.send_json({
                        "type": "GAME_FINISHED",
                        "result": result_type,
                        "winner_id": winner_id,
                        "abandoner_id": abandoner_id,
                    })
                except Exception:
                    pass

    await manager.broadcast_lobby()
    return True


@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query("")
):
    await websocket.accept()

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "Tu sesión no es válida.")
        await websocket.close()
        return

    manager.active_connections.setdefault("lobby", []).append(websocket)
    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") != "CREATE_ROOM":
                continue

            if str(data.get("user_id", "")) != str(user_id):
                await send_error(websocket, "Usuario no autorizado.")
                continue

            wallet = data.get("wallet", "play")
            if wallet not in ("play", "bonus"):
                await send_error(websocket, "Billetera no válida.")
                continue

            try:
                bet = round(float(data.get("bet", 0)), 2)
            except (ValueError, TypeError):
                await send_error(websocket, "Apuesta incorrecta.")
                continue

            if not math.isfinite(bet) or bet < 0.10 or bet > 10000:
                await send_error(websocket, "La apuesta mínima es $0.10.")
                continue

            if any(
                user_id in r["players"] and not r.get("finished")
                for r in lobbies.values()
            ):
                await send_error(websocket, "Ya tienes una partida activa.")
                continue

            room_id = uuid.uuid4().hex[:12]

            success, message = deduct_balance(
                user_id,
                bet,
                wallet,
                room_id,
                f"xo-entry:{room_id}:{user_id}"
            )

            if not success:
                await send_error(websocket, message)
                continue

            creator = str(data.get("creator") or "Jugador")[:40]
            is_public = bool(data.get("is_public", True))
            password = str(data.get("password") or "")

            player = create_xo_player(user_id, wallet, bet, creator)

            lobbies[room_id] = {
                "room_id": room_id,
                "creator": creator,
                "bet": bet,
                "is_public": is_public,
                "password": password,
                "players": {user_id: player},
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
        if websocket in manager.active_connections.get("lobby", []):
            manager.active_connections["lobby"].remove(websocket)


@app.websocket("/ws/game/{room_id}")
async def game_endpoint(
    websocket: WebSocket,
    room_id: str,
    password: str = Query(""),
    wallet: str = Query("play"),
    user_id: str = Query(""),
    access_token: str = Query("")
):
    await websocket.accept()

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "La sesión no es válida.")
        await websocket.close()
        return

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    room = lobbies.get(room_id)
    if not room or room.get("finished"):
        await send_error(websocket, "La sala no existe o terminó.")
        await websocket.close()
        return

    lock = room_locks[room_id]

    async with lock:
        if room.get("finished"):
            await send_error(websocket, "La partida ya terminó.")
            await websocket.close()
            return

        if room["password"] and room["password"] != password:
            await send_error(websocket, "Contraseña incorrecta.")
            await websocket.close()
            return

        player = room["players"].get(user_id)

        if player and player.get("connected"):
            await send_error(websocket, "Ya tienes una conexión activa.")
            await websocket.close()
            return

        if not player:
            if len(room["players"]) >= 2:
                await send_error(websocket, "La sala está llena.")
                await websocket.close()
                return

            if any(
                user_id in r["players"] and not r.get("finished")
                for r in lobbies.values()
            ):
                await send_error(websocket, "Ya tienes otra partida activa.")
                await websocket.close()
                return

            bet = float(room["bet"])
            success, message = deduct_balance(
                user_id, bet, wallet, room_id,
                f"xo-entry:{room_id}:{user_id}"
            )

            if not success:
                await send_error(websocket, message)
                await websocket.close()
                return

            player = create_xo_player(user_id, wallet, bet, "Jugador")
            room["players"][user_id] = player

        player["connected"] = True
        player["websocket"] = websocket

        if len(room["players"]) == 2:
            players = list(room["players"].values())
            players[0]["symbol"] = "X"
            players[1]["symbol"] = "O"
            room["status"] = "PLAYING"

        symbol = player["symbol"]

        await websocket.send_json({
            "type": "INIT",
            "room_id": room_id,
            "symbol": symbol,
            "isHost": user_id == next(iter(room["players"])),
            "board": room["board"],
            "turn": room["turn"],
            "status": room["status"],
            "bet": room["bet"],
            "players_count": len(room["players"]),
        })

        if room["status"] == "PLAYING":
            for p in room["players"].values():
                ws = p.get("websocket")
                if ws:
                    try:
                        await ws.send_json({
                            "type": "START",
                            "board": room["board"],
                            "turn": room["turn"],
                        })
                    except Exception:
                        pass

    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type in ("MOVE", "MAKE_MOVE", "PLAY"):
                async with lock:
                    if room.get("finished") or room["status"] != "PLAYING":
                        continue

                    if room["turn"] != player["symbol"]:
                        await send_error(websocket, "No es tu turno.")
                        continue

                    try:
                        position = int(
                            data.get(
                                "index",
                                data.get("position", data.get("cell", -1))
                            )
                        )
                    except (ValueError, TypeError):
                        continue

                    if position < 0 or position > 8:
                        continue

                    if room["board"][position] is not None:
                        await send_error(websocket, "Casilla ocupada.")
                        continue

                    symbol = player["symbol"]
                    room["board"][position] = symbol
                    winner_symbol = xo_check_winner(room["board"])
                    room["turn"] = "O" if symbol == "X" else "X"

                    message = {
                        "type": "MOVE_MADE",
                        "board": room["board"],
                        "turn": room["turn"],
                        "position": position,
                        "symbol": symbol,
                    }

                    for p in room["players"].values():
                        ws = p.get("websocket")
                        if ws:
                            try:
                                await ws.send_json(message)
                            except Exception:
                                pass

                    if winner_symbol == "DRAW":
                        room["status"] = "FINISHED"
                        result_type = "draw"
                        winner_id = None
                    elif winner_symbol in ("X", "O"):
                        winner_id = next(
                            uid for uid, p in room["players"].items()
                            if p["symbol"] == winner_symbol
                        )
                        room["status"] = "FINISHED"
                        result_type = "win"
                    else:
                        continue

                paid = await finish_xo_room(
                    room_id, result_type, winner_id=winner_id
                )
                if not paid:
                    room["status"] = "PLAYING"

            elif msg_type in ("LEAVE", "CLOSE_ROOM", "ABANDON"):
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR XvO {room_id}: {exc!r}")
    finally:
        should_abandon = False
        abandoner_id = None
        winner_id = None

        async with lock:
            current_player = room["players"].get(user_id)

            if current_player and current_player.get("websocket") is websocket:
                current_player["connected"] = False
                current_player["websocket"] = None

                if not room.get("finished") and not room.get("settling"):
                    abandoner_id = user_id
                    other_ids = [
                        uid for uid in room["players"] if uid != user_id
                    ]
                    if len(other_ids) == 1:
                        winner_id = other_ids[0]
                    should_abandon = True

        if should_abandon:
            if winner_id:
                await finish_xo_room(
                    room_id, "abandon",
                    winner_id=winner_id,
                    abandoner_id=abandoner_id
                )
            else:
                await refund_xo_creator(room_id, abandoner_id)

        await manager.broadcast_lobby()


async def refund_xo_creator(room_id: str, user_id: str):
    room = lobbies.get(room_id)
    if not room:
        return

    lock = room_locks[room_id]

    async with lock:
        if room.get("finished") or room.get("settling"):
            return

        player = room["players"].get(user_id)
        if not player:
            return

        room["settling"] = True
        players = [{
            "user_id": player["user_id"],
            "wallet": player["wallet"],
            "bet": player["bet"],
        }]

    paid, message = settle_xo_match(room_id, "cancel", players)

    async with lock:
        if paid:
            room["finished"] = True
            room["status"] = "FINISHED"
        else:
            room["settling"] = False
            ws = player.get("websocket")
            if ws:
                await send_error(ws, message)


# ============================================================
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 20000
WORLD_HEIGHT = 20000

SNAKE_SPEED = 7.5
SNAKE_BOOST_SPEED = 20.0

SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16
COIN_VALUE_MICROS = 100_000

INITIAL_BALANCE_MICROS = 1_000_000

BOOST_COST_MICROS = 100_000
BOOST_COIN_INTERVAL = 0.5

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 5000
FOOD_GROWTH_PER_ITEM = 3

FOOD_CELL_SIZE = 300
FOOD_VIEW_RADIUS = 1800

FOOD_COLORS = [
    "#ff3b30", "#ff9500", "#ffcc00", "#34c759",
    "#00c7be", "#32ade6", "#007aff", "#af52de",
    "#ff2d55", "#ffffff",
]


def money_from_micros(value: int) -> float:
    return round(int(value) / 1_000_000, 2)


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
# SALAS SNAKE
# ============================================================

class SnakeRoom:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.connections: Dict[str, WebSocket] = {}
        self.snakes: Dict[str, dict] = {}
        self.foods: List[dict] = []
        self.coins: List[dict] = []
        self.food_grid: Dict[tuple, list] = {}
        self.consumed_food_ids = set()
        self.is_running = False
        self.lock = asyncio.Lock()
        self.spawn_food(FOOD_INITIAL_COUNT)
        self.rebuild_food_grid()

    def food_cell(self, x: float, y: float):
        return (int(x // FOOD_CELL_SIZE), int(y // FOOD_CELL_SIZE))

    def rebuild_food_grid(self):
        grid = {}
        for food in self.foods:
            if food["id"] in self.consumed_food_ids:
                continue
            cell = self.food_cell(food["x"], food["y"])
            grid.setdefault(cell, []).append(food)
        self.food_grid = grid

    def add_food_to_grid(self, food: dict):
        cell = self.food_cell(food["x"], food["y"])
        self.food_grid.setdefault(cell, []).append(food)

    def get_food_near(self, x: float, y: float, radius: float):
        min_cell_x = int((x - radius) // FOOD_CELL_SIZE)
        max_cell_x = int((x + radius) // FOOD_CELL_SIZE)
        min_cell_y = int((y - radius) // FOOD_CELL_SIZE)
        max_cell_y = int((y + radius) // FOOD_CELL_SIZE)

        for cell_x in range(min_cell_x, max_cell_x + 1):
            for cell_y in range(min_cell_y, max_cell_y + 1):
                for food in self.food_grid.get((cell_x, cell_y), []):
                    if food["id"] in self.consumed_food_ids:
                        continue
                    if (
                        abs(food["x"] - x) <= radius
                        and abs(food["y"] - y) <= radius
                    ):
                        yield food

    def nearby_foods_for_players(self):
        visible = {}
        for snake in self.snakes.values():
            if not snake.get("alive"):
                continue
            body = snake.get("body", [])
            if not body:
                continue
            head = body[0]
            for food in self.get_food_near(
                head["x"], head["y"], FOOD_VIEW_RADIUS
            ):
                visible[food["id"]] = food
        return list(visible.values())

    def spawn_food(self, amount: int = 1):
        for _ in range(amount):
            self.foods.append({
                "id": f"food_{uuid.uuid4().hex}",
                "x": random.uniform(25, WORLD_WIDTH - 25),
                "y": random.uniform(25, WORLD_HEIGHT - 25),
                "color": random.choice(FOOD_COLORS),
                "radius": FOOD_RADIUS,
                "growth": 1,
            })

    def spawn_coin(self, x: float, y: float, value_micros: int):
        angle = random.uniform(0, math.pi * 2)
        distance = random.uniform(20, 70)
        coin_x = max(
            COIN_RADIUS,
            min(WORLD_WIDTH - COIN_RADIUS, x + math.cos(angle) * distance)
        )
        coin_y = max(
            COIN_RADIUS,
            min(WORLD_HEIGHT - COIN_RADIUS, y + math.sin(angle) * distance)
        )
        self.coins.append({
            "id": f"coin_{uuid.uuid4().hex}",
            "x": coin_x,
            "y": coin_y,
            "value_micros": int(value_micros),
            "value": money_from_micros(value_micros),
        })

    def create_spawn(self):
        positions = [
            (2000, 2000, 0),
            (18000, 18000, math.pi),
            (18000, 2000, math.pi),
            (2000, 18000, 0),
            (10000, 3000, math.pi / 2),
            (10000, 17000, -math.pi / 2),
        ]
        occupied = [
            (s["body"][0]["x"], s["body"][0]["y"])
            for s in self.snakes.values()
            if s.get("alive") and s.get("body")
        ]
        available = [
            (x, y, angle) for x, y, angle in positions
            if all(math.hypot(x - ox, y - oy) > 180 for ox, oy in occupied)
        ]
        if available:
            return random.choice(available)

        for _ in range(100):
            x = random.uniform(150, WORLD_WIDTH - 150)
            y = random.uniform(150, WORLD_HEIGHT - 150)
            if all(
                math.hypot(x - ox, y - oy) > 180
                for ox, oy in occupied
            ):
                return x, y, random.uniform(-math.pi, math.pi)

        return (
            WORLD_WIDTH / 2,
            WORLD_HEIGHT / 2,
            random.uniform(-math.pi, math.pi)
        )

    def add_snake(
        self, user_id: str, bet: float, wallet: str,
        color: str, session_id: str
    ):
        x, y, angle = self.create_spawn()
        self.snakes[user_id] = {
            "session_id": session_id,
            "body": create_snake_body(x, y, angle),
            "angle": angle,
            "score": 0,
            "kills": 0,
            "color": safe_color(color),
            "wallet": wallet,
            "bet": bet,
            "balance_micros": INITIAL_BALANCE_MICROS,
            "entry_remaining_micros": INITIAL_BALANCE_MICROS,
            "collected_micros": 0,
            "earned_micros": 0,
            "earned": 0.0,
            "balance": 1.00,
            "alive": True,
            "ready": False,
            "cashed_out": False,
            "boosting": False,
            "next_boost_coin_at": 0.0,
            "boost_spent_micros": 0,
            "grow_pending": 0,
            "food_eaten": 0,
            "created_at": time.time(),
        }

    def update_balance(self, snake: dict):
        balance = max(0, int(snake.get("balance_micros", 0)))
        snake["balance_micros"] = balance
        snake["balance"] = money_from_micros(balance)
        earned = max(0, int(snake.get("collected_micros", 0)))
        snake["earned_micros"] = earned
        snake["earned"] = money_from_micros(earned)

    def drop_food(self, snake: dict):
        body = snake.get("body", [])
        if not body:
            return
        food_eaten = max(0, int(snake.get("food_eaten", 0)))
        amount_to_drop = food_eaten // 2
        if amount_to_drop <= 0:
            return

        for i in range(amount_to_drop):
            body_index = min(
                len(body) - 1,
                int((i / max(1, amount_to_drop)) * len(body))
            )
            segment = body[body_index]
            angle = random.uniform(0, math.pi * 2)
            distance = random.uniform(15, 65)
            x = max(
                25,
                min(
                    WORLD_WIDTH - 25,
                    segment["x"] + math.cos(angle) * distance
                )
            )
            y = max(
                25,
                min(
                    WORLD_HEIGHT - 25,
                    segment["y"] + math.sin(angle) * distance
                )
            )
            food = {
                "id": f"food_{uuid.uuid4().hex}",
                "x": x,
                "y": y,
                "color": random.choice(FOOD_COLORS),
                "radius": FOOD_RADIUS,
                "growth": FOOD_GROWTH_PER_ITEM,
            }
            self.foods.append(food)
            self.add_food_to_grid(food)

    def drop_coins(self, snake: dict):
        balance = max(0, int(snake.get("balance_micros", 0)))
        body = snake.get("body", [])

        if balance <= 0 or not body:
            snake["balance_micros"] = 0
            snake["entry_remaining_micros"] = 0
            self.update_balance(snake)
            return

        tail = body[-1]
        remaining = balance

        while remaining > 0:
            value = min(COIN_VALUE_MICROS, remaining)
            self.spawn_coin(tail["x"], tail["y"], value)
            remaining -= value

        snake["balance_micros"] = 0
        snake["entry_remaining_micros"] = 0
        self.update_balance(snake)

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return
        snake["alive"] = False
        snake["boosting"] = False
        snake["ready"] = False
        self.drop_food(snake)
        self.drop_coins(snake)

    def consume_food(self, snake: dict):
        if not snake.get("alive") or not snake.get("body"):
            return
        head = snake["body"][0]
        eaten = []

        for food in self.get_food_near(
            head["x"], head["y"], FOOD_RADIUS + 15
        ):
            distance = math.hypot(
                head["x"] - food["x"], head["y"] - food["y"]
            )
            if distance <= FOOD_RADIUS + 12:
                eaten.append(food)

        if not eaten:
            return

        for food in eaten:
            self.consumed_food_ids.add(food["id"])
            snake["food_eaten"] += 1
            snake["score"] += 1
            snake["grow_pending"] += FOOD_GROWTH_PER_ITEM

        if len(self.consumed_food_ids) > 10000:
            self.foods = [
                food for food in self.foods
                if food["id"] not in self.consumed_food_ids
            ]
            self.consumed_food_ids.clear()
            self.rebuild_food_grid()

    def consume_coins(self, snake: dict):
        if not snake.get("alive") or not snake.get("body"):
            return
        head = snake["body"][0]
        remaining = []

        for coin in self.coins:
            distance = math.hypot(
                head["x"] - coin["x"], head["y"] - coin["y"]
            )
            if distance <= COIN_RADIUS + 18:
                value = max(0, int(coin.get("value_micros", 0)))
                snake["balance_micros"] += value
                snake["collected_micros"] += value
                snake["score"] += 1
                self.update_balance(snake)
            else:
                remaining.append(coin)

        self.coins = remaining

    def move_snake(self, snake: dict, delta_time: float):
        if not snake.get("alive") or not snake.get("ready"):
            return
        body = snake.get("body", [])
        if not body:
            return

        angle = float(snake.get("angle", 0))
        speed = SNAKE_BOOST_SPEED if snake.get("boosting") else SNAKE_SPEED
        distance = speed * delta_time * 30
        head = body[0]
        new_x = head["x"] + math.cos(angle) * distance
        new_y = head["y"] + math.sin(angle) * distance

        if (
            new_x < 10 or new_y < 10
            or new_x > WORLD_WIDTH - 10
            or new_y > WORLD_HEIGHT - 10
        ):
            self.kill_snake(snake)
            return

        path = [{"x": new_x, "y": new_y}] + body
        pending_growth = max(0, int(snake.get("grow_pending", 0)))
        target_length = len(body) + pending_growth
        new_body = [{"x": new_x, "y": new_y}]
        path_index = 0
        accumulated_distance = 0.0

        for segment_index in range(1, target_length):
            target_distance = segment_index * SNAKE_SEGMENT_DISTANCE
            found = False

            while path_index < len(path) - 1:
                point_a = path[path_index]
                point_b = path[path_index + 1]
                segment_distance = math.hypot(
                    point_b["x"] - point_a["x"],
                    point_b["y"] - point_a["y"]
                )

                if segment_distance <= 0:
                    path_index += 1
                    accumulated_distance = 0.0
                    continue

                next_accumulated = accumulated_distance + segment_distance

                if next_accumulated >= target_distance:
                    distance_from_a = target_distance - accumulated_distance
                    ratio = distance_from_a / segment_distance
                    ratio = max(0.0, min(1.0, ratio))
                    new_body.append({
                        "x": point_a["x"] + (
                            point_b["x"] - point_a["x"]
                        ) * ratio,
                        "y": point_a["y"] + (
                            point_b["y"] - point_a["y"]
                        ) * ratio,
                    })
                    found = True
                    break

                accumulated_distance = next_accumulated
                path_index += 1

            if not found:
                last = new_body[-1]
                if len(new_body) >= 2:
                    previous = new_body[-2]
                    dx = last["x"] - previous["x"]
                    dy = last["y"] - previous["y"]
                    length = math.hypot(dx, dy)
                    if length > 0:
                        dx /= length
                        dy /= length
                    else:
                        dx = -math.cos(angle)
                        dy = -math.sin(angle)
                else:
                    dx = -math.cos(angle)
                    dy = -math.sin(angle)

                new_body.append({
                    "x": last["x"] + dx * SNAKE_SEGMENT_DISTANCE,
                    "y": last["y"] + dy * SNAKE_SEGMENT_DISTANCE,
                })

        snake["body"] = new_body
        snake["grow_pending"] = 0
        self.consume_food(snake)
        self.consume_coins(snake)

    def check_collisions(self):
        alive_snakes = [
            (user_id, snake)
            for user_id, snake in self.snakes.items()
            if snake.get("alive") and snake.get("ready") and snake.get("body")
        ]

        for user_id, snake in alive_snakes:
            if not snake.get("alive"):
                continue
            head = snake["body"][0]

            for segment in snake["body"][10:]:
                if math.hypot(
                    head["x"] - segment["x"],
                    head["y"] - segment["y"]
                ) < 9:
                    self.kill_snake(snake)
                    break

            if not snake.get("alive"):
                continue

            for other_id, other in alive_snakes:
                if user_id == other_id or not other.get("alive"):
                    continue
                other_body = other.get("body", [])
                if not other_body:
                    continue

                for segment in other_body[1:]:
                    if math.hypot(
                        head["x"] - segment["x"],
                        head["y"] - segment["y"]
                    ) < 12:
                        self.kill_snake(snake)
                        if other.get("alive"):
                            other["kills"] += 1
                            other["score"] += 5
                        break

                if not snake.get("alive"):
                    break

    def process_boost(self, snake: dict):
        if not snake.get("alive") or not snake.get("boosting"):
            return
        now = time.time()
        if now < snake.get("next_boost_coin_at", 0):
            return

        balance = int(snake.get("balance_micros", 0))
        if balance < BOOST_COST_MICROS:
            snake["boosting"] = False
            return

        snake["balance_micros"] -= BOOST_COST_MICROS
        snake["boost_spent_micros"] += BOOST_COST_MICROS
        snake["next_boost_coin_at"] = now + BOOST_COIN_INTERVAL

        body = snake.get("body", [])
        if body:
            tail = body[-1]
            self.spawn_coin(tail["x"], tail["y"], BOOST_COST_MICROS)

        self.update_balance(snake)

    def get_game_state(self):
        snakes_data = {}
        for user_id, snake in self.snakes.items():
            snakes_data[user_id] = {
                "user_id": user_id,
                "body": snake["body"],
                "angle": snake["angle"],
                "score": snake["score"],
                "kills": snake["kills"],
                "color": snake["color"],
                "alive": snake["alive"],
                "ready": snake["ready"],
                "boosting": snake["boosting"],
                "balance": money_from_micros(snake["balance_micros"]),
                "balance_micros": snake["balance_micros"],
                "earned": money_from_micros(snake["collected_micros"]),
                "wallet": snake["wallet"],
            }

        return {
            "type": "GAME_STATE",
            "room_id": self.room_id,
            "world": {"width": WORLD_WIDTH, "height": WORLD_HEIGHT},
            "snakes": snakes_data,
            "foods": self.nearby_foods_for_players(),
            "coins": self.coins,
            "players_count": len([
                s for s in self.snakes.values() if s.get("alive")
            ]),
        }

    async def broadcast(self):
        if not self.connections:
            return
        state = self.get_game_state()
        disconnected = []

        for user_id, websocket in list(self.connections.items()):
            try:
                await websocket.send_json(state)
            except Exception:
                disconnected.append(user_id)

        for user_id in disconnected:
            self.connections.pop(user_id, None)

    async def game_loop(self):
        if self.is_running:
            return
        self.is_running = True
        previous_time = time.monotonic()

        try:
            while self.is_running:
                start = time.monotonic()
                delta_time = min(start - previous_time, 0.1)
                previous_time = start

                async with self.lock:
                    for snake in list(self.snakes.values()):
                        self.process_boost(snake)
                        self.move_snake(snake, delta_time)

                    self.check_collisions()

                    active_food_count = (
                        len(self.foods) - len(self.consumed_food_ids)
                    )
                    if active_food_count < FOOD_INITIAL_COUNT:
                        missing = min(100, FOOD_INITIAL_COUNT - active_food_count)
                        self.spawn_food(missing)
                        self.rebuild_food_grid()

                    await self.broadcast()

                elapsed = time.monotonic() - start
                await asyncio.sleep(max(0, GAME_TICK - elapsed))

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"ERROR en game_loop Snake {self.room_id}: {exc!r}")
        finally:
            self.is_running = False


# ============================================================
# COMISIONES SNAKE
# ============================================================

def registrar_comision_snake(
    user_id: str,
    room_id: str,
    monto_retiro: float,
    transaction_key: str
):
    monto_retiro = round(max(0, float(monto_retiro)), 2)
    porcentaje = 5.00
    comision = round(monto_retiro * 0.05, 2)
    monto_jugador = round(monto_retiro - comision, 2)

    try:
        registro = {
            "user_id": user_id,
            "room_id": room_id,
            "game": "snake",
            "monto_retiro": monto_retiro,
            "porcentaje": porcentaje,
            "comision": comision,
            "monto_jugador": monto_jugador,
            "transaction_key": transaction_key,
        }
        supabase.table("comisiones").upsert(
            registro,
            on_conflict="transaction_key",
            ignore_duplicates=True
        ).execute()
        return True
    except Exception as exc:
        print(f"ERROR registrando comisión Snake: {exc!r}")
        return False


# ============================================================
# OBTENER O CREAR SALA SNAKE
# ============================================================

def get_snake_room(room_id: str) -> SnakeRoom:
    if room_id not in snake_rooms:
        snake_rooms[room_id] = SnakeRoom(room_id)
    return snake_rooms[room_id]


# ============================================================
# ENDPOINT PRINCIPAL SNAKE
# ============================================================

@app.websocket("/ws/snake/{room_id}")
async def snake_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str = Query(""),
    access_token: str = Query(""),
    bet: float = Query(1.00),
    wallet: str = Query("play"),
    color: str = Query("#34d399"),
):
    await websocket.accept()

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "Tu sesión no es válida.")
        await websocket.close()
        return

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    try:
        bet = round(float(bet), 2)
    except (ValueError, TypeError):
        await send_error(websocket, "La apuesta no es válida.")
        await websocket.close()
        return

    if not math.isfinite(bet) or bet != 1.00:
        await send_error(websocket, "La entrada a Snake es de $1.00.")
        await websocket.close()
        return

    if not room_id or len(room_id) > 100:
        await send_error(websocket, "Sala no válida.")
        await websocket.close()
        return

    room = get_snake_room(room_id)
    session_id = uuid.uuid4().hex

    async with room.lock:
        existing = room.snakes.get(user_id)
        if existing and existing.get("alive"):
            await send_error(
                websocket,
                "Ya tienes una serpiente activa en esta sala."
            )
            await websocket.close()
            return

        active_elsewhere = any(
            uid == user_id and snake.get("alive")
            for other_room in snake_rooms.values()
            for uid, snake in other_room.snakes.items()
        )
        if active_elsewhere:
            await send_error(websocket, "Ya tienes una partida Snake activa.")
            await websocket.close()
            return

        transaction_key = f"snake-entry:{room_id}:{user_id}:{session_id}"
        success, message = deduct_balance(
            user_id, bet, wallet, room_id, transaction_key
        )
        if not success:
            await send_error(websocket, message)
            await websocket.close()
            return

        room.add_snake(user_id, bet, wallet, color, session_id)
        room.connections[user_id] = websocket
        snake = room.snakes[user_id]

    try:
        await websocket.send_json(room.get_game_state())
        if not room.is_running:
            asyncio.create_task(room.game_loop())
        await room.broadcast()

        while True:
            data = await websocket.receive_json()
            msg_type = str(data.get("type", "")).upper()
            should_close_connection = False

            async with room.lock:
                current = room.snakes.get(user_id)
                if not current or current.get("session_id") != session_id:
                    await send_error(
                        websocket,
                        "Esta sesión de Snake ya no está activa."
                    )
                    break

                if msg_type == "PING":
                    await websocket.send_json({"type": "PONG"})
                    continue

                if msg_type == "READY":
                    if current.get("alive"):
                        current["ready"] = True

                elif msg_type == "STEER":
                    if not current.get("alive"):
                        continue
                    try:
                        angle = float(data.get("angle", 0))
                    except (ValueError, TypeError):
                        continue
                    if math.isfinite(angle):
                        current["angle"] = angle

                elif msg_type == "BOOST_START":
                    if current.get("alive"):
                        current["boosting"] = True

                elif msg_type == "BOOST_STOP":
                    current["boosting"] = False

                elif msg_type in ("CASH_OUT", "CASHOUT"):
                    if not current.get("alive") or current.get("cashed_out"):
                        await send_error(
                            websocket,
                            "No puedes retirar en este momento."
                        )
                        continue

                    current["boosting"] = False
                    gross_micros = max(
                        0, int(current.get("balance_micros", 0))
                    )
                    gross = money_from_micros(gross_micros)

                    if gross <= 0:
                        await send_error(websocket, "No tienes saldo para retirar.")
                        continue

                    commission = round(gross * 0.05, 2)
                    payout = round(gross - commission, 2)
                    cashout_key = (
                        f"snake-cashout:{room_id}:{user_id}:"
                        f"{current['session_id']}"
                    )

                    current["cashed_out"] = True
                    current["alive"] = False
                    current["balance_micros"] = 0
                    room.update_balance(current)

                    paid, payment_message = settle_snake_cashout(
                        user_id=user_id,
                        room_id=room_id,
                        wallet=current["wallet"],
                        refund=0,
                        payout=payout,
                        transaction_key=cashout_key
                    )

                    if not paid:
                        current["cashed_out"] = False
                        current["alive"] = True
                        current["balance_micros"] = gross_micros
                        room.update_balance(current)
                        await send_error(websocket, payment_message)
                        continue

                    commission_saved = registrar_comision_snake(
                        user_id=user_id,
                        room_id=room_id,
                        monto_retiro=gross,
                        transaction_key=f"{cashout_key}:commission"
                    )

                    await websocket.send_json({
                        "type": "CASHOUT_SUCCESS",
                        "amount": payout,
                        "payout": payout,
                        "gross": gross,
                        "commission": commission,
                        "wallet": current["wallet"],
                        "commission_registered": commission_saved,
                    })

                    if room.connections.get(user_id) is websocket:
                        room.connections.pop(user_id, None)
                    should_close_connection = True

                elif msg_type == "LEAVE":
                    current["boosting"] = False
                    room.kill_snake(current)
                    should_close_connection = True

                else:
                    continue

            await room.broadcast()
            if should_close_connection:
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")
        try:
            await send_error(websocket, "Ocurrió un error en la partida.")
        except Exception:
            pass
    finally:
        async with room.lock:
            current = room.snakes.get(user_id)
            if current and current.get("session_id") == session_id:
                if room.connections.get(user_id) is websocket:
                    room.connections.pop(user_id, None)
                if current.get("alive") and not current.get("cashed_out"):
                    room.kill_snake(current)
        await room.broadcast()


# ============================================================
# RUTAS DE SALUD
# ============================================================

@app.get("/")
async def root():
    return {
        "status": "online",
        "name": "AXIOM Game Backend",
        "games": ["xo", "snake", "billar"],
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "snake_rooms": len(snake_rooms),
        "xo_rooms": len(lobbies),
        "billar_rooms": len(BILLAR_ROOMS),
        "billar_waiting_rooms": (
            len(billar_lobby_rooms())
            if "billar_lobby_rooms" in globals()
            else 0
        ),
    }


# ============================================================
# BILLAR 8 BALL
# ============================================================

BILLAR_ROOMS: Dict[str, dict] = {}
BILLAR_LOCKS: Dict[str, asyncio.Lock] = {}
BILLAR_WIDTH = 1200
BILLAR_HEIGHT = 600
BILLAR_BALL_RADIUS = 12
BILLAR_FRICTION = 0.985
BILLAR_STOP_SPEED = 0.12
BILLAR_POCKET_RADIUS = 27
BILLAR_TICK = 1 / 60

BILLAR_POCKETS = [
    (0, 0),
    (BILLAR_WIDTH / 2, 0),
    (BILLAR_WIDTH, 0),
    (0, BILLAR_HEIGHT),
    (BILLAR_WIDTH / 2, BILLAR_HEIGHT),
    (BILLAR_WIDTH, BILLAR_HEIGHT),
]


def billar_create_balls():
    balls = [{
        "id": 0,
        "number": 0,
        "kind": "cue",
        "x": 300.0,
        "y": BILLAR_HEIGHT / 2,
        "vx": 0.0,
        "vy": 0.0,
        "pocketed": False,
    }]

    rack = [
        1, 9, 2, 10, 8,
        3, 11, 4, 12, 5,
        13, 6, 14, 7, 15,
    ]

    start_x = 850.0
    start_y = BILLAR_HEIGHT / 2
    spacing = BILLAR_BALL_RADIUS * 2 + 1
    index = 0

    for row in range(5):
        for column in range(row + 1):
            number = rack[index]
            index += 1

            if number == 8:
                kind = "eight"
            elif 1 <= number <= 7:
                kind = "solid"
            else:
                kind = "stripe"

            balls.append({
                "id": number,
                "number": number,
                "kind": kind,
                "x": start_x + row * spacing * 0.866,
                "y": start_y + (column - row / 2) * spacing,
                "vx": 0.0,
                "vy": 0.0,
                "pocketed": False,
            })

    return balls


def billar_public_state(room):
    return {
        "type": "BILLAR_STATE",
        "room_id": room["room_id"],
        "status": room["status"],
        "players": [
            {
                "user_id": p["user_id"],
                "name": p["name"],
                "wallet": p["wallet"],
                "group": p.get("group"),
                "connected": p.get("connected", False),
            }
            for p in room["players"].values()
        ],
        "turn": room["turn"],
        "balls": [
            {
                "id": b["id"],
                "number": b["number"],
                "kind": b["kind"],
                "x": round(b["x"], 2),
                "y": round(b["y"], 2),
                "pocketed": b["pocketed"],
            }
            for b in room["balls"]
        ],
        "winner_id": room.get("winner_id"),
        "message": room.get("message", ""),
        "ball_in_hand": room.get("ball_in_hand", False),
        "table": {
            "width": BILLAR_WIDTH,
            "height": BILLAR_HEIGHT,
            "pockets": BILLAR_POCKETS,
            "ball_radius": BILLAR_BALL_RADIUS,
        },
    }


async def billar_broadcast(room):
    message = billar_public_state(room)
    for player in room["players"].values():
        ws = player.get("websocket")
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                pass


# ============================================================
# DESCONTAR APUESTA DE BILLAR DIRECTAMENTE DE PROFILES
# ============================================================

def billar_deduct_balance(
    user_id: str,
    bet: float,
    wallet: str,
    room_id: str,
    transaction_key: str
):
    """
    Descuenta únicamente la apuesta.
    La comisión del 5% está incluida dentro de esa apuesta.
    No utiliza la RPC debit_game_balance.
    """

    if not user_id:
        return False, "No se recibió el ID del usuario."

    if wallet not in ("play", "bonus"):
        return False, "Billetera no válida."

    try:
        bet = round(float(bet), 2)

        if not math.isfinite(bet) or bet <= 0:
            return False, "La apuesta no es válida."

        commission_key = f"billar-commission:{room_id}:{user_id}"

        # Evitar cobrar otra vez una entrada ya registrada.
        existing = (
            supabase.table("comisiones")
            .select("transaction_key")
            .eq("transaction_key", commission_key)
            .limit(1)
            .execute()
        )

        if existing.data:
            return True, "Apuesta previamente descontada."

        column = "balance" if wallet == "play" else "bonus_balance"

        # Actualización condicional para evitar sobrescribir
        # un saldo que haya cambiado simultáneamente.
        for _ in range(5):
            response = (
                supabase.table("profiles")
                .select(f"id,{column}")
                .eq("id", user_id)
                .limit(1)
                .execute()
            )

            if not response.data:
                return False, "No se encontró el perfil del usuario."

            current = round(float(response.data[0].get(column) or 0), 2)

            if current < bet:
                return False, "No tienes saldo suficiente para esta apuesta."

            new_balance = round(current - bet, 2)

            updated = (
                supabase.table("profiles")
                .update({column: new_balance})
                .eq("id", user_id)
                .eq(column, current)
                .select("id")
                .execute()
            )

            if updated.data:
                return True, "Apuesta descontada correctamente."

        return False, "No se pudo actualizar el saldo. Inténtalo nuevamente."

    except Exception as exc:
        print(f"ERROR descontando saldo Billar: {exc!r}")
        return False, "Error al descontar la apuesta de Billar."


def billar_register_commission(
    user_id: str,
    room_id: str,
    bet: float,
    transaction_key: str
):
    bet = round(float(bet), 2)
    commission = round(bet * 0.05, 2)

    try:
        supabase.table("comisiones").upsert(
            {
                "user_id": user_id,
                "room_id": room_id,
                "game": "billar",
                "monto_retiro": bet,
                "porcentaje": 5.00,
                "comision": commission,
                "monto_jugador": round(bet - commission, 2),
                "transaction_key": transaction_key,
            },
            on_conflict="transaction_key",
            ignore_duplicates=True,
        ).execute()

        return True

    except Exception as exc:
        print(f"ERROR registrando comisión Billar: {exc!r}")
        return False


def billar_settle(
    room_id: str,
    result_type: str,
    players: list,
    winner_id: Optional[str] = None,
):
    """
    La comisión del 5% se descuenta de cada apuesta.
    Dos apuestas de $1.00 generan un pozo neto de $1.90.
    """

    room = BILLAR_ROOMS.get(room_id)
    if not room:
        return False, "La sala de billar no existe."

    bet = float(room["bet"])

    # Cada jugador aporta el 95% de su apuesta al pozo.
    # El ganador recibe las dos aportaciones netas.
    payout = round((bet - round(bet * 0.05, 2)) * 2, 2)

    try:
        result = rpc_json("settle_billar_match", {
            "p_transaction_key": f"billar-settlement:{room_id}",
            "p_room_id": room_id,
            "p_result": result_type,
            "p_winner_id": winner_id,
            "p_payout_amount": payout if winner_id else 0,
            "p_players": players,
        })

        return (
            bool(result.get("success")),
            str(result.get("message", "Liquidación completada.")),
        )

    except Exception as exc:
        print(f"ERROR liquidando Billar: {exc!r}")
        return False, "No se pudo liquidar la partida de billar."


def billar_create_room(room_id, user_id, wallet, bet, name):
    return {
        "room_id": room_id,
        "bet": bet,
        "status": "WAITING",
        "creator": name,
        "is_public": True,
        "password": "",
        "players": {
            user_id: {
                "user_id": user_id,
                "wallet": wallet,
                "bet": bet,
                "name": name,
                "websocket": None,
                "connected": False,
                "group": None,
            }
        },
        "balls": billar_create_balls(),
        "turn": user_id,
        "shot_in_progress": False,
        "ball_in_hand": False,
        "winner_id": None,
        "message": "Esperando al segundo jugador.",
        "finished": False,
        "settling": False,
        "created_at": time.time(),
    }


def billar_all_stopped(room):
    return all(
        b["pocketed"] or (
            abs(b["vx"]) < BILLAR_STOP_SPEED
            and abs(b["vy"]) < BILLAR_STOP_SPEED
        )
        for b in room["balls"]
    )


def billar_pocket_ball(ball):
    ball["pocketed"] = True
    ball["vx"] = 0.0
    ball["vy"] = 0.0


def billar_simulate_physics(room):
    balls = room["balls"]
    pocketed_this_shot = []

    for ball in balls:
        if ball["pocketed"]:
            continue

        ball["x"] += ball["vx"]
        ball["y"] += ball["vy"]
        ball["vx"] *= BILLAR_FRICTION
        ball["vy"] *= BILLAR_FRICTION

        if abs(ball["vx"]) < BILLAR_STOP_SPEED:
            ball["vx"] = 0.0
        if abs(ball["vy"]) < BILLAR_STOP_SPEED:
            ball["vy"] = 0.0

        for px, py in BILLAR_POCKETS:
            if math.hypot(ball["x"] - px, ball["y"] - py) < BILLAR_POCKET_RADIUS:
                billar_pocket_ball(ball)
                pocketed_this_shot.append(ball["number"])
                break

        if ball["pocketed"]:
            continue

        radius = BILLAR_BALL_RADIUS

        if ball["x"] < radius:
            ball["x"] = radius
            ball["vx"] = abs(ball["vx"])
        elif ball["x"] > BILLAR_WIDTH - radius:
            ball["x"] = BILLAR_WIDTH - radius
            ball["vx"] = -abs(ball["vx"])

        if ball["y"] < radius:
            ball["y"] = radius
            ball["vy"] = abs(ball["vy"])
        elif ball["y"] > BILLAR_HEIGHT - radius:
            ball["y"] = BILLAR_HEIGHT - radius
            ball["vy"] = -abs(ball["vy"])

    for i in range(len(balls)):
        a = balls[i]
        if a["pocketed"]:
            continue

        for j in range(i + 1, len(balls)):
            b = balls[j]
            if b["pocketed"]:
                continue

            dx = b["x"] - a["x"]
            dy = b["y"] - a["y"]
            distance = math.hypot(dx, dy)
            minimum = BILLAR_BALL_RADIUS * 2

            if distance <= 0 or distance >= minimum:
                continue

            nx = dx / distance
            ny = dy / distance
            overlap = minimum - distance

            a["x"] -= nx * overlap / 2
            a["y"] -= ny * overlap / 2
            b["x"] += nx * overlap / 2
            b["y"] += ny * overlap / 2

            relative_velocity = (
                (a["vx"] - b["vx"]) * nx
                + (a["vy"] - b["vy"]) * ny
            )

            if relative_velocity > 0:
                impulse = relative_velocity
                a["vx"] -= impulse * nx
                a["vy"] -= impulse * ny
                b["vx"] += impulse * nx
                b["vy"] += impulse * ny

    return pocketed_this_shot


def billar_player_group_remaining(room, player_id):
    player = room["players"][player_id]
    group = player.get("group")

    if group not in ("solid", "stripe"):
        return 7

    return sum(
        1 for ball in room["balls"]
        if not ball["pocketed"] and ball["kind"] == group
    )


async def billar_finish(
    room_id: str,
    result_type: str,
    winner_id: Optional[str] = None,
):
    room = BILLAR_ROOMS.get(room_id)
    if not room:
        return False

    lock = BILLAR_LOCKS[room_id]

    async with lock:
        if room["finished"] or room["settling"]:
            return False

        room["settling"] = True
        players = [
            {
                "user_id": p["user_id"],
                "wallet": p["wallet"],
                "bet": p["bet"],
            }
            for p in room["players"].values()
        ]

    paid, message = billar_settle(
        room_id, result_type, players, winner_id
    )

    async with lock:
        if not paid:
            room["settling"] = False
            room["message"] = message
            await billar_broadcast(room)
            return False

        room["finished"] = True
        room["settling"] = False
        room["status"] = "FINISHED"
        room["winner_id"] = winner_id
        room["message"] = (
            "Partida finalizada. Ganador: " + str(winner_id)
            if winner_id else "Partida finalizada."
        )
        await billar_broadcast(room)

    try:
        supabase.table("billar").update({
            "estado": "finalizada",
            "ganador_id": winner_id,
            "resultado": result_type,
            "liquidacion_realizada": True,
            "finalizada_en": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
            ),
        }).eq("room_id", room_id).execute()
    except Exception as exc:
        print(f"ERROR actualizando sala Billar: {exc!r}")

    await billar_broadcast_lobby()
    return True


async def billar_shot(room, user_id, angle, power):
    if room["status"] != "PLAYING" or room["finished"]:
        return False, "La partida no está disponible."
    if room["shot_in_progress"]:
        return False, "Las bolas todavía están en movimiento."
    if room["turn"] != user_id:
        return False, "No es tu turno."
    if not math.isfinite(angle) or not math.isfinite(power):
        return False, "El tiro no es válido."

    power = max(0.0, min(100.0, power))
    if power < 1:
        return False, "La fuerza del tiro es demasiado baja."

    cue = next(
        (b for b in room["balls"] if b["kind"] == "cue"), None
    )
    if not cue or cue["pocketed"]:
        return False, "No se encontró la bola blanca."

    shooter_id = user_id
    opponent_id = next(uid for uid in room["players"] if uid != shooter_id)

    room["shot_in_progress"] = True
    room["ball_in_hand"] = False

    for ball in room["balls"]:
        ball["vx"] = 0.0
        ball["vy"] = 0.0

    speed = power * 0.20
    cue["vx"] = math.cos(angle) * speed
    cue["vy"] = math.sin(angle) * speed

    first_collision = None
    shot_pockets = []
    scratch = False

    for frame in range(900):
        newly_pocketed = billar_simulate_physics(room)
        shot_pockets.extend(newly_pocketed)

        if cue["pocketed"]:
            scratch = True

        if first_collision is None:
            for ball in room["balls"]:
                if ball["kind"] == "cue" or ball["pocketed"]:
                    continue
                distance = math.hypot(
                    cue["x"] - ball["x"], cue["y"] - ball["y"]
                )
                if distance <= BILLAR_BALL_RADIUS * 2 + 1:
                    first_collision = ball["number"]
                    break

        if frame % 4 == 0:
            await billar_broadcast(room)

        if billar_all_stopped(room):
            break

        await asyncio.sleep(BILLAR_TICK)

    if scratch:
        cue["pocketed"] = False
        cue["x"] = 300.0
        cue["y"] = BILLAR_HEIGHT / 2
        cue["vx"] = 0.0
        cue["vy"] = 0.0

    shooter = room["players"][shooter_id]
    opponent = room["players"][opponent_id]

    if (
        shooter["group"] is None
        and not scratch
        and first_collision is not None
    ):
        first_ball = next(
            (b for b in room["balls"] if b["number"] == first_collision),
            None
        )
        if first_ball and first_ball["kind"] in ("solid", "stripe"):
            shooter["group"] = first_ball["kind"]
            opponent["group"] = (
                "stripe" if first_ball["kind"] == "solid" else "solid"
            )

    eight_pocketed = 8 in shot_pockets

    if eight_pocketed:
        remaining = billar_player_group_remaining(room, shooter_id)
        if remaining > 0 or scratch:
            await billar_finish(room["room_id"], "loss_eight_ball", opponent_id)
            return True, "La bola 8 fue metida ilegalmente."

        await billar_finish(room["room_id"], "win", shooter_id)
        return True, "¡Ganaste la partida!"

    foul = scratch or first_collision is None

    if foul:
        room["turn"] = opponent_id
        room["ball_in_hand"] = True
        room["message"] = "Falta. El rival tiene bola en mano."
    else:
        own_group = shooter.get("group")
        own_ball_pocketed = any(
            (
                number != 8
                and next(
                    (
                        b["kind"] for b in room["balls"]
                        if b["number"] == number
                    ),
                    None
                ) == own_group
            )
            for number in shot_pockets
        ) if own_group else bool(shot_pockets)

        if own_ball_pocketed:
            room["turn"] = shooter_id
            room["message"] = "Bola válida. Sigues jugando."
        else:
            room["turn"] = opponent_id
            room["message"] = "Turno del rival."

    room["shot_in_progress"] = False
    await billar_broadcast(room)
    return True, room["message"]


# ============================================================
# LOBBY BILLAR: SALAS PUBLICAS Y PRIVADAS
# ============================================================

BILLAR_LOBBY_CONNECTIONS: List[WebSocket] = []


def billar_lobby_rooms():
    available = []

    for room_id, room in BILLAR_ROOMS.items():
        if (
            room.get("finished")
            or room.get("status") != "WAITING"
            or len(room.get("players", {})) >= 2
            or not room.get("is_public", True)
        ):
            continue

        creator_player = next(iter(room["players"].values()), {})
        available.append({
            "room_id": room_id,
            "creator": room.get("creator") or creator_player.get("name", "Jugador"),
            "bet": float(room["bet"]),
            "is_public": True,
            "players_count": len(room["players"]),
            "game": "billar",
        })

    return available


async def billar_broadcast_lobby():
    payload = {
        "type": "LOBBY_UPDATE",
        "rooms": billar_lobby_rooms(),
        "active_count": len(billar_lobby_rooms()),
    }

    for ws in list(BILLAR_LOBBY_CONNECTIONS):
        try:
            await ws.send_json(payload)
        except Exception:
            if ws in BILLAR_LOBBY_CONNECTIONS:
                BILLAR_LOBBY_CONNECTIONS.remove(ws)


@app.websocket("/ws/billar-lobby")
async def billar_lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query(""),
):
    await websocket.accept()

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "Tu sesión no es válida.")
        await websocket.close()
        return

    BILLAR_LOBBY_CONNECTIONS.append(websocket)

    try:
        await websocket.send_json({
            "type": "LOBBY_UPDATE",
            "rooms": billar_lobby_rooms(),
            "active_count": len(billar_lobby_rooms()),
        })

        while True:
            data = await websocket.receive_json()
            msg_type = str(data.get("type", "")).upper()

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type != "CREATE_ROOM":
                continue

            if str(data.get("user_id", user_id)) != str(user_id):
                await send_error(websocket, "Usuario no autorizado.")
                continue

            if any(
                user_id in room.get("players", {}) and not room.get("finished")
                for room in BILLAR_ROOMS.values()
            ):
                await send_error(
                    websocket, "Ya tienes una partida de billar activa."
                )
                continue

            wallet = str(data.get("wallet", "play")).lower()
            if wallet not in ("play", "bonus"):
                await send_error(websocket, "Billetera no válida.")
                continue

            try:
                bet = round(float(data.get("bet", 0.25)), 2)
            except (ValueError, TypeError):
                await send_error(websocket, "La apuesta no es válida.")
                continue

            if not math.isfinite(bet) or bet < 0.25 or bet > 10000:
                await send_error(
                    websocket, "La apuesta mínima para Billar es $0.25."
                )
                continue

            creator = str(
                data.get("creator") or data.get("name") or "Jugador"
            ).strip()[:40]
            is_public = bool(data.get("is_public", True))
            password = str(data.get("password") or "").strip()

            if not is_public and len(password) < 1:
                await send_error(
                    websocket,
                    "Debes establecer una contraseña para la sala privada."
                )
                continue

            room_id = uuid.uuid4().hex[:12]

            # CAMBIO: se descuenta solo la apuesta.
            # El 5% se calcula dentro de esa misma apuesta.
            entry_total = bet

            success, message = billar_deduct_balance(
                user_id,
                bet,
                wallet,
                room_id,
                f"billar-entry:{room_id}:{user_id}",
            )

            if not success:
                await send_error(websocket, message)
                continue

            commission_saved = billar_register_commission(
                user_id,
                room_id,
                bet,
                f"billar-commission:{room_id}:{user_id}",
            )

            room = billar_create_room(
                room_id, user_id, wallet, bet, creator
            )
            room["creator"] = creator
            room["is_public"] = is_public
            room["password"] = password
            BILLAR_ROOMS[room_id] = room
            BILLAR_LOCKS[room_id] = asyncio.Lock()

            try:
                supabase.table("billar").upsert({
                    "room_id": room_id,
                    "jugador1_id": user_id,
                    "apuesta": bet,
                    "comision_por_jugador": round(bet * 0.05, 2),
                    "billetera_jugador1": wallet,
                    "estado": "esperando",
                    "estado_juego": billar_public_state(room),
                    "entrada_jugador1_pagada": True,
                    "transaction_key": f"billar-entry:{room_id}:{user_id}",
                }, on_conflict="room_id").execute()
            except Exception as exc:
                print(f"ERROR guardando sala creada de Billar: {exc!r}")

            await websocket.send_json({
                "type": "ROOM_CREATED",
                "room_id": room_id,
                "bet": bet,
                "wallet": wallet,
                "is_public": is_public,
                "entry_total": entry_total,
                "commission": round(bet * 0.05, 2),
                "commission_registered": commission_saved,
            })

            await billar_broadcast_lobby()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR lobby Billar: {exc!r}")
        try:
            await send_error(
                websocket, "Ocurrió un error en el lobby de Billar."
            )
        except Exception:
            pass
    finally:
        if websocket in BILLAR_LOBBY_CONNECTIONS:
            BILLAR_LOBBY_CONNECTIONS.remove(websocket)


@app.websocket("/ws/billar/{room_id}")
async def billar_endpoint(
    websocket: WebSocket,
    room_id: str,
    user_id: str = Query(""),
    access_token: str = Query(""),
    bet: float = Query(1.00),
    wallet: str = Query("play"),
    name: str = Query("Jugador"),
):
    await websocket.accept()

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "Tu sesión no es válida.")
        await websocket.close()
        return

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    try:
        bet = round(float(bet), 2)
    except (ValueError, TypeError):
        await send_error(websocket, "La apuesta no es válida.")
        await websocket.close()
        return

    if not math.isfinite(bet) or bet < 0.25 or bet > 10000:
        await send_error(
            websocket, "La apuesta mínima para Billar es $0.25."
        )
        await websocket.close()
        return

    if not room_id or len(room_id) > 100:
        await send_error(websocket, "Sala no válida.")
        await websocket.close()
        return

    lock = BILLAR_LOCKS.setdefault(room_id, asyncio.Lock())

    try:
        async with lock:
            room = BILLAR_ROOMS.get(room_id)

            if room and room.get("finished"):
                await send_error(websocket, "La partida ya terminó.")
                await websocket.close()
                return

            if room and not room.get("is_public", True):
                supplied_password = str(
                    websocket.query_params.get("password", "")
                )
                if supplied_password != str(room.get("password", "")):
                    await send_error(websocket, "Contraseña incorrecta.")
                    await websocket.close()
                    return

            if room and user_id in room["players"]:
                player = room["players"][user_id]

                if player.get("connected"):
                    await send_error(
                        websocket, "Ya tienes una conexión activa."
                    )
                    await websocket.close()
                    return

                player["websocket"] = websocket
                player["connected"] = True

            else:
                if any(
                    user_id in r["players"] and not r["finished"]
                    for r in BILLAR_ROOMS.values()
                ):
                    await send_error(
                        websocket,
                        "Ya tienes otra partida de billar activa."
                    )
                    await websocket.close()
                    return

                if room and len(room["players"]) >= 2:
                    await send_error(websocket, "La sala está llena.")
                    await websocket.close()
                    return

                if room and abs(float(room["bet"]) - bet) > 0.001:
                    await send_error(
                        websocket, "La apuesta no coincide con la sala."
                    )
                    await websocket.close()
                    return

                if not room:
                    room = billar_create_room(
                        room_id, user_id, wallet, bet, str(name)[:40]
                    )
                    BILLAR_ROOMS[room_id] = room

                # CAMBIO: descontar solo el valor de la apuesta.
                entry_total = bet

                success, message = billar_deduct_balance(
                    user_id,
                    bet,
                    wallet,
                    room_id,
                    f"billar-entry:{room_id}:{user_id}",
                )

                if not success:
                    if not room["players"]:
                        BILLAR_ROOMS.pop(room_id, None)

                    await send_error(websocket, message)
                    await websocket.close()
                    return

                commission_saved = billar_register_commission(
                    user_id,
                    room_id,
                    bet,
                    f"billar-commission:{room_id}:{user_id}",
                )

                if not commission_saved:
                    print(
                        "ADVERTENCIA: se cobró la entrada, "
                        "pero falta registrar la comisión."
                    )

                if user_id not in room["players"]:
                    room["players"][user_id] = {
                        "user_id": user_id,
                        "wallet": wallet,
                        "bet": bet,
                        "name": str(name)[:40],
                        "websocket": websocket,
                        "connected": True,
                        "group": None,
                    }

                if len(room["players"]) == 2:
                    room["status"] = "PLAYING"
                    room["message"] = "¡Que comience la partida!"

                    try:
                        supabase.table("billar").update({
                            "jugador2_id": user_id,
                            "billetera_jugador2": wallet,
                            "estado": "jugando",
                            "turno": room["turn"],
                            "entrada_jugador2_pagada": True,
                            "iniciada_en": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                        }).eq("room_id", room_id).execute()
                    except Exception as exc:
                        print(f"ERROR actualizando Billar: {exc!r}")

                else:
                    try:
                        supabase.table("billar").upsert({
                            "room_id": room_id,
                            "jugador1_id": user_id,
                            "apuesta": bet,
                            "comision_por_jugador": round(bet * 0.05, 2),
                            "billetera_jugador1": wallet,
                            "estado": "esperando",
                            "estado_juego": billar_public_state(room),
                            "entrada_jugador1_pagada": True,
                            "transaction_key": (
                                f"billar-entry:{room_id}:{user_id}"
                            ),
                        }, on_conflict="room_id").execute()
                    except Exception as exc:
                        print(f"ERROR guardando sala Billar: {exc!r}")

            await websocket.send_json({
                "type": "BILLAR_INIT",
                "room_id": room_id,
                "user_id": user_id,
                "status": room["status"],
                "bet": room["bet"],

                # CAMBIO: entry_total ya no incluye un 5% adicional.
                "entry_total": round(room["bet"], 2),

                "commission": round(room["bet"] * 0.05, 2),
                "state": billar_public_state(room),
            })

            await billar_broadcast(room)
            await billar_broadcast_lobby()

        while True:
            data = await websocket.receive_json()
            msg_type = str(data.get("type", "")).upper()

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type in ("SHOT", "BILLAR_SHOT"):
                try:
                    angle = float(data.get("angle", 0))
                    power = float(data.get("power", 50))
                except (ValueError, TypeError):
                    await send_error(websocket, "Tiro incorrecto.")
                    continue

                room = BILLAR_ROOMS.get(room_id)
                if not room:
                    await send_error(websocket, "La sala no existe.")
                    continue

                success, message = await billar_shot(
                    room, user_id, angle, power
                )
                if not success:
                    await send_error(websocket, message)

            elif msg_type == "PLACE_CUE":
                room = BILLAR_ROOMS.get(room_id)

                if not room or room["turn"] != user_id:
                    await send_error(
                        websocket, "No puedes colocar la bola blanca."
                    )
                    continue

                if not room.get("ball_in_hand"):
                    await send_error(
                        websocket, "No tienes bola en mano."
                    )
                    continue

                try:
                    x = float(data.get("x", 300))
                    y = float(data.get("y", BILLAR_HEIGHT / 2))
                except (ValueError, TypeError):
                    continue

                x = max(
                    BILLAR_BALL_RADIUS,
                    min(BILLAR_WIDTH / 2 - 20, x)
                )
                y = max(
                    BILLAR_BALL_RADIUS,
                    min(BILLAR_HEIGHT - BILLAR_BALL_RADIUS, y)
                )

                cue = next(
                    b for b in room["balls"] if b["kind"] == "cue"
                )

                occupied = any(
                    not b["pocketed"]
                    and b["kind"] != "cue"
                    and math.hypot(b["x"] - x, b["y"] - y)
                    < BILLAR_BALL_RADIUS * 2
                    for b in room["balls"]
                )

                if occupied:
                    await send_error(
                        websocket,
                        "No puedes colocar la bola encima de otra."
                    )
                    continue

                cue["x"] = x
                cue["y"] = y
                cue["pocketed"] = False
                cue["vx"] = 0.0
                cue["vy"] = 0.0
                room["ball_in_hand"] = False
                room["message"] = "Bola blanca colocada."
                await billar_broadcast(room)

            elif msg_type in ("LEAVE", "ABANDON"):
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR WebSocket Billar {room_id}: {exc!r}")
        try:
            await send_error(websocket, "Ocurrió un error en el billar.")
        except Exception:
            pass
    finally:
        room = BILLAR_ROOMS.get(room_id)

        if room:
            player = room["players"].get(user_id)

            if player and player.get("websocket") is websocket:
                player["connected"] = False
                player["websocket"] = None

                if (
                    room["status"] == "PLAYING"
                    and not room["finished"]
                    and len(room["players"]) == 2
                ):
                    opponent_id = next(
                        uid for uid in room["players"] if uid != user_id
                    )
                    await billar_finish(
                        room_id, "abandon", opponent_id
                    )

        await billar_broadcast_lobby()


# ============================================================
# FIN BILLAR 8 BALL
# ============================================================
