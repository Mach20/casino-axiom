from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from typing import Dict, List
import random

app = FastAPI()

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

@app.websocket("/ws/lobby")
async def lobby_endpoint(websocket: WebSocket):
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
                
                # Validación estricta del mínimo de apuesta
                if bet < 0.10:
                    await websocket.send_json({"type": "ERROR", "message": "La apuesta minima es de $0.10"})
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
async def game_endpoint(websocket: WebSocket, room_id: str, password: str = Query("")):
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

    room["players"].append(websocket)
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
        for ws in room["players"]:
            await ws.send_json({"type": "START", "turn": room["turn"]})

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

                    for ws in room["players"]:
                        await ws.send_json({
                            "type": "MOVE_MADE",
                            "index": idx,
                            "symbol": symbol,
                            "board": room["board"],
                            "next_turn": room["turn"],
                            "net_prize": net_prize,
                            "commission": commission
                        })
            elif data["type"] == "CLOSE_ROOM":
                if is_host:
                    for ws in room["players"]:
                        await ws.send_json({"type": "ROOM_CLOSED_BY_HOST"})
                        await ws.close()
                    if room_id in lobbies:
                        del lobbies[room_id]
                    await manager.broadcast_lobby()
                    break

    except WebSocketDisconnect:
        if websocket in room["players"]:
            room["players"].remove(websocket)
        if len(room["players"]) == 0 and room_id in lobbies:
            del lobbies[room_id]
        await manager.broadcast_lobby()