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
    bonus_steps?: number;
    double_count?: number;
    penalty_pending?: boolean;
    must_move: boolean;
    pot_total: number;
    net_pot?: number;
    commission_total?: number;
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

const STEP_ANIM_MS = 110;

const PARCHIS_BETS: Record<ParchisBet, number> = {
    "0.25": 0.25,
    "1.00": 1.0,
    "10.00": 10.0,
};

// 0: Verde (arriba izq), 1: Rojo (arriba der), 2: Azul (abajo der), 3: Amarillo (abajo izq)
const SEAT_PALETTE = [
    {
        name: "Verde",
        main: "#16a34a",
        light: "#4ade80",
        dark: "#14532d",
        hole: "#116b32",
        trayBg: "#233829",
        trayBorder: "#22c55e",
    },
    {
        name: "Rojo",
        main: "#dc2626",
        light: "#f87171",
        dark: "#7f1d1d",
        hole: "#991b1b",
        trayBg: "#4a2520",
        trayBorder: "#ef4444",
    },
    {
        name: "Azul",
        main: "#2563eb",
        light: "#60a5fa",
        dark: "#1e3a8a",
        hole: "#1d4ed8",
        trayBg: "#1e2f4d",
        trayBorder: "#3b82f6",
    },
    {
        name: "Amarillo",
        main: "#eab308",
        light: "#fde047",
        dark: "#713f12",
        hole: "#ca8a04",
        trayBg: "#574b1c",
        trayBorder: "#eab308",
    },
];

const TRACK_LEN = 68;
const STAR_SPOTS = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const SEAT_START_SPOTS: Record<number, number> = {
    0: 5,
    1: 22,
    2: 39,
    3: 56,
};

function getSeatPalette(seatIndex: number) {
    const idx = (((Number(seatIndex) || 0) % 4) + 4) % 4;
    return SEAT_PALETTE[idx];
}

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

function getSeatHomeCenter(seatIndex: number): { x: number; y: number } {
    const corner = (((Number(seatIndex) || 0) % 4) + 4) % 4;
    switch (corner) {
        case 0:
            return { x: 0.218, y: 0.218 };
        case 1:
            return { x: 0.782, y: 0.218 };
        case 2:
            return { x: 0.782, y: 0.782 };
        default:
            return { x: 0.218, y: 0.782 };
    }
}

function getHomeSlotOffset(
    pieceId: number,
    cellSize: number
): { dx: number; dy: number } {
    const d = cellSize * 0.85;
    const slots = [
        { dx: -d, dy: -d },
        { dx: d, dy: -d },
        { dx: -d, dy: d },
        { dx: d, dy: d },
    ];
    return slots[pieceId % 4];
}

function buildExact68ProjectedCoords(): Array<{ gx: number; gy: number }> {
    const pts19: Array<{ x: number; y: number }> = [];

    // Brazo 1 (0..16)
    pts19.push({ x: 9, y: 0 });
    for (let y = 0; y <= 7; y++) pts19.push({ x: 8, y });
    for (let x = 7; x >= 0; x--) pts19.push({ x, y: 8 });

    // Brazo 2 (17..33)
    pts19.push({ x: 0, y: 9 });
    for (let x = 0; x <= 7; x++) pts19.push({ x, y: 10 });
    for (let y = 11; y <= 18; y++) pts19.push({ x: 8, y });

    // Brazo 3 (34..50)
    pts19.push({ x: 9, y: 18 });
    for (let y = 18; y >= 11; y--) pts19.push({ x: 10, y });
    for (let x = 11; x <= 18; x++) pts19.push({ x, y: 10 });

    // Brazo 4 (51..67)
    pts19.push({ x: 18, y: 9 });
    for (let x = 18; x >= 11; x--) pts19.push({ x, y: 8 });
    for (let y = 7; y >= 0; y--) pts19.push({ x: 10, y });

    return pts19.map((p) => {
        const mapCoord = (v: number) => {
            if (v === 8) return 6;
            if (v === 9) return 7;
            if (v === 10) return 8;
            if (v < 8) return (v * 6) / 8;
            return 9 + ((v - 11) * 6) / 8;
        };
        return {
            gx: mapCoord(p.x),
            gy: mapCoord(p.y),
        };
    });
}

const TRACK_GRID = buildExact68ProjectedCoords();

function getCellDimensions(spotIndex: number): { w: number; h: number } {
    const mod = ((spotIndex % 17) + 17) % 17;
    if (spotIndex < 17) {
        return mod <= 8 ? { w: 1, h: 0.75 } : { w: 0.75, h: 1 };
    }
    if (spotIndex < 34) {
        return mod <= 8 ? { w: 0.75, h: 1 } : { w: 1, h: 0.75 };
    }
    if (spotIndex < 51) {
        return mod <= 8 ? { w: 1, h: 0.75 } : { w: 0.75, h: 1 };
    }
    return mod <= 8 ? { w: 0.75, h: 1 } : { w: 1, h: 0.75 };
}

function getGoalLanePoint(
    seatIndex: number,
    pos: number,
    boardSize: number
): { x: number; y: number } {
    const pad = boardSize * 0.04;
    const inner = boardSize - pad * 2;
    const cell = inner / 15;
    const step = Math.max(0, Math.min(7, pos)) / 7;
    const corner = (((Number(seatIndex) || 0) % 4) + 4) % 4;

    switch (corner) {
        case 0:
            return {
                x: pad + 7.5 * cell,
                y: pad + (1.2 + step * 5.4) * cell,
            };
        case 1:
            return {
                x: pad + (13.8 - step * 5.4) * cell,
                y: pad + 7.5 * cell,
            };
        case 2:
            return {
                x: pad + 7.5 * cell,
                y: pad + (13.8 - step * 5.4) * cell,
            };
        default:
            return {
                x: pad + (1.2 + step * 5.4) * cell,
                y: pad + 7.5 * cell,
            };
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
        const home = getSeatHomeCenter(seatIndex);
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
    const dims = getCellDimensions(spot);
    const baseX = pad + (g.gx + dims.w * 0.5) * cell;
    const baseY = pad + (g.gy + dims.h * 0.5) * cell;
    const angle = (piece.id % 4) * (Math.PI / 2);
    const offset = cell * 0.09;

    return {
        x: baseX + Math.cos(angle) * offset,
        y: baseY + Math.sin(angle) * offset,
    };
}

function canPieceExitWithPairSum(diceValues: number[] | null | undefined): boolean {
    return (
        Array.isArray(diceValues) &&
        diceValues.length === 2 &&
        diceValues[0] + diceValues[1] === 5
    );
}

function canPieceMoveWithStep(piece: ParchisPiece, steps: number): boolean {
    if (!Number.isFinite(steps) || steps < 1) return false;
    if (piece.stage === -1) return steps === 5;
    if (piece.stage === 0) return piece.steps_walked + steps <= 70;
    if (piece.stage === 100) return piece.pos + steps <= 7;
    return false;
}

function getMovableOptionsForPiece(
    piece: ParchisPiece,
    diceRemaining: number[] | null | undefined,
    bonusSteps: number
): number[] {
    if (bonusSteps > 0) {
        if (piece.stage === -1) return [];
        return canPieceMoveWithStep(piece, bonusSteps) ? [bonusSteps] : [];
    }

    const rem = Array.isArray(diceRemaining) ? diceRemaining : [];
    if (rem.length === 0) return [];

    if (piece.stage === -1) {
        if (rem.includes(5) || canPieceExitWithPairSum(rem)) {
            return [5];
        }
        return [];
    }

    const unique = Array.from(new Set(rem));
    return unique.filter((d) => canPieceMoveWithStep(piece, d));
}

function getStepPose(
    startPiece: ParchisPiece,
    seatIndex: number,
    stepNum: number,
    isExitingFromHome: boolean
): ParchisPiece {
    const startSpot = SEAT_START_SPOTS[seatIndex] ?? 5;
    if (stepNum <= 0) return { ...startPiece };

    if (startPiece.stage === -1) {
        if (!isExitingFromHome) return { ...startPiece };
        return {
            ...startPiece,
            stage: 0,
            pos: startSpot,
            steps_walked: 0,
        };
    }

    let stage = startPiece.stage;
    let pos = startPiece.pos;
    let stepsWalked = startPiece.steps_walked;

    for (let s = 1; s <= stepNum; s++) {
        if (stage === 0) {
            stepsWalked += 1;
            if (stepsWalked >= 63) {
                stage = 100;
                pos = stepsWalked - 63;
            } else {
                pos = (startSpot + stepsWalked) % TRACK_LEN;
            }
        } else if (stage === 100) {
            pos = Math.min(7, pos + 1);
        }
    }

    return {
        ...startPiece,
        stage,
        pos,
        steps_walked: stepsWalked,
    };
}

function money(value: number): string {
    return `$${Number(value || 0).toFixed(2)}`;
}

function getNetPotDisplay(state: ParchisState | null): number {
    if (!state) return 0;
    if (typeof state.net_pot === "number" && Number.isFinite(state.net_pot)) {
        return state.net_pot;
    }
    const gross = Number(state.pot_total || 0);
    return Number((gross * 0.94).toFixed(2));
}

function clampDieFace(val: unknown, fallback = 4): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(6, Math.max(1, Math.round(n)));
}

function randomDieFace(exclude?: number): number {
    const pool = [1, 2, 3, 4, 5, 6].filter((n) => n !== exclude);
    return pool[Math.floor(Math.random() * pool.length)];
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

function StarStyleDie({
    num,
    rolling,
    used,
    dimmed,
    selected,
    canRollDie,
    canSelectDie,
    onRoll,
    onSelect,
}: {
    num: number;
    rolling: boolean;
    used?: boolean;
    dimmed?: boolean;
    selected?: boolean;
    canRollDie?: boolean;
    canSelectDie?: boolean;
    onRoll?: () => void;
    onSelect?: () => void;
}) {
    const face = clampDieFace(num, 4);
    const dots = PIP_COORDS[face] || PIP_COORDS[4];
    const gradId = `die-bg-${face}-${used ? "u" : "a"}-${dimmed ? "d" : "l"}`;

    const isClickable =
        !rolling &&
        ((Boolean(canRollDie) && !dimmed) ||
            (Boolean(canSelectDie) && !used && !dimmed));

    const handleDieClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (rolling || dimmed) return;
        if (canRollDie) {
            onRoll?.();
            return;
        }
        if (canSelectDie && !used) {
            onSelect?.();
        }
    };

    return (
        <button
            type="button"
            disabled={!isClickable}
            onClick={handleDieClick}
            className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl p-0.5 flex items-center justify-center shadow-md transition-all duration-150 ${
                used || dimmed ? "opacity-40 cursor-default" : "opacity-100"
            } ${isClickable ? "cursor-pointer hover:scale-105 active:scale-95" : ""} ${
                selected ? "ring-2 ring-amber-300 scale-105" : ""
            } ${rolling ? "rotate-12 scale-105" : "rotate-0 scale-100"}`}
        >
            <svg viewBox="0 0 100 100" className="w-full h-full block">
                <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor={dimmed ? "#6b7280" : "#f8fafc"} />
                        <stop offset="100%" stopColor={dimmed ? "#4b5563" : "#cbd5e1"} />
                    </linearGradient>
                </defs>
                <rect
                    x="3"
                    y="3"
                    width="94"
                    height="94"
                    rx="18"
                    fill={`url(#${gradId})`}
                    stroke={selected ? "#f59e0b" : dimmed ? "#374151" : "#94a3b8"}
                    strokeWidth={selected ? "6" : "4"}
                />
                {dots.map(([cx, cy], idx) => (
                    <circle
                        key={idx}
                        cx={cx}
                        cy={cy}
                        r="10"
                        fill={dimmed ? "#1f2937" : "#1e293b"}
                    />
                ))}
            </svg>
        </button>
    );
}

// Bandeja estilo Parchís STAR: Círculo de color + 2 dados al lado (sin ícono de perfil)
function StarPlayerHud({
    playerName,
    palette,
    dicePair,
    diceRemaining,
    selectedDieValue,
    onSelectDie,
    rolling,
    isActiveTurn,
    canRoll,
    isMovingPiece,
    onRoll,
    position,
}: {
    playerName: string;
    palette: (typeof SEAT_PALETTE)[number];
    dicePair: [number, number];
    diceRemaining: number[];
    selectedDieValue: number | null;
    onSelectDie?: (dieVal: number) => void;
    rolling: boolean;
    isActiveTurn: boolean;
    canRoll: boolean;
    isMovingPiece: boolean;
    onRoll: () => void;
    position: "top" | "bottom";
}) {
    const [spinPair, setSpinPair] = useState<[number, number]>([4, 6]);

    useEffect(() => {
        if (!isActiveTurn || !rolling) return;
        const timer = setInterval(() => {
            setSpinPair((prev) => [
                randomDieFace(prev[0]),
                randomDieFace(prev[1]),
            ]);
        }, 75);
        return () => clearInterval(timer);
    }, [isActiveTurn, rolling]);

    const shownPair: [number, number] =
        isActiveTurn && rolling ? spinPair : dicePair;

    const remCopy = [...diceRemaining];
    const die1Available = isActiveTurn && remCopy.includes(shownPair[0]);
    if (die1Available) {
        remCopy.splice(remCopy.indexOf(shownPair[0]), 1);
    }
    const die2Available = isActiveTurn && remCopy.includes(shownPair[1]);

    const canRollNow = position === "bottom" && canRoll && !isMovingPiece;
    const canPickDice =
        position === "bottom" &&
        isActiveTurn &&
        !canRoll &&
        !rolling &&
        !isMovingPiece &&
        diceRemaining.length > 0;

    const initialLetter = (playerName.trim()[0] || "J").toUpperCase();

    const colorBadge = (
        <div
            className="w-11 h-11 sm:w-12 sm:h-12 rounded-full p-0.5 shadow-lg flex items-center justify-center shrink-0"
            style={{
                background: `linear-gradient(135deg, ${palette.light}, ${palette.main})`,
                boxShadow: isActiveTurn
                    ? `0 0 14px ${palette.main}`
                    : "0 4px 10px rgba(0,0,0,0.45)",
            }}
        >
            <div
                className="w-full h-full rounded-full flex items-center justify-center border-2 border-zinc-900 font-black text-sm text-white"
                style={{ backgroundColor: palette.main }}
            >
                {initialLetter}
            </div>
        </div>
    );

    const diceTray = (
        <div
            style={{
                backgroundColor: palette.trayBg,
                borderColor: isActiveTurn ? palette.trayBorder : "#3f3f46",
            }}
            className={`border-2 rounded-xl px-2 py-1.5 flex items-center gap-1.5 shadow-lg transition-all ${
                canRollNow ? "ring-2 ring-emerald-400/70" : ""
            }`}
        >
            <StarStyleDie
                num={shownPair[0]}
                rolling={rolling}
                used={isActiveTurn && !rolling && diceRemaining.length > 0 && !die1Available}
                dimmed={!isActiveTurn}
                selected={canPickDice && die1Available && selectedDieValue === shownPair[0]}
                canRollDie={canRollNow}
                canSelectDie={canPickDice}
                onRoll={onRoll}
                onSelect={() => onSelectDie?.(shownPair[0])}
            />
            <StarStyleDie
                num={shownPair[1]}
                rolling={rolling}
                used={isActiveTurn && !rolling && diceRemaining.length > 0 && !die2Available}
                dimmed={!isActiveTurn}
                selected={canPickDice && die2Available && selectedDieValue === shownPair[1]}
                canRollDie={canRollNow}
                canSelectDie={canPickDice}
                onRoll={onRoll}
                onSelect={() => onSelectDie?.(shownPair[1])}
            />
        </div>
    );

    if (position === "top") {
        return (
            <div className="w-full flex flex-col items-end pr-1">
                <div className="flex items-center gap-2">
                    {diceTray}
                    {colorBadge}
                </div>
                <span className="text-[11px] sm:text-xs font-bold text-zinc-200 mt-1 pr-1 drop-shadow">
                    {playerName}
                </span>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-start pl-1">
            <div className="flex items-center gap-2 mb-1 pl-1">
                <span className="text-[11px] sm:text-xs font-bold text-zinc-200 drop-shadow">
                    {playerName}
                </span>
                {canRollNow && !rolling && (
                    <span className="text-[10px] font-black uppercase bg-emerald-500 text-black px-2 py-0.5 rounded-full animate-pulse">
                        Toca un dado
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2">
                {colorBadge}
                {diceTray}
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
    const [lastPairShown, setLastPairShown] = useState<[number, number]>([4, 6]);
    const [selectedDieValue, setSelectedDieValue] = useState<number | null>(null);
    const [pendingChoice, setPendingChoice] = useState<{
        pieceId: number;
        xPct: number;
        yPct: number;
    } | null>(null);
    const [busyAction, setBusyAction] = useState(false);
    const [rollingDice, setRollingDice] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isMovingPiece, setIsMovingPiece] = useState(false);
    const [activeSocket, setActiveSocket] = useState<WebSocket | null>(null);

    const [modal, setModal] = useState({
        isOpen: false,
        title: "",
        message: "",
    });

    const boardCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const gameStateRef = useRef<ParchisState | null>(null);
    const userIdRef = useRef<string | null>(null);
    const selectedDieValueRef = useRef<number | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const closingByUserRef = useRef(false);
    const stepAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const animatedPieceRef = useRef<{
        userId: string;
        pieceId: number;
        piece: ParchisPiece;
    } | null>(null);

    useEffect(() => {
        userIdRef.current = userId;
    }, [userId]);

    useEffect(() => {
        selectedDieValueRef.current = selectedDieValue;
    }, [selectedDieValue]);

    const clearAllTimers = useCallback(() => {
        if (stepAnimTimerRef.current) {
            clearTimeout(stepAnimTimerRef.current);
            stepAnimTimerRef.current = null;
        }
        animatedPieceRef.current = null;
        setIsMovingPiece(false);
        setPendingChoice(null);
        setSelectedDieValue(null);
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
                if (error) return;
                session = data.session;
            }

            const currentUserId = session?.user?.id;
            if (!currentUserId) {
                setUserId(null);
                setAccessToken("");
                setPlayBalance(0);
                setBonusBalance(0);
                setPlayerName("");
                setDocNumber("");
                return;
            }

            const token = session.access_token || "";
            setUserId(currentUserId);
            setAccessToken(token);

            const emailFallback =
                session.user?.email?.split("@")[0] || "Jugador";

            const { data: profile, error } = await supabase
                .from("profiles")
                .select("first_name, doc_number, balance, bonus_balance")
                .eq("id", currentUserId)
                .maybeSingle();

            if (error) {
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
            const { data } = await supabase.auth.getSession();
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
                setAccessToken("");
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
                ? `&doc_number=${encodeURIComponent(searchId.trim())}`
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
        }, 5000);
        return () => clearInterval(timer);
    }, [isInGame, userId, fetchPublicRooms]);

    const resetSessionState = useCallback(() => {
        clearAllTimers();
        setIsConnecting(false);
        setIsConnected(false);
        setRollingDice(false);
        setIsInGame(false);
        setGameState(null);
        gameStateRef.current = null;
        setRoomId("");
        setActiveSocket(null);
        socketRef.current = null;
    }, [clearAllTimers]);

    const exitParchisGame = useCallback(async () => {
        closingByUserRef.current = true;

        const currentState = gameStateRef.current;
        const activeRoomId = currentState?.room_id || roomId;
        const mySeat = currentState?.players?.find(
            (pl) => pl.user_id === userIdRef.current
        );
        const hostClosing =
            currentState !== null &&
            userIdRef.current !== null &&
            (currentState.host_user_id === userIdRef.current ||
                mySeat?.seat_index === 0);

        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(
                    JSON.stringify({
                        type: hostClosing ? "CLOSE_ROOM" : "LEAVE_ROOM",
                        room_id: activeRoomId,
                    })
                );
            } catch {}
        }

        if (hostClosing && activeRoomId && accessToken) {
            try {
                await fetch(
                    `${API_BASE}/parchis/rooms/${encodeURIComponent(
                        String(activeRoomId)
                    )}/close`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${accessToken}`,
                        },
                    }
                );
            } catch {}
        }

        if (activeRoomId) {
            setPublicRooms((prev) =>
                prev.filter((r) => String(r.room_id) !== String(activeRoomId))
            );
        }

        resetSessionState();

        if (ws) {
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            if (
                ws.readyState === WebSocket.OPEN ||
                ws.readyState === WebSocket.CONNECTING
            ) {
                ws.close(1000, "Saliendo de sala");
            }
        }

        await loadUserBalances();
        await fetchPublicRooms();
    }, [
        accessToken,
        fetchPublicRooms,
        loadUserBalances,
        resetSessionState,
        roomId,
    ]);

    const applyIncomingGameState = useCallback(
        (nextState: ParchisState) => {
            if (nextState.status === "closed_by_host") {
                resetSessionState();
                showAlert(
                    "Sala cerrada",
                    nextState.last_event ||
                        "El anfitrión cerró la sala y se eliminó la partida."
                );
                return;
            }

            setRollingDice(false);
            setPendingChoice(null);

            const rem = Array.isArray(nextState.dice_remaining)
                ? nextState.dice_remaining
                : [];
            setSelectedDieValue((prev) =>
                prev !== null && rem.includes(prev) ? prev : null
            );

            gameStateRef.current = nextState;
            setGameState(nextState);

            if (
                Array.isArray(nextState.dice_pair) &&
                nextState.dice_pair.length >= 2
            ) {
                setLastPairShown([
                    clampDieFace(nextState.dice_pair[0], 4),
                    clampDieFace(nextState.dice_pair[1], 6),
                ]);
            }
        },
        [resetSessionState, showAlert]
    );

    const connectToRoom = useCallback(
        (
            targetRoomId: string,
            pwd = "",
            overrideBet?: number,
            overridePlayers?: MaxPlayers
        ) => {
            if (isConnecting || socketRef.current) {
                showAlert(
                    "Partida activa",
                    "Ya existe una conexión activa en Parchís."
                );
                return;
            }

            if (!userId || !accessToken) {
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

            clearAllTimers();
            closingByUserRef.current = false;
            setIsConnecting(true);
            setIsConnected(false);

            setRoomId(targetRoomId);
            setIsInGame(true);
            setGameState(null);
            gameStateRef.current = null;
            setLastPairShown([4, 6]);
            setConnectionMessage("Conectando con el servidor...");

            const cleanName = (playerName.trim() || "Jugador").split(/\s+/)[0];

            const wsUrl = getWebSocketUrl(
                `/ws/parchis/${encodeURIComponent(targetRoomId)}` +
                    `?user_id=${encodeURIComponent(userId)}` +
                    `&access_token=${encodeURIComponent(accessToken)}` +
                    `&player_name=${encodeURIComponent(cleanName)}` +
                    `&bet=${encodeURIComponent(String(betAmount))}` +
                    `&max_players=${encodeURIComponent(String(playersCount))}` +
                    `&wallet=${encodeURIComponent(selectedWallet)}` +
                    `&password=${encodeURIComponent(pwd)}`
            );

            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

            try {
                const ws = new WebSocket(wsUrl);
                socketRef.current = ws;
                setActiveSocket(ws);

                ws.onopen = () => {
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
                    try {
                        const data = JSON.parse(event.data);

                        if (data.type === "PARCHIS_STATE") {
                            applyIncomingGameState(data);
                            if (data.room_id) {
                                setRoomId(String(data.room_id));
                            }
                            setIsConnected(true);
                            setConnectionMessage("Partida conectada");
                            if (data.status === "finished") {
                                void loadUserBalances();
                            }
                            return;
                        }

                        if (data.type === "ERROR") {
                            if (stepAnimTimerRef.current) {
                                clearTimeout(stepAnimTimerRef.current);
                                stepAnimTimerRef.current = null;
                            }
                            setRollingDice(false);
                            setIsConnecting(false);
                            setIsMovingPiece(false);
                            animatedPieceRef.current = null;
                            showAlert(
                                "Aviso",
                                data.message ||
                                    "No se pudo completar la acción."
                            );
                            if (!gameStateRef.current) {
                                resetSessionState();
                            }
                        }
                    } catch (error) {
                        console.error(
                            "Error procesando mensaje Parchís:",
                            error
                        );
                    }
                };

                ws.onerror = () => {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }
                    setRollingDice(false);
                    setIsMovingPiece(false);
                    setConnectionMessage("Error de enlace con la sala...");
                };

                ws.onclose = (event) => {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }

                    const wasUserClose = closingByUserRef.current;
                    closingByUserRef.current = false;
                    resetSessionState();

                    if (!wasUserClose) {
                        void fetchPublicRooms();
                        showAlert(
                            "Sala cerrada",
                            event.reason ||
                                `Se cerró la sala (${event.code}).`
                        );
                    }

                    void loadUserBalances();
                };
            } catch (error) {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                resetSessionState();
                showAlert(
                    "Error de conexión",
                    "No se pudo conectar con el servidor de Parchís."
                );
            }
        },
        [
            accessToken,
            applyIncomingGameState,
            bonusBalance,
            clearAllTimers,
            fetchPublicRooms,
            getWebSocketUrl,
            isConnecting,
            loadUserBalances,
            maxPlayers,
            playBalance,
            playerName,
            resetSessionState,
            selectedBet,
            selectedWallet,
            showAlert,
            userId,
        ]
    );

    const handleCreatePrivateOrCustomRoom = async () => {
        if (!accessToken) {
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
            const cleanName = (playerName.trim() || "Jugador").split(/\s+/)[0];
            const res = await fetch(`${API_BASE}/parchis/rooms/create`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({
                    bet: betAmount,
                    max_players: maxPlayers,
                    wallet: selectedWallet,
                    is_private: isPrivate,
                    password: isPrivate ? roomPassword.trim() : "",
                    host_name: cleanName,
                    host_doc_number: docNumber.trim(),
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
        if (isMovingPiece) return;
        const ws = socketRef.current || activeSocket;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        setSelectedDieValue(null);
        setPendingChoice(null);
        setRollingDice(true);
        ws.send(JSON.stringify({ type: "ROLL_DICE" }));
    };

    const sendMovePiece = useCallback(
        (pieceId: number, chosenSteps: number) => {
            if (isMovingPiece) return;
            const ws = socketRef.current || activeSocket;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            const curState = gameStateRef.current;
            const me = curState?.players?.find(
                (p) => p.user_id === userIdRef.current
            );
            const startPiece = me?.pieces?.find((pc) => pc.id === pieceId);
            const seatIdx = me?.seat_index ?? 0;
            const exitingHome = startPiece?.stage === -1;
            const animSteps = exitingHome ? 1 : chosenSteps;

            setPendingChoice(null);

            if (stepAnimTimerRef.current) {
                clearTimeout(stepAnimTimerRef.current);
                stepAnimTimerRef.current = null;
            }

            ws.send(
                JSON.stringify({
                    type: "MOVE_PIECE",
                    piece_id: pieceId,
                    dice_value: chosenSteps,
                })
            );

            if (me && startPiece && animSteps > 0) {
                setIsMovingPiece(true);
                let step = 1;
                animatedPieceRef.current = {
                    userId: me.user_id,
                    pieceId,
                    piece: getStepPose(startPiece, seatIdx, step, exitingHome),
                };

                const nextStep = () => {
                    stepAnimTimerRef.current = setTimeout(() => {
                        if (step < animSteps) {
                            step += 1;
                            animatedPieceRef.current = {
                                userId: me.user_id,
                                pieceId,
                                piece: getStepPose(
                                    startPiece,
                                    seatIdx,
                                    step,
                                    exitingHome
                                ),
                            };
                            nextStep();
                        } else {
                            stepAnimTimerRef.current = null;
                            animatedPieceRef.current = null;
                            setIsMovingPiece(false);
                        }
                    }, STEP_ANIM_MS);
                };

                nextStep();
            }
        },
        [activeSocket, isMovingPiece]
    );

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

        const woodGrad = ctx.createLinearGradient(0, 0, 0, size);
        woodGrad.addColorStop(0, "#75523b");
        woodGrad.addColorStop(0.5, "#60412c");
        woodGrad.addColorStop(1, "#4a301f");
        ctx.fillStyle = woodGrad;
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, 16);
        ctx.fill();

        ctx.strokeStyle = "#8c654a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(1, 1, size - 2, size - 2, 15);
        ctx.stroke();

        const pad = size * 0.04;
        const inner = size - pad * 2;
        const cell = inner / 15;

        ctx.fillStyle = "#ffffff";
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

        const startColorBySpot: Record<number, string> = {
            [SEAT_START_SPOTS[0]]: SEAT_PALETTE[0].main,
            [SEAT_START_SPOTS[3]]: SEAT_PALETTE[3].main,
            [SEAT_START_SPOTS[2]]: SEAT_PALETTE[2].main,
            [SEAT_START_SPOTS[1]]: SEAT_PALETTE[1].main,
        };

        for (let i = 0; i < TRACK_LEN; i++) {
            const g = TRACK_GRID[i];
            const dims = getCellDimensions(i);
            const rx = pad + g.gx * cell;
            const ry = pad + g.gy * cell;
            const rw = dims.w * cell;
            const rh = dims.h * cell;
            const px = rx + rw * 0.5;
            const py = ry + rh * 0.5;
            const startColor = startColorBySpot[i];

            if (startColor) {
                ctx.fillStyle = startColor;
                ctx.fillRect(rx, ry, rw, rh);
            } else if (STAR_SPOTS.has(i)) {
                ctx.fillStyle = "#b8b2b6";
                ctx.fillRect(rx, ry, rw, rh);
            }

            ctx.strokeStyle = "rgba(100, 116, 139, 0.5)";
            ctx.lineWidth = 1;
            ctx.strokeRect(rx, ry, rw, rh);

            if (STAR_SPOTS.has(i) && !startColor) {
                ctx.save();
                ctx.beginPath();
                const starR = Math.max(4.5, Math.min(rw, rh) * 0.3);
                for (let s = 0; s < 10; s++) {
                    const r = s % 2 === 0 ? starR : starR * 0.44;
                    const ang = (s * Math.PI) / 5 - Math.PI / 2;
                    const sx = px + Math.cos(ang) * r;
                    const sy = py + Math.sin(ang) * r;
                    if (s === 0) ctx.moveTo(sx, sy);
                    else ctx.lineTo(sx, sy);
                }
                ctx.closePath();
                ctx.fillStyle = "#6b6469";
                ctx.fill();
                ctx.restore();
            } else {
                ctx.fillStyle = startColor ? "#ffffff" : "#64748b";
                ctx.font = `700 ${Math.max(6.5, Math.floor(Math.min(rw, rh) * 0.32))}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(i + 1), px, py);
            }
        }

        ctx.strokeStyle = "rgba(100, 116, 139, 0.45)";
        ctx.lineWidth = 1;
        for (let k = 1; k <= 5; k++) {
            ctx.strokeRect(pad + 7 * cell, pad + k * cell, cell, cell);
            ctx.strokeRect(pad + (14 - k) * cell, pad + 7 * cell, cell, cell);
            ctx.strokeRect(pad + 7 * cell, pad + (14 - k) * cell, cell, cell);
            ctx.strokeRect(pad + k * cell, pad + 7 * cell, cell, cell);
        }

        const homes = [
            { seat: 0, gx: 0, gy: 0 },
            { seat: 1, gx: 9, gy: 0 },
            { seat: 2, gx: 9, gy: 9 },
            { seat: 3, gx: 0, gy: 9 },
        ];

        for (const h of homes) {
            const pal = getSeatPalette(h.seat);
            const hx0 = pad + h.gx * cell;
            const hy0 = pad + h.gy * cell;
            const hSize = cell * 6;

            ctx.fillStyle = pal.main;
            ctx.fillRect(hx0, hy0, hSize, hSize);
            ctx.strokeStyle = "#3f2a1d";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(hx0, hy0, hSize, hSize);

            const inset = cell * 0.45;
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(
                hx0 + inset,
                hy0 + inset,
                hSize - inset * 2,
                hSize - inset * 2,
                14
            );
            ctx.stroke();

            const center = getSeatHomeCenter(h.seat);
            for (let pid = 0; pid < 4; pid++) {
                const slot = getHomeSlotOffset(pid, cell);
                const sx = center.x * size + slot.dx;
                const sy = center.y * size + slot.dy;

                ctx.beginPath();
                ctx.arc(sx, sy, cell * 0.52, 0, Math.PI * 2);
                ctx.fillStyle = pal.hole;
                ctx.fill();
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
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(0,0,0,0.25)";
            ctx.stroke();
        }

        const state = gameStateRef.current;
        const players: ParchisPlayerState[] =
            state && Array.isArray(state.players) ? state.players : [];
        if (!state || players.length === 0) return;

        const currentUid = userIdRef.current;
        const me = players.find(
            (pl: ParchisPlayerState) => pl.user_id === currentUid
        );

        const isMyTurnNow =
            state.status === "playing" &&
            me &&
            state.turn_seat === me.seat_index &&
            state.must_move &&
            ((state.dice_remaining?.length || 0) > 0 ||
                (state.bonus_steps || 0) > 0);

        for (const p of players) {
            const pal = getSeatPalette(p.seat_index);

            for (const piece of p.pieces || []) {
                const animOverride =
                    animatedPieceRef.current &&
                    animatedPieceRef.current.userId === p.user_id &&
                    animatedPieceRef.current.pieceId === piece.id
                        ? animatedPieceRef.current.piece
                        : piece;

                const pt = getPieceBoardPoint(animOverride, p.seat_index, size);
                const options =
                    isMyTurnNow && p.user_id === currentUid
                        ? getMovableOptionsForPiece(
                              piece,
                              state.dice_remaining,
                              state.bonus_steps || 0
                          )
                        : [];
                const movable = options.length > 0;
                const radius = Math.max(9.5, cell * 0.42);

                if (movable) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, radius + 4.5, 0, Math.PI * 2);
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = 2.5;
                    ctx.setLineDash([4, 3]);
                    ctx.stroke();
                    ctx.restore();
                }

                ctx.save();
                ctx.beginPath();
                ctx.arc(pt.x, pt.y + 2, radius, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(0,0,0,0.45)";
                ctx.fill();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = "#fde047";
                ctx.fill();
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = "#713f12";
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius * 0.82, 0, Math.PI * 2);
                ctx.fillStyle = pal.main;
                ctx.fill();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius * 0.56, 0, Math.PI * 2);
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 2.2;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(pt.x, pt.y, radius * 0.25, 0, Math.PI * 2);
                ctx.fillStyle = "#ffffff";
                ctx.fill();
                ctx.restore();
            }
        }
    }, []);

    useEffect(() => {
        if (!isInGame) return;
        let running = true;
        let rafId = 0;
        const loop = () => {
            if (!running) return;
            renderBoard();
            rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
        return () => {
            running = false;
            cancelAnimationFrame(rafId);
        };
    }, [isInGame, renderBoard]);

    const handleBoardPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
        if (isMovingPiece) return;
        const state = gameStateRef.current;
        const currentUid = userIdRef.current;
        const ws = socketRef.current || activeSocket;
        if (!state || !currentUid || state.status !== "playing") return;

        const players: ParchisPlayerState[] = Array.isArray(state.players)
            ? state.players
            : [];
        const me = players.find(
            (pl: ParchisPlayerState) => pl.user_id === currentUid
        );
        if (!me || state.turn_seat !== me.seat_index) return;

        const canvas = boardCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const size = Math.max(
            240,
            Math.floor(Math.min(rect.width, rect.height || rect.width))
        );
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        if (state.penalty_pending) {
            let chosen = -1;
            let closest = 36;
            for (const piece of me.pieces || []) {
                if (piece.stage === -1) continue;
                const pt = getPieceBoardPoint(piece, me.seat_index, size);
                const dist = Math.hypot(clickX - pt.x, clickY - pt.y);
                if (dist < closest) {
                    closest = dist;
                    chosen = piece.id;
                }
            }
            if (chosen >= 0 && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        type: "SELECT_PENALTY_PIECE",
                        piece_id: chosen,
                    })
                );
            }
            return;
        }

        if (!state.must_move) return;

        let closestPiece: ParchisPiece | null = null;
        let closestPt: { x: number; y: number } | null = null;
        let minDist = 36;

        for (const piece of me.pieces || []) {
            const opts = getMovableOptionsForPiece(
                piece,
                state.dice_remaining,
                state.bonus_steps || 0
            );
            if (opts.length === 0) continue;
            const pt = getPieceBoardPoint(piece, me.seat_index, size);
            const dist = Math.hypot(clickX - pt.x, clickY - pt.y);
            if (dist < minDist) {
                minDist = dist;
                closestPiece = piece;
                closestPt = pt;
            }
        }

        if (!closestPiece || !closestPt) return;

        const options = getMovableOptionsForPiece(
            closestPiece,
            state.dice_remaining,
            state.bonus_steps || 0
        );

        const pickedDie = selectedDieValueRef.current;
        if (
            (state.bonus_steps || 0) === 0 &&
            pickedDie !== null &&
            options.includes(pickedDie)
        ) {
            sendMovePiece(closestPiece.id, pickedDie);
            return;
        }

        if (options.length === 1) {
            sendMovePiece(closestPiece.id, options[0]);
        } else if (options.length > 1) {
            const xPct = Math.max(14, Math.min(86, (closestPt.x / size) * 100));
            const yPct = Math.max(12, Math.min(88, (closestPt.y / size) * 100));
            setPendingChoice({
                pieceId: closestPiece.id,
                xPct,
                yPct,
            });
        }
    };

    if (isAuthLoading) {
        return (
            <div className="min-h-screen bg-[#1f131b] text-white flex flex-col">
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
            <div className="min-h-screen bg-[#1f131b] text-white flex flex-col">
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

    const isMyTurn =
        gameState !== null &&
        gameState.status === "playing" &&
        myPlayer !== null &&
        gameState.turn_seat === myPlayer.seat_index &&
        !isMovingPiece;
    const isHost =
        gameState !== null &&
        (gameState.host_user_id === userId || myPlayer?.seat_index === 0);
    const mainName = (playerName.trim() || "Jugador").split(/\s+/)[0];

    const bottomPlayer = myPlayer || activePlayers[0] || null;
    const topPlayer =
        activePlayers.find((p) => p.user_id !== bottomPlayer?.user_id) ||
        null;

    const extraPlayers = activePlayers.filter(
        (p) =>
            p.user_id !== bottomPlayer?.user_id &&
            p.user_id !== topPlayer?.user_id
    );

    const topPalette = topPlayer
        ? getSeatPalette(topPlayer.seat_index)
        : SEAT_PALETTE[0];
    const bottomPalette = bottomPlayer
        ? getSeatPalette(bottomPlayer.seat_index)
        : SEAT_PALETTE[3];

    const topIsTurn =
        gameState !== null &&
        gameState.status === "playing" &&
        topPlayer !== null &&
        gameState.turn_seat === topPlayer.seat_index;
    const bottomIsTurn =
        gameState !== null &&
        gameState.status === "playing" &&
        bottomPlayer !== null &&
        gameState.turn_seat === bottomPlayer.seat_index;

    const bottomName =
        bottomPlayer?.user_id === userId
            ? getCleanPlayerLabel(bottomPlayer, mainName)
            : getCleanPlayerLabel(bottomPlayer, "Jugador");
    const topName = topPlayer
        ? getCleanPlayerLabel(topPlayer, "Rival")
        : "Esperando rival...";

    const activeDiceRemaining = Array.isArray(gameState?.dice_remaining)
        ? gameState.dice_remaining
        : [];

    const pendingPiece =
        pendingChoice !== null && myPlayer
            ? myPlayer.pieces.find((p) => p.id === pendingChoice.pieceId) ||
              null
            : null;
    const pendingOptions = pendingPiece
        ? getMovableOptionsForPiece(
              pendingPiece,
              activeDiceRemaining,
              gameState?.bonus_steps || 0
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
                className={`flex-1 w-full mx-auto flex flex-col ${
                    isInGame
                        ? "max-w-lg px-2.5 sm:px-5 py-2 sm:py-3 items-center justify-center"
                        : "max-w-3xl px-2 sm:px-4 py-3 sm:py-5 items-center justify-center"
                }`}
            >
                {!isInGame ? (
                    <div className="w-full max-w-md mx-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-3 sm:p-4 space-y-3">
                        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                            <Link
                                href="/"
                                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-bold text-zinc-300"
                            >
                                &lsaquo; Volver
                            </Link>
                            <h2 className="text-sm font-black uppercase tracking-wide text-emerald-400">
                                Parchís P2P
                            </h2>
                            <span className="w-14" />
                        </div>

                        <div className="space-y-2">
                            <label className="block text-[10px] font-bold uppercase text-zinc-500">
                                Billetera
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setSelectedWallet("play")}
                                    className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                                        selectedWallet === "play"
                                            ? "border-emerald-400 bg-emerald-500 text-black"
                                            : "border-zinc-800 bg-black text-zinc-400"
                                    }`}
                                >
                                    Jugar · {money(playBalance)}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSelectedWallet("bonus")}
                                    className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                                        selectedWallet === "bonus"
                                            ? "border-yellow-300 bg-yellow-400 text-black"
                                            : "border-zinc-800 bg-black text-zinc-400"
                                    }`}
                                >
                                    Bono · {money(bonusBalance)}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <label className="block text-[10px] font-bold uppercase text-zinc-500">
                                    Apuesta
                                </label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {(
                                        ["0.25", "1.00", "10.00"] as ParchisBet[]
                                    ).map((amt) => (
                                        <button
                                            key={amt}
                                            type="button"
                                            onClick={() => setSelectedBet(amt)}
                                            className={`rounded-lg border py-2 text-[11px] font-bold ${
                                                selectedBet === amt
                                                    ? "border-emerald-400 bg-emerald-500 text-black"
                                                    : "border-zinc-800 bg-black text-zinc-400"
                                            }`}
                                        >
                                            ${amt}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-bold uppercase text-zinc-500">
                                    Jugadores
                                </label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {([2, 3, 4] as MaxPlayers[]).map((cnt) => (
                                        <button
                                            key={cnt}
                                            type="button"
                                            onClick={() => setMaxPlayers(cnt)}
                                            className={`rounded-lg border py-2 text-[11px] font-bold ${
                                                maxPlayers === cnt
                                                    ? "border-emerald-400 bg-emerald-500 text-black"
                                                    : "border-zinc-800 bg-black text-zinc-400"
                                            }`}
                                        >
                                            {cnt}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <input
                                id="parchis-private"
                                type="checkbox"
                                checked={isPrivate}
                                onChange={(e) => setIsPrivate(e.target.checked)}
                                className="h-4 w-4 accent-emerald-500"
                            />
                            <label
                                htmlFor="parchis-private"
                                className="text-xs text-zinc-300"
                            >
                                Sala privada
                            </label>
                            {isPrivate && (
                                <input
                                    type="text"
                                    value={roomPassword}
                                    onChange={(e) =>
                                        setRoomPassword(e.target.value)
                                    }
                                    placeholder="Contraseña"
                                    className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-black px-2.5 py-2 text-xs text-white outline-none focus:border-emerald-500"
                                />
                            )}
                        </div>

                        <button
                            type="button"
                            disabled={isConnecting || busyAction}
                            onClick={handleCreatePrivateOrCustomRoom}
                            className="w-full rounded-xl bg-emerald-500 py-3 text-xs font-black uppercase text-black hover:bg-emerald-400 disabled:opacity-50"
                        >
                            {busyAction || isConnecting
                                ? "Preparando..."
                                : "Crear sala"}
                        </button>

                        <div className="border-t border-zinc-800 pt-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-white">
                                    Salas disponibles
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void fetchPublicRooms()}
                                    className="text-[10px] font-bold text-emerald-400"
                                >
                                    Actualizar
                                </button>
                            </div>
                            <input
                                type="text"
                                value={searchId}
                                onChange={(e) => setSearchId(e.target.value)}
                                placeholder="Buscar por ID de jugador"
                                className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs text-white outline-none focus:border-emerald-500"
                            />
                            {publicRooms.length === 0 ? (
                                <p className="py-3 text-center text-[11px] text-zinc-500">
                                    {roomsUnavailable
                                        ? "Salas no disponibles"
                                        : "No hay salas públicas"}
                                </p>
                            ) : (
                                <div className="max-h-40 space-y-1.5 overflow-y-auto">
                                    {publicRooms
                                        .filter((item) => {
                                            const hostId = String(
                                                item.host_doc_number ||
                                                    item.host_cedula ||
                                                    ""
                                            );
                                            return (
                                                !searchId.trim() ||
                                                hostId
                                                    .toLowerCase()
                                                    .includes(
                                                        searchId
                                                            .trim()
                                                            .toLowerCase()
                                                    )
                                            );
                                        })
                                        .map((item) => {
                                            const itemName = (
                                                item.host_name || "Jugador"
                                            ).split(/\s+/)[0];
                                            return (
                                                <div
                                                    key={item.room_id}
                                                    className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-black px-2.5 py-2"
                                                >
                                                    <div className="min-w-0">
                                                        <p className="truncate text-[11px] font-bold text-white">
                                                            {itemName}
                                                        </p>
                                                        <p className="text-[10px] text-zinc-500">
                                                            {item.players_count}/
                                                            {item.max_players} · $
                                                            {item.bet.toFixed(2)}
                                                        </p>
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
                                                        className="rounded-md bg-emerald-500 px-3 py-1.5 text-[10px] font-black uppercase text-black"
                                                    >
                                                        Entrar
                                                    </button>
                                                </div>
                                            );
                                        })}
                                </div>
                            )}
                        </div>

                        <div className="flex gap-2 border-t border-zinc-800 pt-3">
                            <input
                                type="text"
                                value={joinRoomId}
                                onChange={(e) => setJoinRoomId(e.target.value)}
                                placeholder="ID de sala"
                                className="min-w-0 w-full rounded-lg border border-zinc-800 bg-black px-2.5 py-2 text-xs text-white outline-none focus:border-emerald-500"
                            />
                            <input
                                type="text"
                                value={joinPassword}
                                onChange={(e) =>
                                    setJoinPassword(e.target.value)
                                }
                                placeholder="Clave"
                                className="min-w-0 w-full rounded-lg border border-zinc-800 bg-black px-2.5 py-2 text-xs text-white outline-none focus:border-emerald-500"
                            />
                            <button
                                type="button"
                                disabled={!joinRoomId.trim() || isConnecting}
                                onClick={() =>
                                    connectToRoom(
                                        joinRoomId.trim(),
                                        joinPassword.trim()
                                    )
                                }
                                className="rounded-lg bg-zinc-800 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-40"
                            >
                                Unirse
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-[min(100%,30rem)] bg-black border border-zinc-800 rounded-3xl p-2.5 sm:p-4 flex flex-col gap-2 shadow-2xl overflow-hidden">
                        <div className="flex items-center justify-between gap-2 pb-1">
                            <button
                                type="button"
                                onClick={() => void exitParchisGame()}
                                className="px-3 py-1.5 bg-black/40 hover:bg-black/60 text-zinc-200 hover:text-red-400 text-[11px] font-bold uppercase rounded-xl border border-white/10"
                            >
                                &lsaquo; {isHost ? "Cerrar Sala" : "Salir"}
                            </button>

                            <div className="text-right">
                                <span className="text-xs font-black text-emerald-400 block">
                                    Pozo: {money(getNetPotDisplay(gameState))}
                                </span>
                                {gameState?.room_id && (
                                    <span className="text-[10px] text-zinc-400 font-bold">
                                        {gameState.room_code
                                            ? `Clave: ${gameState.room_code}`
                                            : `#${gameState.room_id}`}
                                    </span>
                                )}
                            </div>
                        </div>

                        {!isConnected || !gameState ? (
                            <div className="py-24 text-center text-xs text-yellow-400 uppercase font-bold tracking-wider">
                                {connectionMessage}
                            </div>
                        ) : (
                            <>
                                {extraPlayers.length > 0 && (
                                    <div className="flex flex-wrap items-center justify-between gap-1.5 px-1">
                                        {extraPlayers.map((ep) => {
                                            const pal = getSeatPalette(
                                                ep.seat_index
                                            );
                                            return (
                                                <div
                                                    key={ep.user_id}
                                                    className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded-full px-2.5 py-1"
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

                                <StarPlayerHud
                                    playerName={topName}
                                    palette={topPalette}
                                    dicePair={lastPairShown}
                                    diceRemaining={
                                        topIsTurn ? activeDiceRemaining : []
                                    }
                                    selectedDieValue={null}
                                    rolling={rollingDice && topIsTurn}
                                    isActiveTurn={topIsTurn}
                                    canRoll={false}
                                    isMovingPiece={isMovingPiece}
                                    onRoll={sendRollDice}
                                    position="top"
                                />

                                {(gameState.bonus_steps || 0) > 0 && isMyTurn && (
                                    <div className="text-center text-[11px] font-black text-amber-300 bg-black/50 rounded-lg py-1">
                                        ¡Bono de +{gameState.bonus_steps} casillas! Toca una ficha
                                    </div>
                                )}

                                {/* Tablero central + selector flotante arriba de la ficha elegida */}
                                <div className="w-full min-w-0 flex items-center justify-center overflow-hidden">
                                    <div
                                        className="relative w-full aspect-square max-h-[min(92vw,64vh)]"
                                        style={{ maxWidth: "min(100%, 64vh)" }}
                                    >
                                        <canvas
                                            ref={boardCanvasRef}
                                            onPointerDown={handleBoardPointerDown}
                                            className="block w-full h-full rounded-2xl shadow-2xl cursor-pointer touch-none"
                                            style={{ touchAction: "none" }}
                                        />

                                        {pendingPiece && pendingOptions.length > 1 && pendingChoice && (
                                            <div
                                                onPointerDown={(e) => e.stopPropagation()}
                                                style={{
                                                    left: `${pendingChoice.xPct}%`,
                                                    top: `${pendingChoice.yPct}%`,
                                                }}
                                                className="absolute -translate-x-1/2 -translate-y-[145%] z-20 flex items-center gap-1 bg-zinc-950/95 border border-amber-300 rounded-xl p-1 shadow-xl"
                                            >
                                                {pendingOptions.map((opt) => (
                                                    <button
                                                        key={opt}
                                                        type="button"
                                                        onClick={() =>
                                                            sendMovePiece(
                                                                pendingPiece.id,
                                                                opt
                                                            )
                                                        }
                                                        className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs rounded-lg active:scale-95"
                                                    >
                                                        +{opt}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <StarPlayerHud
                                    playerName={bottomName}
                                    palette={bottomPalette}
                                    dicePair={lastPairShown}
                                    diceRemaining={
                                        bottomIsTurn ? activeDiceRemaining : []
                                    }
                                    selectedDieValue={selectedDieValue}
                                    onSelectDie={(dieVal) =>
                                        setSelectedDieValue((prev) =>
                                            prev === dieVal ? null : dieVal
                                        )
                                    }
                                    rolling={rollingDice && bottomIsTurn}
                                    isActiveTurn={bottomIsTurn}
                                    canRoll={
                                        bottomPlayer !== null &&
                                        bottomPlayer.user_id === userId &&
                                        isMyTurn &&
                                        !gameState.must_move
                                    }
                                    isMovingPiece={isMovingPiece}
                                    onRoll={sendRollDice}
                                    position="bottom"
                                />

                                <p className="text-center text-[11px] text-zinc-300/85 truncate px-2">
                                    {gameState.last_event}
                                </p>

                                {gameState.status === "finished" && (
                                    <div className="bg-black/75 border border-emerald-400 rounded-2xl p-3.5 text-center space-y-2">
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

            <footer className="py-3 text-center text-[10px] text-zinc-500 font-bold uppercase tracking-widest">
                AXIOM PARCHIS ARENA
            </footer>
        </div>
    );
}