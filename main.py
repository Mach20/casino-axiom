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
