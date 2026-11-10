import os
import random
import asyncio
import math
import time
import uuid
from typing import Dict, List

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
                await ws.send_json({
                    "type": "LOBBY_UPDATE",
                    "rooms": room_list
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
        result = rpc_json("settle_snake_cashout", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_refund_amount": round(float(refund), 2),
            "p_payout_amount": round(float(payout), 2),
        })
        return result
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


# ============================================================
# X VS O: SE CONSERVA LA IMPLEMENTACIÓN ORIGINAL
# ============================================================

@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query("")
):
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
async def game_endpoint(
    websocket: WebSocket,
    room_id: str,
    password: str = Query(""),
    wallet: str = Query("play"),
    user_id: str = Query(""),
    access_token: str = Query("")
):
    await websocket.accept()
    await websocket.close()


# ============================================================
# SNAKE: CONFIGURACIÓN (MAPA REDUCIDO A 800x800)
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
# La comisión del 5% se calcula únicamente en settle_snake_cashout (SQL).
SNAKE_MINIMUM_BET = 10.00
INITIAL_BALANCE_MICROS = 10_000_000

# Un fragmento de $0.10 por cada segundo de impulso.
BOOST_COST_MICROS = 100_000
BOOST_COIN_INTERVAL = 1.0

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 40  # Ajustado proporcionalmente al nuevo mapa de 800x800

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
    body = []

    for i in range(SNAKE_INITIAL_LENGTH):
        body.append({
            "x": x - math.cos(angle) * i * SNAKE_SEGMENT_DISTANCE,
            "y": y - math.sin(angle) * i * SNAKE_SEGMENT_DISTANCE,
        })

    return body


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
        # Puntos de aparición adaptados al mapa de 800x800
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
            import traceback
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
    color: str = Query("#34d399")
):
    await websocket.accept()
    room = None
    registered = False

    async def reject(message: str, code: int = 1008):
        try:
            await websocket.send_json({"type": "ERROR", "message": message})
        except Exception:
            pass
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

        # Snake tiene una apuesta mínima de $10. No se acepta un importe inferior.
        try:
            bet = float(bet)
        except (TypeError, ValueError):
            await reject("La apuesta no es válida.")
            return

        if not math.isfinite(bet) or bet < SNAKE_MINIMUM_BET:
            await reject("La apuesta mínima para Snake es de $10.00.")
            return

        if bet != SNAKE_MINIMUM_BET:
            # La entrada de Snake queda fijada en $10 por esta versión.
            await reject("La apuesta de entrada a Snake es de $10.00.")
            return

        if not await asyncio.to_thread(verify_user_token, access_token, user_id):
            await reject("La sesión no es válida. Inicia sesión nuevamente.")
            return

        if not room_id or len(room_id) > 64:
            await reject("La sala indicada no es válida.")
            return

        room = snake_rooms.get(room_id)
        if room is None:
            room = SnakeRoom(room_id)
            snake_rooms[room_id] = room

        # Serializar validación, débito y registro para impedir dobles entradas
        # del mismo usuario en una misma sala por conexiones simultáneas.
        async with room.lock:
            if user_id in room.connections:
                await reject("Ya tienes una conexión activa en esta sala.")
                return
            if len(room.connections) >= 30:
                await reject("Esta sala está llena. Intenta entrar a otra sala.", 1013)
                return

            transaction_key = f"snake-entry:{room_id}:{user_id}:{uuid.uuid4().hex}"
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
            room.add_snake(user_id, SNAKE_MINIMUM_BET, wallet, color)
            registered = True

        await websocket.send_json(room.public_state())

        if not room.is_running:
            asyncio.create_task(room.game_loop())

        while True:
            data = await websocket.receive_json()
            if not isinstance(data, dict):
                continue
            msg_type = data.get("type")

            # Heartbeat de aplicación: el frontend envía PING periódicamente.
            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})

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
                        snake and snake["alive"] and snake["ready"]
                        and snake["balance_micros"] >= BOOST_COST_MICROS
                    ):
                        if not snake.get("boosting"):
                            snake["boosting"] = True
                            snake["next_boost_coin_at"] = time.monotonic() + BOOST_COIN_INTERVAL
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
                        snake and snake["alive"] and snake["ready"]
                        and not snake.get("cashed_out", False)
                    ):
                        snake["boosting"] = False
                        balance_micros = max(0, int(snake.get("balance_micros", 0)))
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

                        payout_micros = max(0, balance_micros - refund_micros)
                        refund = money_from_micros(refund_micros)
                        payout = money_from_micros(payout_micros)
                        transaction_key = f"snake-cashout:{room_id}:{user_id}:{snake['session_id']}"

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
                        await websocket.send_json({
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
                        await websocket.send_json({
                            "type": "ERROR",
                            "message": str(result.get("message", "No se pudo procesar el retiro."))
                        })
                    await room.broadcast()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        # Loguear traceback completo permite localizar la causa real del cierre 1006 en Render.
        import traceback
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")
        traceback.print_exc()
        try:
            await websocket.send_json({
                "type": "ERROR",
                "message": "Ocurrió un error interno en Snake. Revisa los registros del servidor."
            })
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

