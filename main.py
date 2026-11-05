
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
    raise RuntimeError("Falta configurar SUPABASE_SERVICE_ROLE_KEY en Render.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)

lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, dict] = {}


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

    # La liquidación se realiza en SQL, no desde el navegador.
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

            # El servidor descuenta la apuesta del creador.
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

                    # Si hay dos jugadores, el otro gana por abandono.
                    # Si solo estaba el creador, se le devuelve el 95%.
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

WORLD_WIDTH = 1920
WORLD_HEIGHT = 1080

SNAKE_SPEED = 7.5
SNAKE_BOOST_SPEED = 12.0

SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16
COIN_VALUE_MICROS = 100_000
INITIAL_BALANCE_MICROS = 1_000_000

BOOST_COST_MICROS = 100_000
BOOST_COIN_INTERVAL = 1.0

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 80

FOOD_COLORS = [
    "#ff3b30", "#ff9500", "#ffcc00", "#34c759",
    "#00c7be", "#32ade6", "#007aff", "#af52de",
    "#ff2d55", "#ffffff",
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
# SALAS SNAKE
# ============================================================

class SnakeRoom:

    def __init__(self, room_id: str):

        self.room_id = room_id
        self.connections: Dict[str, WebSocket] = {}
        self.snakes: Dict[str, dict] = {}

        self.foods: List[dict] = []
        self.coins: List[dict] = []

        self.is_running = False
        self.lock = asyncio.Lock()

        self.spawn_food(FOOD_INITIAL_COUNT)

    def spawn_food(self, amount: int = 1):

        for _ in range(amount):

            self.foods.append({
                "id": f"food_{uuid.uuid4().hex}",
                "x": random.uniform(30, WORLD_WIDTH - 30),
                "y": random.uniform(30, WORLD_HEIGHT - 30),
                "color": random.choice(FOOD_COLORS),
                "radius": FOOD_RADIUS,
                "growth": 1,
            })

    def create_spawn(self):

        positions = [
            (220, 220, 0),
            (1700, 850, math.pi),
            (1700, 220, math.pi),
            (220, 850, 0),
            (960, 250, math.pi / 2),
            (960, 830, -math.pi / 2),
        ]

        occupied = [
            (s["body"][0]["x"], s["body"][0]["y"])
            for s in self.snakes.values()
            if s.get("alive") and s.get("body")
        ]

        available = [
            (x, y, angle)
            for x, y, angle in positions
            if all(math.hypot(x - ox, y - oy) > 180 for ox, oy in occupied)
        ]

        if available:
            return random.choice(available)

        for _ in range(50):

            x = random.uniform(150, WORLD_WIDTH - 150)
            y = random.uniform(150, WORLD_HEIGHT - 150)

            if all(math.hypot(x - ox, y - oy) > 180 for ox, oy in occupied):
                return x, y, random.uniform(-math.pi, math.pi)

        return (
            random.uniform(150, WORLD_WIDTH - 150),
            random.uniform(150, WORLD_HEIGHT - 150),
            random.uniform(-math.pi, math.pi)
        )

    def add_snake(self, user_id: str, bet: float, wallet: str, color: str):

        x, y, angle = self.create_spawn()

        self.snakes[user_id] = {
            "session_id": uuid.uuid4().hex,
            "body": create_snake_body(x, y, angle),
            "angle": angle,
            "score": 0,
            "kills": 0,
            "color": safe_color(color),
            "wallet": wallet,
            "bet": 1.00,
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
            "created_at": time.time(),
        }

    def update_balance(self, snake: dict):

        balance = max(0, int(snake.get("balance_micros", 0)))

        snake["balance_micros"] = balance
        snake["balance"] = money_from_micros(balance)

        earned = max(0, int(snake.get("collected_micros", 0)))

        snake["earned_micros"] = earned
        snake["earned"] = money_from_micros(earned)

    def drop_coins(self, snake: dict):

        if not snake.get("body"):
            return

        head = snake["body"][0]
        balance = int(snake.get("balance_micros", 0))

        if balance <= 0:
            return

        number_of_coins = math.ceil(balance / COIN_VALUE_MICROS)
        remaining = balance

        for _ in range(number_of_coins):

            if remaining <= 0:
                break

            value = min(COIN_VALUE_MICROS, remaining)

            angle = random.uniform(0, math.pi * 2)
            distance = random.uniform(15, 75)

            x = max(
                15,
                min(
                    WORLD_WIDTH - 15,
                    head["x"] + math.cos(angle) * distance
                )
            )

            y = max(
                15,
                min(
                    WORLD_HEIGHT - 15,
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

        self.drop_coins(snake)

    def drop_boost_coin(self, snake: dict) -> bool:

        balance = int(snake.get("balance_micros", 0))
        body = snake.get("body", [])

        if balance < BOOST_COST_MICROS or not body:
            snake["boosting"] = False
            return False

        snake["balance_micros"] -= BOOST_COST_MICROS
        snake["boost_spent_micros"] += BOOST_COST_MICROS

        entry_remaining = int(snake.get("entry_remaining_micros", 0))

        snake["entry_remaining_micros"] = max(
            0,
            entry_remaining - BOOST_COST_MICROS
        )

        self.update_balance(snake)

        tail = body[-1]
        angle = snake.get("angle", 0) + math.pi
        distance = random.uniform(20, 45)

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
            "value_micros": BOOST_COST_MICROS,
            "value": 0.10,
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
            snake["grow_pending"] += 1
            snake["score"] += 1

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

            growth = max(1, int(food.get("growth", 1)))

            snake["grow_pending"] += growth
            snake["score"] += growth

    def check_collision(self, user_id: str, new_head: dict):

        if (
            new_head["x"] < 8
            or new_head["x"] > WORLD_WIDTH - 8
            or new_head["y"] < 8
            or new_head["y"] > WORLD_HEIGHT - 8
        ):
            return "wall"

        for other_uid, other_snake in self.snakes.items():

            if other_uid == user_id or not other_snake.get("alive"):
                continue

            for segment in other_snake.get("body", []):

                if math.hypot(
                    new_head["x"] - segment["x"],
                    new_head["y"] - segment["y"]
                ) < 14:
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
                    snake["next_boost_coin_at"] = now + BOOST_COIN_INTERVAL

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

        collision = self.check_collision(user_id, new_head)

        if collision:

            if collision != "wall":

                killer = self.snakes.get(collision)

                if killer and killer.get("alive"):
                    killer["kills"] += 1

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

        for uid, snake in self.snakes.items():

            public_snakes[uid] = {
                "body": snake["body"],
                "angle": snake["angle"],
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
            }

        return {
            "type": "GAME_STATE",
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

                    missing_food = FOOD_INITIAL_COUNT - len(self.foods)

                    if missing_food > 0:
                        self.spawn_food(min(missing_food, 5))

                await self.broadcast()
                await asyncio.sleep(GAME_TICK)

        except Exception as exc:
            print(f"ERROR Snake loop {self.room_id}: {exc!r}")

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
    bet: float = Query(1.00),
    wallet: str = Query("play"),
    color: str = Query("#34d399")
):

    await websocket.accept()

    if not user_id or not access_token:
        await send_error(websocket, "Debes iniciar sesión para jugar.")
        await websocket.close()
        return

    if not verify_user_token(access_token, user_id):
        await send_error(websocket, "La sesión no es válida.")
        await websocket.close()
        return

    bet = 1.00

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    if room_id not in snake_rooms:
        snake_rooms[room_id] = SnakeRoom(room_id)

    room = snake_rooms[room_id]

    if user_id in room.connections:
        await send_error(websocket, "Ya tienes una conexión activa.")
        await websocket.close()
        return

    transaction_key = f"snake-entry:{room_id}:{user_id}:{uuid.uuid4().hex}"

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

    async with room.lock:
        room.connections[user_id] = websocket
        room.add_snake(user_id, bet, wallet, color)

    await websocket.send_json(room.public_state())

    if not room.is_running:
        asyncio.create_task(room.game_loop())

    try:

        while True:

            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "READY":

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

                        if snake and snake["alive"] and snake["ready"]:
                            snake["angle"] = angle

                except (ValueError, TypeError):
                    pass

            elif msg_type == "BOOST_START":

                async with room.lock:

                    snake = room.snakes.get(user_id)

                    if (
                        snake
                        and snake["alive"]
                        and snake["ready"]
                        and snake["balance_micros"] >= BOOST_COST_MICROS
                    ):

                        if not snake.get("boosting"):
                            snake["boosting"] = True
                            snake["next_boost_coin_at"] = (
                                time.monotonic() + BOOST_COIN_INTERVAL
                            )

                await room.broadcast()

            elif msg_type == "BOOST_STOP":

                async with room.lock:

                    snake = room.snakes.get(user_id)

                    if snake:
                        snake["boosting"] = False

                await room.broadcast()

            elif msg_type == "CASH_OUT":

                cashout_data = None

                async with room.lock:

                    snake = room.snakes.get(user_id)

                    if (
                        snake
                        and snake["alive"]
                        and snake["ready"]
                        and not snake.get("cashed_out")
                    ):

                        snake["boosting"] = False

                        balance_micros = max(
                            0,
                            int(snake.get("balance_micros", 0))
                        )

                        wallet_used = snake["wallet"]

                        # Retiro voluntario: 5% de TODO el saldo actual.
                        total = money_from_micros(balance_micros)
                        commission = round(total * 0.05, 2)
                        net_amount = max(0, round(total - commission, 2))

                        transaction_key = (
                            f"snake-cashout:{room_id}:{user_id}:"
                            f"{snake['session_id']}"
                        )

                        snake["alive"] = False
                        snake["cashed_out"] = True

                        cashout_data = {
                            "refund": 0.0,
                            "payout": net_amount,
                            "wallet": wallet_used,
                            "transaction_key": transaction_key,
                            "commission": commission,
                            "total": total,
                        }

                if cashout_data:

                    paid, payment_message = settle_snake_cashout(
                        user_id,
                        room_id,
                        cashout_data["wallet"],
                        cashout_data["refund"],
                        cashout_data["payout"],
                        cashout_data["transaction_key"]
                    )

                    if paid:

                        await websocket.send_json({
                            "type": "CASHOUT_SUCCESS",
                            "payout": cashout_data["payout"],
                            "refund": 0,
                            "commission": cashout_data["commission"],
                            "wallet": cashout_data["wallet"],
                            "message": "Retiro realizado correctamente."
                        })

                    else:

                        async with room.lock:

                            snake = room.snakes.get(user_id)

                            if snake:
                                snake["alive"] = True
                                snake["cashed_out"] = False

                        await send_error(websocket, payment_message)

                    await room.broadcast()

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")

    finally:

        abandon_data = None

        async with room.lock:

            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            snake = room.snakes.get(user_id)

            # Abandono voluntario/desconexión:
            # devuelve la entrada restante menos 5% de la apuesta inicial.
            if snake and snake.get("alive"):

                snake["alive"] = False
                snake["boosting"] = False

                entry_remaining = max(
                    0,
                    int(snake.get("entry_remaining_micros", 0))
                )

                balance_micros = max(
                    0,
                    int(snake.get("balance_micros", 0))
                )

                refund_micros = min(
                    entry_remaining,
                    balance_micros,
                    INITIAL_BALANCE_MICROS
                )

                refund = money_from_micros(refund_micros)
                commission = 0.05
                refund_net = max(0, round(refund - commission, 2))

                transaction_key = (
                    f"snake-abandon:{room_id}:{user_id}:"
                    f"{snake['session_id']}"
                )

                abandon_data = {
                    "refund": refund_net,
                    "wallet": snake["wallet"],
                    "transaction_key": transaction_key,
                }

                # Lo que no se devuelve queda como monedas.
                remaining = max(
                    0,
                    balance_micros - refund_micros
                )

                snake["balance_micros"] = remaining
                self_drop = remaining

                if self_drop > 0:
                    room.drop_coins(snake)
                else:
                    room.update_balance(snake)

            if not room.connections:
                room.is_running = False

                if snake_rooms.get(room_id) is room:
                    snake_rooms.pop(room_id, None)

        if abandon_data:

            # La RPC de Snake debe registrar comisión del abandono.
            try:

                result = rpc_json("settle_snake_abandon", {
                    "p_transaction_key": abandon_data["transaction_key"],
                    "p_room_id": room_id,
                    "p_user_id": user_id,
                    "p_wallet": abandon_data["wallet"],
                    "p_refund_amount": abandon_data["refund"],
                    "p_commission": 0.05,
                })

                if not result.get("success"):
                    print("ERROR liquidando abandono Snake:", result)

            except Exception as exc:
                print(f"ERROR settle_snake_abandon: {exc!r}")
