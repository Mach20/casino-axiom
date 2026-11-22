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
    dice_remaining?: number[];
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

const CORNER_PALETTE = [
    {
        name: "Verde",
        main: "#289c3e",
        light: "#4ade80",
        dark: "#14532d",
        ring: "#bbf7d0",
    },
    {
        name: "Rojo",
        main: "#e03131",
        light: "#ff6b6b",
        dark: "#7f1d1d",
        ring: "#fecaca",
    },
    {
        name: "Azul",
        main: "#1971c2",
        light: "#4dabf7",
        dark: "#1e3a8a",
        ring: "#bfdbfe",
    },
    {
        name: "Amarillo",
        main: "#f59f00",
        light: "#ffd43b",
        dark: "#78350f",
        ring: "#fef08a",
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

function getCleanPlayerLabel(
    player: ParchisPlayerState | null | undefined,
    fallback: string
): string {
    const raw = (player?.player_name || "").trim();
    if (!raw) return fallback;
    return raw.split(/\s+/)[0] || fallback;
}

function getPlayerVisualCorner(
    playerSeat: number,
    mySeat: number | null,
    totalPlayers: number
): number {
    if (totalPlayers <= 2) {
        if (mySeat !== null) {
            return playerSeat === mySeat ? 3 : 1;
        }
        return playerSeat === 0 ? 3 : 1;
    }
    if (mySeat !== null) {
        const rel = (((playerSeat - mySeat) % 4) + 4) % 4;
        const order = [3, 2, 1, 0];
        return order[rel];
    }
    return playerSeat % 4;
}

function getHomeCenter(corner: number): { x: number; y: number } {
    switch (corner) {
        case 0:
            return { x: 0.21, y: 0.21 };
        case 1:
            return { x: 0.79, y: 0.21 };
        case 2:
            return { x: 0.79, y: 0.79 };
        default:
            return { x: 0.21, y: 0.79 };
    }
}

function getHomeSlotOffset(
    pieceId: number,
    cellSize: number
): { dx: number; dy: number } {
    const d = cellSize * 0.72;
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
    const pad = boardSize * 0.036;
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
    const pad = boardSize * 0.036;
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
    const angle = (piece.id % 4) * (Math.PI / 2);
    const offset = cell * 0.12;

    return {
        x: baseX + Math.cos(angle) * offset,
        y: baseY + Math.sin(angle) * offset,
    };
}

function canPieceMove(piece: ParchisPiece, diceValue: number | null): boolean {
    if (diceValue === null || diceValue < 1 || diceValue > 6) return false;
    if (piece.stage === -1) return diceValue === 5;
    if (piece.stage === 0) return piece.steps_walked + diceValue <= 70;
    if (piece.stage === 100) return piece.pos + diceValue <= 7;
    return false;
}

function getMovableDice(
    piece: ParchisPiece,
    diceValues: number[] | null | undefined
): number[] {
    if (!Array.isArray(diceValues)) return [];
    return diceValues.filter((value) => canPieceMove(piece, value));
}

function money(value: number): string {
    return `$${Number(value || 0).toFixed(2)}`;
}

function clampDieFace(val: unknown, fallback = 1): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(6, Math.max(1, Math.round(n)));
}

function randomDieFace(exclude?: number): number {
    const candidates = [1, 2, 3, 4, 5, 6].filter((n) => n !== exclude);
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function randomDiePair(prev?: [number, number]): [number, number] {
    return [randomDieFace(prev?.[0]), randomDieFace(prev?.[1])];
}

function randomPairForSum(
    totalValue: number,
    prev?: [number, number]
): [number, number] {
    const t = Math.round(totalValue);
    const validPairs: Array<[number, number]> = [];
    for (let a = 1; a <= 6; a++) {
        for (let b = 1; b <= 6; b++) {
            if (a + b === t) validPairs.push([a, b]);
        }
    }
    if (validPairs.length > 0) {
        const filtered = prev
            ? validPairs.filter(
                ([a, b]) => !(a === prev[0] && b === prev[1])
            )
            : validPairs;
        const pool = filtered.length > 0 ? filtered : validPairs;
        return pool[Math.floor(Math.random() * pool.length)];
    }
    if (t >= 1 && t <= 6) {
        const other = randomDieFace(prev?.[1]);
        return Math.random() < 0.5 ? [t, other] : [other, t];
    }
    return randomDiePair(prev);
}

const PIP_COORDS: Record<number, Array<[number, number]>> = {
    1: [[50, 50]],
    2: [
        [28, 28],
        [72, 72],
    ],
    3: [
        [28, 28],
        [50, 50],
        [72, 72],
    ],
    4: [
        [28, 28],
        [72, 28],
        [28, 72],
        [72, 72],
    ],
    5: [
        [28, 28],
        [72, 28],
        [50, 50],
        [28, 72],
        [72, 72],
    ],
    6: [
        [28, 26],
        [72, 26],
        [28, 50],
        [72, 50],
        [28, 74],
        [72, 74],
    ],
};

function PipDieBox({
    num,
    rolling,
}: {
    num: number;
    rolling: boolean;
}) {
    const face = clampDieFace(num, 1);
    const dots = PIP_COORDS[face] || PIP_COORDS[1];

    return (
        <div
            className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-zinc-100 border-2 border-zinc-500 p-1 flex items-center justify-center shadow-md transition-transform duration-150 ${rolling ? "rotate-12 scale-105" : "rotate-0 scale-100"
                }`}
        >
            <svg viewBox="0 0 100 100" className="w-full h-full block">
                <rect
                    x="2"
                    y="2"
                    width="96"
                    height="96"
                    rx="18"
                    fill="#f4f4f5"
                />
                {dots.map(([cx, cy], idx) => (
                    <circle key={idx} cx={cx} cy={cy} r="10.5" fill="#18181b" />
                ))}
            </svg>
        </div>
    );
}

function PlayerTurnRow({
    playerName,
    colorName,
    accentColor,
    d1,
    d2,
    rolling,
    isActiveTurn,
    canRoll,
    mustMove,
    onRoll,
    position,
}: {
    playerName: string;
    colorName: string;
    accentColor: string;
    d1: number;
    d2: number;
    rolling: boolean;
    isActiveTurn: boolean;
    canRoll: boolean;
    mustMove: boolean;
    onRoll: () => void;
    position: "top" | "bottom";
}) {
    const [spinDice, setSpinDice] = useState<[number, number]>([3, 5]);

    useEffect(() => {
        if (!rolling) return;
        const timer = setInterval(() => {
            setSpinDice((prev) => randomDiePair(prev));
        }, 75);
        return () => clearInterval(timer);
    }, [rolling]);

    const show1 = rolling ? spinDice[0] : d1;
    const show2 = rolling ? spinDice[1] : d2;

    const badge = (
        <div className="flex items-center gap-1.5">
            <span
                className="w-3 h-3 rounded-full border border-white/40 shadow"
                style={{ backgroundColor: accentColor }}
            />
            <span className="text-xs sm:text-sm font-black text-white">
                {playerName}
            </span>
            <span
                className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full text-black"
                style={{ backgroundColor: accentColor }}
            >
                {colorName}
            </span>
            {isActiveTurn && (
                <span className="text-[10px] font-bold uppercase text-emerald-400">
                    {mustMove ? "· Mueve ficha" : "· Su turno"}
                </span>
            )}
        </div>
    );

    const diceBox = (
        <div className="flex items-center gap-2">
            <button
                type="button"
                disabled={!canRoll || rolling}
                onClick={onRoll}
                aria-label="Lanzar dados"
                style={{
                    borderColor: isActiveTurn ? accentColor : "#3f3f46",
                }}
                className="bg-zinc-900 border-2 rounded-2xl p-1.5 flex items-center gap-1.5 shadow-lg active:scale-95 transition-all disabled:cursor-default disabled:active:scale-100"
            >
                <PipDieBox num={show1} rolling={rolling} />
                <PipDieBox num={show2} rolling={rolling} />
            </button>
            {canRoll && (
                <button
                    type="button"
                    disabled={rolling}
                    onClick={onRoll}
                    className="px-3.5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-black text-[11px] uppercase rounded-xl shadow-md active:scale-95 transition-all"
                >
                    {rolling ? "..." : "Lanzar"}
                </button>
            )}
        </div>
    );

    if (position === "top") {
        return (
            <div className="w-full flex flex-col items-end gap-1">
                {diceBox}
                {badge}
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-start gap-1">
            {badge}
            {diceBox}
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
    const [displayedDice, setDisplayedDice] = useState<[number, number]>([
        3, 5,
    ]);
    const [busyAction, setBusyAction] = useState(false);
    const [rollingDice, setRollingDice] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);

    const [modal, setModal] = useState({
        isOpen: false,
        title: "",
        message: "",
    });

    const boardCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const gameStateRef = useRef<ParchisState | null>(null);
    const userIdRef = useRef<string | null>(null);
    const accessTokenRef = useRef<string>("");
    const roomIdRef = useRef<string>("");
    const animationFrameRef = useRef<number | null>(null);
    const connectedRef = useRef<boolean>(false);
    const closingByUserRef = useRef<boolean>(false);
    const connectingRef = useRef<boolean>(false);
    const rollCounterRef = useRef<number>(0);
    const appliedRollCounterRef = useRef<number>(0);
    const displayedDiceRef = useRef<[number, number]>([3, 5]);
    const pieceCoordsMapRef = useRef<Map<string, { x: number; y: number }>>(
        new Map()
    );

    const setConnectingFlag = useCallback((flag: boolean) => {
        connectingRef.current = flag;
        setIsConnecting(flag);
    }, []);

    const setDicePair = useCallback((pair: [number, number]) => {
        displayedDiceRef.current = pair;
        setDisplayedDice(pair);
    }, []);

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

    const exitParchisGame = useCallback(async () => {
        closingByUserRef.current = true;
        setConnectingFlag(false);
        connectedRef.current = false;
        setRollingDice(false);

        const activeRoomId =
            gameStateRef.current?.room_id || roomIdRef.current || roomId;
        const currentState = gameStateRef.current;
        const currentUid = userIdRef.current;
        const mySeat = currentState?.players?.find(
            (pl) => pl.user_id === currentUid
        );
        const hostClosing = Boolean(
            currentState &&
            currentUid &&
            (currentState.host_user_id === currentUid ||
                mySeat?.seat_index === 0)
        );

        const ws = socketRef.current;
        socketRef.current = null;

        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(
                    JSON.stringify({
                        type: hostClosing ? "CLOSE_ROOM" : "LEAVE_ROOM",
                        room_id: activeRoomId,
                    })
                );
            } catch { }
        }

        if (hostClosing && activeRoomId && accessTokenRef.current) {
            try {
                await fetch(
                    `${API_BASE}/parchis/rooms/${encodeURIComponent(
                        String(activeRoomId)
                    )}/close`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${accessTokenRef.current}`,
                        },
                    }
                );
            } catch { }
        }

        setIsConnected(false);
        setIsInGame(false);
        setGameState(null);
        gameStateRef.current = null;
        pieceCoordsMapRef.current.clear();
        roomIdRef.current = "";
        setRoomId("");
        rollCounterRef.current = 0;
        appliedRollCounterRef.current = 0;

        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }

        if (ws) {
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            if (
                ws.readyState === WebSocket.OPEN ||
                ws.readyState === WebSocket.CONNECTING
            ) {
                ws.close(
                    1000,
                    hostClosing
                        ? "Anfitrión cerró la sala"
                        : "Jugador salió de la partida"
                );
            }
        }

        await loadUserBalances();
        await fetchPublicRooms();
    }, [fetchPublicRooms, loadUserBalances, roomId, setConnectingFlag]);

    const connectToRoom = useCallback(
        (
            targetRoomId: string,
            pwd = "",
            overrideBet?: number,
            overridePlayers?: MaxPlayers
        ) => {
            if (connectingRef.current || socketRef.current) {
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

            setConnectingFlag(true);
            closingByUserRef.current = false;
            connectedRef.current = false;
            rollCounterRef.current = 0;
            appliedRollCounterRef.current = 0;
            pieceCoordsMapRef.current.clear();

            roomIdRef.current = targetRoomId;
            setRoomId(targetRoomId);
            setIsInGame(true);
            setIsConnected(false);
            setGameState(null);
            gameStateRef.current = null;
            setDicePair(randomDiePair());
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
                            } catch { }
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
                            void exitParchisGame();
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

                            if (
                                Array.isArray(data.dice_pair) &&
                                data.dice_pair.length === 2
                            ) {
                                setDicePair([
                                    clampDieFace(data.dice_pair[0], 1),
                                    clampDieFace(data.dice_pair[1], 1),
                                ]);
                            }

                            if (data.room_id) {
                                const nextId = String(data.room_id);
                                roomIdRef.current = nextId;
                                setRoomId(nextId);
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
                            setConnectingFlag(false);
                            showAlert(
                                "Error del servidor",
                                data.message || "No se pudo completar la acción."
                            );
                            if (!connectedRef.current) {
                                void exitParchisGame();
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

                    setConnectingFlag(false);
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
                setConnectingFlag(false);
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
            setConnectingFlag,
            setDicePair,
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
        rollCounterRef.current += 1;
        setRollingDice(true);
        ws.send(JSON.stringify({ type: "ROLL_DICE" }));
    };

    const sendMovePiece = (pieceId: number, diceValue: number) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: "MOVE_PIECE",
            piece_id: pieceId,
            dice_value: diceValue,
        }));
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

        const woodGrad = ctx.createLinearGradient(0, 0, size, size);
        woodGrad.addColorStop(0, "#6f472b");
        woodGrad.addColorStop(0.5, "#53331d");
        woodGrad.addColorStop(1, "#3b2212");
        ctx.fillStyle = woodGrad;
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, 18);
        ctx.fill();

        ctx.strokeStyle = "#8c5b38";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(1.5, 1.5, size - 3, size - 3, 17);
        ctx.stroke();

        const pad = size * 0.036;
        const inner = size - pad * 2;
        const cell = inner / 15;

        ctx.fillStyle = "#f6f0e2";
        ctx.fillRect(pad, pad, inner, inner);

        for (let y = 1; y <= 6; y++) {
            ctx.fillStyle = CORNER_PALETTE[0].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        for (let x = 8; x <= 13; x++) {
            ctx.fillStyle = CORNER_PALETTE[1].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }
        for (let y = 8; y <= 13; y++) {
            ctx.fillStyle = CORNER_PALETTE[2].main;
            ctx.fillRect(pad + 7 * cell, pad + y * cell, cell, cell);
        }
        for (let x = 1; x <= 6; x++) {
            ctx.fillStyle = CORNER_PALETTE[3].main;
            ctx.fillRect(pad + x * cell, pad + 7 * cell, cell, cell);
        }

        ctx.strokeStyle = "rgba(39, 39, 42, 0.38)";
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
                ctx.fillStyle = CORNER_PALETTE[sIdx % 4].main;
                ctx.fillRect(
                    pad + g.gx * cell + 1,
                    pad + g.gy * cell + 1,
                    cell - 2,
                    cell - 2
                );
            }

            if (SAFE_SPOTS.has(i)) {
                if (!startEntry) {
                    ctx.fillStyle = "#b8bec8";
                    ctx.fillRect(
                        pad + g.gx * cell + 1.2,
                        pad + g.gy * cell + 1.2,
                        cell - 2.4,
                        cell - 2.4
                    );
                }
                ctx.save();
                ctx.beginPath();
                const starR = Math.max(4, cell * 0.22);
                for (let s = 0; s < 10; s++) {
                    const r = s % 2 === 0 ? starR : starR * 0.45;
                    const ang = (s * Math.PI) / 5 - Math.PI / 2;
                    const sx = px + Math.cos(ang) * r;
                    const sy = py + Math.sin(ang) * r;
                    if (s === 0) ctx.moveTo(sx, sy);
                    else ctx.lineTo(sx, sy);
                }
                ctx.closePath();
                ctx.fillStyle = startEntry ? "#ffffff" : "#3f3f46";
                ctx.fill();
                ctx.restore();
            } else {
                ctx.fillStyle = "rgba(24, 24, 27, 0.55)";
                ctx.font = `700 ${Math.max(7, Math.floor(cell * 0.27))}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(i + 1), px, py);
            }
        }

        const state = gameStateRef.current;
        const players: ParchisPlayerState[] =
            state && Array.isArray(state.players) ? state.players : [];
        const currentUid = userIdRef.current;
        const me = players.find(
            (pl: ParchisPlayerState) => pl.user_id === currentUid
        );
        const mySeat = me ? me.seat_index : null;

        const activeCorners = new Set(
            players.map((pl: ParchisPlayerState) =>
                getPlayerVisualCorner(pl.seat_index, mySeat, players.length)
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
            const pal = CORNER_PALETTE[h.corner];
            const hx0 = pad + h.gx * cell;
            const hy0 = pad + h.gy * cell;
            const hSize = cell * 6;

            const hGrad = ctx.createLinearGradient(
                hx0,
                hy0,
                hx0 + hSize,
                hy0 + hSize
            );
            if (isActive) {
                hGrad.addColorStop(0, pal.light);
                hGrad.addColorStop(0.35, pal.main);
                hGrad.addColorStop(1, pal.dark);
            } else {
                hGrad.addColorStop(0, "#52525b");
                hGrad.addColorStop(1, "#27272a");
            }

            ctx.fillStyle = hGrad;
            ctx.fillRect(hx0, hy0, hSize, hSize);
            ctx.strokeStyle = "#18181b";
            ctx.lineWidth = 2;
            ctx.strokeRect(hx0, hy0, hSize, hSize);

            const inset = cell * 0.42;
            ctx.strokeStyle = isActive
                ? "rgba(255,255,255,0.45)"
                : "rgba(255,255,255,0.12)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.roundRect(
                hx0 + inset,
                hy0 + inset,
                hSize - inset * 2,
                hSize - inset * 2,
                12
            );
            ctx.stroke();

            const center = getHomeCenter(h.corner);
            for (let pid = 0; pid < 4; pid++) {
                const slot = getHomeSlotOffset(pid, cell);
                const sx = center.x * size + slot.dx;
                const sy = center.y * size + slot.dy;

                ctx.beginPath();
                ctx.arc(sx, sy, cell * 0.44, 0, Math.PI * 2);
                ctx.fillStyle = isActive ? pal.dark : "#18181b";
                ctx.fill();
                ctx.lineWidth = 1.8;
                ctx.strokeStyle = isActive ? pal.ring : "#52525b";
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
                color: CORNER_PALETTE[0].main,
            },
            {
                pts: [
                    [cLeft + cSize, cTop],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: CORNER_PALETTE[1].main,
            },
            {
                pts: [
                    [cLeft, cTop + cSize],
                    [cLeft + cSize, cTop + cSize],
                    [midX, midY],
                ],
                color: CORNER_PALETTE[2].main,
            },
            {
                pts: [
                    [cLeft, cTop],
                    [cLeft, cTop + cSize],
                    [midX, midY],
                ],
                color: CORNER_PALETTE[3].main,
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

        const isMyTurn =
            state.status === "playing" &&
            me &&
            state.turn_seat === me.seat_index &&
            state.must_move &&
            (state.dice_remaining?.length || 0) > 0;

        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.009);

        for (const p of players) {
            const corner = getPlayerVisualCorner(
                p.seat_index,
                mySeat,
                players.length
            );
            const pal = CORNER_PALETTE[corner];

            for (const piece of p.pieces || []) {
                const target = getPieceBoardPoint(piece, corner, size);
                const key = `${p.user_id}-${piece.id}`;
                const prev = pieceCoordsMapRef.current.get(key);
                const cur = prev
                    ? {
                        x: prev.x + (target.x - prev.x) * 0.28,
                        y: prev.y + (target.y - prev.y) * 0.28,
                    }
                    : target;
                pieceCoordsMapRef.current.set(key, cur);

                const movable = Boolean(
                    isMyTurn &&
                    p.user_id === currentUid &&
                    getMovableDice(piece, state.dice_remaining).length > 0
                );

                const radius = Math.max(8.5, cell * 0.37);

                if (movable) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(
                        cur.x,
                        cur.y,
                        radius + 3.5 + pulse * 3,
                        0,
                        Math.PI * 2
                    );
                    ctx.strokeStyle = "#10b981";
                    ctx.lineWidth = 2.8;
                    ctx.stroke();
                    ctx.restore();
                }

                ctx.save();
                ctx.beginPath();
                ctx.arc(cur.x + 1.4, cur.y + 2.2, radius, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(0,0,0,0.48)";
                ctx.fill();

                const pieceGrad = ctx.createRadialGradient(
                    cur.x - radius * 0.3,
                    cur.y - radius * 0.3,
                    radius * 0.15,
                    cur.x,
                    cur.y,
                    radius
                );
                pieceGrad.addColorStop(0, pal.light);
                pieceGrad.addColorStop(0.65, pal.main);
                pieceGrad.addColorStop(1, pal.dark);

                ctx.beginPath();
                ctx.arc(cur.x, cur.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = pieceGrad;
                ctx.fill();
                ctx.lineWidth = movable ? 2.4 : 1.6;
                ctx.strokeStyle = movable ? "#ffffff" : "#111827";
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(cur.x, cur.y, radius * 0.52, 0, Math.PI * 2);
                ctx.fillStyle = "#ffffff";
                ctx.fill();

                ctx.beginPath();
                ctx.arc(cur.x, cur.y, radius * 0.24, 0, Math.PI * 2);
                ctx.fillStyle = pal.main;
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
            !(state.dice_remaining?.length)
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
        const corner = getPlayerVisualCorner(
            me.seat_index,
            me.seat_index,
            players.length
        );

        let closestId = -1;
        let minDist = 30;

        for (const piece of me.pieces || []) {
            const availableDice = getMovableDice(piece, state.dice_remaining);
            if (availableDice.length === 0) continue;
            const pt = getPieceBoardPoint(piece, corner, size);
            const dist = Math.hypot(clickX - pt.x, clickY - pt.y);
            if (dist < minDist) {
                minDist = dist;
                closestId = piece.id;
            }
        }

        if (closestId >= 0) {
            const selectedPiece = me.pieces.find((piece) => piece.id === closestId);
            const die = selectedPiece
                ? getMovableDice(selectedPiece, state.dice_remaining)[0]
                : undefined;
            if (die !== undefined) sendMovePiece(closestId, die);
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
    const mySeatIndex = myPlayer ? myPlayer.seat_index : null;

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
    const [d1, d2] = displayedDice;

    const bottomPlayer =
        myPlayer ||
        activePlayers.find(
            (p) =>
                getPlayerVisualCorner(
                    p.seat_index,
                    mySeatIndex,
                    activePlayers.length
                ) === 3
        ) ||
        activePlayers[0] ||
        null;

    const topPlayer =
        activePlayers.find((p) => p.user_id !== bottomPlayer?.user_id) ||
        null;

    const extraPlayers = activePlayers.filter(
        (p) =>
            p.user_id !== bottomPlayer?.user_id &&
            p.user_id !== topPlayer?.user_id
    );

    const bottomCorner = bottomPlayer
        ? getPlayerVisualCorner(
            bottomPlayer.seat_index,
            mySeatIndex,
            activePlayers.length
        )
        : 3;
    const topCorner = topPlayer
        ? getPlayerVisualCorner(
            topPlayer.seat_index,
            mySeatIndex,
            activePlayers.length
        )
        : 1;

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

    const bottomName =
        bottomPlayer?.user_id === userId
            ? getCleanPlayerLabel(bottomPlayer, mainName)
            : getCleanPlayerLabel(bottomPlayer, "Jugador");
    const topName = topPlayer
        ? getCleanPlayerLabel(topPlayer, "Rival")
        : "Esperando rival...";

    const movablePieces =
        isMyTurn && gameState?.must_move && myPlayer
            ? (myPlayer.pieces || []).filter((pc) =>
                getMovableDice(pc, gameState.dice_remaining).length > 0
            )
            : [];

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

            <main
                className={`flex-1 w-full mx-auto flex flex-col ${isInGame
                        ? "max-w-xl px-2.5 sm:px-6 py-2 sm:py-4 items-center justify-center"
                        : "max-w-6xl px-3 sm:px-6 py-4 sm:py-8 items-center justify-center"
                    }`}
            >
                {!isInGame ? (
                    <div className="w-full max-w-3xl mx-auto bg-zinc-950 border border-zinc-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-2xl">
                        <div className="border-b border-zinc-900 pb-4">
                            <Link
                                href="/"
                                className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-emerald-400 font-bold uppercase transition"
                            >
                                <span>←</span> Volver al menú principal
                            </Link>
                            <div className="mt-5 text-center">
                                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
                                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399]" />
                                    <span className="text-[9px] font-black uppercase tracking-[0.22em] text-emerald-400">AXIOM · Arena P2P</span>
                                </div>
                                <h2 className="mt-3 text-2xl sm:text-3xl font-black text-white uppercase tracking-wider">
                                    Parchís <span className="text-emerald-400">Arena</span>
                                </h2>
                                <p className="mt-1 text-xs text-zinc-500">Crea una partida o entra a una sala disponible.</p>
                            </div>
                            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px]">
                                <span className="text-zinc-500">Jugador: <strong className="text-zinc-200">{mainName}</strong></span>
                                <span className="text-zinc-700">·</span>
                                <span className="text-zinc-500">ID: <strong className="text-emerald-400">{visibleUserId}</strong></span>
                            </div>
                        </div>

                        <section className="space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-[9px] text-emerald-400 uppercase font-black tracking-[0.2em]">Nueva partida</p>
                                    <h3 className="mt-1 text-sm font-black text-white uppercase">Crear sala</h3>
                                </div>
                                <span className="rounded-lg border border-zinc-800 bg-black px-2.5 py-1.5 text-[9px] font-black text-zinc-400 uppercase">P2P</span>
                            </div>

                            <div>
                                <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">Selecciona tu billetera</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedWallet("play")}
                                        className={`rounded-xl border p-3 text-left transition ${selectedWallet === "play" ? "border-emerald-500 bg-emerald-500/10" : "border-zinc-800 bg-black hover:border-zinc-700"}`}
                                    >
                                        <span className="block text-[9px] text-zinc-500 uppercase font-bold">Saldo para jugar</span>
                                        <span className={`mt-1 block text-lg font-black tabular-nums ${selectedWallet === "play" ? "text-emerald-400" : "text-white"}`}>{money(playBalance)}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedWallet("bonus")}
                                        className={`rounded-xl border p-3 text-left transition ${selectedWallet === "bonus" ? "border-yellow-500 bg-yellow-500/10" : "border-zinc-800 bg-black hover:border-zinc-700"}`}
                                    >
                                        <span className="block text-[9px] text-zinc-500 uppercase font-bold">Saldo bono</span>
                                        <span className={`mt-1 block text-lg font-black tabular-nums ${selectedWallet === "bonus" ? "text-yellow-400" : "text-white"}`}>{money(bonusBalance)}</span>
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">Apuesta por jugador</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(["0.25", "1.00", "10.00"] as ParchisBet[]).map((amt) => (
                                            <button key={amt} type="button" onClick={() => setSelectedBet(amt)} className={`rounded-xl border py-3 text-xs font-black transition ${selectedBet === amt ? "border-emerald-500 bg-emerald-500 text-black" : "border-zinc-800 bg-black text-zinc-400 hover:border-emerald-500/50 hover:text-white"}`}>
                                                ${amt}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">Cantidad de jugadores</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([2, 3, 4] as MaxPlayers[]).map((cnt) => (
                                            <button key={cnt} type="button" onClick={() => setMaxPlayers(cnt)} className={`rounded-xl border py-3 text-xs font-black transition ${maxPlayers === cnt ? "border-emerald-500 bg-emerald-500 text-black" : "border-zinc-800 bg-black text-zinc-400 hover:border-emerald-500/50 hover:text-white"}`}>
                                                {cnt}P
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-xl border border-zinc-800 bg-black p-3">
                                <label className="flex cursor-pointer items-center justify-between gap-3">
                                    <span>
                                        <span className="block text-xs font-bold text-white">Sala privada</span>
                                        <span className="mt-0.5 block text-[10px] text-zinc-500">Protege la entrada con un código</span>
                                    </span>
                                    <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
                                </label>
                                {isPrivate && (
                                    <input type="text" value={roomPassword} onChange={(e) => setRoomPassword(e.target.value)} placeholder="Código de acceso (opcional)" className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500" />
                                )}
                            </div>

                            <button
                                type="button"
                                disabled={isConnecting || busyAction}
                                onClick={handleCreatePrivateOrCustomRoom}
                                className="w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.99] px-4 py-3.5 text-xs font-black uppercase tracking-wider text-black transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {busyAction || isConnecting ? "Preparando sala..." : isPrivate ? "Crear sala privada" : "Crear sala pública"}
                            </button>
                            <p className="text-center text-[9px] leading-relaxed text-zinc-600">La apuesta se descuenta al entrar a la sala. La comisión se aplica mediante la liquidación configurada en AXIOM.</p>
                        </section>

                        <div className="border-t border-zinc-900 pt-4 space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-[9px] text-emerald-400 uppercase font-black tracking-[0.2em]">Encuentra rivales</p>
                                    <h3 className="mt-1 text-sm font-black text-white uppercase">Salas públicas</h3>
                                </div>
                                <button type="button" onClick={() => void fetchPublicRooms()} className="rounded-lg border border-zinc-800 bg-black px-3 py-2 text-[9px] font-black uppercase text-emerald-400 hover:border-emerald-500/40 transition">Actualizar</button>
                            </div>
                            <input type="text" value={searchId} onChange={(e) => setSearchId(e.target.value)} placeholder="Buscar por ID del anfitrión..." className="w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500" />
                            {publicRooms.length === 0 ? (
                                <div className="rounded-xl border border-dashed border-zinc-800 bg-black/60 px-4 py-7 text-center">
                                    <span className="text-2xl text-zinc-700">♟</span>
                                    <p className="mt-2 text-xs font-bold text-zinc-300">{roomsUnavailable ? "Salas temporalmente no disponibles" : "No hay salas públicas disponibles"}</p>
                                    <p className="mt-1 text-[10px] text-zinc-600">Crea una sala o únete usando su ID.</p>
                                </div>
                            ) : (
                                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                    {publicRooms.filter((item) => {
                                        const hostId = String(item.host_doc_number || item.host_cedula || "");
                                        return !searchId.trim() || hostId.toLowerCase().includes(searchId.trim().toLowerCase());
                                    }).map((item) => {
                                        const itemId = item.host_doc_number || item.host_cedula;
                                        const itemName = (item.host_name || "Jugador").split(/\s+/)[0];
                                        return (
                                            <div key={item.room_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black p-3 hover:border-zinc-700 transition">
                                                <div className="min-w-0">
                                                    <span className="block truncate text-xs font-black text-white">{itemName}</span>
                                                    <span className="mt-1 block text-[10px] text-zinc-500">{itemId ? `ID ${itemId} · ` : ""}{item.players_count}/{item.max_players} jugadores · ${item.bet.toFixed(2)}</span>
                                                </div>
                                                <button type="button" onClick={() => connectToRoom(item.room_id, "", item.bet, item.max_players as MaxPlayers)} className="w-full sm:w-auto shrink-0 rounded-lg bg-emerald-500 px-5 py-2.5 text-[10px] font-black uppercase text-black hover:bg-emerald-400 transition">Entrar</button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="border-t border-zinc-900 pt-4 space-y-3">
                            <div>
                                <p className="text-[9px] text-emerald-400 uppercase font-black tracking-[0.2em]">Acceso directo</p>
                                <h3 className="mt-1 text-sm font-black text-white uppercase">Unirse a una sala</h3>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
                                <input type="text" value={joinRoomId} onChange={(e) => setJoinRoomId(e.target.value)} placeholder="ID de sala" className="min-w-0 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500" />
                                <input type="text" value={joinPassword} onChange={(e) => setJoinPassword(e.target.value)} placeholder="Código (si es privada)" className="min-w-0 w-full rounded-xl border border-zinc-800 bg-black px-3 py-3 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500" />
                                <button type="button" disabled={!joinRoomId.trim() || isConnecting} onClick={() => connectToRoom(joinRoomId.trim(), joinPassword.trim())} className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-3 text-[10px] font-black uppercase text-emerald-400 hover:bg-emerald-500 hover:text-black transition disabled:opacity-40">Unirse</button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-[min(100%,42rem)] bg-[#090d0b] border border-white/10 rounded-3xl p-2.5 sm:p-4 flex flex-col gap-2.5 shadow-2xl overflow-hidden">
                        <div className="flex items-center justify-between gap-2 border-b border-zinc-900 pb-2">
                            <button
                                type="button"
                                onClick={() => void exitParchisGame()}
                                className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-red-400 text-[11px] font-bold uppercase rounded-xl border border-zinc-800"
                            >
                                &lsaquo; {isHost ? "Cerrar Sala" : "Salir"}
                            </button>

                            <div className="text-center">
                                <span className="text-xs font-black text-emerald-400 block">
                                    Pozo: {money(gameState?.pot_total ?? 0)}
                                </span>
                                {gameState?.room_id && (
                                    <span className="text-[10px] text-zinc-400 font-bold">
                                        Sala #{gameState.room_id}
                                    </span>
                                )}
                            </div>
                        </div>

                        {!isConnected || !gameState ? (
                            <div className="py-20 text-center text-xs text-yellow-400 uppercase font-bold tracking-wider">
                                {connectionMessage}
                            </div>
                        ) : (
                            <>
                                {extraPlayers.length > 0 && (
                                    <div className="flex flex-wrap items-center justify-between gap-1.5 px-1">
                                        {extraPlayers.map((ep) => {
                                            const c = getPlayerVisualCorner(
                                                ep.seat_index,
                                                mySeatIndex,
                                                activePlayers.length
                                            );
                                            const pal = CORNER_PALETTE[c];
                                            return (
                                                <div
                                                    key={ep.user_id}
                                                    className="flex items-center gap-1.5 bg-zinc-900/80 border border-zinc-800 rounded-full px-2.5 py-1"
                                                >
                                                    <span
                                                        className="w-2.5 h-2.5 rounded-full"
                                                        style={{
                                                            backgroundColor:
                                                                pal.main,
                                                        }}
                                                    />
                                                    <span className="text-[11px] font-bold text-white">
                                                        {getCleanPlayerLabel(
                                                            ep,
                                                            "Jugador"
                                                        )}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <PlayerTurnRow
                                    playerName={topName}
                                    colorName={CORNER_PALETTE[topCorner].name}
                                    accentColor={CORNER_PALETTE[topCorner].main}
                                    d1={d1}
                                    d2={d2}
                                    rolling={rollingDice && topIsTurn}
                                    isActiveTurn={topIsTurn}
                                    canRoll={Boolean(
                                        topPlayer &&
                                        topPlayer.user_id === userId &&
                                        isMyTurn &&
                                        !gameState.must_move
                                    )}
                                    mustMove={Boolean(
                                        topIsTurn && gameState.must_move
                                    )}
                                    onRoll={sendRollDice}
                                    position="top"
                                />

                                <div className="w-full min-w-0 flex items-center justify-center overflow-hidden">
                                    <canvas
                                        ref={boardCanvasRef}
                                        onPointerDown={handleBoardPointerDown}
                                        className="block w-full aspect-square max-h-[min(92vw,68vh)] rounded-2xl border border-emerald-500/20 bg-[#090d0b] shadow-2xl cursor-pointer touch-none"
                                        style={{ touchAction: "none", maxWidth: "min(100%, 68vh)" }}
                                    />
                                </div>

                                <PlayerTurnRow
                                    playerName={bottomName}
                                    colorName={
                                        CORNER_PALETTE[bottomCorner].name
                                    }
                                    accentColor={
                                        CORNER_PALETTE[bottomCorner].main
                                    }
                                    d1={d1}
                                    d2={d2}
                                    rolling={rollingDice && bottomIsTurn}
                                    isActiveTurn={bottomIsTurn}
                                    canRoll={Boolean(
                                        bottomPlayer &&
                                        bottomPlayer.user_id === userId &&
                                        isMyTurn &&
                                        !gameState.must_move
                                    )}
                                    mustMove={Boolean(
                                        bottomIsTurn && gameState.must_move
                                    )}
                                    onRoll={sendRollDice}
                                    position="bottom"
                                />

                                {movablePieces.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                        <span className="text-[10px] font-bold uppercase text-zinc-400">
                                            Mover:
                                        </span>
                                        {movablePieces.map((pc) => (
                                            <div key={pc.id} className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-black/30 p-2">
                                                <span className="px-1 text-[10px] font-black uppercase text-white">Ficha #{pc.id + 1}</span>
                                                {getMovableDice(pc, gameState.dice_remaining).map((die, dieIndex) => (
                                                    <button
                                                        key={`${pc.id}-${dieIndex}-${die}`}
                                                        type="button"
                                                        onClick={() => sendMovePiece(pc.id, die)}
                                                        className="min-w-9 rounded-lg bg-emerald-400 px-2.5 py-2 text-[10px] font-black text-black transition hover:bg-emerald-300 active:scale-95"
                                                    >
                                                        Dado: {die}
                                                    </button>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {gameState.status === "finished" && (
                                    <div className="bg-zinc-900/70 border border-emerald-400 rounded-2xl p-3.5 text-center space-y-2">
                                        <h3 className="text-sm font-black uppercase text-emerald-400">
                                            Partida Finalizada
                                        </h3>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void exitParchisGame()
                                            }
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

            <footer className="py-4 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
                AXIOM PARCHIS ARENA
            </footer>
        </div>
    );
}