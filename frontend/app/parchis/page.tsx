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

const SEAT_PALETTE = [
    {
        name: "Rojo",
        main: "#ef4444",
        dark: "#7f1d1d",
        soft: "rgba(239, 68, 68, 0.22)",
        light: "#fca5a5",
    },
    {
        name: "Azul",
        main: "#3b82f6",
        dark: "#1e3a8a",
        soft: "rgba(59, 130, 246, 0.22)",
        light: "#93c5fd",
    },
    {
        name: "Verde",
        main: "#22c55e",
        dark: "#14532d",
        soft: "rgba(34, 197, 94, 0.22)",
        light: "#86efac",
    },
    {
        name: "Amarillo",
        main: "#eab308",
        dark: "#713f12",
        soft: "rgba(234, 179, 8, 0.22)",
        light: "#fde047",
    },
];

const TRACK_LEN = 68;
const SAFE_SPOTS = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const START_SPOTS: Record<number, number> = { 0: 0, 1: 17, 2: 34, 3: 51 };

// Coordenadas normalizadas (0..1) sobre un tablero cuadrado de Parchís
// Orden de asientos: 0 = Arriba-Izquierda (Rojo), 1 = Arriba-Derecha (Azul),
// 2 = Abajo-Derecha (Verde), 3 = Abajo-Izquierda (Amarillo)
function getHomeCenter(seatIndex: number): { x: number; y: number } {
    switch (seatIndex % 4) {
        case 0:
            return { x: 0.2, y: 0.2 };
        case 1:
            return { x: 0.8, y: 0.2 };
        case 2:
            return { x: 0.8, y: 0.8 };
        default:
            return { x: 0.2, y: 0.8 };
    }
}

function getHomeSlotOffset(pieceId: number, cellSize: number): { dx: number; dy: number } {
    const d = cellSize * 0.62;
    const slots = [
        { dx: -d, dy: -d },
        { dx: d, dy: -d },
        { dx: -d, dy: d },
        { dx: d, dy: d },
    ];
    return slots[pieceId % 4];
}

// Genera las 68 casillas perimetrales alrededor de la cruz central (grilla 15x15)
function buildTrackGridCoords(): Array<{ gx: number; gy: number }> {
    const coords: Array<{ gx: number; gy: number }> = [];

    // Brazo superior (columna 6 bajando, columna 8 subiendo)
    for (let y = 0; y <= 5; y++) coords.push({ gx: 6, gy: y });
    coords.push({ gx: 6, gy: 6 }); // esquina superior izq de la cruz
    for (let x = 5; x >= 0; x--) coords.push({ gx: x, gy: 6 });
    coords.push({ gx: 0, gy: 7 }); // extremo izquierdo medio
    for (let x = 0; x <= 5; x++) coords.push({ gx: x, gy: 8 });
    coords.push({ gx: 6, gy: 8 }); // esquina inferior izq de la cruz
    for (let y = 9; y <= 14; y++) coords.push({ gx: 6, gy: y });
    coords.push({ gx: 7, gy: 14 }); // extremo inferior medio
    for (let y = 14; y >= 9; y--) coords.push({ gx: 8, gy: y });
    coords.push({ gx: 8, gy: 8 }); // esquina inferior der de la cruz
    for (let x = 9; x <= 14; x++) coords.push({ gx: x, gy: 8 });
    coords.push({ gx: 14, gy: 7 }); // extremo derecho medio
    for (let x = 14; x >= 9; x--) coords.push({ gx: x, gy: 6 });
    coords.push({ gx: 8, gy: 6 }); // esquina superior der de la cruz
    for (let y = 5; y >= 0; y--) coords.push({ gx: 8, gy: y });
    coords.push({ gx: 7, gy: 0 }); // extremo superior medio

    // Ajustamos exactamente a 68 posiciones distribuidas en el perímetro de la cruz
    const perimeter: Array<{ gx: number; gy: number }> = [];
    // Superior izq -> baja por col 6
    for (let y = 0; y < 6; y++) perimeter.push({ gx: 6, gy: y });
    // Izq superior -> va a der por fila 6 hasta col 5
    for (let x = 5; x >= 0; x--) perimeter.push({ gx: x, gy: 6 });
    perimeter.push({ gx: 0, gy: 7 });
    for (let x = 0; x < 6; x++) perimeter.push({ gx: x, gy: 8 });
    for (let y = 9; y <= 14; y++) perimeter.push({ gx: 6, gy: y });
    perimeter.push({ gx: 7, gy: 14 });
    for (let y = 14; y > 8; y--) perimeter.push({ gx: 8, gy: y });
    for (let x = 9; x <= 14; x++) perimeter.push({ gx: x, gy: 8 });
    perimeter.push({ gx: 14, gy: 7 });
    for (let x = 14; x > 8; x--) perimeter.push({ gx: x, gy: 6 });
    for (let y = 5; y >= 0; y--) perimeter.push({ gx: 8, gy: y });
    perimeter.push({ gx: 7, gy: 0 });

    // Normaliza a 68 casillas uniformes sobre el bucle perimetral
    const result: Array<{ gx: number; gy: number }> = [];
    const totalPts = perimeter.length;
    for (let i = 0; i < TRACK_LEN; i++) {
        const idx = Math.floor((i * totalPts) / TRACK_LEN) % totalPts;
        result.push(perimeter[idx]);
    }
    return result;
}

const TRACK_GRID = buildTrackGridCoords();

function getGoalLanePoint(
    seatIndex: number,
    pos: number,
    boardSize: number
): { x: number; y: number } {
    const pad = boardSize * 0.04;
    const inner = boardSize - pad * 2;
    const cell = inner / 15;
    const clamped = Math.max(0, Math.min(7, pos));
    const step = clamped / 7;

    // 0: arriba (baja hacia centro), 1: derecha (va hacia centro),
    // 2: abajo (sube hacia centro), 3: izquierda (va hacia centro)
    switch (seatIndex % 4) {
        case 0: {
            const gx = 7;
            const gy = 1 + step * 5.2;
            return {
                x: pad + (gx + 0.5) * cell,
                y: pad + (gy + 0.5) * cell,
            };
        }
        case 1: {
            const gx = 13 - step * 5.2;
            const gy = 7;
            return {
                x: pad + (gx + 0.5) * cell,
                y: pad + (gy + 0.5) * cell,
            };
        }
        case 2: {
            const gx = 7;
            const gy = 13 - step * 5.2;
            return {
                x: pad + (gx + 0.5) * cell,
                y: pad + (gy + 0.5) * cell,
            };
        }
        default: {
            const gx = 1 + step * 5.2;
            const gy = 7;
            return {
                x: pad + (gx + 0.5) * cell,
                y: pad + (gy + 0.5) * cell,
            };
        }
    }
}

function getPieceBoardPoint(
    piece: ParchisPiece,
    seatIndex: number,
    boardSize: number
): { x: number; y: number } {
    const pad = boardSize * 0.04;
    const inner = boardSize - pad * 2;
    const cell = inner / 15;

    if (piece.stage === -1) {
        const home = getHomeCenter(seatIndex);
        const slot = getHomeSlotOffset(piece.id, cell);
        return {
            x: home.x * boardSize + slot.dx,
            y: home.y * boardSize + slot.dy,
        };
    }

    if (piece.stage === 100) {
        const pt = getGoalLanePoint(seatIndex, piece.pos, boardSize);
        const jitter = (piece.id % 2 === 0 ? -1 : 1) * (cell * 0.14);
        return {
            x: pt.x + (seatIndex % 2 === 0 ? jitter : 0),
            y: pt.y + (seatIndex % 2 === 1 ? jitter : 0),
        };
    }

    const spot = ((piece.pos % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
    const g = TRACK_GRID[spot];
    const baseX = pad + (g.gx + 0.5) * cell;
    const baseY = pad + (g.gy + 0.5) * cell;

    const spread = (piece.id % 2 === 0 ? -1 : 1) * (cell * 0.15);
    return {
        x: baseX + spread,
        y: baseY - spread * 0.6,
    };
}

function money(value: number): string {
    return `$${Number(value || 0).toFixed(2)}`;
}

function DiceFace({ value }: { value: number | null }) {
    const pipsMap: Record<number, number[]> = {
        1: [4],
        2: [2, 6],
        3: [2, 4, 6],
        4: [0, 2, 6, 8],
        5: [0, 2, 4, 6, 8],
        6: [0, 2, 3, 5, 6, 8],
    };
    const activePips = value && pipsMap[value] ? pipsMap[value] : [];

    return (
        <div className="w-14 h-14 rounded-2xl bg-zinc-100 text-zinc-950 border-2 border-white shadow-lg p-2 grid grid-cols-3 grid-rows-3 place-items-center shrink-0">
            {Array.from({ length: 9 }).map((_, idx) => (
                <span
                    key={idx}
                    className={`w-2.5 h-2.5 rounded-full transition-all ${
                        activePips.includes(idx)
                            ? "bg-zinc-950 scale-100"
                            : "bg-transparent scale-0"
                    }`}
                />
            ))}
        </div>
    );
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
    const [roomsUnavailable, setRoomsUnavailable] = useState(false);
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
            if (!res.ok) {
                setRoomsUnavailable(true);
                setPublicRooms([]);
                return;
            }
            const data = await res.json();
            setRoomsUnavailable(false);
            setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
        } catch {
            setRoomsUnavailable(true);
            setPublicRooms([]);
        }
    }, [selectedBet]);

    useEffect(() => {
        if (isInGame || !userId) return;
        void fetchPublicRooms();
        const timer = setInterval(() => {
            void fetchPublicRooms();
        }, 6000);
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
        (
            targetRoomId: string,
            pwd = "",
            overrideBet?: number,
            overridePlayers?: MaxPlayers
        ) => {
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

            const data = await res.json().catch(() => ({}));
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
        const size = Math.max(
            240,
            Math.floor(Math.min(rect.width, rect.height || rect.width))
        );

        if (
            canvas.width !== Math.floor(size * dpr) ||
            canvas.height !== Math.floor(size * dpr)
        ) {
            canvas.width = Math.floor(size * dpr);
            canvas.height = Math.floor(size * dpr);
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);

        // Marco exterior tipo madera/tablero clásico oscuro elegante
        ctx.fillStyle = "#111815";
        ctx.fillRect(0, 0, size, size);

        const pad = size * 0.04;
        const inner = size - pad * 2;
        const cell = inner / 15;

        // Fondo crema marfil clásico del tablero
        ctx.fillStyle = "#f4efe2";
        ctx.fillRect(pad, pad, inner, inner);

        // Dibujar pasillos de llegada (6 casillas de color hacia el centro)
        // Asiento 0 (Rojo): col 7, filas 1..6
        for (let y = 1; y <= 6; y++) {
            ctx.fillStyle = SEAT_PALETTE[0].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        // Asiento 1 (Azul): fila 7, cols 8..13
        for (let x = 8; x <= 13; x++) {
            ctx.fillStyle = SEAT_PALETTE[1].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }
        // Asiento 2 (Verde): col 7, filas 8..13
        for (let y = 8; y <= 13; y++) {
            ctx.fillStyle = SEAT_PALETTE[2].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        // Asiento 3 (Amarillo): fila 7, cols 1..6
        for (let x = 1; x <= 6; x++) {
            ctx.fillStyle = SEAT_PALETTE[3].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }

        // Cuadrícula de casillas del tablero
        ctx.strokeStyle = "rgba(24, 24, 27, 0.35)";
        ctx.lineWidth = 1;
        for (let r = 0; r < 15; r++) {
            for (let c = 0; c < 15; c++) {
                // Omitir interior de las 4 casas (6x6 en esquinas) y centro (3x3)
                const inTopLeftHome = r < 6 && c < 6;
                const inTopRightHome = r < 6 && c > 8;
                const inBottomRightHome = r > 8 && c > 8;
                const inBottomLeftHome = r > 8 && c < 6;
                const inCenter = r >= 6 && r <= 8 && c >= 6 && c <= 8;

                if (
                    inTopLeftHome ||
                    inTopRightHome ||
                    inBottomRightHome ||
                    inBottomLeftHome ||
                    inCenter
                ) {
                    continue;
                }

                ctx.strokeRect(
                    pad + c * cell,
                    pad + r * cell,
                    cell,
                    cell
                );
            }
        }

        // Resaltar casillas seguras y de salida en el track de 68
        for (let i = 0; i < TRACK_LEN; i++) {
            const g = TRACK_GRID[i];
            const px = pad + (g.gx + 0.5) * cell;
            const py = pad + (g.gy + 0.5) * cell;

            const startSeatEntry = Object.entries(START_SPOTS).find(
                ([, spot]) => spot === i
            );

            if (startSeatEntry) {
                const sIdx = Number(startSeatEntry[0]);
                ctx.fillStyle = SEAT_PALETTE[sIdx % 4].main;
                ctx.fillRect(
                    pad + g.gx * cell + 1,
                    pad + g.gy * cell + 1,
                    cell - 2,
                    cell - 2
                );
            }

            if (SAFE_SPOTS.has(i)) {
                ctx.beginPath();
                ctx.arc(px, py, Math.max(3.5, cell * 0.18), 0, Math.PI * 2);
                ctx.fillStyle = startSeatEntry ? "#ffffff" : "#d97706";
                ctx.fill();
                ctx.lineWidth = 1;
                ctx.strokeStyle = "#18181b";
                ctx.stroke();
            }
        }

        // Dibujar las 4 Casas (Cárceles) en las esquinas
        const homes = [
            { seat: 0, gx: 0, gy: 0 },
            { seat: 1, gx: 9, gy: 0 },
            { seat: 2, gx: 9, gy: 9 },
            { seat: 3, gx: 0, gy: 9 },
        ];

        const state = gameStateRef.current;

        for (const h of homes) {
            const pal = SEAT_PALETTE[h.seat];
            const hx0 = pad + h.gx * cell;
            const hy0 = pad + h.gy * cell;
            const hSize = cell * 6;

            ctx.fillStyle = pal.main;
            ctx.fillRect(hx0, hy0, hSize, hSize);
            ctx.strokeStyle = "#18181b";
            ctx.lineWidth = 2;
            ctx.strokeRect(hx0, hy0, hSize, hSize);

            // Patio interior blanco de la casa
            const inset = cell * 1.1;
            ctx.fillStyle = "#f4efe2";
            ctx.beginPath();
            ctx.roundRect(
                hx0 + inset,
                hy0 + inset,
                hSize - inset * 2,
                hSize - inset * 2,
                cell * 0.5
            );
            ctx.fill();

            const isTurn =
                state?.status === "playing" && state.turn_seat === h.seat;
            if (isTurn) {
                ctx.save();
                ctx.strokeStyle = "#10b981";
                ctx.lineWidth = 3.5;
                ctx.strokeRect(hx0 + 2, hy0 + 2, hSize - 4, hSize - 4);
                ctx.restore();
            }

            // 4 huecos de fichas en casa
            const center = getHomeCenter(h.seat);
            for (let pid = 0; pid < 4; pid++) {
                const slot = getHomeSlotOffset(pid, cell);
                const sx = center.x * size + slot.dx;
                const sy = center.y * size + slot.dy;

                ctx.beginPath();
                ctx.arc(sx, sy, cell * 0.36, 0, Math.PI * 2);
                ctx.fillStyle = pal.soft;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = pal.main;
                ctx.stroke();
            }
        }

        // Meta central (4 triángulos de colores)
        const cLeft = pad + 6 * cell;
        const cTop = pad + 6 * cell;
        const cSize = cell * 3;
        const midX = cLeft + cSize / 2;
        const midY = cTop + cSize / 2;

        const triangles = [
            // Rojo (arriba)
            {
                pts: [
                    [cLeft, cTop],
                    [cLeft + cSize, cTop],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[0].main,
            },
            // Azul (derecha)
            {
                pts: [
                    [cLeft + cSize, cTop],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[1].main,
            },
            // Verde (abajo)
            {
                pts: [
                    [cLeft, cTop + cSize],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[2].main,
            },
            // Amarillo (izquierda)
            {
                pts: [
                    [cLeft, cTop],
                    [cLeft, cTop + cSize],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[3].main,
            },
        ];

        for (const tri of triangles) {
            ctx.beginPath();
            ctx.moveTo(tri.pts[0][0], tri.pts[0][1]);
            ctx.lineTo(tri.pts[1][0], tri.pts[1][1]);
            ctx.lineTo(tri.pts[2][0], tri.pts[2][1]);
            ctx.closePath();
            ctx.fillStyle = tri.color;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#18181b";
            ctx.stroke();
        }

        if (!state || !Array.isArray(state.players)) return;

        const currentUid = userIdRef.current;
        const me = state.players.find((p) => p.user_id === currentUid);
        const isMyTurn =
            state.status === "playing" &&
            me &&
            state.turn_seat === me.seat_index &&
            state.must_move &&
            state.dice !== null;

        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);

        for (const p of state.players) {
            const pal = SEAT_PALETTE[p.seat_index % SEAT_PALETTE.length];

            for (const piece of p.pieces || []) {
                const pt = getPieceBoardPoint(piece, p.seat_index, size);
                const canMoveThis = Boolean(
                    isMyTurn &&
                        p.user_id === currentUid &&
                        ((piece.stage === -1 && state.dice === 5) ||
                            piece.stage === 0 ||
                            piece.stage === 100)
                );

                const radius = Math.max(7.5, cell * 0.34);

                if (canMoveThis) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(
                        pt.x,
                        pt.y,
                        radius + 3 + pulse * 3,
                        0,
                        Math.PI * 2
                    );
                    ctx.strokeStyle = "#10b981";
                    ctx.lineWidth = 2.5;
                    ctx.stroke();
                    ctx.restore();
                }

                // Sombra de ficha
                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x + 1.2, pt.y + 1.8, radius, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(0,0,0,0.45)";
                ctx.fill();

                // Cuerpo de ficha
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = pal.main;
                ctx.fill();
                ctx.lineWidth = canMoveThis ? 2.5 : 1.8;
                ctx.strokeStyle = canMoveThis ? "#ffffff" : "#111827";
                ctx.stroke();

                // Aro interior tipo ficha de parchís
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius * 0.62, 0, Math.PI * 2);
                ctx.fillStyle = pal.dark;
                ctx.fill();

                ctx.fillStyle = "#ffffff";
                ctx.font = `bold ${Math.max(8, Math.floor(radius * 0.95))}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(piece.id + 1), pt.x, pt.y + 0.5);
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
            240,
            Math.floor(Math.min(rect.width, rect.height || rect.width))
        );
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        let closestId = -1;
        let minDist = 24;

        for (const piece of me.pieces || []) {
            const pt = getPieceBoardPoint(piece, me.seat_index, size);
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
                                        {roomsUnavailable
                                            ? "Lista de salas en mantenimiento; puedes crear o buscar sala directa."
                                            : "No hay salas públicas disponibles para este monto."}
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
                                        className="w-full max-w-[400px] aspect-square rounded-2xl border-2 border-zinc-700 shadow-2xl cursor-pointer touch-none"
                                        style={{ touchAction: "none" }}
                                    />
                                    <p className="text-[11px] text-emerald-400 mt-2.5 text-center font-semibold">
                                        {gameState.last_event || "Esperando turno..."}
                                    </p>
                                </div>

                                <div className="lg:col-span-6 space-y-4">
                                    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-3.5">
                                            <DiceFace value={gameState.dice} />
                                            <div>
                                                <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                                    {isMyTurn
                                                        ? gameState.must_move
                                                            ? "Elige una ficha"
                                                            : "Tu turno"
                                                        : `Turno asiento ${gameState.turn_seat + 1}`}
                                                </span>
                                                <span className="text-lg font-black text-white">
                                                    {gameState.dice !== null
                                                        ? `Dado: ${gameState.dice}`
                                                        : "Sin tirar"}
                                                </span>
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            disabled={!isMyTurn || gameState.must_move}
                                            onClick={sendRollDice}
                                            className="px-5 py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-black text-xs uppercase rounded-2xl transition-all shrink-0"
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
                                            const pal =
                                                SEAT_PALETTE[
                                                    p.seat_index % SEAT_PALETTE.length
                                                ];

                                            return (
                                                <div
                                                    key={p.user_id}
                                                    className={`bg-zinc-900/40 rounded-2xl p-3 border transition-all ${
                                                        activeTurn
                                                            ? "border-emerald-400"
                                                            : "border-zinc-800"
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <span
                                                                className="w-3.5 h-3.5 rounded-full border border-white/40"
                                                                style={{
                                                                    backgroundColor:
                                                                        pal.main,
                                                                }}
                                                            />
                                                            <span className="text-xs font-black">
                                                                {pal.name} · Asiento{" "}
                                                                {p.seat_index + 1}
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
                                                                        null &&
                                                                    ((pc.stage === -1 &&
                                                                        gameState.dice ===
                                                                            5) ||
                                                                        pc.stage ===
                                                                            0 ||
                                                                        pc.stage ===
                                                                            100)
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
                                                                            ? "bg-emerald-500/20 hover:bg-emerald-500/35 border-emerald-400 text-white"
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