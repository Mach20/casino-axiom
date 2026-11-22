"use client";

import {
    useState,
    useEffect,
    useRef,
    useCallback,
    type PointerEvent,
} from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";

type Wallet = "play" | "bonus";
type ParchisBet = "0.25" | "1.00" | "10.00";
type MaxPlayers = 2 | 3 | 4;

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

const API_BASE =
    process.env.NEXT_PUBLIC_API_URL || "https://casino-axiom.ethiodeploy.app";

const PARCHIS_BETS: Record<ParchisBet, number> = {
    "0.25": 0.25,
    "1.00": 1.0,
    "10.00": 10.0,
};

const SEAT_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
const TRACK_LEN = 68;
const SAFE_SPOTS = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const START_SPOTS: Record<number, number> = { 0: 0, 1: 17, 2: 34, 3: 51 };

function money(value: number): string {
    return `$${Number(value || 0).toFixed(2)}`;
}

function getTrackPoint(
    spot: number,
    cx: number,
    cy: number,
    outerR: number
): { x: number; y: number } {
    const angle = (spot / TRACK_LEN) * Math.PI * 2 - Math.PI / 2;
    return {
        x: cx + Math.cos(angle) * outerR,
        y: cy + Math.sin(angle) * outerR,
    };
}

function getPieceBoardPoint(
    piece: ParchisPiece,
    seatIndex: number,
    cx: number,
    cy: number,
    boardSize: number
): { x: number; y: number } {
    const outerR = boardSize * 0.41;
    const seatAngle = (seatIndex * Math.PI) / 2 - Math.PI / 2;
    const perpAngle = seatAngle + Math.PI / 2;

    if (piece.stage === -1) {
        const homeDist = boardSize * 0.31;
        const hx = cx + Math.cos(seatAngle) * homeDist;
        const hy = cy + Math.sin(seatAngle) * homeDist;
        const offsets = [
            { dx: -11, dy: -11 },
            { dx: 11, dy: -11 },
            { dx: -11, dy: 11 },
            { dx: 11, dy: 11 },
        ];
        const off = offsets[piece.id % offsets.length];
        return { x: hx + off.dx, y: hy + off.dy };
    }

    if (piece.stage === 100) {
        const progress = Math.max(0, Math.min(7, piece.pos)) / 7;
        const startDist = outerR * 0.88;
        const endDist = boardSize * 0.08;
        const dist = startDist - (startDist - endDist) * progress;
        const jitter = ((piece.id % 2 === 0 ? 1 : -1) * 5);
        return {
            x: cx + Math.cos(seatAngle) * dist + Math.cos(perpAngle) * jitter,
            y: cy + Math.sin(seatAngle) * dist + Math.sin(perpAngle) * jitter,
        };
    }

    const pt = getTrackPoint(piece.pos, cx, cy, outerR);
    const laneOffset = ((piece.id % 2 === 0 ? 1 : -1) * 4.5);
    return {
        x: pt.x + Math.cos(seatAngle) * laneOffset,
        y: pt.y + Math.sin(seatAngle) * laneOffset,
    };
}

export default function ParchisGamePage() {
    const [userId, setUserId] = useState<string | null>(null);
    const [accessToken, setAccessToken] = useState("");
    const [isAuthLoading, setIsAuthLoading] = useState(true);

    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

    const [selectedBet, setSelectedBet] = useState<ParchisBet>("0.25");
    const selectedBetRef = useRef<number>(0.25);

    const [maxPlayers, setMaxPlayers] = useState<MaxPlayers>(4);
    const [isPrivate, setIsPrivate] = useState(false);
    const [roomPassword, setRoomPassword] = useState("");
    const [joinRoomId, setJoinRoomId] = useState("");
    const [joinPassword, setJoinPassword] = useState("");

    const [publicRooms, setPublicRooms] = useState<PublicRoomItem[]>([]);
    const [isInGame, setIsInGame] = useState(false);
    const [roomId, setRoomId] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState(
        "Preparando tablero..."
    );
    const [gameState, setGameState] = useState<ParchisState | null>(null);
    const [busyAction, setBusyAction] = useState(false);

    const [modal, setModal] = useState({
        isOpen: false,
        title: "",
        message: "",
    });

    const boardCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const gameStateRef = useRef<ParchisState | null>(null);
    const userIdRef = useRef<string | null>(null);
    const accessTokenRef = useRef("");
    const animationFrameRef = useRef<number | null>(null);
    const connectedRef = useRef(false);
    const closingByUserRef = useRef(false);
    const startingRef = useRef(false);

    const showAlert = useCallback((title: string, message: string) => {
        setModal({ isOpen: true, title, message });
    }, []);

    const closeModal = () => {
        setModal({ isOpen: false, title: "", message: "" });
    };

    const getWebSocketUrl = useCallback((endpoint: string) => {
        const configuredUrl =
            process.env.NEXT_PUBLIC_WS_URL ||
            API_BASE ||
            "wss://casino-axiom.ethiodeploy.app";

        let backendUrl = configuredUrl.trim().replace(/\/+$/, "");

        if (backendUrl.startsWith("https://")) {
            backendUrl = "wss://" + backendUrl.slice(8);
        } else if (backendUrl.startsWith("http://")) {
            backendUrl = "ws://" + backendUrl.slice(7);
        }

        return `${backendUrl}${endpoint}`;
    }, []);

    const loadUserBalances = useCallback(async (currentSession?: any) => {
        try {
            let session = currentSession;

            if (!session) {
                const { data, error } = await supabase.auth.getSession();
                if (error) {
                    console.error("Error obteniendo sesión:", error);
                    return;
                }
                session = data.session;
            }

            const currentUserId = session?.user?.id;
            if (!currentUserId) {
                setUserId(null);
                userIdRef.current = null;
                setAccessToken("");
                accessTokenRef.current = "";
                setPlayBalance(0);
                setBonusBalance(0);
                return;
            }

            const token = session.access_token || "";
            setUserId(currentUserId);
            userIdRef.current = currentUserId;
            setAccessToken(token);
            accessTokenRef.current = token;

            const { data: profile, error } = await supabase
                .from("profiles")
                .select("balance, bonus_balance")
                .eq("id", currentUserId)
                .maybeSingle();

            if (error) {
                console.error("Error cargando perfil:", error);
                return;
            }

            if (profile) {
                setPlayBalance(Number(profile.balance ?? 0));
                setBonusBalance(Number(profile.bonus_balance ?? 0));
            }
        } catch (error) {
            console.error("Error cargando saldos:", error);
        }
    }, []);

    useEffect(() => {
        let mounted = true;

        const initialize = async () => {
            const { data, error } = await supabase.auth.getSession();
            if (error) {
                console.error("Error de autenticación:", error);
            }
            if (!mounted) return;
            await loadUserBalances(data.session);
            if (mounted) setIsAuthLoading(false);
        };

        void initialize();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!mounted) return;
            if (session) {
                void loadUserBalances(session);
            } else {
                setUserId(null);
                userIdRef.current = null;
                setAccessToken("");
                accessTokenRef.current = "";
                setPlayBalance(0);
                setBonusBalance(0);
            }
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, [loadUserBalances]);

    const fetchPublicRooms = useCallback(async () => {
        try {
            const amount = PARCHIS_BETS[selectedBet];
            const res = await fetch(
                `${API_BASE}/parchis/rooms?bet=${encodeURIComponent(String(amount))}`
            );
            if (!res.ok) return;
            const data = await res.json();
            setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
        } catch {
            // ignore network errors while polling lobby
        }
    }, [selectedBet]);

    useEffect(() => {
        if (isInGame || !userId) return;
        void fetchPublicRooms();
        const timer = setInterval(() => {
            void fetchPublicRooms();
        }, 4000);
        return () => clearInterval(timer);
    }, [isInGame, userId, fetchPublicRooms]);

    const exitParchisGame = useCallback(() => {
        closingByUserRef.current = true;
        startingRef.current = false;
        connectedRef.current = false;

        setIsConnected(false);
        setIsInGame(false);
        setGameState(null);
        gameStateRef.current = null;

        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }

        const ws = socketRef.current;
        socketRef.current = null;

        if (ws) {
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            if (
                ws.readyState === WebSocket.OPEN ||
                ws.readyState === WebSocket.CONNECTING
            ) {
                ws.close(1000, "Jugador salió de la partida");
            }
        }

        void loadUserBalances();
    }, [loadUserBalances]);

    const connectToRoom = useCallback(
        (targetRoomId: string, pwd = "", overrideBet?: number, overridePlayers?: MaxPlayers) => {
            if (startingRef.current || socketRef.current) {
                showAlert(
                    "Partida activa",
                    "Ya existe una conexión activa en Parchís."
                );
                return;
            }

            if (!userIdRef.current || !accessTokenRef.current) {
                showAlert(
                    "Error de sesión",
                    "No se detectó una sesión válida. Vuelve a iniciar sesión."
                );
                return;
            }

            const betAmount = overrideBet ?? PARCHIS_BETS[selectedBet];
            const playersCount = overridePlayers ?? maxPlayers;
            const available =
                selectedWallet === "play" ? playBalance : bonusBalance;

            if (available < betAmount) {
                showAlert(
                    "Saldo insuficiente",
                    `Necesitas al menos ${money(betAmount)} en la billetera seleccionada.`
                );
                return;
            }

            startingRef.current = true;
            selectedBetRef.current = betAmount;
            closingByUserRef.current = false;
            connectedRef.current = false;

            setRoomId(targetRoomId);
            setIsInGame(true);
            setIsConnected(false);
            setGameState(null);
            gameStateRef.current = null;
            setConnectionMessage("Conectando con la mesa de Parchís...");

            const wsUrl = getWebSocketUrl(
                `/ws/parchis/${encodeURIComponent(targetRoomId)}` +
                    `?user_id=${encodeURIComponent(userIdRef.current)}` +
                    `&access_token=${encodeURIComponent(accessTokenRef.current)}` +
                    `&bet=${encodeURIComponent(String(betAmount))}` +
                    `&max_players=${encodeURIComponent(String(playersCount))}` +
                    `&wallet=${encodeURIComponent(selectedWallet)}` +
                    `&password=${encodeURIComponent(pwd)}`
            );

            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

            try {
                const ws = new WebSocket(wsUrl);
                socketRef.current = ws;

                ws.onopen = () => {
                    if (socketRef.current !== ws) return;
                    if (heartbeatTimer) clearInterval(heartbeatTimer);
                    heartbeatTimer = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            try {
                                ws.send(JSON.stringify({ type: "PING" }));
                            } catch {}
                        }
                    }, 20000);
                    setConnectionMessage("Esperando estado del tablero...");
                };

                ws.onmessage = (event) => {
                    if (socketRef.current !== ws) return;

                    try {
                        const data = JSON.parse(event.data);

                        if (data.type === "PARCHIS_STATE") {
                            gameStateRef.current = data;
                            setGameState(data);
                            if (data.room_id) {
                                setRoomId(String(data.room_id));
                            }
                            if (!connectedRef.current) {
                                connectedRef.current = true;
                                setIsConnected(true);
                                setConnectionMessage("Conectado");
                            }
                            if (data.status === "finished") {
                                void loadUserBalances();
                            }
                            return;
                        }

                        if (data.type === "ERROR") {
                            startingRef.current = false;
                            showAlert(
                                "Error de partida",
                                data.message || "No se pudo completar la acción."
                            );
                            if (!connectedRef.current) {
                                exitParchisGame();
                            }
                        }
                    } catch (error) {
                        console.error("Error procesando mensaje Parchís:", error);
                    }
                };

                ws.onerror = () => {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }
                    if (socketRef.current === ws) {
                        setConnectionMessage("Reintentando enlace...");
                    }
                };

                ws.onclose = (event) => {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }
                    if (socketRef.current !== ws) return;

                    startingRef.current = false;
                    socketRef.current = null;
                    connectedRef.current = false;
                    setIsConnected(false);

                    if (!closingByUserRef.current) {
                        setIsInGame(false);
                        if (event.code !== 1000) {
                            showAlert(
                                "Conexión cerrada",
                                event.reason ||
                                    `Se cerró la conexión (${event.code}).`
                            );
                        }
                    }

                    void loadUserBalances();
                };
            } catch (error) {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                console.error("Error creando WebSocket Parchís:", error);
                startingRef.current = false;
                socketRef.current = null;
                setIsInGame(false);
                showAlert(
                    "Error de conexión",
                    "No se pudo conectar con el servidor de Parchís."
                );
            }
        },
        [
            bonusBalance,
            exitParchisGame,
            getWebSocketUrl,
            loadUserBalances,
            maxPlayers,
            playBalance,
            selectedBet,
            selectedWallet,
            showAlert,
        ]
    );

    const handleCreatePrivateOrCustomRoom = async () => {
        if (!accessTokenRef.current) {
            showAlert("Sesión requerida", "Inicia sesión para crear una sala.");
            return;
        }

        const betAmount = PARCHIS_BETS[selectedBet];
        const available =
            selectedWallet === "play" ? playBalance : bonusBalance;

        if (available < betAmount) {
            showAlert(
                "Saldo insuficiente",
                `Necesitas al menos ${money(betAmount)} en la billetera seleccionada.`
            );
            return;
        }

        setBusyAction(true);
        try {
            const res = await fetch(`${API_BASE}/parchis/rooms/create`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${accessTokenRef.current}`,
                },
                body: JSON.stringify({
                    bet: betAmount,
                    max_players: maxPlayers,
                    wallet: selectedWallet,
                    is_private: isPrivate,
                    password: isPrivate ? roomPassword.trim() : "",
                }),
            });

            const data = await res.json();
            if (!res.ok || !data.room_id) {
                showAlert(
                    "No se pudo crear la sala",
                    data.detail || "Revisa los datos e intenta nuevamente."
                );
                return;
            }

            connectToRoom(
                String(data.room_id),
                String(data.room_code || roomPassword.trim()),
                betAmount,
                maxPlayers
            );
        } catch {
            showAlert("Error de red", "No se pudo contactar al servidor.");
        } finally {
            setBusyAction(false);
        }
    };

    const sendRollDice = () => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "ROLL_DICE" }));
    };

    const sendMovePiece = (pieceId: number) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "MOVE_PIECE", piece_id: pieceId }));
    };

    const renderBoard = useCallback(() => {
        const canvas = boardCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const size = Math.max(220, Math.floor(Math.min(rect.width, rect.height || rect.width)));

        if (
            canvas.width !== Math.floor(size * dpr) ||
            canvas.height !== Math.floor(size * dpr)
        ) {
            canvas.width = Math.floor(size * dpr);
            canvas.height = Math.floor(size * dpr);
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);

        const cx = size / 2;
        const cy = size / 2;
        const outerR = size * 0.41;

        ctx.fillStyle = "#060b09";
        ctx.fillRect(0, 0, size, size);

        ctx.beginPath();
        ctx.arc(cx, cy, outerR + 18, 0, Math.PI * 2);
        ctx.fillStyle = "#0b1511";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(52, 211, 153, 0.25)";
        ctx.stroke();

        for (let i = 0; i < TRACK_LEN; i++) {
            const pt = getTrackPoint(i, cx, cy, outerR);
            const isSafe = SAFE_SPOTS.has(i);
            const isStart = Object.values(START_SPOTS).includes(i);

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isSafe ? 6.5 : 4.5, 0, Math.PI * 2);
            ctx.fillStyle = isStart
                ? "#34d399"
                : isSafe
                  ? "#fbbf24"
                  : "#182620";
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.14)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.085, 0, Math.PI * 2);
        ctx.fillStyle = "#10b981";
        ctx.fill();

        const state = gameStateRef.current;
        if (!state || !Array.isArray(state.players)) return;

        const currentUid = userIdRef.current;
        const me = state.players.find((p) => p.user_id === currentUid);
        const isMyTurn =
            state.status === "playing" &&
            me &&
            state.turn_seat === me.seat_index &&
            state.must_move &&
            state.dice !== null;

        for (const p of state.players) {
            const color = SEAT_COLORS[p.seat_index % SEAT_COLORS.length];
            const seatAngle = (p.seat_index * Math.PI) / 2 - Math.PI / 2;
            const homeDist = size * 0.31;
            const hx = cx + Math.cos(seatAngle) * homeDist;
            const hy = cy + Math.sin(seatAngle) * homeDist;

            ctx.save();
            ctx.beginPath();
            ctx.arc(hx, hy, 22, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(24, 24, 27, 0.85)";
            ctx.fill();
            ctx.lineWidth = state.turn_seat === p.seat_index ? 3 : 1.5;
            ctx.strokeStyle =
                state.turn_seat === p.seat_index ? "#34d399" : color;
            ctx.stroke();
            ctx.restore();

            for (const piece of p.pieces || []) {
                const pt = getPieceBoardPoint(piece, p.seat_index, cx, cy, size);
                const canMoveThis = Boolean(
                    isMyTurn &&
                        p.user_id === currentUid &&
                        ((piece.stage === -1 && state.dice === 5) ||
                            piece.stage === 0 ||
                            piece.stage === 100)
                );

                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, canMoveThis ? 9 : 7.5, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.lineWidth = canMoveThis ? 2.5 : 1.5;
                ctx.strokeStyle = canMoveThis ? "#ffffff" : "#09090b";
                ctx.stroke();

                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 9px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(piece.id + 1), pt.x, pt.y);
                ctx.restore();
            }
        }
    }, []);

    useEffect(() => {
        if (!isInGame) return;
        let running = true;
        const loop = () => {
            if (!running) return;
            renderBoard();
            animationFrameRef.current = requestAnimationFrame(loop);
        };
        animationFrameRef.current = requestAnimationFrame(loop);
        return () => {
            running = false;
            if (animationFrameRef.current !== null) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        };
    }, [isInGame, renderBoard]);

    const handleBoardPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
        const state = gameStateRef.current;
        const currentUid = userIdRef.current;
        if (!state || !currentUid || state.status !== "playing") return;

        const me = state.players.find((p) => p.user_id === currentUid);
        if (
            !me ||
            state.turn_seat !== me.seat_index ||
            !state.must_move ||
            state.dice === null
        ) {
            return;
        }

        const canvas = boardCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const size = Math.max(
            220,
            Math.floor(Math.min(rect.width, rect.height || rect.width))
        );
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        const cx = size / 2;
        const cy = size / 2;

        let closestId = -1;
        let minDist = 20;

        for (const piece of me.pieces || []) {
            const pt = getPieceBoardPoint(piece, me.seat_index, cx, cy, size);
            const dist = Math.hypot(clickX - pt.x, clickY - pt.y);
            if (dist < minDist) {
                minDist = dist;
                closestId = piece.id;
            }
        }

        if (closestId >= 0) {
            sendMovePiece(closestId);
        }
    };

    if (isAuthLoading) {
        return (
            <div className="min-h-screen bg-black text-white flex flex-col">
                <Header />
                <main className="flex-1 flex items-center justify-center p-4">
                    <p className="text-xs uppercase tracking-widest text-emerald-400 font-bold">
                        Cargando AXIOM Parchís
                    </p>
                </main>
            </div>
        );
    }

    if (!userId) {
        return (
            <div className="min-h-screen bg-black text-white flex flex-col">
                <Header />
                <main className="flex-1 flex items-center justify-center p-4">
                    <div className="max-w-md w-full bg-zinc-950 border border-zinc-800 rounded-3xl p-6 sm:p-8 text-center space-y-6 shadow-2xl">
                        <h2 className="text-xl font-black uppercase">
                            Acceso restringido
                        </h2>
                        <p className="text-xs text-zinc-400 leading-relaxed">
                            Inicia sesión para jugar en las mesas de Parchís.
                        </p>
                        <Link
                            href="/"
                            className="block w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                        >
                            Iniciar sesión
                        </Link>
                    </div>
                </main>
            </div>
        );
    }

    const myPlayer =
        gameState?.players.find((p) => p.user_id === userId) || null;
    const isMyTurn = Boolean(
        gameState &&
            gameState.status === "playing" &&
            myPlayer &&
            gameState.turn_seat === myPlayer.seat_index
    );

    return (
        <div className="min-h-screen bg-black text-white flex flex-col select-none font-sans overflow-x-hidden">
            {modal.isOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
                    <div className="bg-zinc-950 border border-zinc-800 w-full max-w-sm rounded-3xl p-6 text-center space-y-4 shadow-2xl">
                        <h3 className="text-lg font-black uppercase text-emerald-400">
                            {modal.title}
                        </h3>
                        <p className="text-xs text-zinc-300 leading-relaxed">
                            {modal.message}
                        </p>
                        <button
                            type="button"
                            onClick={closeModal}
                            className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                        >
                            Entendido
                        </button>
                    </div>
                </div>
            )}

            <Header />

            <main className="flex-1 max-w-5xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-8 flex flex-col items-center justify-center">
                {!isInGame ? (
                    <div className="w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-2xl">
                        <div className="flex items-center justify-between gap-2 border-b border-zinc-900 pb-3.5">
                            <Link
                                href="/"
                                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-emerald-400 font-bold uppercase transition-colors"
                            >
                                <span>&lsaquo;</span>
                                <span>Volver</span>
                            </Link>

                            <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full">
                                {maxPlayers === 4 ? "2v2 Equipos" : "Todos vs Todos"}
                            </span>
                        </div>

                        <div className="text-center">
                            <h2 className="text-xl sm:text-2xl font-black text-emerald-400 uppercase tracking-wider">
                                Parchís Arena P2P
                            </h2>
                            <p className="text-xs text-zinc-400 mt-1">
                                Elige billetera, apuesta y modalidad de mesa.
                            </p>
                        </div>

                        <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4 space-y-5">
                            <div>
                                <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                    Billetera
                                </label>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedWallet("play")}
                                        className={`py-3 px-2 rounded-xl text-xs font-black uppercase border transition-all ${
                                            selectedWallet === "play"
                                                ? "bg-emerald-500 text-black border-emerald-400"
                                                : "bg-black text-zinc-400 hover:text-white border-zinc-800"
                                        }`}
                                    >
                                        Jugar ({money(playBalance)})
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setSelectedWallet("bonus")}
                                        className={`py-3 px-2 rounded-xl text-xs font-black uppercase border transition-all ${
                                            selectedWallet === "bonus"
                                                ? "bg-yellow-400 text-black border-yellow-300"
                                                : "bg-black text-zinc-400 hover:text-white border-zinc-800"
                                        }`}
                                    >
                                        Bono ({money(bonusBalance)})
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                        Apuesta
                                    </label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(["0.25", "1.00", "10.00"] as ParchisBet[]).map(
                                            (amt) => (
                                                <button
                                                    key={amt}
                                                    type="button"
                                                    onClick={() => setSelectedBet(amt)}
                                                    className={`py-3 rounded-xl text-xs sm:text-sm font-black border transition-all ${
                                                        selectedBet === amt
                                                            ? "bg-emerald-500 text-black border-emerald-400"
                                                            : "bg-black text-zinc-400 border-zinc-800 hover:border-emerald-500"
                                                    }`}
                                                >
                                                    ${amt}
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>

                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                        Jugadores
                                    </label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([2, 3, 4] as MaxPlayers[]).map((cnt) => (
                                            <button
                                                key={cnt}
                                                type="button"
                                                onClick={() => setMaxPlayers(cnt)}
                                                className={`py-3 rounded-xl text-xs sm:text-sm font-black border transition-all ${
                                                    maxPlayers === cnt
                                                        ? "bg-emerald-500 text-black border-emerald-400"
                                                        : "bg-black text-zinc-400 border-zinc-800 hover:border-emerald-500"
                                                }`}
                                            >
                                                {cnt}P
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="bg-black/60 border border-zinc-800 rounded-2xl p-3.5 space-y-3">
                                <label className="flex items-center gap-2.5 text-xs font-bold text-zinc-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={isPrivate}
                                        onChange={(e) => setIsPrivate(e.target.checked)}
                                        className="rounded accent-emerald-500"
                                    />
                                    <span>Sala privada con contraseña</span>
                                </label>

                                {isPrivate && (
                                    <input
                                        type="text"
                                        value={roomPassword}
                                        onChange={(e) => setRoomPassword(e.target.value)}
                                        placeholder="Código o contraseña de sala"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                    <button
                                        type="button"
                                        disabled={startingRef.current || busyAction}
                                        onClick={() => connectToRoom("matchmake", "")}
                                        className="py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs uppercase rounded-2xl transition-all"
                                    >
                                        Buscar Sala Pública
                                    </button>

                                    <button
                                        type="button"
                                        disabled={startingRef.current || busyAction}
                                        onClick={handleCreatePrivateOrCustomRoom}
                                        className="py-3.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-black text-xs uppercase rounded-2xl border border-zinc-700 transition-all"
                                    >
                                        {isPrivate ? "Crear Sala Privada" : "Crear Nueva Sala"}
                                    </button>
                                </div>
                            </div>

                            <div className="border-t border-zinc-800 pt-4 space-y-2.5">
                                <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                    Entrar por ID de sala
                                </span>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <input
                                        type="text"
                                        value={joinRoomId}
                                        onChange={(e) => setJoinRoomId(e.target.value)}
                                        placeholder="ID de sala"
                                        className="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                    <input
                                        type="text"
                                        value={joinPassword}
                                        onChange={(e) => setJoinPassword(e.target.value)}
                                        placeholder="Contraseña (si aplica)"
                                        className="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                    <button
                                        type="button"
                                        disabled={!joinRoomId.trim() || startingRef.current}
                                        onClick={() =>
                                            connectToRoom(
                                                joinRoomId.trim(),
                                                joinPassword.trim()
                                            )
                                        }
                                        className="py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-emerald-400 font-black text-xs uppercase rounded-xl border border-zinc-800 transition-all"
                                    >
                                        Unirse
                                    </button>
                                </div>
                            </div>

                            <div className="border-t border-zinc-800 pt-4 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-zinc-400 uppercase font-bold">
                                        Salas abiertas (${selectedBet})
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => void fetchPublicRooms()}
                                        className="text-[10px] text-emerald-400 font-bold uppercase hover:underline"
                                    >
                                        Actualizar
                                    </button>
                                </div>

                                {publicRooms.length === 0 ? (
                                    <p className="text-xs text-zinc-500">
                                        No hay salas públicas disponibles para este monto.
                                    </p>
                                ) : (
                                    <div className="space-y-2 max-h-40 overflow-y-auto">
                                        {publicRooms.map((item) => (
                                            <div
                                                key={item.room_id}
                                                className="flex items-center justify-between bg-black border border-zinc-800 rounded-xl px-3 py-2 text-xs"
                                            >
                                                <div>
                                                    <span className="font-mono text-zinc-200 block">
                                                        {item.room_id}
                                                    </span>
                                                    <span className="text-[10px] text-zinc-400">
                                                        {item.players_count}/{item.max_players} jugadores ·{" "}
                                                        {item.team_mode === "2v2" ? "2v2" : "FFA"}
                                                    </span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        connectToRoom(
                                                            item.room_id,
                                                            "",
                                                            item.bet,
                                                            item.max_players as MaxPlayers
                                                        )
                                                    }
                                                    className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-[10px] uppercase rounded-lg"
                                                >
                                                    Entrar
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-2xl">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-900 pb-3.5">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <button
                                    type="button"
                                    onClick={exitParchisGame}
                                    className="px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-red-400 text-xs font-bold uppercase rounded-xl border border-zinc-800 shrink-0"
                                >
                                    &lsaquo; Salir
                                </button>
                                <div className="min-w-0">
                                    <span className="block text-xs font-black text-emerald-400 uppercase truncate">
                                        Parchís Arena
                                    </span>
                                    <span className="block text-[10px] text-zinc-400 truncate">
                                        {gameState?.room_id || roomId}
                                        {gameState?.is_private && gameState?.room_code
                                            ? ` · Código: ${gameState.room_code}`
                                            : ""}
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="text-right">
                                    <span className="block text-[9px] text-zinc-500 uppercase">
                                        Bote
                                    </span>
                                    <span className="text-xs sm:text-sm font-black text-emerald-400">
                                        {money(gameState?.pot_total ?? 0)}
                                    </span>
                                </div>

                                <span
                                    className={`text-[10px] font-bold uppercase ${
                                        isConnected
                                            ? "text-emerald-400"
                                            : "text-yellow-400"
                                    }`}
                                >
                                    {isConnected ? "Activo" : "Enlazando"}
                                </span>
                            </div>
                        </div>

                        {!isConnected || !gameState ? (
                            <div className="py-16 text-center text-xs text-yellow-400 uppercase font-bold tracking-wider">
                                {connectionMessage}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                                <div className="lg:col-span-6 flex flex-col items-center">
                                    <canvas
                                        ref={boardCanvasRef}
                                        onPointerDown={handleBoardPointerDown}
                                        className="w-full max-w-[380px] aspect-square rounded-2xl border border-zinc-800 cursor-pointer touch-none"
                                        style={{ touchAction: "none" }}
                                    />
                                    <p className="text-[11px] text-emerald-400 mt-2.5 text-center font-medium">
                                        {gameState.last_event || "Esperando turno..."}
                                    </p>
                                </div>

                                <div className="lg:col-span-6 space-y-4">
                                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-3">
                                        <div>
                                            <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                                Dado actual
                                            </span>
                                            <span className="text-2xl font-black text-white">
                                                {gameState.dice !== null
                                                    ? gameState.dice
                                                    : "-"}
                                            </span>
                                        </div>

                                        <button
                                            type="button"
                                            disabled={!isMyTurn || gameState.must_move}
                                            onClick={sendRollDice}
                                            className="px-5 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-black text-xs uppercase rounded-2xl transition-all"
                                        >
                                            Lanzar Dado
                                        </button>
                                    </div>

                                    {gameState.status === "finished" && (
                                        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-2xl p-4 text-center space-y-2">
                                            <h3 className="text-base font-black uppercase text-emerald-400">
                                                Partida Finalizada
                                            </h3>
                                            <p className="text-xs text-zinc-200">
                                                {gameState.winners.includes(userId)
                                                    ? "¡Ganaste la partida!"
                                                    : "La partida ha concluido."}
                                            </p>
                                            <button
                                                type="button"
                                                onClick={exitParchisGame}
                                                className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-xl"
                                            >
                                                Volver al Lobby
                                            </button>
                                        </div>
                                    )}

                                    <div className="space-y-2.5">
                                        {gameState.players.map((p) => {
                                            const isMe = p.user_id === userId;
                                            const activeTurn =
                                                gameState.status === "playing" &&
                                                gameState.turn_seat === p.seat_index;
                                            const seatColor =
                                                SEAT_COLORS[
                                                    p.seat_index % SEAT_COLORS.length
                                                ];

                                            return (
                                                <div
                                                    key={p.user_id}
                                                    className={`bg-zinc-900/40 rounded-2xl p-3 border ${
                                                        activeTurn
                                                            ? "border-emerald-400"
                                                            : "border-zinc-800"
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <span
                                                                className="w-3 h-3 rounded-full"
                                                                style={{
                                                                    backgroundColor:
                                                                        seatColor,
                                                                }}
                                                            />
                                                            <span className="text-xs font-black">
                                                                Asiento {p.seat_index + 1}
                                                                {p.team
                                                                    ? ` · Equipo ${p.team}`
                                                                    : ""}
                                                                {isMe ? " (Tú)" : ""}
                                                            </span>
                                                        </div>
                                                        <span className="text-[10px] text-zinc-400 uppercase">
                                                            {p.connected
                                                                ? "Conectado"
                                                                : "Desconectado"}
                                                        </span>
                                                    </div>

                                                    <div className="grid grid-cols-4 gap-1.5">
                                                        {p.pieces.map((pc) => {
                                                            const canMove = Boolean(
                                                                isMe &&
                                                                    isMyTurn &&
                                                                    gameState.must_move &&
                                                                    gameState.dice !==
                                                                        null
                                                            );
                                                            const label =
                                                                pc.stage === -1
                                                                    ? "Casa"
                                                                    : pc.stage === 100
                                                                      ? `Meta ${pc.pos + 1}`
                                                                      : `C-${pc.pos}`;

                                                            return (
                                                                <button
                                                                    key={pc.id}
                                                                    type="button"
                                                                    disabled={!canMove}
                                                                    onClick={() =>
                                                                        sendMovePiece(pc.id)
                                                                    }
                                                                    className={`py-1.5 px-2 rounded-xl border text-[10px] font-bold transition-all ${
                                                                        canMove
                                                                            ? "bg-emerald-500/15 hover:bg-emerald-500/30 border-emerald-400 text-white"
                                                                            : "bg-black/60 border-zinc-800 text-zinc-400"
                                                                    }`}
                                                                >
                                                                    F{pc.id + 1}: {label}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {!isInGame && (
                <footer className="py-6 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
                    AXIOM PARCHIS ARENA
                </footer>
            )}
        </div>
    );
}