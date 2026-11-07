
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

SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "https://djdzytfdztctusnuuvrm.supabase.co"
)

SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY",
    ""
)

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "Falta configurar SUPABASE_SERVICE_ROLE_KEY en las variables de entorno."
    )

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

    def calculate_commission(self, amount: float) -> float:
        return round(max(0, amount) * 0.05, 2)

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
        (0, 1, 2),
        (3, 4, 5),
        (6, 7, 8),
        (0, 3, 6),
        (1, 4, 7),
        (2, 5, 8),
        (0, 4, 8),
        (2, 4, 6),
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

            player = create_xo_player(
                user_id,
                wallet,
                bet,
                creator
            )

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
                user_id,
                bet,
                wallet,
                room_id,
                f"xo-entry:{room_id}:{user_id}"
            )

            if not success:
                await send_error(websocket, message)
                await websocket.close()
                return

            player = create_xo_player(
                user_id,
                wallet,
                bet,
                "Jugador"
            )

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
                            uid
                            for uid, p in room["players"].items()
                            if p["symbol"] == winner_symbol
                        )

                        room["status"] = "FINISHED"
                        result_type = "win"

                    else:
                        continue

                paid = await finish_xo_room(
                    room_id,
                    result_type,
                    winner_id=winner_id
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

            if (
                current_player
                and current_player.get("websocket") is websocket
            ):
                current_player["connected"] = False
                current_player["websocket"] = None

                if not room.get("finished") and not room.get("settling"):
                    abandoner_id = user_id

                    other_ids = [
                        uid for uid in room["players"]
                        if uid != user_id
                    ]

                    if len(other_ids) == 1:
                        winner_id = other_ids[0]

                    should_abandon = True

        if should_abandon:
            if winner_id:
                await finish_xo_room(
                    room_id,
                    "abandon",
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

    paid, message = settle_xo_match(
        room_id,
        "cancel",
        players
    )

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
        return (
            int(x // FOOD_CELL_SIZE),
            int(y // FOOD_CELL_SIZE)
        )

    def rebuild_food_grid(self):
        grid = {}

        for food in self.foods:
            cell = self.food_cell(food["x"], food["y"])

            if cell not in grid:
                grid[cell] = []

            grid[cell].append(food)

        self.food_grid = grid

    def add_food_to_grid(self, food: dict):
        cell = self.food_cell(food["x"], food["y"])

        if cell not in self.food_grid:
            self.food_grid[cell] = []

        self.food_grid[cell].append(food)

    def get_food_near(
        self,
        x: float,
        y: float,
        radius: float
    ):
        min_cell_x = int((x - radius) // FOOD_CELL_SIZE)
        max_cell_x = int((x + radius) // FOOD_CELL_SIZE)

        min_cell_y = int((y - radius) // FOOD_CELL_SIZE)
        max_cell_y = int((y + radius) // FOOD_CELL_SIZE)

        for cell_x in range(min_cell_x, max_cell_x + 1):
            for cell_y in range(min_cell_y, max_cell_y + 1):
                foods = self.food_grid.get((cell_x, cell_y), [])

                for food in foods:
                    if food["id"] in self.consumed_food_ids:
                        continue

                    if (
                        abs(food["x"] - x) <= radius
                        and abs(food["y"] - y) <= radius
                    ):
                        yield food

    def nearby_foods_for_players(self):
        visible = {}
        radius = FOOD_VIEW_RADIUS

        for snake in self.snakes.values():
            if not snake.get("alive"):
                continue

            body = snake.get("body", [])

            if not body:
                continue

            head = body[0]

            for food in self.get_food_near(
                head["x"],
                head["y"],
                radius
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
            min(
                WORLD_WIDTH - COIN_RADIUS,
                x + math.cos(angle) * distance
            )
        )

        coin_y = max(
            COIN_RADIUS,
            min(
                WORLD_HEIGHT - COIN_RADIUS,
                y + math.sin(angle) * distance
            )
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
            (x, y, angle)
            for x, y, angle in positions
            if all(
                math.hypot(x - ox, y - oy) > 180
                for ox, oy in occupied
            )
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
        self,
        user_id: str,
        bet: float,
        wallet: str,
        color: str
    ):
        x, y, angle = self.create_spawn()

        self.snakes[user_id] = {
            "session_id": uuid.uuid4().hex,
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

    # ========================================================
    # SOLTAR COMIDA: 50% DE LA COMIDA RECOGIDA
    # ========================================================

    def drop_food(self, snake: dict):
        body = snake.get("body", [])

        if not body:
            return

        head = body[0]

        food_eaten = max(
            0,
            int(snake.get("food_eaten", 0))
        )

        amount_to_drop = food_eaten // 2

        for _ in range(amount_to_drop):
            angle = random.uniform(0, math.pi * 2)
            distance = random.uniform(20, 130)

            x = max(
                25,
                min(
                    WORLD_WIDTH - 25,
                    head["x"] + math.cos(angle) * distance
                )
            )

            y = max(
                25,
                min(
                    WORLD_HEIGHT - 25,
                    head["y"] + math.sin(angle) * distance
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

    # ========================================================
    # SOLTAR EL 100% DEL SALDO EN MONEDAS
    # ========================================================

    def drop_coins(self, snake: dict):
        balance = max(
            0,
            int(snake.get("balance_micros", 0))
        )

        body = snake.get("body", [])

        if balance <= 0 or not body:
            snake["balance_micros"] = 0
            snake["entry_remaining_micros"] = 0
            self.update_balance(snake)
            return

        tail = body[-1]
        remaining = balance

        while remaining > 0:
            value = min(
                COIN_VALUE_MICROS,
                remaining
            )

            self.spawn_coin(
                tail["x"],
                tail["y"],
                value
            )

            remaining -= value

        snake["balance_micros"] = 0
        snake["entry_remaining_micros"] = 0

        self.update_balance(snake)

    # ========================================================
    # MUERTE
    # ========================================================

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return

        snake["alive"] = False
        snake["boosting"] = False

        # Suelta el 50% de la comida recogida.
        self.drop_food(snake)

        # Suelta todo el saldo restante en monedas.
        self.drop_coins(snake)

    # ========================================================
    # COMER
    # ========================================================

    def consume_food(self, snake: dict):
        if not snake.get("alive") or not snake.get("body"):
            return

        head = snake["body"][0]
        eaten = []

        for food in self.get_food_near(
            head["x"],
            head["y"],
            FOOD_RADIUS + 15
        ):
            distance = math.hypot(
                head["x"] - food["x"],
                head["y"] - food["y"]
            )

            if distance <= FOOD_RADIUS + 12:
                eaten.append(food)

        if not eaten:
            return

        for food in eaten:
            self.consumed_food_ids.add(food["id"])

            snake["food_eaten"] += 1
            snake["score"] += 1

            # Cada alimento agrega tres segmentos.
            snake["grow_pending"] += FOOD_GROWTH_PER_ITEM

        if len(self.consumed_food_ids) > 10000:
            self.foods = [
                food for food in self.foods
                if food["id"] not in self.consumed_food_ids
            ]

            self.consumed_food_ids.clear()
            self.rebuild_food_grid()

    # ========================================================
    # RECOGER MONEDAS
    # ========================================================

    def consume_coins(self, snake: dict):
        if not snake.get("alive") or not snake.get("body"):
            return

        head = snake["body"][0]
        remaining = []

        for coin in self.coins:
            distance = math.hypot(
                head["x"] - coin["x"],
                head["y"] - coin["y"]
            )

            if distance <= COIN_RADIUS + 18:
                value = max(
                    0,
                    int(coin.get("value_micros", 0))
                )

                snake["balance_micros"] += value
                snake["collected_micros"] += value
                snake["score"] += 1

                self.update_balance(snake)
            else:
                remaining.append(coin)

        self.coins = remaining

    # ========================================================
    # MOVIMIENTO
    # ========================================================

    def move_snake(self, snake: dict, delta_time: float):
        if not snake.get("alive") or not snake.get("ready"):
            return

        body = snake.get("body", [])

        if not body:
            return

        angle = float(snake.get("angle", 0))

        speed = (
            SNAKE_BOOST_SPEED
            if snake.get("boosting")
            else SNAKE_SPEED
        )

        distance = speed * delta_time * 30

        head = body[0]

        new_x = head["x"] + math.cos(angle) * distance
        new_y = head["y"] + math.sin(angle) * distance

        if (
            new_x < 10
            or new_y < 10
            or new_x > WORLD_WIDTH - 10
            or new_y > WORLD_HEIGHT - 10
        ):
            self.kill_snake(snake)
            return

        new_body = [{"x": new_x, "y": new_y}]

        # Reconstruye el cuerpo conservando su longitud.
        for point in body:
            previous = new_body[-1]

            dx = point["x"] - previous["x"]
            dy = point["y"] - previous["y"]
            distance_between = math.hypot(dx, dy)

            if distance_between >= SNAKE_SEGMENT_DISTANCE:
                ratio = SNAKE_SEGMENT_DISTANCE / distance_between

                new_body.append({
                    "x": previous["x"] + dx * ratio,
                    "y": previous["y"] + dy * ratio,
                })

        # Solo crecer cuando se recoge comida.
        # BOOST no modifica grow_pending ni agrega segmentos.
        if snake.get("grow_pending", 0) > 0:
            last = new_body[-1]

            new_body.append({
                "x": last["x"],
                "y": last["y"],
            })

            snake["grow_pending"] -= 1

        snake["body"] = new_body

        self.consume_food(snake)
        self.consume_coins(snake)

    # ========================================================
    # COLISIONES
    # ========================================================

    def check_collisions(self):
        alive_snakes = [
            (user_id, snake)
            for user_id, snake in self.snakes.items()
            if snake.get("alive")
            and snake.get("ready")
            and snake.get("body")
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

    # ========================================================
    # ACELERACIÓN
    # ========================================================

    def process_boost(self, snake: dict):
        if not snake.get("alive") or not snake.get("boosting"):
            return

        now = time.time()

        if now < snake.get("next_boost_coin_at", 0):
            return

        balance = int(snake.get("balance_micros", 0))

        # Si no tiene $0.10, se detiene la aceleración.
        if balance < BOOST_COST_MICROS:
            snake["boosting"] = False
            return

        # Descontar $0.10.
        snake["balance_micros"] -= BOOST_COST_MICROS
        snake["boost_spent_micros"] += BOOST_COST_MICROS

        snake["next_boost_coin_at"] = now + BOOST_COIN_INTERVAL

        # La cantidad descontada aparece como moneda en el mapa.
        body = snake.get("body", [])

        if body:
            tail = body[-1]

            self.spawn_coin(
                tail["x"],
                tail["y"],
                BOOST_COST_MICROS
            )

        self.update_balance(snake)

        # IMPORTANTE:
        # Aquí no se modifica el cuerpo.
        # Aquí no se modifica grow_pending.
        # Acelerar nunca hace crecer la serpiente.

    # ========================================================
    # ESTADO DEL JUEGO
    # ========================================================

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
                "balance": money_from_micros(
                    snake["balance_micros"]
                ),
                "balance_micros": snake["balance_micros"],
                "earned": money_from_micros(
                    snake["collected_micros"]
                ),
                "wallet": snake["wallet"],
            }

        return {
            "type": "GAME_STATE",
            "room_id": self.room_id,
            "world": {
                "width": WORLD_WIDTH,
                "height": WORLD_HEIGHT,
            },
            "snakes": snakes_data,
            "foods": self.nearby_foods_for_players(),
            "coins": self.coins,
            "players_count": len([
                s for s in self.snakes.values()
                if s.get("alive")
            ]),
        }

    # ========================================================
    # TRANSMITIR ESTADO
    # ========================================================

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

    # ========================================================
    # BUCLE PRINCIPAL
    # ========================================================

    async def game_loop(self):
        if self.is_running:
            return

        self.is_running = True
        previous_time = time.monotonic()

        try:
            while self.is_running:
                start = time.monotonic()

                delta_time = min(
                    start - previous_time,
                    0.1
                )

                previous_time = start

                async with self.lock:
                    for snake in list(self.snakes.values()):
                        self.process_boost(snake)
                        self.move_snake(snake, delta_time)

                    self.check_collisions()

                    # Reponer comida si disminuye demasiado.
                    if len(self.foods) < FOOD_INITIAL_COUNT:
                        missing = min(
                            100,
                            FOOD_INITIAL_COUNT - len(self.foods)
                        )

                        self.spawn_food(missing)
                        self.rebuild_food_grid()

                    await self.broadcast()

                elapsed = time.monotonic() - start

                await asyncio.sleep(
                    max(0, GAME_TICK - elapsed)
                )

        except asyncio.CancelledError:
            raise

        except Exception as exc:
            print(
                f"ERROR en game_loop Snake {self.room_id}: {exc!r}"
            )

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

    monto_jugador = round(
        monto_retiro - comision,
        2
    )

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

    async with room.lock:
        existing = room.snakes.get(user_id)

        if existing and existing.get("alive"):
            await send_error(
                websocket,
                "Ya tienes una serpiente activa en esta sala."
            )
            await websocket.close()
            return

        if existing and existing.get("cashed_out"):
            await send_error(
                websocket,
                "Ya retiraste tu saldo de esta partida."
            )
            await websocket.close()
            return

        if existing and not existing.get("alive"):
            await send_error(
                websocket,
                "Tu partida terminó. Ingresa a una nueva sala."
            )
            await websocket.close()
            return

        if any(
            uid == user_id and snake.get("alive")
            for other_room in snake_rooms.values()
            for uid, snake in other_room.snakes.items()
        ):
            await send_error(
                websocket,
                "Ya tienes una partida Snake activa."
            )
            await websocket.close()
            return

        transaction_key = f"snake-entry:{room_id}:{user_id}"

        success, message = deduct_balance(
            user_id,
            bet,
            wallet,
            room_id,
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
            color
        )

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

            async with room.lock:
                current = room.snakes.get(user_id)

                if not current:
                    await send_error(
                        websocket,
                        "No se encontró tu serpiente."
                    )
                    continue

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
                    if (
                        not current.get("alive")
                        or current.get("cashed_out")
                    ):
                        await send_error(
                            websocket,
                            "No puedes retirar en este momento."
                        )
                        continue

                    current["boosting"] = False

                    gross_micros = max(
                        0,
                        int(current.get("balance_micros", 0))
                    )

                    gross = money_from_micros(gross_micros)

                    if gross <= 0:
                        await send_error(
                            websocket,
                            "No tienes saldo para retirar."
                        )
                        continue

                    commission = round(gross * 0.05, 2)

                    payout = round(
                        gross - commission,
                        2
                    )

                    cashout_key = (
                        f"snake-cashout:"
                        f"{room_id}:{user_id}:"
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

                        await send_error(
                            websocket,
                            payment_message
                        )
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

                    room.connections.pop(user_id, None)

                elif msg_type == "LEAVE":
                    current["boosting"] = False
                    room.kill_snake(current)

                else:
                    continue

            await room.broadcast()

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")

        try:
            await send_error(
                websocket,
                "Ocurrió un error en la partida."
            )
        except Exception:
            pass

    finally:
        async with room.lock:
            current = room.snakes.get(user_id)

            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            if (
                current
                and current.get("alive")
                and not current.get("cashed_out")
            ):
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
        "games": [
            "xo",
            "snake",
        ],
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "snake_rooms": len(snake_rooms),
        "xo_rooms": len(lobbies),
    }
