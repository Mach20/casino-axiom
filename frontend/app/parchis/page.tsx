"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";

type Wallet = "play" | "bonus";
type Piece = { id: number; stage: number; pos: number; steps_walked: number };
type Player = { user_id: string; player_name?: string; seat_index: number; team: string | null; wallet: Wallet; connected: boolean; pieces: Piece[] };
type GameState = { type: string; room_id: string; bet: number; max_players: number; team_mode: string; is_private: boolean; room_code: string | null; status: string; turn_seat: number; turn_seconds: number; dice: number | null; dice_pair: number[] | null; dice_remaining: number[]; double_count: number; penalty_pending: boolean; must_move: boolean; pot_total: number; net_pot: number; commission_total: number; winners: string[]; last_event: string; players: Player[] };
type Room = { room_id: string; bet: number; max_players: number; players_count: number; team_mode: string; is_private: boolean };
type Seat = { color: string; dark: string; light: string; label: string };

const API = (process.env.NEXT_PUBLIC_API_URL || "https://casino-axiom.ethiodeploy.app").replace(/\/$/, "");
const BETS = [0.25, 1, 10];
const SEATS: Seat[] = [
    { color: "#18a66a", dark: "#075b3a", light: "#a7f3d0", label: "VERDE" },
    { color: "#e34455", dark: "#8e1729", light: "#fecdd3", label: "ROJO" },
    { color: "#3478df", dark: "#173d83", light: "#bfdbfe", label: "AZUL" },
    { color: "#e9b52d", dark: "#93620a", light: "#fef3a6", label: "AMARILLO" },
];
const TRACK: [number, number][] = [
    ...Array.from({ length: 17 }, (_, i): [number, number] => [i + 1, 0]),
    ...Array.from({ length: 17 }, (_, i): [number, number] => [18, i + 1]),
    ...Array.from({ length: 17 }, (_, i): [number, number] => [17 - i, 18]),
    ...Array.from({ length: 17 }, (_, i): [number, number] => [0, 17 - i]),
];
const STARTS = [5, 22, 39, 56];
const SAFE = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const money = (n: number) => `$${Number(n || 0).toFixed(2)}`;
const seatOf = (state: GameState | null, uid: string | null) => state?.players?.find(p => p.user_id === uid)?.seat_index ?? -1;

function pieceCell(piece: Piece, seat: number): [number, number] | null {
    if (piece.stage === -1) {
        const bases: [number, number][] = [[3, 3], [15, 3], [15, 15], [3, 15]];
        const offsets: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        return [bases[seat][0] + offsets[piece.id][0] * 1.05, bases[seat][1] + offsets[piece.id][1] * 1.05];
    }
    if (piece.stage === 0) return TRACK[piece.pos] || null;
    if (piece.stage === 100) {
        const lanes: [number, number][][] = [
            Array.from({ length: 8 }, (_, i): [number, number] => [9, i + 1]),
            Array.from({ length: 8 }, (_, i): [number, number] => [17 - i, 9]),
            Array.from({ length: 8 }, (_, i): [number, number] => [9, 17 - i]),
            Array.from({ length: 8 }, (_, i): [number, number] => [i + 1, 9]),
        ];
        return lanes[seat][piece.pos] || null;
    }
    return null;
}

export default function ParchisPage() {
    const [uid, setUid] = useState("");
    const [token, setToken] = useState("");
    const [name, setName] = useState("Jugador");
    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [wallet, setWallet] = useState<Wallet>("play");
    const [bet, setBet] = useState(0.25);
    const [maxPlayers, setMaxPlayers] = useState<2 | 3 | 4>(2);
    const [privateRoom, setPrivateRoom] = useState(false);
    const [password, setPassword] = useState("");
    const [joinCode, setJoinCode] = useState("");
    const [rooms, setRooms] = useState<Room[]>([]);
    const [state, setState] = useState<GameState | null>(null);
    const [roomId, setRoomId] = useState("");
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [selectedPiece, setSelectedPiece] = useState<number | null>(null);
    const socket = useRef<WebSocket | null>(null);
    const mySeat = seatOf(state, uid || null);
    const myTurn = Boolean(state && mySeat >= 0 && state.turn_seat === mySeat && state.status === "playing");
    const myPlayer = state?.players.find(p => p.user_id === uid);
    const availableBalance = wallet === "play" ? playBalance : bonusBalance;

    const refreshProfile = useCallback(async () => {
        const { data } = await supabase.auth.getSession();
        const session = data.session;
        if (!session) { setUid(""); setToken(""); return; }
        setUid(session.user.id); setToken(session.access_token);
        const { data: profile } = await supabase.from("profiles").select("first_name,balance,bonus_balance").eq("id", session.user.id).maybeSingle();
        if (profile) {
            setName(profile.first_name || "Jugador");
            setPlayBalance(Number(profile.balance || 0));
            setBonusBalance(Number(profile.bonus_balance || 0));
        }
    }, []);

    const loadRooms = useCallback(async () => {
        try {
            const response = await fetch(`${API}/parchis/rooms`);
            const data = await response.json();
            setRooms(Array.isArray(data.rooms) ? data.rooms : []);
        } catch { setError("No se pudo cargar la lista de salas."); }
    }, []);

    useEffect(() => { void refreshProfile(); void loadRooms(); }, [refreshProfile, loadRooms]);
    useEffect(() => {
        const channel = supabase.auth.onAuthStateChange(() => { void refreshProfile(); });
        return () => { channel.data.subscription.unsubscribe(); };
    }, [refreshProfile]);
    useEffect(() => () => { socket.current?.close(); }, []);

    const connect = useCallback((target: string, roomPassword = "") => {
        if (!uid || !token) { setError("Inicie sesión para entrar a Parchís."); return; }
        socket.current?.close();
        setBusy(true); setError(""); setRoomId(target); setState(null); setSelectedPiece(null);
        const wsBase = (process.env.NEXT_PUBLIC_WS_URL || API).replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "");
        const query = new URLSearchParams({ user_id: uid, access_token: token, player_name: name, bet: String(bet), max_players: String(maxPlayers), wallet, password: roomPassword });
        const ws = new WebSocket(`${wsBase}/ws/parchis/${encodeURIComponent(target)}?${query.toString()}`);
        socket.current = ws;
        ws.onopen = () => { setConnected(true); setBusy(false); };
        ws.onmessage = event => {
            let msg: any; try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.type === "PARCHIS_STATE") { setState(msg as GameState); setRoomId(msg.room_id); setError(""); }
            else if (msg.type === "ERROR") { setError(msg.message || "Error en la partida."); setBusy(false); }
            else if (msg.type === "PONG") return;
        };
        ws.onerror = () => { setError("No se pudo conectar con el servidor de Parchís."); setBusy(false); };
        ws.onclose = () => { setConnected(false); setBusy(false); };
    }, [uid, token, name, bet, maxPlayers, wallet]);

    useEffect(() => {
        if (!connected || !socket.current) return;
        const timer = window.setInterval(() => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "PING" })); }, 20000);
        return () => window.clearInterval(timer);
    }, [connected]);

    const joinPrivateRoom = async () => {
        const code = joinCode.trim();
        if (!code) return;
        setBusy(true); setError("");
        try {
            const response = await fetch(`${API}/parchis/rooms/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ room_code: code }),
            });
            const data = await response.json();
            if (!response.ok || !data.room_id) throw new Error(data.detail || "Código de sala no válido.");
            connect(data.room_id, code);
        } catch (e) {
            setError(e instanceof Error ? e.message : "No se pudo localizar la sala.");
            setBusy(false);
        }
    };

    const createRoom = async () => {
        if (!token) { setError("Inicie sesión para crear una sala."); return; }
        if (availableBalance < bet) { setError(`Saldo insuficiente en la billetera ${wallet}.`); return; }
        setBusy(true); setError("");
        try {
            const response = await fetch(`${API}/parchis/rooms/create`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ bet, max_players: maxPlayers, wallet, is_private: privateRoom, password: privateRoom ? password : "" }) });
            const data = await response.json();
            if (!response.ok || !data.room_id) throw new Error(data.detail || "No se pudo crear la sala.");
            connect(data.room_id, data.room_code || password);
        } catch (e) { setError(e instanceof Error ? e.message : "Error al crear sala."); setBusy(false); }
    };

    const send = (type: string, extra: Record<string, unknown> = {}) => {
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type, ...extra }));
    };
    const move = (piece: Piece, die: number) => { send("MOVE_PIECE", { piece_id: piece.id, dice_value: die }); setSelectedPiece(null); };
    const canMoveWithDie = (piece: Piece, die: number) => piece.stage === -1 ? die === 5 || (state?.dice_remaining?.length === 2 && state.dice_remaining.reduce((a, b) => a + b, 0) === 5) : true;

    const piecePositions = useMemo(() => {
        if (!state) return [] as { player: Player; piece: Piece; x: number; y: number; stack: number; total: number }[];
        const entries: { player: Player; piece: Piece; x: number; y: number; stack: number; total: number }[] = [];
        state.players.forEach(player => player.pieces.forEach(piece => {
            const cell = pieceCell(piece, player.seat_index); if (!cell) return;
            const same = entries.filter(e => e.x === cell[0] && e.y === cell[1]);
            entries.push({ player, piece, x: cell[0], y: cell[1], stack: same.length, total: same.length + 1 });
        }));
        return entries;
    }, [state]);

    const leave = () => { socket.current?.close(1000, "Salida voluntaria"); socket.current = null; setState(null); setRoomId(""); setConnected(false); setSelectedPiece(null); void refreshProfile(); void loadRooms(); };

    return <div className="min-h-screen bg-black text-white flex flex-col select-none font-sans overflow-x-hidden"><Header />
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 py-6 sm:py-8">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-black tracking-[.35em] text-emerald-400 uppercase">AXIOM · MULTIPLAYER</p><h1 className="mt-1 text-2xl sm:text-3xl font-black tracking-wider uppercase text-emerald-400">Parchís Arena</h1></div><div className="flex gap-2 text-[10px] sm:text-xs font-black uppercase"><span className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-emerald-400">Jugar {money(playBalance)}</span><span className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-yellow-300">Bono {money(bonusBalance)}</span></div></div>
            {error && <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
            {!state ? <div className="mx-auto flex w-full max-w-md flex-col gap-5">
                <section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-6 sm:p-8 shadow-2xl"><h2 className="text-lg font-extrabold">Crear partida</h2>
                    <label className="mt-5 block text-xs font-bold uppercase tracking-wider text-slate-400">Billetera</label><div className="mt-2 grid grid-cols-2 gap-2">{(["play", "bonus"] as Wallet[]).map(w => <button key={w} onClick={() => setWallet(w)} className={`rounded-xl border px-3 py-3 text-sm font-bold ${wallet === w ? "border-emerald-400 bg-emerald-400/15 text-emerald-200" : "border-zinc-800 bg-black text-slate-400"}`}>{w === "play" ? "Saldo para jugar" : "Saldo bono"}</button>)}</div>
                    <label className="mt-5 block text-xs font-bold uppercase tracking-wider text-slate-400">Apuesta</label><div className="mt-2 grid grid-cols-3 gap-2">{BETS.map(v => <button key={v} onClick={() => setBet(v)} className={`rounded-xl border py-3 font-black ${bet === v ? "border-emerald-400 bg-emerald-400/15 text-emerald-200" : "border-zinc-800 bg-black text-slate-300"}`}>{money(v)}</button>)}</div>
                    <label className="mt-5 block text-xs font-bold uppercase tracking-wider text-slate-400">Jugadores</label><div className="mt-2 grid grid-cols-3 gap-2">{([2, 3, 4] as const).map(n => <button key={n} onClick={() => setMaxPlayers(n)} className={`rounded-xl border py-3 font-bold ${maxPlayers === n ? "border-emerald-400 bg-emerald-400/15 text-emerald-200" : "border-zinc-800 bg-black text-slate-300"}`}>{n}</button>)}</div>
                    <label className="mt-5 flex items-center gap-3 text-sm text-slate-300"><input type="checkbox" checked={privateRoom} onChange={e => setPrivateRoom(e.target.checked)} className="accent-emerald-400" /> Sala privada</label>
                    {privateRoom && <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Contraseña (opcional)" className="mt-3 w-full rounded-xl border border-zinc-800 bg-black px-4 py-3 outline-none focus:border-emerald-500" />}
                    <button disabled={busy} onClick={() => void createRoom()} className="mt-5 w-full rounded-xl bg-emerald-500 px-4 py-3.5 font-black text-[#04130d] transition hover:bg-emerald-400 disabled:opacity-50">{busy ? "Conectando…" : "CREAR SALA"}</button>
                    <div className="mt-6 border-t border-white/10 pt-5"><h3 className="font-bold">Entrar con código</h3><div className="mt-2 flex gap-2"><input value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="Código o contraseña de sala" className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-black px-3 py-3 outline-none focus:border-emerald-500" /><button onClick={() => void joinPrivateRoom()} disabled={!joinCode.trim() || busy} className="rounded-xl border border-white/10 px-4 font-bold hover:bg-white/10 disabled:opacity-40">ENTRAR</button></div></div>
                </section>
                <section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-extrabold">Salas públicas</h2><button onClick={() => void loadRooms()} className="text-sm font-bold text-emerald-300">Actualizar</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{rooms.map(room => <div key={room.room_id} className="rounded-2xl border border-zinc-800 bg-black p-4"><div className="flex items-center justify-between"><b>{money(room.bet)} por jugador</b><span className="text-xs text-slate-400">{room.players_count}/{room.max_players}</span></div><p className="mt-1 text-xs text-slate-500">{room.team_mode === "2v2" ? "Equipos 2 contra 2" : "Todos contra todos"}</p><button onClick={() => { setBet(room.bet); setMaxPlayers(room.max_players as 2 | 3 | 4); connect(room.room_id); }} className="mt-4 w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-2.5 text-sm font-bold text-emerald-200 hover:bg-emerald-500/20">UNIRSE</button></div>)}{rooms.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500 sm:col-span-2 xl:col-span-3">No hay salas públicas disponibles.</p>}</div></section>
            </div> : <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl sm:p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-2"><div><p className="text-[10px] font-bold tracking-[.3em] text-emerald-300">SALA {roomId}{state.is_private && state.room_code ? ` · CÓDIGO ${state.room_code}` : ""}</p><h2 className="text-lg font-black">Tablero de Parchís</h2></div><button onClick={leave} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-white/10">SALIR</button></div>
                    <div className="mx-auto w-full max-w-[900px] rounded-[24px] border-[8px] border-[#4b3020] bg-[#d9c49d] p-1 shadow-[inset_0_0_0_3px_#a88b65,0_18px_55px_#000b]"><svg viewBox="-0.5 -0.5 19 19" className="block h-auto w-full rounded-[18px]" role="img" aria-label="Tablero de Parchís visto desde arriba"><defs><pattern id="wood" width=".5" height=".5" patternUnits="userSpaceOnUse"><path d="M0 .25H.5" stroke="#b7a487" strokeWidth=".025" opacity=".4" /></pattern><filter id="shadow"><feDropShadow dx="0.03" dy="0.06" stdDeviation=".05" floodOpacity=".35" /></filter></defs><rect x="0" y="0" width="18" height="18" fill="#e9e0cb" /><rect x="0" y="0" width="18" height="18" fill="url(#wood)" />
                        {[{ x: 0, y: 0, c: SEATS[0] }, { x: 12, y: 0, c: SEATS[1] }, { x: 12, y: 12, c: SEATS[2] }, { x: 0, y: 12, c: SEATS[3] }].map((b, i) => <g key={i}><rect x={b.x} y={b.y} width="6" height="6" rx=".35" fill={b.c.color} /><rect x={b.x + .55} y={b.y + .55} width="4.9" height="4.9" rx=".55" fill="#f3ead8" stroke={b.c.dark} strokeWidth=".12" /><rect x={b.x + .85} y={b.y + .85} width="4.3" height="4.3" rx=".4" fill={b.c.light} opacity=".25" />{[[1.7, 1.7], [4.3, 1.7], [1.7, 4.3], [4.3, 4.3]].map(([cx, cy], j) => <g key={j}><circle cx={b.x + cx} cy={b.y + cy} r=".62" fill={b.c.dark} opacity=".35" /><circle cx={b.x + cx} cy={b.y + cy - .04} r=".48" fill={b.c.color} stroke={b.c.dark} strokeWidth=".07" /><circle cx={b.x + cx - .12} cy={b.y + cy - .17} r=".11" fill="#fff" opacity=".45" /></g>)}</g>)}
                        {TRACK.map(([x, y], i) => <g key={i}><rect x={x - .48} y={y - .48} width=".96" height=".96" fill={SAFE.has(i) ? "#f8edc9" : "#f4eee1"} stroke="#a99a7e" strokeWidth=".035" /><rect x={x - .4} y={y - .4} width=".8" height=".8" fill={SAFE.has(i) ? "#fff6d9" : "#fffaf0"} opacity=".8" /><text x={x} y={y + .12} textAnchor="middle" fontSize=".2" fill="#7c705e">{SAFE.has(i) ? "◆" : ""}</text></g>)}
                        {STARTS.map((pos, seat) => { const [x, y] = TRACK[pos]; return <g key={seat}><rect x={x - .48} y={y - .48} width=".96" height=".96" fill={SEATS[seat].color} stroke="#fff" strokeWidth=".09" /><path d={`M${x - .25} ${y}h.5 M${x} ${y - .25}v.5`} stroke="#fff" strokeWidth=".07" /></g>; })}
                        {Array.from({ length: 8 }, (_, i) => <g key={i}>{[[9, i + 1], [17 - i, 9], [9, 17 - i], [i + 1, 9]].map(([x, y], s) => <rect key={s} x={x - .46} y={y - .46} width=".92" height=".92" fill={SEATS[s].light} stroke={SEATS[s].dark} strokeWidth=".035" />)}</g>)}
                        <path d="M6 6L12 6L9 9Z" fill="#18a66a" stroke="#ffffff" strokeWidth=".07" /><path d="M12 6L12 12L9 9Z" fill="#e34455" stroke="#ffffff" strokeWidth=".07" /><path d="M12 12L6 12L9 9Z" fill="#3478df" stroke="#ffffff" strokeWidth=".07" /><path d="M6 12L6 6L9 9Z" fill="#e9b52d" stroke="#ffffff" strokeWidth=".07" /><circle cx="9" cy="9" r=".22" fill="#f8f0dc" stroke="#8d7a5e" strokeWidth=".05" />
                        {piecePositions.map(({ player, piece, x, y, stack, total }) => { const c = SEATS[player.seat_index]; const dx = total > 1 ? (stack % 2 ? -.16 : .16) : 0; const dy = total > 1 ? (stack > 1 ? .16 : -.16) : 0; const mine = player.user_id === uid; const selectable = mine && myTurn && (state.must_move || state.penalty_pending); return <g key={`${player.user_id}-${piece.id}`} onClick={() => { if (!selectable) return; if (state.penalty_pending) { send("SELECT_PENALTY_PIECE", { piece_id: piece.id }); setSelectedPiece(null); } else { setSelectedPiece(piece.id); } }} className={selectable ? "cursor-pointer" : ""}><circle cx={x + dx} cy={y + dy} r=".32" fill={c.dark} opacity=".25" /><circle cx={x + dx} cy={y + dy - .035} r=".27" fill={c.color} stroke={selectedPiece === piece.id ? "#fff" : c.dark} strokeWidth={selectedPiece === piece.id ? ".13" : ".07"} filter="url(#shadow)" /><circle cx={x + dx - .07} cy={y + dy - .12} r=".07" fill="#fff" opacity=".65" /><text x={x + dx} y={y + dy + .08} textAnchor="middle" fontSize=".18" fontWeight="bold" fill="#fff">{piece.id + 1}</text></g>; })}
                    </svg></div><div className="mt-3 flex flex-wrap justify-center gap-3">{SEATS.map((s, i) => <span key={i} className="flex items-center gap-2 text-xs text-slate-400"><i className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.label}</span>)}</div></section>
                <aside className="space-y-4"><section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-5"><div className="flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-widest text-slate-400">Bote</span><span className="text-xs text-slate-500">Comisión 6%</span></div><p className="mt-1 text-3xl font-black text-emerald-300">{money(state.net_pot || 0)}</p><p className="text-xs text-slate-500">Total apostado {money(state.pot_total)} · Comisión {money(state.commission_total)}</p><div className="my-4 h-px bg-white/10" /><div className="flex items-center justify-between"><span className="text-sm text-slate-400">Estado</span><b className="text-sm">{state.status === "waiting" ? "Esperando jugadores" : state.status === "finished" ? "Finalizada" : "En juego"}</b></div><div className="mt-3 flex items-center justify-between"><span className="text-sm text-slate-400">Turno</span><b className="text-sm" style={{ color: SEATS[state.turn_seat]?.color }}>{state.players.find(p => p.seat_index === state.turn_seat)?.player_name || `Jugador ${state.turn_seat + 1}`}</b></div><div className="mt-2 flex items-center justify-between"><span className="text-sm text-slate-400">Tiempo</span><b className="text-xl tabular-nums">{state.turn_seconds}s</b></div></section>
                    <section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-5"><h3 className="font-extrabold">Jugadores</h3><div className="mt-3 space-y-2">{state.players.map(p => <div key={p.user_id} className={`flex items-center justify-between rounded-xl border px-3 py-2 ${p.seat_index === state.turn_seat ? "border-emerald-400/50 bg-emerald-400/5" : "border-white/5 bg-black/20"}`}><div className="flex items-center gap-2"><i className="h-3 w-3 rounded-full" style={{ background: SEATS[p.seat_index].color }} /><span className="text-sm font-semibold">{p.player_name || `Jugador ${p.seat_index + 1}`}{p.user_id === uid ? " (tú)" : ""}</span></div><span className={`text-[10px] font-bold ${p.connected ? "text-emerald-300" : "text-slate-500"}`}>{p.connected ? "EN LÍNEA" : "DESCONECTADO"}</span></div>)}</div></section>
                    <section className="rounded-3xl border border-zinc-800 bg-zinc-950 p-5"><h3 className="font-extrabold">Dados</h3>{myTurn ? <><div className="my-4 flex justify-center gap-3">{(state.dice_pair || []).map((d, i) => <div key={i} className="grid h-16 w-16 place-items-center rounded-2xl border border-white/20 bg-[#f6f0e3] text-3xl font-black text-[#18202a] shadow-lg">{d}</div>)}{!state.dice_pair && <div className="grid h-16 w-36 place-items-center rounded-2xl border border-dashed border-white/20 text-xs text-slate-500">Lanza los dados</div>}</div><button disabled={state.must_move || state.penalty_pending} onClick={() => send("ROLL_DICE")} className="w-full rounded-xl bg-emerald-500 py-3 font-black text-[#04130d] disabled:opacity-40">LANZAR DADOS</button>{state.must_move && <p className="mt-3 text-center text-xs text-emerald-200">Seleccione una ficha en el tablero.</p>}{state.penalty_pending && <p className="mt-3 text-center text-xs text-rose-300">Seleccione una ficha para devolverla a casa.</p>}{selectedPiece !== null && <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3"><p className="mb-2 text-xs text-emerald-200">Elija el dado para la ficha {selectedPiece + 1}</p><div className="flex gap-2">{(state.dice_remaining || []).map((d, i) => <button key={`${d}-${i}`} onClick={() => { const pc = myPlayer?.pieces.find(p => p.id === selectedPiece); if (pc) move(pc, d); }} disabled={!myPlayer?.pieces.some(p => p.id === selectedPiece && canMoveWithDie(p, d))} className="flex-1 rounded-lg border border-white/15 bg-white/5 py-2 font-black disabled:opacity-30">{d}</button>)}{myPlayer?.pieces.find(p => p.id === selectedPiece)?.stage === -1 && state.dice_remaining?.length === 2 && state.dice_remaining.reduce((a, b) => a + b, 0) === 5 && !state.dice_remaining.includes(5) && <button onClick={() => move(myPlayer.pieces.find(p => p.id === selectedPiece)!, 5)} className="flex-1 rounded-lg bg-amber-400 py-2 font-black text-black">SUMA 5</button>}</div></div>}</> : <div className="my-5 rounded-xl bg-black/20 p-4 text-center text-sm text-slate-500">Los dados se muestran únicamente durante su turno.</div>}</section>
                    <p className="rounded-xl border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-slate-400">{state.last_event || (connected ? "Conectado al servidor." : "Conectando…")}</p>
                    {state.status === "finished" && <button onClick={leave} className="w-full rounded-xl bg-emerald-500 py-3 font-black text-black">VOLVER A SALAS</button>}
                </aside>
            </div>}
            {!connected && state && <p className="mt-3 text-center text-xs text-amber-300">Reconectando con la sala…</p>}
        </main></div>;
}