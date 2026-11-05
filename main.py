from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from typing import Dict, List, Tuple
import random
from supabase import create_client, Client

app = FastAPI()

SUPABASE_URL = "https://djdzytfdztctusnuuvrm.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqZHp5dGZkenRjdHVzbnV1dnJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MTkxNzcsImV4cCI6MjEwNTA5NTE3N30.Pvqp1Hl4zfKzQj0pxrohZaj1sHR9HJAT1ESPv2P-ot4"
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

lobbies: Dict[str, dict] = {}

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
                "room_id": rid,
                "creator": r["creator"],
                "bet": r["bet"],
                "is_public": r["is_public"],
                "players_count": len(r["players"])
            }
            for rid, r in lobbies.items() if len(r["players"]) < 2
        ]
        
        if "lobby" in self.active_connections:
            for ws in self.active_connections["lobby"]:
                try:
                    await ws.send_json({"type": "LOBBY_UPDATE", "rooms": room_list})
                except:
                    pass

manager = GameManager()

def deduct_balance(user_id: str, bet: float, wallet: str) -> Tuple[bool, str]:
    """Descuenta la apuesta e informa el motivo real si no puede hacerlo."""
    try:
        if not user_id:
            return False, "No se recibió el ID del usuario."

        if wallet not in ("play", "bonus"):
            return False, "Tipo de saldo no válido."

        if bet < 0.10:
            return False, "La apuesta mínima es de $0.10."

        column = "bonus_balance" if wallet == "bonus" else "balance"
        print(
            f"Intentando descontar ${bet:.2f} de {column} "
            f"para el usuario {user_id}"
        )

        res = (
            supabase.table("profiles")
            .select(f"id, {column}")
            .eq("id", user_id)
            .execute()
        )

        if not res.data:
            print(f"ERROR: No existe perfil para user_id={user_id}")
            return False, "No se encontró el perfil de tu cuenta."

        profile = res.data[0]
        current_val = float(profile.get(column) or 0.0)
        print(f"Saldo consultado: {current_val:.2f}; apuesta: {bet:.2f}")

        if current_val < bet:
            return False, (
                f"Saldo insuficiente. Disponible: ${current_val:.2f}; "
                f"apuesta: ${bet:.2f}."
            )

        new_val = round(current_val - bet, 2)
        update_res = (
            supabase.table("profiles")
            .update({column: new_val})
            .eq("id", user_id)
            .select("id")
            .execute()
        )

        if not update_res.data:
            print("ERROR: Supabase no confirmó la actualización del saldo.")
            return False, "Supabase no confirmó el descuento del saldo."

        print(f"DESCUENTO CORRECTO: {current_val:.2f} -> {new_val:.2f}")
        return True, ""

    except Exception as e:
        print(f"ERROR REAL EN deduct_balance: {repr(e)}")
        return False, "Error al consultar o actualizar tu saldo. Revisa los registros del servidor."

def credit_withdraw_balance(user_id: str, prize: float):
    try:
        res = supabase.table("profiles").select("withdraw_balance").eq("id", user_id).execute()
        if res.data:
            current_withdraw = float(res.data[0].get("withdraw_balance") or 0.0)
            new_withdraw = round(current_withdraw + prize, 2)
            supabase.table("profiles").update({"withdraw_balance": new_withdraw}).eq("id", user_id).execute()
    except Exception as e:
        print(f"Error acreditando premio: {e}")

@app.websocket("/ws/lobby")
async def lobby_endpoint(websocket: WebSocket, user_id: str = Query("")):
    await websocket.accept()
    if "lobby" not in manager.active_connections:
        manager.active_connections["lobby"] = []
    manager.active_connections["lobby"].append(websocket)
    
    await websocket.send_json({
        "type": "LOBBY_UPDATE",
        "rooms": [
            {"room_id": rid, "creator": r["creator"], "bet": r["bet"], "is_public": r["is_public"], "players_count": len(r["players"])}
            for rid, r in lobbies.items() if len(r["players"]) < 2
        ]
    })

    try:
        while True:
            data = await websocket.receive_json()
            if data["type"] == "CREATE_ROOM":
                bet = float(data["bet"])
                wallet = data.get("wallet", "play")
                creator_uid = data.get("user_id") or user_id
                
                if bet < 0.10:
                    await websocket.send_json({"type": "ERROR", "message": "La apuesta minima es de $0.10"})
                    continue

                success, error_message = deduct_balance(creator_uid, bet, wallet)
                if not success:
                    await websocket.send_json({"type": "ERROR", "message": error_message})
                    continue

                room_id = f"room_{random.randint(10000, 99999)}"
                is_public = data["is_public"]
                password = data.get("password", "")
                creator = data["creator"]

                lobbies[room_id] = {
                    "creator": creator,
                    "bet": bet,
                    "is_public": is_public,
                    "password": password,
                    "players": [],
                    "board": [None] * 9,
                    "turn": "X"
                }
                await manager.broadcast_lobby()
                await websocket.send_json({"type": "ROOM_CREATED", "room_id": room_id, "password": password})
    except WebSocketDisconnect:
        if websocket in manager.active_connections.get("lobby", []):
            manager.active_connections["lobby"].remove(websocket)


@app.websocket("/ws/game/{room_id}")
async def game_endpoint(
    websocket: WebSocket, 
    room_id: str, 
    password: str = Query(""), 
    wallet: str = Query("play"),
    user_id: str = Query("")
):
    await websocket.accept()
    
    if room_id not in lobbies:
        await websocket.send_json({"type": "ERROR", "message": "La sala no existe."})
        await websocket.close()
        return

    room = lobbies[room_id]

    if not room["is_public"] and len(room["players"]) == 1:
        if room["password"] and password != room["password"]:
            await websocket.send_json({"type": "ERROR", "message": "Contrasena incorrecta."})
            await websocket.close()
            return

    if len(room["players"]) >= 2:
        await websocket.send_json({"type": "ERROR", "message": "La sala esta llena."})
        await websocket.close()
        return

    if len(room["players"]) == 1:
        if not user_id:
            await websocket.send_json({"type": "ERROR", "message": "No se recibió el ID de tu usuario."})
            await websocket.close()
            return

        success, error_message = deduct_balance(user_id, room["bet"], wallet)
        if not success:
            await websocket.send_json({"type": "ERROR", "message": error_message})
            await websocket.close()
            return

    room["players"].append({"ws": websocket, "user_id": user_id})
    is_host = len(room["players"]) == 1
    player_symbol = "X" if is_host else "O"
    
    await manager.broadcast_lobby()

    await websocket.send_json({
        "type": "INIT",
        "symbol": player_symbol,
        "is_host": is_host,
        "board": room["board"],
        "turn": room["turn"],
        "bet": room["bet"]
    })

    if len(room["players"]) == 2:
        for p in room["players"]:
            await p["ws"].send_json({"type": "START", "turn": room["turn"]})

    try:
        while True:
            data = await websocket.receive_json()
            if data["type"] == "MOVE":
                idx = data["index"]  
                symbol = data["symbol"]

                if room["board"][idx] is None and room["turn"] == symbol:
                    room["board"][idx] = symbol
                    room["turn"] = "O" if symbol == "X" else "X"

                    total_pot = room["bet"] * 2
                    commission = manager.calculate_commission(total_pot)
                    net_prize = total_pot - commission

                    board = room["board"]
                    winning_lines = [
                        [0,1,2],[3,4,5],[6,7,8],
                        [0,3,6],[1,4,7],[2,5,8],
                        [0,4,8],[2,4,6]
                    ]
                    
                    winner_symbol = None
                    for line in winning_lines:
                        if board[line[0]] and board[line[0]] == board[line[1]] == board[line[2]]:
                            winner_symbol = board[line[0]]
                            break

                    for p in room["players"]:
                        await p["ws"].send_json({
                            "type": "MOVE_MADE",
                            "index": idx,
                            "symbol": symbol,
                            "board": room["board"],
                            "next_turn": room["turn"],
                            "net_prize": net_prize,
                            "commission": commission
                        })

                    if winner_symbol:
                        winner_idx = 0 if winner_symbol == "X" else 1
                        if len(room["players"]) > winner_idx:
                            winner_uid = room["players"][winner_idx].get("user_id")
                            if winner_uid:
                                credit_withdraw_balance(winner_uid, net_prize)

            elif data["type"] == "CLOSE_ROOM":
                if is_host:
                    for p in room["players"]:
                        await p["ws"].send_json({"type": "ROOM_CLOSED_BY_HOST"})
                        await p["ws"].close()
                    if room_id in lobbies:
                        del lobbies[room_id]
                    await manager.broadcast_lobby()
                    break

    except WebSocketDisconnect:
        room["players"] = [p for p in room["players"] if p.get("ws") is not websocket]
        if len(room["players"]) == 0 and room_id in lobbies:
            del lobbies[room_id]
        await manager.broadcast_lobby()
