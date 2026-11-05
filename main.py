
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
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"


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


# ============================================================
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 1920
WORLD_HEIGHT = 1080

# Velocidad aumentada
SNAKE_SPEED = 7.5
SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16

# Todos los jugadores empiezan con $1.00.
INITIAL_BALANCE_MICROS = 1_000_000

# Cada fragmento vale exactamente $0.10.
COIN_VALUE_MICROS = 100_000

MAX_BET = 1000.00
MIN_BET = 0.01

# No hay vencimiento automático de fragmentos.
MAX_COINS_PER_DROP = 10000


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

        # Ya no existe comida que genere dinero.
        self.foods = []

        # Fragmentos de saldo de jugadores eliminados.
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

            # La apuesta real inicial es $1.00.
            "bet": 1.00,

            # Saldo acumulado de la serpiente.
            "balance_micros": INITIAL_BALANCE_MICROS,

            # Campos de compatibilidad con el frontend anterior.
            "earned_micros": 0,
            "earned": 0.0,
            "balance": 1.00,

            "alive": True,
            "ready": False,
            "cashed_out": False,
            "grow_pending": 0,
            "created_at": time.time(),
        }

    def update_balance(self, snake: dict):
        balance = int(snake.get("balance_micros", 0))

        snake["balance"] = money_from_micros(balance)

        # Ganancia acumulada por encima del dólar inicial.
        earned = max(0, balance - INITIAL_BALANCE_MICROS)

        snake["earned_micros"] = earned
        snake["earned"] = money_from_micros(earned)

    # ========================================================
    # CONVERTIR EL SALDO DE UNA SERPIENTE EN FRAGMENTOS
    # ========================================================

    def drop_coins(self, snake: dict):
        if not snake.get("body"):
            return

        head = snake["body"][0]

        balance = int(snake.get("balance_micros", 0))

        if balance <= 0:
            return

        # Cada fragmento vale $0.10.
        number_of_coins = balance // COIN_VALUE_MICROS

        # Todos los saldos del juego deben ser múltiplos de $0.10.
        # Si hubiera algún resto por datos antiguos, se conserva
        # como un fragmento adicional para no perder valor.
        remainder = balance % COIN_VALUE_MICROS

        if remainder:
            number_of_coins += 1

        number_of_coins = min(
            number_of_coins,
            MAX_COINS_PER_DROP
        )

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
                "id": f"coin_{random.randint(100000, 999999999)}",
                "x": x,
                "y": y,
                "value_micros": value,
                "value": money_from_micros(value),
            })

            remaining -= value

        # El saldo de la serpiente eliminada se convierte en fragmentos.
        snake["balance_micros"] = 0
        snake["balance"] = 0.0
        snake["earned_micros"] = 0
        snake["earned"] = 0.0

    # ========================================================
    # ELIMINAR SERPIENTE
    # ========================================================

    def kill_snake(self, snake: dict):
        if not snake.get("alive"):
            return

        snake["alive"] = False

        # Su saldo completo queda repartido en el mapa.
        self.drop_coins(snake)

    # ========================================================
    # RECOGER FRAGMENTOS
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

        if not collected:
            return

        for coin in collected:
            if coin not in self.coins:
                continue

            self.coins.remove(coin)

            value = int(coin["value_micros"])

            # Sumar el valor del fragmento al saldo.
            snake["balance_micros"] += value

            # Crecer por cada fragmento recogido.
            snake["grow_pending"] = (
                snake.get("grow_pending", 0) + 1
            )

            snake["score"] += 1

        self.update_balance(snake)

    # ========================================================
    # COLISIONES
    # ========================================================

    def check_collision(self, user_id: str, new_head: dict) -> bool:
        snake = self.snakes[user_id]

        # 1. Morir al chocar con los bordes.
        if (
            new_head["x"] < 8
            or new_head["x"] > WORLD_WIDTH - 8
            or new_head["y"] < 8
            or new_head["y"] > WORLD_HEIGHT - 8
        ):
            return True

        # 2. No hay colisión contra el propio cuerpo.
        # La serpiente puede cruzar sobre sí misma.

        # 3. Morir al chocar contra otra serpiente.
        for other_uid, other_snake in self.snakes.items():
            if other_uid == user_id:
                continue

            if not other_snake.get("alive"):
                continue

            other_body = other_snake.get("body", [])

            for segment in other_body:
                if math.hypot(
                    new_head["x"] - segment["x"],
                    new_head["y"] - segment["y"]
                ) < 14:
                    return True

        return False

    # ========================================================
    # MOVIMIENTO
    # ========================================================

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

        # Únicas causas de muerte:
        # bordes del mapa u otra serpiente.
        if self.check_collision(user_id, new_head):
            self.kill_snake(snake)
            return

        snake["body"].insert(0, new_head)

        # Recoger fragmentos de otros jugadores.
        self.collect_coins(snake, new_head)

        # Aplicar crecimiento.
        if snake.get("grow_pending", 0) > 0:
            snake["grow_pending"] -= 1
        else:
            snake["body"].pop()

    # ========================================================
    # ESTADO PÚBLICO
    # ========================================================

    def public_state(self):
        public_snakes = {}

        for uid, snake in self.snakes.items():
            public_snakes[uid] = {
                "body": snake["body"],
                "angle": snake["angle"],
                "score": snake["score"],
                "color": snake["color"],
                "wallet": snake["wallet"],
                "bet": snake["bet"],
                "balance": snake["balance"],
                "balance_micros": snake["balance_micros"],
                "earned": snake["earned"],
                "earned_micros": snake["earned_micros"],
                "alive": snake["alive"],
                "ready": snake["ready"],
            }

        return {
            "type": "GAME_STATE",
            "snakes": public_snakes,

            # Se mantiene foods vacío para compatibilidad.
            "foods": [],

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

    # ========================================================
    # MOTOR DEL JUEGO
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

                await self.broadcast()
                await asyncio.sleep(GAME_TICK)

        except Exception as exc:
            print(
                f"ERROR en Snake game_loop {self.room_id}: {exc!r}"
            )

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

    # 2. Todos comienzan con una apuesta fija de $1.00.
    bet = 1.00

    if wallet not in ("play", "bonus"):
        await websocket.send_json({
            "type": "ERROR",
            "message": "La billetera seleccionada no es válida."
        })
        await websocket.close()
        return

    # 3. Crear o recuperar sala.
    if room_id not in snake_rooms:
        snake_rooms[room_id] = SnakeRoom(room_id)

    room = snake_rooms[room_id]

    # Evitar conexiones duplicadas del mismo usuario.
    old_connection = room.connections.get(user_id)

    if old_connection:
        try:
            await old_connection.close()
        except Exception:
            pass

        room.connections.pop(user_id, None)

    # 4. Descontar una sola apuesta inicial de $1.00.
    transaction_key = (
        f"snake:{room_id}:{user_id}:"
        f"{random.randint(100000, 999999999)}"
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

    # 5. Registrar jugador.
    async with room.lock:
        room.connections[user_id] = websocket
        room.add_snake(user_id, bet, wallet, color)

    # 6. Estado inicial.
    try:
        await websocket.send_json(room.public_state())
    except Exception as exc:
        print(
            f"ERROR enviando estado inicial Snake: {exc!r}"
        )

    # 7. Iniciar motor.
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

                        payout = money_from_micros(
                            snake.get("balance_micros", 0)
                        )

                        earned = snake.get("earned", 0.0)

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
        print(
            f"ERROR WebSocket Snake {room_id}: {exc!r}"
        )

    finally:
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

