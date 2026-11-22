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
    player_name?: string;
    doc_number?: string;
    cedula?: string;
    seat_index: number;
    team: string | null;
    wallet: string;
    connected: boolean;
    pieces: ParchisPiece[];
}

interface ParchisState {
    type: string;
    room_id: string;
    host_user_id?: string;
    host_name?: string;
    host_doc_number?: string;
    host_cedula?: string;
    bet: number;
    max_players: number;
    team_mode: "ffa" | "2v2";
    is_private: boolean;
    room_code: string | null;
    status: string;
    turn_seat: number;
    dice: number | null;
    dice_pair?: [number, number] | number[] | null;
    must_move: boolean;
    pot_total: number;
    winners: string[];
    last_event: string;
    players: ParchisPlayerState[];
}

interface PublicRoomItem {
    room_id: string;
    host_name?: string;
    host_doc_number?: string;
    host_cedula?: string;
    bet: number;
    max_players: number;
    players_count: number;
    team_mode: string;
    is_private: boolean;
}

interface ProfileRow {
    first_name: string | null;
    doc_number: string | null;
    balance: number | null;
    bonus_balance: number | null;
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
        main: "#e53935",
        dark: "#8e1c1a",
        soft: "rgba(229, 57, 53, 0.25)",
    },
    {
        name: "Azul",
        main: "#1e88e5",
        dark: "#124e85",
        soft: "rgba(30, 136, 229, 0.25)",
    },
    {
        name: "Verde",
        main: "#2e9e44",
        dark: "#185926",
        soft: "rgba(46, 158, 68, 0.25)",
    },
    {
        name: "Amarillo",
        main: "#f4b400",
        dark: "#8c6600",
        soft: "rgba(244, 180, 0, 0.25)",
    },
];

const TRACK_LEN = 68;
const SAFE_SPOTS = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const START_SPOTS: Record<number, number> = { 0: 0, 1: 17, 2: 34, 3: 51 };

function getMainName(
    profile: Partial<ProfileRow> | null,
    fallback = "Jugador"
): string {
    const raw = (profile?.first_name || "").trim();
    if (!raw) return fallback;
    return raw.split(/\s+/)[0] || fallback;
}

function getVisualCorner(seatIndex: number, totalPlayers: number): number {
    if (totalPlayers === 2) {
        return seatIndex === 0 ? 2 : 0;
    }
    return seatIndex % 4;
}

function getHomeCenter(corner: number): { x: number; y: number } {
    switch (corner) {
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

function getHomeSlotOffset(
    pieceId: number,
    cellSize: number
): { dx: number; dy: number } {
    const d = cellSize * 0.68;
    const slots = [
        { dx: -d, dy: -d },
        { dx: d, dy: -d },
        { dx: -d, dy: d },
        { dx: d, dy: d },
    ];
    return slots[pieceId % 4];
}

function buildTrackGridCoords(): Array<{ gx: number; gy: number }> {
    const perimeter: Array<{ gx: number; gy: number }> = [];
    for (let y = 0; y < 6; y++) perimeter.push({ gx: 6, gy: y });
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
    corner: number,
    pos: number,
    boardSize: number
): { x: number; y: number } {
    const pad = boardSize * 0.03;
    const inner = boardSize - pad * 2;
    const cell = inner / 15;
    const step = Math.max(0, Math.min(7, pos)) / 7;

    switch (corner) {
        case 0:
            return {
                x: pad + 7.5 * cell,
                y: pad + (1.5 + step * 5.2) * cell,
            };
        case 1:
            return {
                x: pad + (13.5 - step * 5.2) * cell,
                y: pad + 7.5 * cell,
            };
        case 2:
            return {
                x: pad + 7.5 * cell,
                y: pad + (13.5 - step * 5.2) * cell,
            };
        default:
            return {
                x: pad + (1.5 + step * 5.2) * cell,
                y: pad + 7.5 * cell,
            };
    }
}

function getPieceBoardPoint(
    piece: ParchisPiece,
    corner: number,
    boardSize: number
): { x: number; y: number } {
    const pad = boardSize * 0.03;
    const inner = boardSize - pad * 2;
    const cell = inner / 15;

    if (piece.stage === -1) {
        const home = getHomeCenter(corner);
        const slot = getHomeSlotOffset(piece.id, cell);
        return {
            x: home.x * boardSize + slot.dx,
            y: home.y * boardSize + slot.dy,
        };
    }

    if (piece.stage === 100) {
        const pt = getGoalLanePoint(corner, piece.pos, boardSize);
        const jitter = (piece.id % 2 === 0 ? -1 : 1) * (cell * 0.14);
        return {
            x: pt.x + (corner % 2 === 0 ? jitter : 0),
            y: pt.y + (corner % 2 === 1 ? jitter : 0),
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

function resolveTwoDice(
    state: ParchisState | null
): [number | null, number | null] {
    if (!state) return [null, null];
    if (Array.isArray(state.dice_pair) && state.dice_pair.length >= 2) {
        return [Number(state.dice_pair[0]), Number(state.dice_pair[1])];
    }
    if (typeof state.dice === "number" && state.dice > 0) {
        const d1 = Math.min(6, Math.max(1, Math.ceil(state.dice / 2)));
        const d2 = Math.min(6, Math.max(1, state.dice - d1 || 1));
        return [d1, d2];
    }
    return [null, null];
}

const PIP_POSITIONS: Record<number, number[]> = {
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
};

function PipDieBox({
    num,
    rolling,
}: {
    num: number | null;
    rolling: boolean;
}) {
    const pips = num && PIP_POSITIONS[num] ? PIP_POSITIONS[num] : [];
    return (
        <div
            className={`w-11 h-11 rounded-xl bg-gradient-to-b from-zinc-100 to-zinc-300 border-2 border-zinc-500 p-1.5 grid grid-cols-3 grid-rows-3 place-items-center shadow-md transition-transform duration-150 ${
                rolling ? "rotate-12 scale-105" : "rotate-0 scale-100"
            }`}
        >
            {Array.from({ length: 9 }).map((_, idx) => (
                <span
                    key={idx}
                    className={`w-2 h-2 rounded-full ${
                        pips.includes(idx) ? "bg-zinc-900" : "bg-transparent"
                    }`}
                />
            ))}
        </div>
    );
}

function PlayerDiceBar({
    playerName,
    accentColor,
    d1,
    d2,
    rolling,
    canRoll,
    onRoll,
    alignRight = false,
}: {
    playerName: string;
    accentColor: string;
    d1: number | null;
    d2: number | null;
    rolling: boolean;
    canRoll: boolean;
    onRoll: () => void;
    alignRight?: boolean;
}) {
    const [spinDice, setSpinDice] = useState<[number, number]>([2, 4]);

    useEffect(() => {
        if (!rolling) return;
        const timer = setInterval(() => {
            setSpinDice([
                Math.floor(Math.random() * 6) + 1,
                Math.floor(Math.random() * 6) + 1,
            ]);
        }, 75);
        return () => clearInterval(timer);
    }, [rolling]);

    const show1 = rolling ? spinDice[0] : d1;
    const show2 = rolling ? spinDice[1] : d2;

    return (
        <div
            className={`flex items-center justify-between gap-3 ${
                alignRight ? "flex-row-reverse" : "flex-row"
            }`}
        >
            <div
                className={`flex items-center gap-2 min-w-0 ${
                    alignRight ? "flex-row-reverse text-right" : "text-left"
                }`}
            >
                <span
                    className="w-3.5 h-3.5 rounded-full border border-white/50 shrink-0"
                    style={{ backgroundColor: accentColor }}
                />
                <span className="text-xs sm:text-sm font-black text-white truncate">
                    {playerName}
                </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
                <div className="bg-zinc-900/90 border border-zinc-700 rounded-2xl p-1.5 flex items-center gap-1.5">
                    <PipDieBox num={show1} rolling={rolling} />
                    <PipDieBox num={show2} rolling={rolling} />
                </div>

                {canRoll && (
                    <button
                        type="button"
                        disabled={rolling}
                        onClick={onRoll}
                        className="px-3.5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-black text-[11px] uppercase rounded-xl active:scale-95 transition-all"
                    >
                        {rolling ? "..." : "Lanzar"}
                    </button>
                )}
            </div>
        </div>
    );
}

export default function ParchisGamePage() {
    const [userId, setUserId] = useState<string | null>(null);
    const [accessToken, setAccessToken] = useState("");
    const [isAuthLoading, setIsAuthLoading] = useState(true);

    const [playerName, setPlayerName] = useState("");
    const [docNumber, setDocNumber] = useState("");
    const [searchId, setSearchId] = useState("");

    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

    const [selectedBet, setSelectedBet] = useState<ParchisBet>("0.25");
    const selectedBetRef = useRef<number>(0.25);

    const [maxPlayers, setMaxPlayers] = useState<MaxPlayers>(2);
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
        "Preparando arena..."
    );
    const [gameState, setGameState] = useState<ParchisState | null>(null);
    const [busyAction, setBusyAction] = useState(false);
    const [rollingDice, setRollingDice] = useState(false);
    const [rulesOpen, setRulesOpen] = useState(false);

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
                setPlayerName("");
                setDocNumber("");
                return;
            }

            const token = session.access_token || "";

            setUserId(currentUserId);
            userIdRef.current = currentUserId;
            setAccessToken(token);
            accessTokenRef.current = token;

            const emailFallback =
                session.user?.email?.split("@")[0] || "Jugador";

            const { data: profile, error } = await supabase
                .from("profiles")
                .select("first_name, doc_number, balance, bonus_balance")
                .eq("id", currentUserId)
                .maybeSingle();

            if (error) {
                console.error("Error cargando perfil:", error);
                setPlayerName((prev) => prev || emailFallback);
                return;
            }

            if (profile) {
                setPlayerName(getMainName(profile, emailFallback));
                setDocNumber(
                    profile.doc_number ? String(profile.doc_number) : ""
                );
                setPlayBalance(Number(profile.balance ?? 0));
                setBonusBalance(Number(profile.bonus_balance ?? 0));
            } else {
                setPlayerName((prev) => prev || emailFallback);
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
                setPlayerName("");
                setDocNumber("");
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
            const idParam = searchId.trim()
                ? `&doc_number=${encodeURIComponent(searchId.trim())}&cedula=${encodeURIComponent(searchId.trim())}`
                : "";
            const res = await fetch(
                `${API_BASE}/parchis/rooms?bet=${encodeURIComponent(
                    String(amount)
                )}${idParam}`
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
    }, [selectedBet, searchId]);

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
        setRollingDice(false);

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
            setConnectionMessage("Conectando con el servidor...");

            const cleanName = (playerName.trim() || "Jugador").split(/\s+/)[0];
            const cleanId = docNumber.trim();

            const wsUrl = getWebSocketUrl(
                `/ws/parchis/${encodeURIComponent(targetRoomId)}` +
                    `?user_id=${encodeURIComponent(userIdRef.current)}` +
                    `&access_token=${encodeURIComponent(accessTokenRef.current)}` +
                    `&player_name=${encodeURIComponent(cleanName)}` +
                    `&doc_number=${encodeURIComponent(cleanId)}` +
                    `&cedula=${encodeURIComponent(cleanId)}` +
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
                    setConnectionMessage("Esperando estado de la partida...");
                };

                ws.onmessage = (event) => {
                    if (socketRef.current !== ws) return;

                    try {
                        const data = JSON.parse(event.data);

                        if (
                            data.type === "HOST_LEFT" ||
                            data.type === "ROOM_CLOSED" ||
                            data.status === "closed_by_host"
                        ) {
                            exitParchisGame();
                            showAlert(
                                "Sala cerrada",
                                data.message ||
                                    "El anfitrión salió de la sala y esta se cerró."
                            );
                            return;
                        }

                        if (data.type === "PARCHIS_STATE") {
                            setRollingDice(false);
                            gameStateRef.current = data;
                            setGameState(data);
                            if (data.room_id) {
                                setRoomId(String(data.room_id));
                            }
                            if (!connectedRef.current) {
                                connectedRef.current = true;
                                setIsConnected(true);
                                setConnectionMessage("Partida conectada");
                            }
                            if (data.status === "finished") {
                                void loadUserBalances();
                            }
                            return;
                        }

                        if (data.type === "ERROR") {
                            setRollingDice(false);
                            startingRef.current = false;
                            showAlert(
                                "Error del servidor",
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
                        setRollingDice(false);
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
                    setRollingDice(false);
                    setIsConnected(false);

                    if (!closingByUserRef.current) {
                        setIsInGame(false);
                        if (event.code !== 1000) {
                            showAlert(
                                "Partida interrumpida",
                                event.reason ||
                                    `Se cerró la sesión de juego (${event.code}).`
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
            docNumber,
            exitParchisGame,
            getWebSocketUrl,
            loadUserBalances,
            maxPlayers,
            playBalance,
            playerName,
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
        if (!docNumber.trim()) {
            showAlert(
                "ID requerido",
                "Tu perfil no tiene ID registrado o está vacío."
            );
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
            const cleanName = (playerName.trim() || "Jugador").split(/\s+/)[0];
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
                    host_name: cleanName,
                    host_doc_number: docNumber.trim(),
                    host_cedula: docNumber.trim(),
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
        setRollingDice(true);
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
            260,
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

        ctx.fillStyle = "#5c3b28";
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, 16);
        ctx.fill();

        const pad = size * 0.032;
        const inner = size - pad * 2;
        const cell = inner / 15;

        ctx.fillStyle = "#f7f3e8";
        ctx.fillRect(pad, pad, inner, inner);

        for (let y = 1; y <= 6; y++) {
            ctx.fillStyle = SEAT_PALETTE[0].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        for (let x = 8; x <= 13; x++) {
            ctx.fillStyle = SEAT_PALETTE[1].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }
        for (let y = 8; y <= 13; y++) {
            ctx.fillStyle = SEAT_PALETTE[2].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        for (let x = 1; x <= 6; x++) {
            ctx.fillStyle = SEAT_PALETTE[3].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }

        ctx.strokeStyle = "rgba(39, 39, 42, 0.35)";
        ctx.lineWidth = 1;
        for (let r = 0; r < 15; r++) {
            for (let c = 0; c < 15; c++) {
                const inHome =
                    (r < 6 && c < 6) ||
                    (r < 6 && c > 8) ||
                    (r > 8 && c > 8) ||
                    (r > 8 && c < 6);
                const inCenter = r >= 6 && r <= 8 && c >= 6 && c <= 8;
                if (inHome || inCenter) continue;
                ctx.strokeRect(pad + c * cell, pad + r * cell, cell, cell);
            }
        }

        for (let i = 0; i < TRACK_LEN; i++) {
            const g = TRACK_GRID[i];
            const px = pad + (g.gx + 0.5) * cell;
            const py = pad + (g.gy + 0.5) * cell;

            const startEntry = Object.entries(START_SPOTS).find(
                ([, spot]) => spot === i
            );
            if (startEntry) {
                const sIdx = Number(startEntry[0]);
                ctx.fillStyle = SEAT_PALETTE[sIdx % 4].main;
                ctx.fillRect(
                    pad + g.gx * cell + 1,
                    pad + g.gy * cell + 1,
                    cell - 2,
                    cell - 2
                );
            }
            if (SAFE_SPOTS.has(i)) {
                ctx.fillStyle = startEntry ? "#ffffff" : "#9ca3af";
                ctx.fillRect(
                    pad + g.gx * cell + 1.5,
                    pad + g.gy * cell + 1.5,
                    cell - 3,
                    cell - 3
                );
                ctx.beginPath();
                ctx.arc(px, py, Math.max(3.5, cell * 0.17), 0, Math.PI * 2);
                ctx.fillStyle = "#27272a";
                ctx.fill();
            }

            ctx.fillStyle = "rgba(24, 24, 27, 0.55)";
            ctx.font = `600 ${Math.max(7, Math.floor(cell * 0.28))}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(i + 1), px, py);
        }

        const state = gameStateRef.current;
        const players: ParchisPlayerState[] =
            state && Array.isArray(state.players) ? state.players : [];

        const activeCorners = new Set(
            players.map((pl: ParchisPlayerState) =>
                getVisualCorner(pl.seat_index, players.length)
            )
        );

        const homes = [
            { corner: 0, gx: 0, gy: 0 },
            { corner: 1, gx: 9, gy: 0 },
            { corner: 2, gx: 9, gy: 9 },
            { corner: 3, gx: 0, gy: 9 },
        ];

        for (const h of homes) {
            const isActive = activeCorners.has(h.corner);
            const pal = SEAT_PALETTE[h.corner];
            const hx0 = pad + h.gx * cell;
            const hy0 = pad + h.gy * cell;
            const hSize = cell * 6;

            ctx.fillStyle = isActive ? pal.main : "#3f3f46";
            ctx.fillRect(hx0, hy0, hSize, hSize);
            ctx.strokeStyle = "#18181b";
            ctx.lineWidth = 2;
            ctx.strokeRect(hx0, hy0, hSize, hSize);

            const center = getHomeCenter(h.corner);
            for (let pid = 0; pid < 4; pid++) {
                const slot = getHomeSlotOffset(pid, cell);
                ctx.beginPath();
                ctx.arc(
                    center.x * size + slot.dx,
                    center.y * size + slot.dy,
                    cell * 0.42,
                    0,
                    Math.PI * 2
                );
                ctx.fillStyle = isActive ? pal.dark : "#27272a";
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = isActive ? "#ffffff" : "#52525b";
                ctx.stroke();
            }
        }

        const cLeft = pad + 6 * cell;
        const cTop = pad + 6 * cell;
        const cSize = cell * 3;
        const midX = cLeft + cSize / 2;
        const midY = cTop + cSize / 2;

        const triangles = [
            {
                pts: [
                    [cLeft, cTop],
                    [cLeft + cSize, cTop],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[0].main,
            },
            {
                pts: [
                    [cLeft + cSize, cTop],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[1].main,
            },
            {
                pts: [
                    [cLeft, cTop + cSize],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: SEAT_PALETTE[2].main,
            },
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

        if (!state || players.length === 0) return;

        const currentUid = userIdRef.current;
        const me = players.find(
            (pl: ParchisPlayerState) => pl.user_id === currentUid
        );
        const isMyTurn =
            state.status === "playing" &&
            me &&
            state.turn_seat === me.seat_index &&
            state.must_move &&
            state.dice !== null;

        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);

        for (const p of players) {
            const corner = getVisualCorner(p.seat_index, players.length);
            const pal = SEAT_PALETTE[corner];

            for (const piece of p.pieces || []) {
                const pt = getPieceBoardPoint(piece, corner, size);
                const canMoveThis = Boolean(
                    isMyTurn &&
                        p.user_id === currentUid &&
                        ((piece.stage === -1 && state.dice === 5) ||
                            piece.stage === 0 ||
                            piece.stage === 100)
                );

                const radius = Math.max(8, cell * 0.36);

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

                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x + 1.2, pt.y + 1.8, radius, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(0,0,0,0.45)";
                ctx.fill();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = pal.main;
                ctx.fill();
                ctx.lineWidth = canMoveThis ? 2.5 : 1.8;
                ctx.strokeStyle = canMoveThis ? "#ffffff" : "#111827";
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius * 0.56, 0, Math.PI * 2);
                ctx.fillStyle = "#ffffff";
                ctx.fill();
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

        const players: ParchisPlayerState[] = Array.isArray(state.players)
            ? state.players
            : [];
        const me = players.find(
            (pl: ParchisPlayerState) => pl.user_id === currentUid
        );
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
            260,
            Math.floor(Math.min(rect.width, rect.height || rect.width))
        );
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const corner = getVisualCorner(me.seat_index, players.length);

        let closestId = -1;
        let minDist = 26;

        for (const piece of me.pieces || []) {
            const pt = getPieceBoardPoint(piece, corner, size);
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
                        Cargando AXIOM Arena
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
                            Inicia sesión para entrar a las arenas.
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

    const activePlayers: ParchisPlayerState[] = gameState?.players || [];
    const myPlayer: ParchisPlayerState | null =
        activePlayers.find((pl: ParchisPlayerState) => pl.user_id === userId) ||
        null;
    const isMyTurn = Boolean(
        gameState &&
            gameState.status === "playing" &&
            myPlayer &&
            gameState.turn_seat === myPlayer.seat_index
    );
    const isHost = Boolean(
        gameState &&
            (gameState.host_user_id === userId || myPlayer?.seat_index === 0)
    );
    const mainName = (playerName.trim() || "Jugador").split(/\s+/)[0];
    const visibleUserId = docNumber.trim() || "-";
    const [d1, d2] = resolveTwoDice(gameState);

    const topPlayer =
        activePlayers.find(
            (p) => getVisualCorner(p.seat_index, activePlayers.length) === 0
        ) ||
        activePlayers[1] ||
        null;
    const bottomPlayer =
        activePlayers.find(
            (p) => getVisualCorner(p.seat_index, activePlayers.length) === 2
        ) ||
        activePlayers[0] ||
        null;

    const topCorner = topPlayer
        ? getVisualCorner(topPlayer.seat_index, activePlayers.length)
        : 0;
    const bottomCorner = bottomPlayer
        ? getVisualCorner(bottomPlayer.seat_index, activePlayers.length)
        : 2;

    const topIsTurn = Boolean(
        gameState &&
            gameState.status === "playing" &&
            topPlayer &&
            gameState.turn_seat === topPlayer.seat_index
    );
    const bottomIsTurn = Boolean(
        gameState &&
            gameState.status === "playing" &&
            bottomPlayer &&
            gameState.turn_seat === bottomPlayer.seat_index
    );

    const topName = (topPlayer?.player_name || "Jugador").split(/\s+/)[0];
    const bottomName = (bottomPlayer?.player_name || mainName).split(
        /\s+/
    )[0];

    return (
        <div className="min-h-screen bg-black text-white flex flex-col select-none font-sans overflow-x-hidden">
            {rulesOpen && (
                <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
                    <div className="bg-zinc-950 border border-zinc-800 max-w-lg w-full rounded-3xl p-6 space-y-4 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-zinc-900 pb-3.5">
                            <h3 className="text-sm sm:text-base font-black uppercase tracking-wider text-emerald-400">
                                Reglas del Parchís
                            </h3>
                            <button
                                type="button"
                                onClick={() => setRulesOpen(false)}
                                className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-black text-zinc-300 hover:text-white transition-colors"
                            >
                                Listo
                            </button>
                        </div>

                        <ul className="space-y-2.5 text-xs text-zinc-300 leading-relaxed list-disc pl-4">
                            <li>
                                <strong className="text-white">
                                    Objetivo:
                                </strong>{" "}
                                Llevar tus 4 fichas desde casa hasta la meta
                                central por tu pasillo de color.
                            </li>
                            <li>
                                <strong className="text-white">
                                    Salida con 5:
                                </strong>{" "}
                                Sacar{" "}
                                <strong className="text-emerald-400">
                                    5
                                </strong>{" "}
                                en el dado saca una ficha a tu salida.
                            </li>
                            <li>
                                <strong className="text-white">
                                    Casillas seguras:
                                </strong>{" "}
                                Protegen las fichas de ser capturadas.
                            </li>
                            <li>
                                <strong className="text-white">
                                    Capturas:
                                </strong>{" "}
                                Caer en una casilla no segura ocupada por un
                                rival envía su ficha a casa.
                            </li>
                            <li>
                                <strong className="text-white">
                                    Anfitrión:
                                </strong>{" "}
                                Si el anfitrión sale, la sala se cierra para
                                todos.
                            </li>
                        </ul>

                        <button
                            type="button"
                            onClick={() => setRulesOpen(false)}
                            className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                        >
                            Entendido
                        </button>
                    </div>
                </div>
            )}

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

            <main
                className={`flex-1 w-full mx-auto flex flex-col ${
                    isInGame
                        ? "max-w-3xl px-3 sm:px-6 py-3 sm:py-5 items-center justify-center"
                        : "max-w-4xl px-3 sm:px-6 py-4 sm:py-8 items-center justify-center"
                }`}
            >
                {!isInGame ? (
                    <div className="w-full max-w-xl bg-zinc-950 border border-zinc-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-2xl">
                        <div className="flex items-center justify-between gap-2 border-b border-zinc-900 pb-3.5">
                            <Link
                                href="/"
                                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-emerald-400 font-bold uppercase transition-colors"
                            >
                                <span>&lsaquo;</span>
                                <span>Volver</span>
                            </Link>

                            <button
                                type="button"
                                onClick={() => setRulesOpen(true)}
                                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-xs font-black uppercase transition-all"
                            >
                                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                                <span>Reglas</span>
                            </button>
                        </div>

                        <div className="text-center space-y-1">
                            <h2 className="text-xl sm:text-2xl font-black text-emerald-400 uppercase tracking-wider">
                                Parchís Arena P2P
                            </h2>
                            <p className="text-xs text-zinc-400">
                                <span className="text-white font-black">
                                    {mainName}
                                </span>{" "}
                                · ID:{" "}
                                <span className="text-emerald-400 font-bold">
                                    {visibleUserId}
                                </span>
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
                                        onClick={() =>
                                            setSelectedWallet("bonus")
                                        }
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
                                        Sala
                                    </label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(["0.25", "1.00", "10.00"] as ParchisBet[]).map(
                                            (amt) => (
                                                <button
                                                    key={amt}
                                                    type="button"
                                                    onClick={() =>
                                                        setSelectedBet(amt)
                                                    }
                                                    className={`py-3 rounded-xl text-sm font-black border transition-all ${
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
                                        {([2, 3, 4] as MaxPlayers[]).map(
                                            (cnt) => (
                                                <button
                                                    key={cnt}
                                                    type="button"
                                                    onClick={() =>
                                                        setMaxPlayers(cnt)
                                                    }
                                                    className={`py-3 rounded-xl text-sm font-black border transition-all ${
                                                        maxPlayers === cnt
                                                            ? "bg-emerald-500 text-black border-emerald-400"
                                                            : "bg-black text-zinc-400 border-zinc-800 hover:border-emerald-500"
                                                    }`}
                                                >
                                                    {cnt}P
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="bg-black/70 border border-zinc-800 rounded-2xl p-3.5 space-y-3">
                                <label className="flex items-center gap-2.5 text-xs font-bold text-zinc-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={isPrivate}
                                        onChange={(e) =>
                                            setIsPrivate(e.target.checked)
                                        }
                                        className="rounded accent-emerald-500"
                                    />
                                    <span>Sala privada con contraseña</span>
                                </label>

                                {isPrivate && (
                                    <input
                                        type="text"
                                        value={roomPassword}
                                        onChange={(e) =>
                                            setRoomPassword(e.target.value)
                                        }
                                        placeholder="Contraseña de sala"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                )}

                                <button
                                    type="button"
                                    disabled={startingRef.current || busyAction}
                                    onClick={handleCreatePrivateOrCustomRoom}
                                    className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs uppercase tracking-wider rounded-2xl shadow-lg active:scale-95 transition-all"
                                >
                                    {isPrivate
                                        ? "Crear Sala Privada"
                                        : "Crear Sala"}
                                </button>
                            </div>

                            <div className="border-t border-zinc-800 pt-4 space-y-2.5">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-zinc-400 uppercase font-bold">
                                        Buscar sala por ID
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => void fetchPublicRooms()}
                                        className="text-[10px] text-emerald-400 font-bold uppercase hover:underline"
                                    >
                                        Actualizar
                                    </button>
                                </div>

                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={searchId}
                                        onChange={(e) =>
                                            setSearchId(e.target.value)
                                        }
                                        placeholder="ID del anfitrión..."
                                        className="flex-1 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                    {searchId && (
                                        <button
                                            type="button"
                                            onClick={() => setSearchId("")}
                                            className="px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-bold rounded-xl border border-zinc-800"
                                        >
                                            Limpiar
                                        </button>
                                    )}
                                </div>

                                {publicRooms.length === 0 ? (
                                    <p className="text-xs text-zinc-500">
                                        {roomsUnavailable
                                            ? "Lista de salas en mantenimiento; crea una sala o entra por ID de sala."
                                            : "No hay salas disponibles con ese filtro."}
                                    </p>
                                ) : (
                                    <div className="space-y-2 max-h-44 overflow-y-auto">
                                        {publicRooms.map((item) => {
                                            const itemId =
                                                item.host_doc_number ||
                                                item.host_cedula;
                                            const itemName = (
                                                item.host_name || "Jugador"
                                            ).split(/\s+/)[0];
                                            return (
                                                <div
                                                    key={item.room_id}
                                                    className="flex items-center justify-between gap-3 bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs"
                                                >
                                                    <div className="min-w-0">
                                                        <span className="font-black text-white block truncate">
                                                            {itemName}
                                                        </span>
                                                        <span className="text-[10px] text-zinc-400 block truncate">
                                                            {itemId
                                                                ? `ID: ${itemId} · `
                                                                : ""}
                                                            {item.players_count}/
                                                            {item.max_players}P · $
                                                            {item.bet.toFixed(2)}
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
                                                        className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-[10px] uppercase rounded-xl shrink-0"
                                                    >
                                                        Entrar
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div className="border-t border-zinc-800 pt-4 space-y-2">
                                <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                    Entrar por ID de sala
                                </span>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <input
                                        type="text"
                                        value={joinRoomId}
                                        onChange={(e) =>
                                            setJoinRoomId(e.target.value)
                                        }
                                        placeholder="ID de sala"
                                        className="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                    <input
                                        type="text"
                                        value={joinPassword}
                                        onChange={(e) =>
                                            setJoinPassword(e.target.value)
                                        }
                                        placeholder="Contraseña"
                                        className="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                    <button
                                        type="button"
                                        disabled={
                                            !joinRoomId.trim() ||
                                            startingRef.current
                                        }
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
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-xl bg-zinc-950 border border-zinc-800 rounded-3xl p-3 sm:p-4 flex flex-col gap-3 shadow-2xl">
                        <div className="flex items-center justify-between gap-2 border-b border-zinc-900 pb-2.5">
                            <button
                                type="button"
                                onClick={exitParchisGame}
                                className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-red-400 text-[11px] font-bold uppercase rounded-xl border border-zinc-800"
                            >
                                &lsaquo; {isHost ? "Cerrar Sala" : "Salir"}
                            </button>

                            <span className="text-xs font-black text-emerald-400">
                                {money(gameState?.pot_total ?? 0)}
                            </span>

                            <button
                                type="button"
                                onClick={() => setRulesOpen(true)}
                                className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-200 font-black uppercase"
                            >
                                Reglas
                            </button>
                        </div>

                        {!isConnected || !gameState ? (
                            <div className="py-20 text-center text-xs text-yellow-400 uppercase font-bold tracking-wider">
                                {connectionMessage}
                            </div>
                        ) : (
                            <>
                                <PlayerDiceBar
                                    playerName={topName}
                                    accentColor={SEAT_PALETTE[topCorner].main}
                                    d1={topIsTurn ? d1 : null}
                                    d2={topIsTurn ? d2 : null}
                                    rolling={rollingDice && topIsTurn}
                                    canRoll={
                                        Boolean(
                                            topPlayer &&
                                                topPlayer.user_id === userId &&
                                                isMyTurn &&
                                                !gameState.must_move
                                        )
                                    }
                                    onRoll={sendRollDice}
                                    alignRight={true}
                                />

                                <div className="w-full flex items-center justify-center">
                                    <canvas
                                        ref={boardCanvasRef}
                                        onPointerDown={handleBoardPointerDown}
                                        className="w-full max-w-[540px] aspect-square rounded-2xl border-2 border-zinc-800 shadow-2xl cursor-pointer touch-none"
                                        style={{ touchAction: "none" }}
                                    />
                                </div>

                                <PlayerDiceBar
                                    playerName={bottomName}
                                    accentColor={SEAT_PALETTE[bottomCorner].main}
                                    d1={bottomIsTurn ? d1 : null}
                                    d2={bottomIsTurn ? d2 : null}
                                    rolling={rollingDice && bottomIsTurn}
                                    canRoll={
                                        Boolean(
                                            bottomPlayer &&
                                                bottomPlayer.user_id ===
                                                    userId &&
                                                isMyTurn &&
                                                !gameState.must_move
                                        )
                                    }
                                    onRoll={sendRollDice}
                                    alignRight={false}
                                />

                                {gameState.status === "finished" && (
                                    <div className="bg-zinc-900/70 border border-emerald-400 rounded-2xl p-3.5 text-center space-y-2">
                                        <h3 className="text-sm font-black uppercase text-emerald-400">
                                            Partida Finalizada
                                        </h3>
                                        <button
                                            type="button"
                                            onClick={exitParchisGame}
                                            className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-xl"
                                        >
                                            Volver
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </main>

            <footer className="py-5 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
                AXIOM PARCHIS ARENA
            </footer>
        </div>
    );
}