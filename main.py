
import random
import asyncio
import math
import time
import uuid
import traceback
from typing import Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from supabase import create_client, Client

app = FastAPI(title="AXIOM Game Backend")

# ============================================================
# SUPABASE
# ============================================================

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"


if not SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY.startswith("PEGA_AQUI"):
    raise RuntimeError("Debes colocar tu nueva SUPABASE_SERVICE_ROLE_KEY en main.py.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)

# ============================================================
# ESTADO GLOBAL
# ============================================================

lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, dict] = {}

MIN_XO_BET = 0.25


@app.get("/")
async def root():
    return {
        "service": "AXIOM Game Backend",
        "status": "online",
        "games": ["x_vs_o", "snake"]
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


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


def settle_snake_cashout(
    user_id: str,
    room_id: str,
    wallet: str,
    refund: float,
    payout: float,
    transaction_key: str
):
    try:
        return rpc_json("settle_snake_cashout", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_refund_amount": round(float(refund), 2),
            "p_payout_amount": round(float(payout), 2),
        })
    except Exception as exc:
        print(f"ERROR settle_snake_cashout: {exc!r}")
        return {
            "success": False,
            "message": "No se pudo procesar el retiro. Inténtalo nuevamente."
        }


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


async def safe_send(ws: WebSocket, message: dict):
    try:
        await ws.send_json(message)
        return True
    except Exception:
        return False


# ============================================================
# ADMINISTRADOR DEL LOBBY X VS O
# ============================================================

class GameManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {
            "lobby": []
        }

    async def broadcast_lobby(self):
        room_list = []

        for room_id, room in list(lobbies.items()):
            if room.get("finished"):
                continue

            if len(room.get("players", {})) >= 2:
                continue

            room_list.append({
                "room_id": room_id,
                "creator": room["creator"],
                "bet": room["bet"],
                "is_public": room["is_public"],
                "players_count": len(room.get("players", {})),
            })

        for ws in list(self.active_connections.get("lobby", [])):
            if not await safe_send(ws, {
                "type": "LOBBY_UPDATE",
                "rooms": room_list
            }):
                try:
                    self.active_connections["lobby"].remove(ws)
                except ValueError:
                    pass


manager = GameManager()


# ============================================================
# X VS O: LÓGICA DEL JUEGO
# ============================================================

def new_xo_room(
    creator_id: str,
    creator: str,
    bet: float,
    is_public: bool,
    password: str,
    wallet: str
):
    room_id = uuid.uuid4().hex[:12]

    return room_id, {
        "room_id": room_id,
        "creator_id": creator_id,
        "creator": creator,
        "bet": round(bet, 2),
        "is_public": bool(is_public),
        "password": password if not is_public else "",
        "wallet": wallet,
        "players": {},
        "board": [None] * 9,
        "turn": "X",
        "status": "waiting",
        "finished": False,
        "settling": False,
        "created_at": time.time(),
    }


def xo_check_winner(board: list):
    lines = [
        (0, 1, 2),
        (3, 4, 5),
        (0, 3, 6),
        (1, 4, 7),
        (2, 5, 8),
        (0, 4, 8),
        (2, 4, 6),
    ]

    for a, b, c in lines:
        if board[a] and board[a] == board[b] == board[c]:
            return board[a]

    if all(cell is not None for cell in board):
        return "DRAW"

    return None


async def xo_send_players(room: dict, message: dict):
    for player in list(room["players"].values()):
        await safe_send(player["ws"], message)


async def xo_remove_room(room_id: str):
    room = lobbies.pop(room_id, None)
    room_locks.pop(room_id, None)

    if room:
        for player in list(room.get("players", {}).values()):
            try:
                await player["ws"].close()
            except Exception:
                pass

    await manager.broadcast_lobby()


# ============================================================
# WEBSOCKET LOBBY X VS O
# ============================================================

@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query("")
):
    await websocket.accept()

    if not user_id:
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "No se recibió el usuario."
        })
        await websocket.close(code=1008)
        return

    manager.active_connections.setdefault("lobby", []).append(websocket)

    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = data.get("type")

            if msg_type != "CREATE_ROOM":
                continue

            creator_id = str(data.get("user_id") or user_id)

            if creator_id != user_id:
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "El usuario de la solicitud no coincide."
                })
                continue

            creator = str(data.get("creator") or "Jugador").strip()[:40]
            wallet = str(data.get("wallet") or "play")

            try:
                bet = float(data.get("bet"))
            except (TypeError, ValueError):
                bet = 0

            is_public = bool(data.get("is_public", True))
            password = str(data.get("password") or "").strip()

            if wallet not in ("play", "bonus"):
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "La billetera seleccionada no es válida."
                })
                continue

            if not math.isfinite(bet) or bet < MIN_XO_BET:
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "La apuesta mínima es de $0.25."
                })
                continue

            if not is_public and not password:
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "Debes establecer una contraseña para la sala privada."
                })
                continue

            # La página ya descontó la apuesta mediante deduct_bet_balance.
            # No se vuelve a descontar desde el backend.
            room_id, room = new_xo_room(
                creator_id=creator_id,
                creator=creator,
                bet=bet,
                is_public=is_public,
                password=password,
                wallet=wallet
            )

            lobbies[room_id] = room
            room_locks[room_id] = asyncio.Lock()

            await safe_send(websocket, {
                "type": "ROOM_CREATED",
                "room_id": room_id,
                "password": password if not is_public else ""
            })

            await manager.broadcast_lobby()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR lobby X vs O: {exc!r}")
        traceback.print_exc()
    finally:
        try:
            manager.active_connections["lobby"].remove(websocket)
        except ValueError:
            pass


# ============================================================
# WEBSOCKET PARTIDA X VS O
# ============================================================

@app.websocket("/ws/game/{room_id}")
async def game_endpoint(
    websocket: WebSocket,
    room_id: str,
    password: str = Query(""),
    wallet: str = Query("play"),
    user_id: str = Query("")
):
    await websocket.accept()

    if not user_id:
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "No se recibió el usuario."
        })
        await websocket.close(code=1008)
        return

    if wallet not in ("play", "bonus"):
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "La billetera seleccionada no es válida."
        })
        await websocket.close(code=1008)
        return

    room = lobbies.get(room_id)

    if room is None:
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "La sala ya no existe o fue cerrada."
        })
        await websocket.close(code=1008)
        return

    lock = room_locks.get(room_id)

    if lock is None:
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "No se pudo encontrar el estado de la sala."
        })
        await websocket.close(code=1011)
        return

    registered = False
    player_symbol = None

    try:
        async with lock:
            if lobbies.get(room_id) is not room or room.get("finished"):
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "Esta partida ya terminó."
                })
                await websocket.close(code=1008)
                return

            if not room["is_public"] and password != room["password"]:
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "La contraseña de la sala es incorrecta."
                })
                await websocket.close(code=1008)
                return

            if user_id in room["players"]:
                await safe_send(websocket, {
                    "type": "ERROR",
                    "message": "Ya tienes una conexión en esta sala."
                })
                await websocket.close(code=1008)
                return

            if user_id == room["creator_id"]:
                if len(room["players"]) != 0:
                    await safe_send(websocket, {
                        "type": "ERROR",
                        "message": "El creador ya está conectado."
                    })
                    await websocket.close(code=1008)
                    return

                player_symbol = "X"
                is_host = True

            else:
                if len(room["players"]) != 1:
                    await safe_send(websocket, {
                        "type": "ERROR",
                        "message": "Esta sala ya está completa."
                    })
                    await websocket.close(code=1008)
                    return

                if room["status"] != "waiting":
                    await safe_send(websocket, {
                        "type": "ERROR",
                        "message": "La partida ya comenzó."
                    })
                    await websocket.close(code=1008)
                    return

                player_symbol = "O"
                is_host = False

            room["players"][user_id] = {
                "ws": websocket,
                "symbol": player_symbol,
                "wallet": wallet,
                "connected_at": time.time(),
            }

            registered = True

            if player_symbol == "O":
                room["status"] = "playing"

            await safe_send(websocket, {
                "type": "INIT",
                "room_id": room_id,
                "symbol": player_symbol,
                "is_host": is_host,
                "board": room["board"],
                "turn": room["turn"],
                "status": room["status"],
                "bet": room["bet"],
                "players_count": len(room["players"]),
            })

            if len(room["players"]) == 2:
                await xo_send_players(room, {
                    "type": "START",
                    "board": room["board"],
                    "turn": room["turn"],
                })

        await manager.broadcast_lobby()

        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = data.get("type")

            if msg_type == "PING":
                await safe_send(websocket, {"type": "PONG"})
                continue

            if msg_type == "MOVE":
                try:
                    index = int(data.get("index"))
                except (TypeError, ValueError):
                    continue

                async with lock:
                    if lobbies.get(room_id) is not room:
                        break

                    if room["finished"] or room["status"] != "playing":
                        continue

                    player = room["players"].get(user_id)

                    if not player:
                        continue

                    if player["symbol"] != room["turn"]:
                        continue

                    if index < 0 or index > 8:
                        continue

                    if room["board"][index] is not None:
                        continue

                    # El símbolo se determina en el servidor.
                    # No se confía en el símbolo enviado por el navegador.
                    symbol = player["symbol"]

                    room["board"][index] = symbol
                    result = xo_check_winner(room["board"])

                    next_turn = "O" if symbol == "X" else "X"
                    room["turn"] = next_turn

                    if result:
                        room["finished"] = True
                        room["status"] = "finished"

                    await xo_send_players(room, {
                        "type": "MOVE_MADE",
                        "board": room["board"],
                        "next_turn": next_turn,
                        "position": index,
                        "symbol": symbol,
                        "result": result,
                    })

                    if result:
                        await xo_send_players(room, {
                            "type": "GAME_FINISHED",
                            "result": result,
                            "winner_id": (
                                next(
                                    (
                                        uid
                                        for uid, p in room["players"].items()
                                        if p["symbol"] == result
                                    ),
                                    None
                                )
                                if result in ("X", "O")
                                else None
                            ),
                            "abandoner_id": None,
                        })

                continue

            if msg_type == "CLOSE_ROOM":
                async with lock:
                    if user_id != room["creator_id"]:
                        continue

                    if lobbies.get(room_id) is room:
                        for other_id, other in list(room["players"].items()):
                            if other_id != user_id:
                                await safe_send(other["ws"], {
                                    "type": "ROOM_CLOSED_BY_HOST"
                                })

                        room["finished"] = True
                        room["status"] = "closed"

                await xo_remove_room(room_id)
                break

            if msg_type in ("LEAVE", "ABANDON"):
                break

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR WebSocket X vs O {room_id}: {exc!r}")
        traceback.print_exc()
        await safe_send(websocket, {
            "type": "ERROR",
            "message": "Ocurrió un error interno en la partida."
        })
    finally:
        if registered:
            should_remove_room = False

            async with lock:
                current = lobbies.get(room_id)

                if current is room:
                    player = room["players"].get(user_id)

                    if player and player["ws"] is websocket:
                        room["players"].pop(user_id, None)

                    if user_id == room["creator_id"]:
                        # Si el creador sale, se cierra la sala.
                        should_remove_room = True
                    elif not room["finished"]:
                        # Si sale el segundo jugador, el creador puede
                        # permanecer en la sala esperando otro rival.
                        room["status"] = "waiting"
                        room["board"] = [None] * 9
                        room["turn"] = "X"

                        host = room["players"].get(room["creator_id"])
                        if host:
                            await safe_send(host["ws"], {
                                "type": "OPPONENT_LEFT",
                                "message": "El rival abandonó la sala."
                            })

            if should_remove_room:
                await xo_remove_room(room_id)
            else:
                await manager.broadcast_lobby()

        try:
            await websocket.close()
        except Exception:
            pass


# ============================================================
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 800
WORLD_HEIGHT = 800

SNAKE_SPEED = 7.5
SNAKE_BOOST_SPEED = 12.0

SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16
COIN_VALUE_MICROS = 100_000

SNAKE_MINIMUM_BET = 10.00
INITIAL_BALANCE_MICROS = 10_000_000

BOOST_COST_MICROS = 100_000
BOOST_COIN_INTERVAL = 1.0

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 40

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
            (150, 150, 0),
            (650, 650, math.pi),
            (650, 150, math.pi),
            (150, 650, 0),
            (400, 150, math.pi / 2),
            (400, 650, -math.pi / 2),
        ]

        occupied = [
            (snake["body"][0]["x"], snake["body"][0]["y"])
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
        pattern: str = "solid",
        eyes: str = "classic",
        accessory: str = "none"
    ):
        x, y, angle = self.create_spawn()

        self.snakes[user_id] = {
            "session_id": uuid.uuid4().hex,
            "body": create_snake_body(x, y, angle),
            "angle": angle,
            "score": 0,
            "kills": 0,
            "color": safe_color(color),
            "pattern": pattern if pattern in ("solid", "stripes", "spots", "neon") else "solid",
            "eyes": eyes if eyes in ("classic", "laser", "sleepy") else "classic",
            "accessory": accessory if accessory in ("none", "crown", "bandana", "halo") else "none",
            "wallet": wallet,
            "bet": float(bet),
            "balance_micros": INITIAL_BALANCE_MICROS,
            "entry_remaining_micros": INITIAL_BALANCE_MICROS,
            "collected_micros": 0,
            "earned_micros": 0,
            "earned": 0.0,
            "balance": money_from_micros(INITIAL_BALANCE_MICROS),
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
            distance = random.uniform(15, 50)

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

        if balance < BOOST_COST_MICROS:
            snake["boosting"] = False
            return False

        body = snake.get("body", [])

        if not body:
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
            if other_uid == user_id:
                continue

            if not other_snake.get("alive"):
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
                    killer["kills"] = int(killer.get("kills", 0)) + 1

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
                "pattern": snake.get("pattern", "solid"),
                "eyes": snake.get("eyes", "classic"),
                "accessory": snake.get("accessory", "none"),
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
            if not await safe_send(ws, message):
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
            print(f"ERROR en Snake game_loop {self.room_id}: {exc!r}")
            traceback.print_exc()
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
    bet: float = Query(SNAKE_MINIMUM_BET),
    wallet: str = Query("play"),
    color: str = Query("#34d399"),
    pattern: str = Query("solid"),
    eyes: str = Query("classic"),
    accessory: str = Query("none")
):
    await websocket.accept()

    room = None
    registered = False

    async def reject(message: str, code: int = 1008):
        await safe_send(websocket, {
            "type": "ERROR",
            "message": message
        })
        try:
            await websocket.close(code=code)
        except Exception:
            pass

    try:
        if not user_id or not access_token:
            await reject("Debes iniciar sesión para jugar.")
            return

        if wallet not in ("play", "bonus"):
            await reject("La billetera seleccionada no es válida.")
            return

        try:
            bet = float(bet)
        except (TypeError, ValueError):
            await reject("La apuesta no es válida.")
            return

        if not math.isfinite(bet) or bet < SNAKE_MINIMUM_BET:
            await reject("La apuesta mínima para Snake es de $10.00.")
            return

        if bet != SNAKE_MINIMUM_BET:
            await reject("La apuesta de entrada a Snake es de $10.00.")
            return

        if not await asyncio.to_thread(
            verify_user_token,
            access_token,
            user_id
        ):
            await reject("La sesión no es válida. Inicia sesión nuevamente.")
            return

        if not room_id or len(room_id) > 64:
            await reject("La sala indicada no es válida.")
            return

        room = snake_rooms.get(room_id)

        if room is None:
            room = SnakeRoom(room_id)
            snake_rooms[room_id] = room

        async with room.lock:
            if user_id in room.connections:
                await reject("Ya tienes una conexión activa en esta sala.")
                return

            if len(room.connections) >= 30:
                await reject(
                    "Esta sala está llena. Intenta entrar a otra sala.",
                    1013
                )
                return

            transaction_key = (
                f"snake-entry:{room_id}:{user_id}:{uuid.uuid4().hex}"
            )

            success, message = await asyncio.to_thread(
                deduct_balance,
                user_id,
                SNAKE_MINIMUM_BET,
                wallet,
                room_id,
                transaction_key
            )

            if not success:
                await reject(message)
                return

            room.connections[user_id] = websocket

            room.add_snake(
                user_id,
                SNAKE_MINIMUM_BET,
                wallet,
                color,
                pattern,
                eyes,
                accessory
            )

            registered = True

        await websocket.send_json(room.public_state())

        if not room.is_running:
            asyncio.create_task(room.game_loop())

        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = data.get("type")

            if msg_type == "PING":
                await safe_send(websocket, {"type": "PONG"})

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
                        and not snake.get("cashed_out", False)
                    ):
                        snake["boosting"] = False

                        balance_micros = max(
                            0,
                            int(snake.get("balance_micros", 0))
                        )

                        kills = int(snake.get("kills", 0))
                        wallet_used = snake["wallet"]

                        if kills == 0:
                            refund_micros = min(
                                int(snake.get("entry_remaining_micros", 0)),
                                balance_micros,
                                INITIAL_BALANCE_MICROS
                            )
                        else:
                            refund_micros = 0

                        payout_micros = max(
                            0,
                            balance_micros - refund_micros
                        )

                        refund = money_from_micros(refund_micros)
                        payout = money_from_micros(payout_micros)

                        transaction_key = (
                            f"snake-cashout:{room_id}:{user_id}:"
                            f"{snake['session_id']}"
                        )

                        snake["alive"] = False
                        snake["cashed_out"] = True

                        cashout_data = {
                            "refund": refund,
                            "payout": payout,
                            "wallet": wallet_used,
                            "transaction_key": transaction_key,
                        }

                if cashout_data is not None:
                    result = await asyncio.to_thread(
                        settle_snake_cashout,
                        user_id,
                        room_id,
                        cashout_data["wallet"],
                        cashout_data["refund"],
                        cashout_data["payout"],
                        cashout_data["transaction_key"]
                    )

                    if result.get("success"):
                        await safe_send(websocket, {
                            "type": "CASHOUT_SUCCESS",
                            "payout": float(result.get("payout", 0)),
                            "refund": float(result.get("refund", 0)),
                            "commission": float(result.get("commission", 0)),
                            "gross_total": float(result.get("gross_total", 0)),
                            "wallet": cashout_data["wallet"],
                            "message": "Retiro realizado correctamente. Comisión del 5% aplicada."
                        })
                    else:
                        async with room.lock:
                            snake = room.snakes.get(user_id)

                            if snake:
                                snake["alive"] = True
                                snake["cashed_out"] = False

                        await safe_send(websocket, {
                            "type": "ERROR",
                            "message": str(
                                result.get(
                                    "message",
                                    "No se pudo procesar el retiro."
                                )
                            )
                        })

                    await room.broadcast()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")
        traceback.print_exc()

        await safe_send(websocket, {
            "type": "ERROR",
            "message": "Ocurrió un error interno en Snake. Revisa los registros del servidor."
        })

        try:
            await websocket.close(code=1011)
        except Exception:
            pass

    finally:
        if room is not None and registered:
            async with room.lock:
                if room.connections.get(user_id) is websocket:
                    room.connections.pop(user_id, None)

                snake = room.snakes.get(user_id)

                if snake and snake.get("alive"):
                    room.kill_snake(snake)

                if not room.connections:
                    room.is_running = False

                    if snake_rooms.get(room_id) is room:
                        snake_rooms.pop(room_id, None)
