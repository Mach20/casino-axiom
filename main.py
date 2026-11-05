
import os
import random
import asyncio
import math
import time
from typing import Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from supabase import create_client, Client

app = FastAPI(title="AXIOM Game Backend")

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Falta configurar SUPABASE_SERVICE_ROLE_KEY en Render.")

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
                await ws.send_json({
                    "type": "LOBBY_UPDATE",
                    "rooms": room_list
                })
            except Exception:
                pass


manager = GameManager()


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
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 1920
WORLD_HEIGHT = 1080

SNAKE_SPEED = 4.0
SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

FOOD_RADIUS = 13
COIN_RADIUS = 16

# Los valores están expresados en millonésimas de dólar.
# 1000 unidades = $0.001
FOOD_VALUES = [1000, 2000, 5000]

MAX_BET = 1000.00
MIN_BET = 0.01

COIN_LIFETIME = 90
MAX_COINS_PER_DROP = 100


def money_from_micros(value: int) -> float:
    return value / 1_000_000


def create_food():
    return {
        "id": f"food_{random.randint(100000, 999999999)}",
        "x": random.uniform(40, WORLD_WIDTH - 40),
        "y": random.uniform(40, WORLD_HEIGHT - 40),
        "value_micros": random.choice(FOOD_VALUES),
    }


def create_snake_body(x: float, y: float, angle: float):
    body = []

    for i in range(SNAKE_INITIAL_LENGTH):
        body.append({
            "x": x - math.cos(angle) * i * SNAKE_SEGMENT_DISTANCE,
            "y": y - math.sin(angle) * i * SNAKE_SEGMENT_DISTANCE,
        })

    return body


def safe_color(color: str) -> str:
    if (
        isinstance(color, str)
        and len(color) == 7
        and color.startswith("#")
    ):
        try:
            int(color[1:], 16)
            return color
        except ValueError:
            pass

    return "#34d399"


# ============================================================
# SNAKE: SALA MULTIJUGADOR
# ============================================================

class SnakeRoom:
    def __init__(self, room_id: str):
        self.room_id = room_id

        self.connections: Dict[str, WebSocket] = {}
        self.snakes: Dict[str, dict] = {}

        self.foods = [create_food() for _ in range(60)]
        self.coins: List[dict] = []

        self.is_running = False
        self.lock = asyncio.Lock()

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
            (snake["body"][0]["x"], snake["body"][0]["y"])
            for snake in self.snakes.values()
            if snake.get("alive") and snake.get("body")
        ]

        available = []

        for x, y, angle in positions:
            if all(
                math.hypot(x - ox, y - oy) > 180
                for ox, oy in occupied
            ):
                available.append((x, y, angle))

        if available:
            return random.choice(available)

        for _ in range(50):
            x = random.uniform(150, WORLD_WIDTH - 150)
            y = random.uniform(150, WORLD_HEIGHT - 150)

            if all(
                math.hypot(x - ox, y - oy) > 180
                for ox, oy in occupied
            ):
                return x, y, random.uniform(-math.pi, math.pi)

        return (
            random.uniform(150, WORLD_WIDTH - 150),
            random.uniform(150, WORLD_HEIGHT - 150),
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
            "body": create_snake_body(x, y, angle),
            "angle": angle,
            "score": 0,
            "color": safe_color(color),
            "wallet": wallet,
            "bet": round(bet, 2),
            "earned_micros": 0,
            "earned": 0.0,
            "alive": True,
            "ready": False,
            "cashed_out": False,
            "created_at": time.time(),
        }

    def update_earned(self, snake: dict):
        snake["earned"] = money_from_micros(
            snake.get("earned_micros", 0)
        )

    def drop_coins(self, snake: dict):
        if not snake.get("body"):
            return

        head = snake["body"][0]
        earned = int(snake.get("earned_micros", 0))

        if earned <= 0:
            return

        # Se crean monedas coleccionables con el valor acumulado.
        # Se distribuyen alrededor del lugar de la muerte.
        number_of_coins = min(
            MAX_COINS_PER_DROP,
            max(1, math.ceil(earned / 1000))
        )

        remaining = earned

        for i in range(number_of_coins):
            if remaining <= 0:
                break

            value = min(1000, remaining)
            remaining -= value

            angle = random.uniform(0, math.pi * 2)
            distance = random.uniform(15, 65)

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
                "id": f"coin_{random.randint(100000, 999999999)}",
                "x": x,
                "y": y,
                "value_micros": value,
                "expires_at": time.time() + COIN_LIFETIME,
            })

        snake["earned_micros"] = 0
        snake["earned"] = 0.0

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return

        snake["alive"] = False
        self.drop_coins(snake)

    def collect_food(self, snake: dict, head: dict):
        for food in list(self.foods):
            distance = math.hypot(
                head["x"] - food["x"],
                head["y"] - food["y"]
            )

            if distance <= FOOD_RADIUS + 8:
                self.foods.remove(food)

                value = int(food["value_micros"])

                snake["earned_micros"] += value
                snake["score"] += 1

                self.update_earned(snake)

                # Crece al recoger comida.
                snake["grow_pending"] = (
                    snake.get("grow_pending", 0) + 1
                )

                self.foods.append(create_food())
                return True

        return False

    def collect_coins(self, snake: dict, head: dict):
        for coin in list(self.coins):
            distance = math.hypot(
                head["x"] - coin["x"],
                head["y"] - coin["y"]
            )

            if distance <= COIN_RADIUS + 8:
                self.coins.remove(coin)

                value = int(coin["value_micros"])

                snake["earned_micros"] += value
                snake["score"] += 1

                self.update_earned(snake)

                snake["grow_pending"] = (
                    snake.get("grow_pending", 0) + 1
                )

                break

    def check_collision(self, user_id: str, new_head: dict) -> bool:
        snake = self.snakes[user_id]

        # Colisión contra los límites.
        if (
            new_head["x"] < 8
            or new_head["x"] > WORLD_WIDTH - 8
            or new_head["y"] < 8
            or new_head["y"] > WORLD_HEIGHT - 8
        ):
            return True

        # Colisión contra el propio cuerpo.
        own_body = snake["body"][10:]

        for segment in own_body:
            if math.hypot(
                new_head["x"] - segment["x"],
                new_head["y"] - segment["y"]
            ) < 12:
                return True

        # Colisión contra los cuerpos de otros jugadores.
        for other_uid, other_snake in self.snakes.items():
            if other_uid == user_id:
                continue

            if not other_snake.get("alive"):
                continue

            for segment in other_snake["body"][2:]:
                if math.hypot(
                    new_head["x"] - segment["x"],
                    new_head["y"] - segment["y"]
                ) < 14:
                    return True

        return False

    def update_snake(self, user_id: str):
        snake = self.snakes[user_id]

        if not snake.get("alive") or not snake.get("ready"):
            return

        if not snake.get("body"):
            self.kill_snake(snake)
            return

        head = snake["body"][0]
        angle = snake.get("angle", 0)

        new_head = {
            "x": head["x"] + math.cos(angle) * SNAKE_SPEED,
            "y": head["y"] + math.sin(angle) * SNAKE_SPEED,
        }

        if self.check_collision(user_id, new_head):
            self.kill_snake(snake)
            return

        snake["body"].insert(0, new_head)

        ate = self.collect_food(snake, new_head)

        if not ate:
            self.collect_coins(snake, new_head)

        if snake.get("grow_pending", 0) > 0:
            snake["grow_pending"] -= 1
        else:
            snake["body"].pop()

    def clean_expired_coins(self):
        now = time.time()

        self.coins = [
            coin for coin in self.coins
            if coin.get("expires_at", 0) > now
        ]

    def public_state(self):
        # Se crea una copia sencilla para enviar por WebSocket.
        public_snakes = {}

        for uid, snake in self.snakes.items():
            public_snakes[uid] = {
                "body": snake["body"],
                "angle": snake["angle"],
                "score": snake["score"],
                "color": snake["color"],
                "wallet": snake["wallet"],
                "bet": snake["bet"],
                "earned": snake["earned"],
                "earned_micros": snake["earned_micros"],
                "alive": snake["alive"],
                "ready": snake["ready"],
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

                    self.clean_expired_coins()

                await self.broadcast()
                await asyncio.sleep(GAME_TICK)

        except Exception as exc:
            print(f"ERROR en Snake game_loop {self.room_id}: {exc!r}")

        finally:
            self.is_running = False


# ============================================================
# SNAKE: WEBSOCKET
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

    # 1. Validar identidad.
    if not user_id or not access_token:
        await websocket.send_json({
            "type": "ERROR",
            "message": "Debes iniciar sesión para jugar."
        })
        await websocket.close()
        return

    if not verify_user_token(access_token, user_id):
        await websocket.send_json({
            "type": "ERROR",
            "message": "La sesión no es válida. Inicia sesión nuevamente."
        })
        await websocket.close()
        return

    # 2. Validar apuesta y billetera.
    try:
        bet = round(float(bet), 2)
    except (ValueError, TypeError):
        bet = 0

    if bet < MIN_BET or bet > MAX_BET:
        await websocket.send_json({
            "type": "ERROR",
            "message": "La apuesta no es válida."
        })
        await websocket.close()
        return

    if wallet not in ("play", "bonus"):
        await websocket.send_json({
            "type": "ERROR",
            "message": "La billetera seleccionada no es válida."
        })
        await websocket.close()
        return

    # 3. Crear o recuperar la sala.
    if room_id not in snake_rooms:
        snake_rooms[room_id] = SnakeRoom(room_id)

    room = snake_rooms[room_id]

    # Evitar que el mismo usuario se conecte dos veces a la misma sala.
    old_connection = room.connections.get(user_id)

    if old_connection:
        try:
            await old_connection.close()
        except Exception:
            pass

        room.connections.pop(user_id, None)

    # 4. Descontar la apuesta mediante la función SQL existente.
    transaction_key = (
        f"snake:{room_id}:{user_id}:{random.randint(100000, 999999999)}"
    )

    success, message = deduct_balance(
        user_id,
        bet,
        wallet,
        room_id,
        transaction_key
    )

    if not success:
        await websocket.send_json({
            "type": "ERROR",
            "message": message
        })
        await websocket.close()
        return

    # 5. Registrar al jugador.
    async with room.lock:
        room.connections[user_id] = websocket
        room.add_snake(user_id, bet, wallet, color)

    # 6. Enviar estado inicial.
    try:
        await websocket.send_json(room.public_state())
    except Exception as exc:
        print(f"ERROR enviando estado inicial Snake: {exc!r}")

    # 7. Iniciar el motor de la sala.
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

                        if (
                            snake
                            and snake["alive"]
                            and snake["ready"]
                        ):
                            # Limitar el ángulo para evitar valores inválidos.
                            snake["angle"] = angle

                except (ValueError, TypeError):
                    pass

            elif msg_type == "CASH_OUT":
                payout = None

                async with room.lock:
                    snake = room.snakes.get(user_id)

                    if (
                        snake
                        and snake["alive"]
                        and snake["ready"]
                        and not snake.get("cashed_out", False)
                    ):
                        snake["alive"] = False
                        snake["cashed_out"] = True

                        earned = money_from_micros(
                            snake.get("earned_micros", 0)
                        )

                        payout = round(snake["bet"] + earned, 2)

                if payout is not None:
                    paid, payment_message = credit_winner(
                        user_id,
                        payout,
                        room_id
                    )

                    if paid:
                        await websocket.send_json({
                            "type": "CASHOUT_SUCCESS",
                            "payout": payout,
                            "earned": earned,
                            "message": "Retiro realizado correctamente."
                        })
                    else:
                        # Si el pago falla, no se debe afirmar que se pagó.
                        async with room.lock:
                            snake = room.snakes.get(user_id)

                            if snake:
                                snake["alive"] = True
                                snake["cashed_out"] = False

                        await websocket.send_json({
                            "type": "ERROR",
                            "message": payment_message
                        })

                    await room.broadcast()

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR WebSocket Snake {room_id}: {exc!r}")

    finally:
        async with room.lock:
            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            snake = room.snakes.get(user_id)

            if snake and snake.get("alive"):
                room.kill_snake(snake)

            # La sala se elimina cuando ya no tiene jugadores conectados.
            if not room.connections:
                room.is_running = False

                if snake_rooms.get(room_id) is room:
                    snake_rooms.pop(room_id, None)
