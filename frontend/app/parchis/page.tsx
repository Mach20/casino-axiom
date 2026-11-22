"use client";

import React, { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://djdzytfdztctusnuuvrm.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "https://casino-axiom.ethiodeploy.app";
const WS_BASE = API_BASE.replace(/^http/i, "ws");

const supabaseClient = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

interface ParchisPiece {
  id: number;
  stage: number;
  pos: number;
  steps_walked: number;
}

interface ParchisPlayerState {
  user_id: string;
  seat_index: number;
  team: string | null;
  wallet: string;
  connected: boolean;
  pieces: ParchisPiece[];
}

interface ParchisState {
  type: string;
  room_id: string;
  bet: number;
  max_players: number;
  team_mode: "ffa" | "2v2";
  is_private: boolean;
  room_code: string | null;
  status: string;
  turn_seat: number;
  dice: number | null;
  must_move: boolean;
  pot_total: number;
  winners: string[];
  last_event: string;
  players: ParchisPlayerState[];
}

interface PublicRoomItem {
  room_id: string;
  bet: number;
  max_players: number;
  players_count: number;
  team_mode: string;
  is_private: boolean;
}

const SEAT_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];

export default function ParchisPage() {
  const [userId, setUserId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [bet, setBet] = useState<number>(0.25);
  const [maxPlayers, setMaxPlayers] = useState<number>(4);
  const [wallet, setWallet] = useState<"play" | "bonus">("play");
  const [isPrivate, setIsPrivate] = useState<boolean>(false);
  const [password, setPassword] = useState<string>("");
  const [joinRoomId, setJoinRoomId] = useState<string>("");
  const [joinPassword, setJoinPassword] = useState<string>("");

  const [publicRooms, setPublicRooms] = useState<PublicRoomItem[]>([]);
  const [gameState, setGameState] = useState<ParchisState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!supabaseClient) return;
    supabaseClient.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (s?.user?.id) setUserId(s.user.id);
      if (s?.access_token) setAccessToken(s.access_token);
    });
  }, []);

  const fetchRooms = async () => {
    try {
      const res = await fetch(`${API_BASE}/parchis/rooms?bet=${bet}`);
      if (!res.ok) return;
      const data = await res.json();
      setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchRooms();
    const timer = setInterval(fetchRooms, 4000);
    return () => clearInterval(timer);
  }, [bet]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const connectWs = (targetRoomId: string, pwd = "") => {
    setErrorMsg("");
    if (!userId.trim() || !accessToken.trim()) {
      setErrorMsg("Falta sesión de usuario o token de acceso.");
      return;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const params = new URLSearchParams({
      user_id: userId.trim(),
      access_token: accessToken.trim(),
      bet: String(bet),
      max_players: String(maxPlayers),
      wallet,
      password: pwd,
    });

    const ws = new WebSocket(
      `${WS_BASE}/ws/parchis/${encodeURIComponent(targetRoomId)}?${params.toString()}`
    );

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "PARCHIS_STATE") {
          setGameState(msg);
          setErrorMsg("");
        } else if (msg.type === "ERROR") {
          setErrorMsg(msg.message || "Error en la partida.");
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      setErrorMsg("Error de conexión WebSocket.");
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    wsRef.current = ws;
  };

  const handleCreateRoom = async () => {
    setErrorMsg("");
    if (!accessToken.trim()) {
      setErrorMsg("Debes iniciar sesión para crear una sala.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/parchis/rooms/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken.trim()}`,
        },
        body: JSON.stringify({
          bet,
          max_players: maxPlayers,
          wallet,
          is_private: isPrivate,
          password: isPrivate ? password : "",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.room_id) {
        setErrorMsg(data.detail || "No se pudo crear la sala.");
        return;
      }
      connectWs(data.room_id, data.room_code || password);
      fetchRooms();
    } catch {
      setErrorMsg("Error de red al crear la sala.");
    } finally {
      setBusy(false);
    }
  };

  const handleRollDice = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "ROLL_DICE" }));
  };

  const handleMovePiece = (pieceId: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "MOVE_PIECE", piece_id: pieceId }));
  };

  const handleLeaveRoom = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setGameState(null);
  };

  const myPlayer = gameState?.players.find((p) => p.user_id === userId) || null;
  const isMyTurn =
    Boolean(gameState) &&
    gameState?.status === "playing" &&
    myPlayer?.seat_index === gameState?.turn_seat;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <h1 className="text-2xl font-bold tracking-tight">Parchís AXIOM</h1>
          {gameState && (
            <button
              onClick={handleLeaveRoom}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
            >
              Salir de la sala
            </button>
          )}
        </div>

        {errorMsg && (
          <div className="p-3 rounded bg-red-950 border border-red-700 text-red-200 text-sm">
            {errorMsg}
          </div>
        )}

        {!gameState ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="text-lg font-semibold">Configurar / Crear Sala</h2>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Apuesta</label>
                <div className="grid grid-cols-3 gap-2">
                  {[0.25, 1.0, 10.0].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setBet(amt)}
                      className={`py-2 rounded font-medium border ${
                        bet === amt
                          ? "bg-emerald-600 border-emerald-500 text-white"
                          : "bg-zinc-950 border-zinc-800 text-zinc-300"
                      }`}
                    >
                      ${amt.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Jugadores ({maxPlayers === 4 ? "2v2 Equipos" : "Todos contra todos"})
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[2, 3, 4].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setMaxPlayers(cnt)}
                      className={`py-2 rounded font-medium border ${
                        maxPlayers === cnt
                          ? "bg-blue-600 border-blue-500 text-white"
                          : "bg-zinc-950 border-zinc-800 text-zinc-300"
                      }`}
                    >
                      {cnt}P
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Billetera</label>
                <div className="grid grid-cols-2 gap-2">
                  {(["play", "bonus"] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setWallet(w)}
                      className={`py-2 rounded font-medium border ${
                        wallet === w
                          ? "bg-amber-600 border-amber-500 text-white"
                          : "bg-zinc-950 border-zinc-800 text-zinc-300"
                      }`}
                    >
                      {w === "play" ? "Saldo Jugar" : "Saldo Bono"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="privCheck"
                  type="checkbox"
                  checked={isPrivate}
                  onChange={(e) => setIsPrivate(e.target.checked)}
                />
                <label htmlFor="privCheck" className="text-sm text-zinc-300">
                  Sala privada
                </label>
              </div>

              {isPrivate && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Código / Contraseña de sala
                  </label>
                  <input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Ej. AXIOM123"
                    className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 text-sm"
                  />
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => connectWs("matchmake", "")}
                  className="flex-1 py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 font-semibold text-sm"
                >
                  Buscar sala pública
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleCreateRoom}
                  className="flex-1 py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 font-semibold text-sm"
                >
                  Crear sala
                </button>
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="text-lg font-semibold">Unirse por ID / Sala Privada</h2>

              <input
                type="text"
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value)}
                placeholder="ID de sala (parchis_...)"
                className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 text-sm"
              />
              <input
                type="text"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                placeholder="Contraseña (si es privada)"
                className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 text-sm"
              />
              <button
                type="button"
                onClick={() => connectWs(joinRoomId.trim(), joinPassword.trim())}
                disabled={!joinRoomId.trim()}
                className="w-full py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 font-semibold text-sm"
              >
                Entrar a sala
              </button>

              <div className="pt-2 border-t border-zinc-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    Salas públicas (${bet.toFixed(2)})
                  </span>
                  <button
                    type="button"
                    onClick={fetchRooms}
                    className="text-xs text-emerald-400 hover:underline"
                  >
                    Actualizar
                  </button>
                </div>

                {publicRooms.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No hay salas abiertas para este monto.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-52 overflow-y-auto">
                    {publicRooms.map((r) => (
                      <div
                        key={r.room_id}
                        className="flex items-center justify-between p-2.5 rounded bg-zinc-950 border border-zinc-800 text-xs"
                      >
                        <div>
                          <div className="font-mono text-zinc-200">{r.room_id}</div>
                          <div className="text-zinc-400">
                            {r.players_count}/{r.max_players} jugadores ·{" "}
                            {r.team_mode === "2v2" ? "2v2" : "FFA"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => connectWs(r.room_id, "")}
                          className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                        >
                          Unirse
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-semibold">
                  Sala <span className="font-mono">{gameState.room_id}</span> ·{" "}
                  ${gameState.bet.toFixed(2)} ·{" "}
                  {gameState.team_mode === "2v2" ? "Equipos 2v2" : "Todos contra todos"}
                </div>
                <div className="text-xs text-zinc-400">
                  Estado: {gameState.status} · Bote: ${gameState.pot_total.toFixed(2)}
                  {gameState.is_private && gameState.room_code
                    ? ` · Código: ${gameState.room_code}`
                    : ""}
                </div>
                {gameState.last_event && (
                  <div className="text-xs text-emerald-400">{gameState.last_event}</div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded bg-zinc-950 border border-zinc-800 text-center">
                  <div className="text-[10px] text-zinc-400">DADO</div>
                  <div className="text-xl font-bold">
                    {gameState.dice !== null ? gameState.dice : "-"}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!isMyTurn || gameState.must_move}
                  onClick={handleRollDice}
                  className="px-4 py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 font-semibold text-sm"
                >
                  Lanzar dado
                </button>
              </div>
            </div>

            {gameState.status === "finished" && (
              <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-600 text-amber-200 text-sm font-semibold">
                Partida finalizada. Ganadores:{" "}
                {gameState.winners.length > 0
                  ? gameState.winners.join(", ")
                  : "Por definir"}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {gameState.players.map((p) => {
                const isMe = p.user_id === userId;
                const isTurn =
                  gameState.status === "playing" && gameState.turn_seat === p.seat_index;
                const colorHex = SEAT_COLORS[p.seat_index % SEAT_COLORS.length];

                return (
                  <div
                    key={p.user_id}
                    className={`rounded-xl p-4 border bg-zinc-900 ${
                      isTurn ? "border-emerald-400" : "border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3.5 h-3.5 rounded-full inline-block"
                          style={{ backgroundColor: colorHex }}
                        />
                        <span className="font-semibold text-sm">
                          Asiento {p.seat_index + 1}
                          {p.team ? ` · Equipo ${p.team}` : ""}
                          {isMe ? " (Tú)" : ""}
                        </span>
                      </div>
                      <span className="text-xs text-zinc-400">
                        {p.connected ? "Conectado" : "Desconectado"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {p.pieces.map((pc) => {
                        const posLabel =
                          pc.stage === -1
                            ? "En casa"
                            : pc.stage === 100
                              ? `Meta ${pc.pos + 1}/8`
                              : `Casilla ${pc.pos}`;

                        const canClick =
                          isMe && isMyTurn && gameState.must_move && gameState.dice !== null;

                        return (
                          <button
                            key={pc.id}
                            type="button"
                            disabled={!canClick}
                            onClick={() => handleMovePiece(pc.id)}
                            className={`p-2 rounded text-left border text-xs ${
                              canClick
                                ? "bg-zinc-950 hover:bg-zinc-800 border-emerald-500/70 text-zinc-100"
                                : "bg-zinc-950/60 border-zinc-800 text-zinc-400"
                            }`}
                          >
                            <div className="font-semibold">Ficha #{pc.id + 1}</div>
                            <div>{posLabel}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}