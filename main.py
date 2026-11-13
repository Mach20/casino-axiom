
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

SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhbGciOiJIUzI1NiIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTUxOTE3NywiZXhwIjoyMTA1MDk1MTc3fQ.45n4zgBGqXTtqI3LJOhefxSNckxnddsKGZjoSajkihM"

if not SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY == "PEGA_AQUI_TU_NUEVA_SERVICE_ROLE_KEY":
    raise RuntimeError("Falta configurar la SUPABASE_SERVICE_ROLE_KEY.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)

lobbies: Dict[str, dict] = {}
room_locks: Dict[str, asyncio.Lock] = {}
snake_rooms: Dict[str, dict] = {}


# ============================================================
# FUNCIONES GENERALES
# ============================================================

async def send_error(websocket: WebSocket, message: str):
    """Envía errores con un formato uniforme sin romper la conexión."""
    try:
        await websocket.send_json({
            "type": "ERROR",
            "message": str(message)
        })
    except Exception as exc:
        print(f"ERROR enviando mensaje WebSocket: {exc!r}")


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


# ============================================================
# INGRESO SNAKE CON COMISIÓN DEL 6%
# ============================================================

def enter_snake_game(
    user_id: str,
    bet: float,
    wallet: str,
    room_id: str,
    transaction_key: str
):
    if not user_id:
        return False, "No se recibió el ID del usuario.", 0

    if wallet not in ("play", "bonus"):
        return False, "Tipo de saldo no válido.", 0

    try:
        result = rpc_json("enter_snake_game", {
            "p_transaction_key": transaction_key,
            "p_room_id": room_id,
            "p_user_id": user_id,
            "p_wallet": wallet,
            "p_amount": round(float(bet), 2),
        })

        if not result.get("success"):
            return (
                False,
                str(result.get("message", "No se pudo procesar la entrada.")),
                0
            )

        playable_amount = float(result.get("playable_amount", 0))

        if not math.isfinite(playable_amount) or playable_amount <= 0:
            return (
                False,
                "El saldo inicial de Snake no es válido.",
                0
            )

        playable_micros = round(playable_amount * 1_000_000)

        return (
            True,
            str(result.get("message", "Entrada procesada correctamente.")),
            playable_micros
        )

    except Exception as exc:
        print(f"ERROR enter_snake_game: {exc!r}")
        return False, "No se pudo procesar la entrada a Snake.", 0


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
# ADMINISTRADOR DE CONEXIONES Y LOBBY
# ============================================================

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
            for room_id, room in list(lobbies.items())
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
# X VS O
# El frontend actual realiza el débito, la comisión y el premio.
# Este backend administra únicamente salas, conexiones y movimientos.
# ============================================================

def xo_player(user_id: str, wallet: str, bet: float, creator: str, is_host: bool):
    return {
        "user_id": user_id,
        "wallet": wallet,
        "bet": bet,
        "creator": creator,
        "symbol": "X" if is_host else "O",
        "is_host": is_host,
        "connected": False,
        "websocket": None,
    }


def xo_winner(board):
    lines = (
        (0, 1, 2), (3, 4, 5), (6, 7, 8),
        (0, 3, 6), (1, 4, 7), (2, 5, 8),
        (0, 4, 8), (2, 4, 6),
    )

    for a, b, c in lines:
        if board[a] is not None and board[a] == board[b] == board[c]:
            return board[a]

    return "DRAW" if all(cell is not None for cell in board) else None


async def xo_send(player: dict, payload: dict):
    ws = player.get("websocket")

    if ws is not None:
        try:
            await ws.send_json(payload)
        except Exception:
            pass


async def xo_remove_room(room_id: str):
    lobbies.pop(room_id, None)
    room_locks.pop(room_id, None)
    await manager.broadcast_lobby()


@app.get("/")
async def root():
    return {"status": "ok", "service": "AXIOM Game Backend"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


# ============================================================
# WEBSOCKET LOBBY X VS O
# ============================================================

@app.websocket("/ws/lobby")
async def lobby_endpoint(
    websocket: WebSocket,
    user_id: str = Query(""),
    access_token: str = Query(""),
):
    await websocket.accept()

    if not user_id:
        await send_error(websocket, "No se recibió el usuario.")
        await websocket.close()
        return

    manager.active_connections.setdefault("lobby", []).append(websocket)
    await manager.broadcast_lobby()

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict) or data.get("type") != "CREATE_ROOM":
                continue

            creator_id = str(data.get("user_id") or "")

            if creator_id != str(user_id):
                await send_error(websocket, "Usuario no autorizado.")
                continue

            wallet = str(data.get("wallet", "play")).lower()

            if wallet not in ("play", "bonus"):
                await send_error(websocket, "Billetera no válida.")
                continue

            try:
                bet = round(float(data.get("bet", 0)), 2)
            except (TypeError, ValueError):
                await send_error(websocket, "La apuesta no es válida.")
                continue

            if not math.isfinite(bet) or bet < 0.25 or bet > 10000:
                await send_error(websocket, "La apuesta mínima es $0.25.")
                continue

            already_active = any(
                str(creator_id) in room.get("players", {})
                and not room.get("finished", False)
                for room in lobbies.values()
            )

            if already_active:
                await send_error(websocket, "Ya tienes una sala activa.")
                continue

            is_public = bool(data.get("is_public", True))
            password = "" if is_public else str(data.get("password") or "").strip()

            if not is_public and not password:
                await send_error(
                    websocket,
                    "Debes establecer una contraseña para la sala privada."
                )
                continue

            room_id = uuid.uuid4().hex[:12]
            creator_name = str(data.get("creator") or "Jugador").strip()[:40] or "Jugador"
            host = xo_player(creator_id, wallet, bet, creator_name, True)

            # El frontend ya ejecuta el débito antes de CREATE_ROOM.
            lobbies[room_id] = {
                "room_id": room_id,
                "creator": creator_name,
                "creator_id": creator_id,
                "bet": bet,
                "is_public": is_public,
                "password": password,
                "players": {creator_id: host},
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
        connections = manager.active_connections.get("lobby", [])

        if websocket in connections:
            connections.remove(websocket)


# ============================================================
# WEBSOCKET PARTIDA X VS O
# ============================================================

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

    if not user_id:
        await send_error(websocket, "No se recibió el usuario.")
        await websocket.close()
        return

    wallet = str(wallet).lower()

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "Billetera no válida.")
        await websocket.close()
        return

    room = lobbies.get(room_id)
    lock = room_locks.get(room_id)

    if room is None or lock is None:
        await send_error(websocket, "La sala no existe o ya fue cerrada.")
        await websocket.close()
        return

    player = None

    try:
        async with lock:
            if room.get("finished"):
                await send_error(websocket, "La partida ya terminó.")
                await websocket.close()
                return

            if (
                not room.get("is_public", True)
                and str(room.get("password", "")) != str(password)
            ):
                await send_error(websocket, "Contraseña incorrecta.")
                await websocket.close()
                return

            player = room["players"].get(str(user_id))

            if player is None:
                if len(room["players"]) >= 2:
                    await send_error(websocket, "La sala está llena.")
                    await websocket.close()
                    return

                if str(user_id) == str(room["creator_id"]):
                    await send_error(websocket, "No puedes entrar dos veces a tu propia sala.")
                    await websocket.close()
                    return

                if any(
                    str(user_id) in other.get("players", {})
                    and not other.get("finished", False)
                    for rid, other in lobbies.items()
                    if rid != room_id
                ):
                    await send_error(websocket, "Ya tienes otra partida activa.")
                    await websocket.close()
                    return

                # El frontend ya descontó la apuesta al unirse.
                player = xo_player(
                    str(user_id),
                    wallet,
                    float(room["bet"]),
                    "Jugador",
                    False
                )

                room["players"][str(user_id)] = player

            if player.get("connected"):
                await send_error(websocket, "Ya tienes una conexión activa.")
                await websocket.close()
                return

            player["wallet"] = wallet
            player["connected"] = True
            player["websocket"] = websocket

            if len(room["players"]) == 2:
                host = room["players"].get(str(room["creator_id"]))

                guest = next(
                    (
                        p for uid, p in room["players"].items()
                        if uid != str(room["creator_id"])
                    ),
                    None
                )

                if host is None or guest is None:
                    await send_error(websocket, "No se pudieron identificar los jugadores.")
                    await websocket.close()
                    return

                host["symbol"] = "X"
                guest["symbol"] = "O"
                room["status"] = "PLAYING"

            await websocket.send_json({
                "type": "INIT",
                "room_id": room_id,
                "symbol": player["symbol"],
                "is_host": bool(player.get("is_host")),
                "board": list(room["board"]),
                "turn": room["turn"],
                "status": room["status"],
                "bet": room["bet"],
                "players_count": len(room["players"]),
            })

            if room["status"] == "PLAYING":
                for p in room["players"].values():
                    await xo_send(p, {
                        "type": "START",
                        "board": list(room["board"]),
                        "turn": room["turn"],
                    })

        await manager.broadcast_lobby()

        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = str(data.get("type", "")).upper()

            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type == "MOVE":
                async with lock:
                    if room.get("finished") or room.get("status") != "PLAYING":
                        continue

                    if room["players"].get(str(user_id)) is not player:
                        await send_error(websocket, "Jugador no válido.")
                        continue

                    if data.get("symbol") not in (None, player.get("symbol")):
                        await send_error(websocket, "Ficha no válida.")
                        continue

                    if room["turn"] != player.get("symbol"):
                        await send_error(websocket, "No es tu turno.")
                        continue

                    try:
                        index = int(data.get("index", -1))
                    except (TypeError, ValueError):
                        continue

                    if index < 0 or index > 8 or room["board"][index] is not None:
                        await send_error(websocket, "Movimiento no válido.")
                        continue

                    symbol = player["symbol"]
                    room["board"][index] = symbol

                    result = xo_winner(room["board"])
                    room["turn"] = "O" if symbol == "X" else "X"

                    move_payload = {
                        "type": "MOVE_MADE",
                        "board": list(room["board"]),
                        "next_turn": room["turn"],
                        "turn": room["turn"],
                        "symbol": symbol,
                        "index": index,
                    }

                    for p in room["players"].values():
                        await xo_send(p, move_payload)

                    if result is not None:
                        room["finished"] = True
                        room["status"] = "FINISHED"

                        winner_id = None

                        if result != "DRAW":
                            winner_id = next(
                                uid for uid, candidate in room["players"].items()
                                if candidate.get("symbol") == result
                            )

                        for p in room["players"].values():
                            await xo_send(p, {
                                "type": "GAME_FINISHED",
                                "result": "draw" if result == "DRAW" else "win",
                                "winner_id": winner_id,
                                "abandoner_id": None,
                            })

                await manager.broadcast_lobby()
                continue

            # El cierre voluntario se procesa en finally.
            # Si la partida ya comenzó, el rival gana por abandono.
            if msg_type == "CLOSE_ROOM":
                if not player.get("is_host"):
                    await send_error(websocket, "Solo el creador puede cerrar la sala.")
                    continue

                break

            if msg_type in ("LEAVE", "ABANDON"):
                break

    except WebSocketDisconnect:
        pass

    except Exception as exc:
        print(f"ERROR WebSocket XvO {room_id}: {exc!r}")
        await send_error(websocket, "Ocurrió un error en la partida.")

    finally:
        if room is not None and lock is not None:
            remove_room = False
            lobby_changed = False

            async with lock:
                current = room.get("players", {}).get(str(user_id))

                # Evita que una conexión vieja desconecte una conexión nueva.
                if current is player and current.get("websocket") is websocket:
                    current["connected"] = False
                    current["websocket"] = None

                    # Si la partida ya terminó normalmente, no se declara
                    # otro ganador por la desconexión posterior.
                    if room.get("finished"):
                        remove_room = True

                    # PARTIDA EN CURSO:
                    # el jugador que permanece conectado gana por abandono.
                    elif room.get("status") == "PLAYING":
                        winner_id = None
                        winner_player = None

                        for uid, other in room["players"].items():
                            if uid != str(user_id):
                                winner_id = uid
                                winner_player = other
                                break

                        room["finished"] = True
                        room["status"] = "FINISHED"

                        if winner_player is not None:
                            await xo_send(winner_player, {
                                "type": "GAME_FINISHED",
                                "result": "win",
                                "winner_id": winner_id,
                                "abandoner_id": str(user_id),
                                "reason": "abandonment",
                            })

                        # También se intenta informar al jugador que abandona.
                        await xo_send(current, {
                            "type": "GAME_FINISHED",
                            "result": "lose",
                            "winner_id": winner_id,
                            "abandoner_id": str(user_id),
                            "reason": "abandonment",
                        })

                        remove_room = True
                        lobby_changed = True

                    # SALA EN ESPERA:
                    # si se va el creador, se elimina la sala sin ganador.
                    elif current.get("is_host"):
                        room["finished"] = True
                        room["status"] = "FINISHED"

                        for uid, other in list(room["players"].items()):
                            if uid != str(user_id):
                                await xo_send(other, {
                                    "type": "ROOM_CLOSED_BY_HOST"
                                })

                        remove_room = True
                        lobby_changed = True

                    # SALA EN ESPERA:
                    # si se va el invitado, se libera el espacio y el
                    # creador puede seguir esperando a otro jugador.
                    else:
                        room["players"].pop(str(user_id), None)
                        room["board"] = [None] * 9
                        room["turn"] = "X"
                        room["status"] = "WAITING"

                        host = room["players"].get(str(room["creator_id"]))

                        if host:
                            await xo_send(host, {
                                "type": "INIT",
                                "room_id": room_id,
                                "symbol": "X",
                                "is_host": True,
                                "board": list(room["board"]),
                                "turn": "X",
                                "status": "WAITING",
                                "bet": room["bet"],
                                "players_count": 1,
                            })

                        lobby_changed = True

            if remove_room:
                await xo_remove_room(room_id)
            elif lobby_changed:
                await manager.broadcast_lobby()


# ============================================================
# SNAKE: CONFIGURACIÓN
# ============================================================

WORLD_WIDTH = 5000
WORLD_HEIGHT = 5000

SNAKE_SPEED = 7.5
SNAKE_BOOST_SPEED = 12.0

SNAKE_SEGMENT_DISTANCE = 10
SNAKE_INITIAL_LENGTH = 8

GAME_TICK = 1 / 30

COIN_RADIUS = 16
COIN_VALUE_MICROS = 100_000

# ÚNICAS APUESTAS PERMITIDAS
SNAKE_BETS = {
    "snake_020": 200_000,
    "snake_1000": 10_000_000,
    "snake_5000": 50_000_000,
}

BOOST_COST_MICROS = 100_000
BOOST_COIN_INTERVAL = 1.0

FOOD_RADIUS = 9
FOOD_INITIAL_COUNT = 200
MAX_SNAKE_PLAYERS = 30

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
# CONTROL GLOBAL DE SALAS SNAKE
# ============================================================

# La selección de sala y la reserva del espacio se realizan
# dentro de este mismo bloqueo para evitar carreras de conexiones.
snake_rooms_lock = asyncio.Lock()


def get_snake_bet_category(bet: float):
    try:
        bet_micros = round(float(bet) * 1_000_000)
    except (ValueError, TypeError, OverflowError):
        return None

    for category, amount in SNAKE_BETS.items():
        if bet_micros == amount:
            return category

    return None


def get_available_snake_room_locked(category: str):
    """
    IMPORTANTE: esta función debe llamarse teniendo adquirido
    snake_rooms_lock. Así no se selecciona simultáneamente
    el mismo último espacio de una sala.
    """

    available_rooms = []

    for room_id, room in snake_rooms.items():
        if not room_id.startswith(category + "_"):
            continue

        if room.bet_micros != SNAKE_BETS[category]:
            continue

        if len(room.connections) < MAX_SNAKE_PLAYERS:
            available_rooms.append(room)

    # Primero llena las salas que ya tienen más jugadores.
    if available_rooms:
        available_rooms.sort(
            key=lambda room: len(room.connections),
            reverse=True
        )
        return available_rooms[0]

    # Si todas están llenas, crea una nueva sala.
    number = 1

    while f"{category}_{number}" in snake_rooms:
        number += 1

    new_room_id = f"{category}_{number}"

    room = SnakeRoom(new_room_id)
    snake_rooms[new_room_id] = room

    print(
        f"NUEVA SALA SNAKE: {new_room_id} "
        f"APUESTA: ${room.bet:.2f}"
    )

    return room


# ============================================================
# SALAS SNAKE
# ============================================================

class SnakeRoom:

    def __init__(self, room_id: str):
        self.room_id = room_id

        category = room_id.rsplit("_", 1)[0]

        if category not in SNAKE_BETS:
            raise ValueError(f"Categoría Snake inválida: {room_id}")

        self.bet_micros = SNAKE_BETS[category]
        self.bet = money_from_micros(self.bet_micros)

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
            (850, 850, math.pi),
            (850, 150, math.pi),
            (150, 850, 0),
            (500, 150, math.pi / 2),
            (500, 850, -math.pi / 2),
        ]

        occupied = [
            (
                snake["body"][0]["x"],
                snake["body"][0]["y"]
            )
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

    # ========================================================
    # CREAR SERPIENTE CON SALDO NETO
    # ========================================================

    def add_snake(
        self,
        user_id: str,
        bet: float,
        wallet: str,
        color: str,
        session_id: str,
        playable_micros: int
    ):
        x, y, angle = self.create_spawn()

        bet_micros = self.bet_micros
        bet_amount = money_from_micros(bet_micros)

        playable_micros = max(0, int(playable_micros))
        playable_amount = money_from_micros(playable_micros)

        self.snakes[user_id] = {
            "session_id": session_id,

            "body": create_snake_body(x, y, angle),
            "angle": angle,

            "score": 0,
            "kills": 0,

            "color": safe_color(color),
            "wallet": wallet,

            "bet": bet_amount,
            "bet_micros": bet_micros,

            # La serpiente comienza con el 94% de la apuesta.
            "balance_micros": playable_micros,
            "entry_remaining_micros": playable_micros,
            "collected_micros": 0,

            "earned_micros": 0,
            "earned": 0.0,
            "balance": playable_amount,

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
        balance = max(
            0,
            int(snake.get("balance_micros", 0))
        )

        snake["balance_micros"] = balance
        snake["balance"] = money_from_micros(balance)

        earned = max(
            0,
            int(snake.get("collected_micros", 0))
        )

        snake["earned_micros"] = earned
        snake["earned"] = money_from_micros(earned)

    def drop_coins(self, snake: dict):
        if not snake.get("body"):
            return

        head = snake["body"][0]
        balance = int(snake.get("balance_micros", 0))

        if balance <= 0:
            return

        number_of_coins = math.ceil(
            balance / COIN_VALUE_MICROS
        )

        remaining = balance

        for _ in range(number_of_coins):
            if remaining <= 0:
                break

            value = min(
                COIN_VALUE_MICROS,
                remaining
            )

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

        entry_remaining = int(
            snake.get("entry_remaining_micros", 0)
        )

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
            "value": money_from_micros(BOOST_COST_MICROS),
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

            # Las monedas aumentan el saldo, no el tamaño.
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

            growth = max(
                1,
                int(food.get("growth", 1))
            )

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
            "room_id": self.room_id,
            "bet": self.bet,
            "players_count": len(self.connections),
            "max_players": MAX_SNAKE_PLAYERS,
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
            print(
                f"ERROR en Snake game_loop "
                f"{self.room_id}: {exc!r}"
            )

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
    bet: float = Query(0.20),
    wallet: str = Query("play"),
    color: str = Query("#34d399")
):
    await websocket.accept()

    if not user_id or not access_token:
        await send_error(websocket, "Debes iniciar sesión para jugar.")
        await websocket.close()
        return

    if not verify_user_token(access_token, user_id):
        await send_error(
            websocket,
            "La sesión no es válida. Inicia sesión nuevamente."
        )
        await websocket.close()
        return

    wallet = str(wallet).lower()

    if wallet not in ("play", "bonus"):
        await send_error(websocket, "La billetera seleccionada no es válida.")
        await websocket.close()
        return

    category = get_snake_bet_category(bet)

    if category is None:
        await send_error(
            websocket,
            "Apuesta no permitida. Solo puedes jugar con $0.20, $10 o $50."
        )
        await websocket.close()
        return

    bet_micros = SNAKE_BETS[category]
    bet = money_from_micros(bet_micros)

    # El frontend debe enviar la categoría correspondiente.
    # Se acepta snake_public por compatibilidad con el frontend anterior.
    if room_id not in (category, "snake_public"):
        await send_error(
            websocket,
            "La categoría de sala no corresponde a la apuesta."
        )
        await websocket.close()
        return

    room = None
    reserved = False

    # ========================================================
    # ASIGNACIÓN Y RESERVA ATÓMICA
    # No se libera el bloqueo entre seleccionar sala y reservar.
    # ========================================================

    async with snake_rooms_lock:
        already_playing = any(
            user_id in existing_room.connections
            for existing_room in snake_rooms.values()
        )

        if already_playing:
            await send_error(
                websocket,
                "Ya tienes una conexión activa en Snake."
            )
            await websocket.close()
            return

        room = get_available_snake_room_locked(category)

        async with room.lock:
            if len(room.connections) >= MAX_SNAKE_PLAYERS:
                await send_error(
                    websocket,
                    "No se pudo reservar el espacio. Intenta nuevamente."
                )
                await websocket.close()
                return

            if user_id in room.connections:
                await send_error(
                    websocket,
                    "Ya tienes una conexión activa en esta sala."
                )
                await websocket.close()
                return

            # Una sesión nueva tiene una clave de transacción propia.
            session_id = uuid.uuid4().hex

            transaction_key = (
                f"snake-entry:{room.room_id}:{user_id}:{session_id}"
            )

            # Descuenta la apuesta completa y registra la comisión del 6%.
            success, message, playable_micros = enter_snake_game(
                user_id,
                bet,
                wallet,
                room.room_id,
                transaction_key
            )

            if not success:
                await send_error(websocket, message)
                await websocket.close()
                return

            # Crea la serpiente con el saldo neto del 94%.
            room.add_snake(
                user_id,
                bet,
                wallet,
                color,
                session_id,
                playable_micros
            )

            room.connections[user_id] = websocket

            reserved = True

    if not reserved or room is None:
        try:
            await websocket.close()
        except Exception:
            pass
        return

    try:
        await websocket.send_json(room.public_state())

    except Exception as exc:
        print(f"ERROR enviando estado inicial Snake: {exc!r}")

    if not room.is_running:
        asyncio.create_task(room.game_loop())

    try:
        while True:
            data = await websocket.receive_json()

            if not isinstance(data, dict):
                continue

            msg_type = str(data.get("type", "")).upper()

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

                        if (
                            snake
                            and snake["alive"]
                            and snake["ready"]
                        ):
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
                                int(snake.get("bet_micros", 0))
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
                            f"snake-cashout:{room.room_id}:{user_id}:"
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
                    paid, payment_message = settle_snake_cashout(
                        user_id=user_id,
                        room_id=room.room_id,
                        wallet=cashout_data["wallet"],
                        refund=cashout_data["refund"],
                        payout=cashout_data["payout"],
                        transaction_key=cashout_data["transaction_key"]
                    )

                    if paid:
                        await websocket.send_json({
                            "type": "CASHOUT_SUCCESS",
                            "payout": cashout_data["payout"],
                            "refund": cashout_data["refund"],
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
        print(f"ERROR WebSocket Snake {room.room_id}: {exc!r}")

    finally:
        async with room.lock:
            if room.connections.get(user_id) is websocket:
                room.connections.pop(user_id, None)

            snake = room.snakes.get(user_id)

            if snake and snake.get("alive"):
                room.kill_snake(snake)

            # La sala queda disponible para nuevos jugadores.
            if not room.connections:
                room.is_running = False

                room.snakes.clear()
                room.coins.clear()
                room.foods.clear()

                room.spawn_food(FOOD_INITIAL_COUNT)

                print(f"SALA SNAKE DISPONIBLE: {room.room_id}")
