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
type MatchMode = "solo" | "duo";

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
    server_ts?: number;
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

interface ProfileRow {
    first_name: string | null;
    doc_number: string | null;
    balance: number | null;
    bonus_balance: number | null;
}

interface ActivePieceAnim {
    key: string;
    userId: string;
    seatIndex: number;
    pieceId: number;
    startPiece: ParchisPiece;
    currentPiece: ParchisPiece;
    step: number;
    totalSteps: number;
    exitingHome: boolean;
}

const API_BASE =
    process.env.NEXT_PUBLIC_API_URL || "https://casino-axiom.ethiodeploy.app";

const STEP_ANIM_MS = 50;
const DICE_VIEW_HOLD_MS = 950;
const TURN_SECONDS = 10;

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
    return {
        x: pad + (g.gx + dims.w * 0.5) * cell,
        y: pad + (g.gy + dims.h * 0.5) * cell,
    };
}

function canPieceExitWithPairSum(diceValues: number[] | null | undefined): boolean {
    return (
        Array.isArray(diceValues) &&
        diceValues.length === 2 &&
        diceValues[0] + diceValues[1] === 5
    );
}

// Verifica reglas de tablero: máximo 2 fichas del mismo color por espacio y bloqueo de 2 fichas en estrellas
function canPieceMoveWithStep(
    piece: ParchisPiece,
    steps: number,
    seatIndex: number,
    allPlayers: ParchisPlayerState[]
): boolean {
    if (!Number.isFinite(steps) || steps < 1) return false;

    const spotOccupants = new Map<number, ParchisPlayerState[]>();
    for (const pl of allPlayers) {
        for (const pc of pl.pieces || []) {
            if (pc.stage === 0) {
                const s = ((pc.pos % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
                const list = spotOccupants.get(s) || [];
                list.push(pl);
                spotOccupants.set(s, list);
            }
        }
    }

    if (piece.stage === -1) {
        if (steps !== 5) return false;
        const startSpot = SEAT_START_SPOTS[seatIndex] ?? 5;
        const occ = spotOccupants.get(startSpot) || [];
        const myColorCount = occ.filter((o) => o.seat_index === seatIndex).length;
        if (myColorCount >= 2) return false;
        if (STAR_SPOTS.has(startSpot) && occ.length >= 2) return false;
        return true;
    }

    if (piece.stage === 0) {
        if (piece.steps_walked + steps > 70) return false;

        const startSpot = SEAT_START_SPOTS[seatIndex] ?? 5;
        for (let s = 1; s <= steps; s++) {
            const nextWalked = piece.steps_walked + s;
            if (nextWalked >= 63) break;
            const checkSpot = (startSpot + nextWalked) % TRACK_LEN;
            const occ = spotOccupants.get(checkSpot) || [];

            if (STAR_SPOTS.has(checkSpot) && occ.length >= 2) {
                return false;
            }

            if (s === steps) {
                const myColorCount = occ.filter(
                    (o) => o.seat_index === seatIndex
                ).length;
                if (myColorCount >= 2) return false;
            }
        }
        return true;
    }

    if (piece.stage === 100) {
        return piece.pos + steps <= 7;
    }

    return false;
}

function getMovableOptionsForPiece(
    piece: ParchisPiece,
    diceRemaining: number[] | null | undefined,
    bonusSteps: number,
    seatIndex: number,
    allPlayers: ParchisPlayerState[]
): number[] {
    const rem = Array.isArray(diceRemaining) ? diceRemaining : [];

    // Si hay bono (+20 o +10) pero ninguna ficha puede moverse esos pasos exactos,
    // se omite el bono y se evalúan directamente los dados restantes
    if (bonusSteps > 0) {
        const canUseBonusAny =
            piece.stage !== -1 &&
            canPieceMoveWithStep(piece, bonusSteps, seatIndex, allPlayers);
        const anyPlayerCanBonus = allPlayers.some(
            (pl) =>
                pl.seat_index === seatIndex &&
                (pl.pieces || []).some(
                    (pc) =>
                        pc.stage !== -1 &&
                        canPieceMoveWithStep(pc, bonusSteps, seatIndex, allPlayers)
                )
        );

        if (anyPlayerCanBonus) {
            return canUseBonusAny ? [bonusSteps] : [];
        }
    }

    if (rem.length === 0) return [];

    if (piece.stage === -1) {
        if (rem.includes(5) || canPieceExitWithPairSum(rem)) {
            return canPieceMoveWithStep(piece, 5, seatIndex, allPlayers)
                ? [5]
                : [];
        }
        return [];
    }

    const unique = Array.from(new Set(rem));
    return unique.filter((d) =>
        canPieceMoveWithStep(piece, d, seatIndex, allPlayers)
    );
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

function makePartyCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
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

// Bandeja estilo Parchís STAR: Círculo de color + 2 dados al lado + contador de 10s
function StarPlayerHud({
    playerName,
    teamLabel,
    palette,
    dicePair,
    diceRemaining,
    selectedDieValue,
    onSelectDie,
    rolling,
    isActiveTurn,
    secondsLeft,
    canRoll,
    isMovingPiece,
    onRoll,
    position,
}: {
    playerName: string;
    teamLabel?: string | null;
    palette: (typeof SEAT_PALETTE)[number];
    dicePair: [number, number];
    diceRemaining: number[];
    selectedDieValue: number | null;
    onSelectDie?: (dieVal: number) => void;
    rolling: boolean;
    isActiveTurn: boolean;
    secondsLeft: number;
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

    const turnBadge = isActiveTurn ? (
        <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-black tabular-nums border ${
                secondsLeft <= 3
                    ? "bg-red-500/20 border-red-400 text-red-300 animate-pulse"
                    : "bg-zinc-900/90 border-amber-400/70 text-amber-300"
            }`}
        >
            {Math.max(0, secondsLeft)}s
        </span>
    ) : null;

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
                    {turnBadge}
                    {diceTray}
                    {colorBadge}
                </div>
                <div className="flex items-center gap-1.5 mt-1 pr-1">
                    {teamLabel && (
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-amber-300 border border-amber-400/40">
                            {teamLabel}
                        </span>
                    )}
                    <span className="text-[11px] sm:text-xs font-bold text-zinc-200 drop-shadow">
                        {playerName}
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col items-start pl-1">
            <div className="flex items-center gap-2 mb-1 pl-1">
                <span className="text-[11px] sm:text-xs font-bold text-zinc-200 drop-shadow">
                    {playerName}
                </span>
                {teamLabel && (
                    <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-emerald-300 border border-emerald-400/40">
                        {teamLabel}
                    </span>
                )}
                {turnBadge}
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

    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

    const [selectedBet, setSelectedBet] = useState<ParchisBet>("0.25");
    const [maxPlayers, setMaxPlayers] = useState<MaxPlayers>(4);
    const [matchMode, setMatchMode] = useState<MatchMode>("solo");
    const [partyCode, setPartyCode] = useState("");
    const [joinPartyCode, setJoinPartyCode] = useState("");
    const [teammateName, setTeammateName] = useState<string | null>(null);
    const [isSearchingMatch, setIsSearchingMatch] = useState(false);

    const [isPrivate, setIsPrivate] = useState(false);
    const [roomPassword, setRoomPassword] = useState("");
    const [joinRoomId, setJoinRoomId] = useState("");
    const [joinPassword, setJoinPassword] = useState("");

    const [isInGame, setIsInGame] = useState(false);
    const [roomId, setRoomId] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState(
        "Preparando arena..."
    );
    const [gameState, setGameState] = useState<ParchisState | null>(null);
    const [displayedState, setDisplayedState] = useState<ParchisState | null>(null);
    const [lastPairShown, setLastPairShown] = useState<[number, number]>([4, 6]);
    const [selectedDieValue, setSelectedDieValue] = useState<number | null>(null);
    const [turnSecondsLeft, setTurnSecondsLeft] = useState<number>(TURN_SECONDS);
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
    const partySocketRef = useRef<WebSocket | null>(null);
    const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const turnDeadlineRef = useRef<number>(0);
    const turnTimeoutSentKeyRef = useRef<string>("");
    const closingByUserRef = useRef(false);
    const animTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const turnHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeAnimsRef = useRef<Record<string, ActivePieceAnim>>({});

    useEffect(() => {
        userIdRef.current = userId;
    }, [userId]);

    useEffect(() => {
        selectedDieValueRef.current = selectedDieValue;
    }, [selectedDieValue]);

    useEffect(() => {
        if (matchMode === "duo" && maxPlayers !== 4) {
            setMaxPlayers(4);
        }
    }, [matchMode, maxPlayers]);

    const clearHeartbeat = useCallback(() => {
        if (heartbeatTimerRef.current) {
            clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
        }
    }, []);

    const clearAllTimers = useCallback(() => {
        clearHeartbeat();
        if (animTickTimerRef.current) {
            clearTimeout(animTickTimerRef.current);
            animTickTimerRef.current = null;
        }
        if (turnHoldTimerRef.current) {
            clearTimeout(turnHoldTimerRef.current);
            turnHoldTimerRef.current = null;
        }
        activeAnimsRef.current = {};
        turnDeadlineRef.current = 0;
        turnTimeoutSentKeyRef.current = "";
        setTurnSecondsLeft(TURN_SECONDS);
        setIsMovingPiece(false);
        setPendingChoice(null);
        setSelectedDieValue(null);
    }, [clearHeartbeat]);

    const scheduleAnimLoop = useCallback(() => {
        if (animTickTimerRef.current) return;

        const tick = () => {
            const entries = Object.values(activeAnimsRef.current);
            if (entries.length === 0) {
                animTickTimerRef.current = null;
                setIsMovingPiece(false);
                return;
            }

            let stillRunning = false;
            for (const anim of entries) {
                if (anim.step < anim.totalSteps) {
                    anim.step += 1;
                    anim.currentPiece = getStepPose(
                        anim.startPiece,
                        anim.seatIndex,
                        anim.step,
                        anim.exitingHome
                    );
                    stillRunning = true;
                } else {
                    delete activeAnimsRef.current[anim.key];
                }
            }

            if (stillRunning || Object.keys(activeAnimsRef.current).length > 0) {
                animTickTimerRef.current = setTimeout(tick, STEP_ANIM_MS);
            } else {
                animTickTimerRef.current = null;
                setIsMovingPiece(false);
            }
        };

        animTickTimerRef.current = setTimeout(tick, STEP_ANIM_MS);
    }, []);

    const queuePieceStepAnimation = useCallback(
        (
            targetUserId: string,
            seatIndex: number,
            fromPiece: ParchisPiece,
            toPiece: ParchisPiece,
            explicitSteps?: number
        ) => {
            const exitingHome = fromPiece.stage === -1 && toPiece.stage === 0;
            let totalSteps = explicitSteps ?? 1;

            if (!explicitSteps) {
                if (exitingHome) {
                    totalSteps = 1;
                } else {
                    const walkedDiff =
                        (toPiece.steps_walked || 0) -
                        (fromPiece.steps_walked || 0);
                    totalSteps =
                        walkedDiff > 0
                            ? walkedDiff
                            : Math.max(
                                  1,
                                  Math.abs(
                                      (toPiece.pos || 0) - (fromPiece.pos || 0)
                                  )
                              );
                }
            }

            totalSteps = Math.min(Math.max(1, totalSteps), 25);
            const key = `${targetUserId}:${fromPiece.id}`;

            activeAnimsRef.current[key] = {
                key,
                userId: targetUserId,
                seatIndex,
                pieceId: fromPiece.id,
                startPiece: { ...fromPiece },
                currentPiece: getStepPose(
                    fromPiece,
                    seatIndex,
                    1,
                    exitingHome
                ),
                step: 1,
                totalSteps,
                exitingHome,
            };

            setIsMovingPiece(true);
            scheduleAnimLoop();
        },
        [scheduleAnimLoop]
    );

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

    useEffect(() => {
        return () => {
            clearAllTimers();
            if (partySocketRef.current) {
                try {
                    partySocketRef.current.close(1000, "Desmontado");
                } catch {}
                partySocketRef.current = null;
            }
            const ws = socketRef.current;
            if (ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.onmessage = null;
                if (
                    ws.readyState === WebSocket.OPEN ||
                    ws.readyState === WebSocket.CONNECTING
                ) {
                    try {
                        ws.close(1000, "Componente desmontado");
                    } catch {}
                }
            }
        };
    }, [clearAllTimers]);

    const resetSessionState = useCallback(() => {
        clearAllTimers();
        setIsSearchingMatch(false);
        setIsConnecting(false);
        setIsConnected(false);
        setRollingDice(false);
        setIsInGame(false);
        setGameState(null);
        setDisplayedState(null);
        gameStateRef.current = null;
        setRoomId("");
        setActiveSocket(null);
        socketRef.current = null;
    }, [clearAllTimers]);

    const exitParchisGame = useCallback(async () => {
        closingByUserRef.current = true;
        clearHeartbeat();

        if (partySocketRef.current) {
            try {
                partySocketRef.current.close(1000, "Saliendo de búsqueda");
            } catch {}
            partySocketRef.current = null;
        }

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
                        type: hostClosing ? "CLOSE_ROOM" : "LEAVE",
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
    }, [
        accessToken,
        clearHeartbeat,
        loadUserBalances,
        resetSessionState,
        roomId,
    ]);

    const passTurnByTimeout = useCallback(() => {
        const curState = gameStateRef.current;
        const currentUid = userIdRef.current;
        if (!curState || !currentUid || curState.status !== "playing") return;

        const me = curState.players?.find((p) => p.user_id === currentUid);
        if (!me || curState.turn_seat !== me.seat_index) return;

        const remKey = JSON.stringify(curState.dice_remaining || []);
        const turnKey = `${curState.turn_seat}:${curState.must_move ? 1 : 0}:${curState.bonus_steps || 0}:${remKey}`;
        if (turnTimeoutSentKeyRef.current === turnKey) return;
        turnTimeoutSentKeyRef.current = turnKey;

        setRollingDice(false);
        setPendingChoice(null);
        setSelectedDieValue(null);

        const ws = socketRef.current || activeSocket;
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(
                    JSON.stringify({
                        type: "PASS_TURN",
                        reason: "timeout",
                    })
                );
            } catch {}
        }

        const players = curState.players || [];
        const seatsSorted = players
            .map((p) => p.seat_index)
            .sort((a, b) => a - b);
        const curIdx = seatsSorted.indexOf(me.seat_index);
        const nextSeat =
            seatsSorted.length > 0
                ? seatsSorted[(curIdx + 1) % seatsSorted.length]
                : me.seat_index;

        const fallbackState: ParchisState = {
            ...curState,
            turn_seat: nextSeat,
            must_move: false,
            dice_remaining: [],
            bonus_steps: 0,
            penalty_pending: false,
            last_event: `${getCleanPlayerLabel(me, "Jugador")} perdió el turno por tiempo (10s).`,
        };
        gameStateRef.current = fallbackState;
        setGameState(fallbackState);
        setDisplayedState(fallbackState);
    }, [activeSocket]);

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

            const prevState = gameStateRef.current;

            if (prevState && Array.isArray(nextState.players)) {
                for (const nextP of nextState.players) {
                    const prevP = prevState.players?.find(
                        (x) => x.user_id === nextP.user_id
                    );
                    if (!prevP) continue;

                    for (const nextPiece of nextP.pieces || []) {
                        const prevPiece = prevP.pieces?.find(
                            (x) => x.id === nextPiece.id
                        );
                        if (!prevPiece) continue;

                        const moved =
                            prevPiece.stage !== nextPiece.stage ||
                            prevPiece.pos !== nextPiece.pos ||
                            prevPiece.steps_walked !== nextPiece.steps_walked;

                        const sentHome =
                            nextPiece.stage === -1 && prevPiece.stage !== -1;

                        if (moved && !sentHome) {
                            queuePieceStepAnimation(
                                nextP.user_id,
                                nextP.seat_index,
                                prevPiece,
                                nextPiece
                            );
                        }
                    }
                }
            }

            const hasPair =
                Array.isArray(nextState.dice_pair) &&
                nextState.dice_pair.length >= 2;

            if (hasPair && nextState.dice_pair) {
                setLastPairShown([
                    clampDieFace(nextState.dice_pair[0], 4),
                    clampDieFace(nextState.dice_pair[1], 6),
                ]);
            }

            const turnChanged =
                !prevState ||
                prevState.turn_seat !== nextState.turn_seat ||
                prevState.status !== nextState.status;

            if (turnChanged && nextState.status === "playing") {
                turnDeadlineRef.current = Date.now() + TURN_SECONDS * 1000;
                turnTimeoutSentKeyRef.current = "";
                setTurnSecondsLeft(TURN_SECONDS);
            } else if (nextState.status !== "playing") {
                turnDeadlineRef.current = 0;
                setTurnSecondsLeft(TURN_SECONDS);
            }

            gameStateRef.current = nextState;
            setGameState(nextState);

            if (turnHoldTimerRef.current) {
                clearTimeout(turnHoldTimerRef.current);
                turnHoldTimerRef.current = null;
            }

            const turnPassedRightAfterRoll =
                prevState !== null &&
                prevState.status === "playing" &&
                nextState.status === "playing" &&
                prevState.turn_seat !== nextState.turn_seat &&
                !prevState.must_move &&
                !nextState.must_move &&
                hasPair;

            if (turnPassedRightAfterRoll) {
                setDisplayedState({
                    ...nextState,
                    turn_seat: prevState.turn_seat,
                    dice_remaining: [],
                    must_move: false,
                    last_event: nextState.last_event,
                });
                turnHoldTimerRef.current = setTimeout(() => {
                    turnHoldTimerRef.current = null;
                    setDisplayedState(nextState);
                }, DICE_VIEW_HOLD_MS);
            } else {
                setDisplayedState(nextState);
            }
        },
        [queuePieceStepAnimation, resetSessionState, showAlert]
    );

    const activeStateForTimer = displayedState || gameState;
    const timerStatus = activeStateForTimer?.status || "";
    const timerTurnSeat = activeStateForTimer?.turn_seat ?? -1;

    useEffect(() => {
        if (!isInGame || timerStatus !== "playing") return;

        if (!turnDeadlineRef.current) {
            turnDeadlineRef.current = Date.now() + TURN_SECONDS * 1000;
        }

        const interval = setInterval(() => {
            const remainingMs = turnDeadlineRef.current - Date.now();
            const secs = Math.max(0, Math.ceil(remainingMs / 1000));
            setTurnSecondsLeft(secs);

            if (remainingMs <= 0) {
                passTurnByTimeout();
            }
        }, 250);

        return () => clearInterval(interval);
    }, [isInGame, timerStatus, timerTurnSeat, passTurnByTimeout]);

    const connectToRoom = useCallback(
        (
            targetRoomId: string,
            pwd = "",
            overrideBet?: number,
            overridePlayers?: MaxPlayers,
            overrideTeamMode?: "ffa" | "2v2",
            overridePartyCode?: string
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
            const playersCount =
                overrideTeamMode === "2v2" ? 4 : (overridePlayers ?? maxPlayers);
            const teamModeValue =
                overrideTeamMode ?? (matchMode === "duo" ? "2v2" : "ffa");
            const available =
                selectedWallet === "play" ? playBalance : bonusBalance;

            if (available < betAmount) {
                showAlert(
                    "Saldo insuficiente",
                    `Necesitas al menos ${money(betAmount)} en la billetera seleccionada.`
                );
                return;
            }

            if (partySocketRef.current) {
                try {
                    partySocketRef.current.close(1000, "Entrando a partida");
                } catch {}
                partySocketRef.current = null;
            }

            clearAllTimers();
            closingByUserRef.current = false;
            setIsSearchingMatch(false);
            setIsConnecting(true);
            setIsConnected(false);

            setRoomId(targetRoomId);
            setIsInGame(true);
            setGameState(null);
            setDisplayedState(null);
            gameStateRef.current = null;
            setLastPairShown([4, 6]);
            setConnectionMessage("Conectando con el servidor...");

            const cleanName = (playerName.trim() || "Jugador").split(/\s+/)[0];
            const partyParam = overridePartyCode
                ? `&party_code=${encodeURIComponent(overridePartyCode)}`
                : "";

            const wsUrl = getWebSocketUrl(
                `/ws/parchis/${encodeURIComponent(targetRoomId)}` +
                    `?user_id=${encodeURIComponent(userId)}` +
                    `&access_token=${encodeURIComponent(accessToken)}` +
                    `&player_name=${encodeURIComponent(cleanName)}` +
                    `&bet=${encodeURIComponent(String(betAmount))}` +
                    `&max_players=${encodeURIComponent(String(playersCount))}` +
                    `&team_mode=${encodeURIComponent(teamModeValue)}` +
                    `&wallet=${encodeURIComponent(selectedWallet)}` +
                    `&password=${encodeURIComponent(pwd)}${partyParam}`
            );

            try {
                const ws = new WebSocket(wsUrl);
                socketRef.current = ws;
                setActiveSocket(ws);

                ws.onopen = () => {
                    clearHeartbeat();
                    heartbeatTimerRef.current = setInterval(() => {
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
                            clearAllTimers();
                            setRollingDice(false);
                            setIsConnecting(false);
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
                    clearHeartbeat();
                    setRollingDice(false);
                    setIsMovingPiece(false);
                    setConnectionMessage("Error de enlace con la sala...");
                };

                ws.onclose = (event) => {
                    clearHeartbeat();

                    const wasUserClose = closingByUserRef.current;
                    closingByUserRef.current = false;
                    resetSessionState();

                    if (!wasUserClose) {
                        showAlert(
                            "Sala cerrada",
                            event.reason ||
                                `Se cerró la sala (${event.code}).`
                        );
                    }

                    void loadUserBalances();
                };
            } catch {
                clearHeartbeat();
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
            clearHeartbeat,
            getWebSocketUrl,
            isConnecting,
            loadUserBalances,
            matchMode,
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

    const handleFindPublicMatch = async () => {
        if (!userId || !accessToken) {
            showAlert("Sesión requerida", "Inicia sesión para buscar partida.");
            return;
        }

        const isDuo = matchMode === "duo";
        const betAmount = PARCHIS_BETS[selectedBet];
        const playersCount: MaxPlayers = isDuo ? 4 : maxPlayers;
        const teamModeValue: "ffa" | "2v2" = isDuo ? "2v2" : "ffa";
        const available =
            selectedWallet === "play" ? playBalance : bonusBalance;

        if (available < betAmount) {
            showAlert(
                "Saldo insuficiente",
                `Necesitas al menos ${money(betAmount)} en la billetera seleccionada.`
            );
            return;
        }

        const activeCode = isDuo
            ? (partyCode || joinPartyCode || makePartyCode()).trim().toUpperCase()
            : "";
        if (isDuo && !partyCode) {
            setPartyCode(activeCode);
        }

        setBusyAction(true);
        setIsSearchingMatch(true);

        try {
            const query = new URLSearchParams({
                bet: String(betAmount),
                max_players: String(playersCount),
                team_mode: teamModeValue,
            });
            if (activeCode) {
                query.set("party_code", activeCode);
            }

            const res = await fetch(
                `${API_BASE}/parchis/matchmaking/find?${query.toString()}`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                }
            );

            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data.room_id) {
                    connectToRoom(
                        String(data.room_id),
                        "",
                        betAmount,
                        playersCount,
                        teamModeValue,
                        activeCode
                    );
                    return;
                }
            }

            const fallbackRoomId =
                isDuo && activeCode
                    ? `auto-2v2-${betAmount}-${activeCode}`
                    : `auto-${teamModeValue}-${playersCount}-${betAmount}`;

            connectToRoom(
                fallbackRoomId,
                "",
                betAmount,
                playersCount,
                teamModeValue,
                activeCode
            );
        } catch {
            const fallbackRoomId =
                isDuo && activeCode
                    ? `auto-2v2-${betAmount}-${activeCode}`
                    : `auto-${teamModeValue}-${playersCount}-${betAmount}`;

            connectToRoom(
                fallbackRoomId,
                "",
                betAmount,
                playersCount,
                teamModeValue,
                activeCode
            );
        } finally {
            setBusyAction(false);
        }
    };

    const handleCreatePrivateOrCustomRoom = async () => {
        if (!accessToken) {
            showAlert("Sesión requerida", "Inicia sesión para crear una sala.");
            return;
        }

        const isDuo = matchMode === "duo";
        const betAmount = PARCHIS_BETS[selectedBet];
        const playersCount: MaxPlayers = isDuo ? 4 : maxPlayers;
        const teamModeValue: "ffa" | "2v2" = isDuo ? "2v2" : "ffa";
        const available =
            selectedWallet === "play" ? playBalance : bonusBalance;

        if (available < betAmount) {
            showAlert(
                "Saldo insuficiente",
                `Necesitas al menos ${money(betAmount)} en la billetera seleccionada.`
            );
            return;
        }

        const activeCode = isDuo
            ? (partyCode || joinPartyCode || makePartyCode()).trim().toUpperCase()
            : "";

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
                    max_players: playersCount,
                    team_mode: teamModeValue,
                    party_code: activeCode || null,
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
                playersCount,
                teamModeValue,
                activeCode
            );
        } catch {
            showAlert("Error de red", "No se pudo contactar al servidor.");
        } finally {
            setBusyAction(false);
        }
    };

    const handleJoinDuoParty = () => {
        const cleanCode = joinPartyCode.trim().toUpperCase();
        if (!cleanCode) {
            showAlert("Código de equipo", "Ingresa el código de equipo de tu amigo.");
            return;
        }
        setMatchMode("duo");
        setMaxPlayers(4);
        setPartyCode(cleanCode);
        setTeammateName("Amigo vinculado");
    };

    const handleCreateDuoPartyCode = () => {
        const nextCode = makePartyCode();
        setMatchMode("duo");
        setMaxPlayers(4);
        setPartyCode(nextCode);
        setTeammateName(null);
    };

    const sendRollDice = () => {
        if (isMovingPiece || turnHoldTimerRef.current) return;
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

            setPendingChoice(null);

            ws.send(
                JSON.stringify({
                    type: "MOVE_PIECE",
                    piece_id: pieceId,
                    dice_value: chosenSteps,
                })
            );

            if (me && startPiece) {
                const exitingHome = startPiece.stage === -1;
                const animSteps = exitingHome ? 1 : chosenSteps;
                queuePieceStepAnimation(
                    me.user_id,
                    seatIdx,
                    startPiece,
                    startPiece,
                    animSteps
                );
            }
        },
        [activeSocket, isMovingPiece, queuePieceStepAnimation]
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

        const drawablePieces: Array<{
            player: ParchisPlayerState;
            pal: (typeof SEAT_PALETTE)[number];
            piece: ParchisPiece;
            activePiece: ParchisPiece;
            pt: { x: number; y: number };
            movable: boolean;
            remainingAnimSteps: number;
        }> = [];

        for (const p of players) {
            const pal = getSeatPalette(p.seat_index);

            for (const piece of p.pieces || []) {
                const animKey = `${p.user_id}:${piece.id}`;
                const activeAnim = activeAnimsRef.current[animKey];
                const animOverride = activeAnim
                    ? activeAnim.currentPiece
                    : piece;

                const pt = getPieceBoardPoint(animOverride, p.seat_index, size);
                const options =
                    isMyTurnNow && p.user_id === currentUid
                        ? getMovableOptionsForPiece(
                              piece,
                              state.dice_remaining,
                              state.bonus_steps || 0,
                              p.seat_index,
                              players
                          )
                        : [];

                drawablePieces.push({
                    player: p,
                    pal,
                    piece,
                    activePiece: animOverride,
                    pt,
                    movable: options.length > 0,
                    remainingAnimSteps: activeAnim
                        ? Math.max(0, activeAnim.totalSteps - activeAnim.step)
                        : 0,
                });
            }
        }

        const baseRadius = Math.max(9.5, cell * 0.42);

        for (let i = 0; i < drawablePieces.length; i++) {
            const item = drawablePieces[i];

            const sameSpotIndices =
                item.activePiece.stage === -1
                    ? [i]
                    : drawablePieces
                          .map((other, idx) => ({ other, idx }))
                          .filter(
                              ({ other }) =>
                                  other.activePiece.stage !== -1 &&
                                  Math.hypot(
                                      other.pt.x - item.pt.x,
                                      other.pt.y - item.pt.y
                                  ) <
                                      baseRadius * 0.65
                          )
                          .map(({ idx }) => idx);

            const countInSpot = Math.min(2, sameSpotIndices.length);
            const indexInSpot = Math.min(1, sameSpotIndices.indexOf(i));

            let radius = baseRadius;
            let drawX = item.pt.x;
            const drawY = item.pt.y;

            // Cuando hay 2 fichas en el mismo espacio, se muestran un poco más amplias y armónicas
            if (countInSpot === 2) {
                radius = baseRadius * 0.82;
                const shift = radius * 0.72;
                drawX += indexInSpot === 0 ? -shift : shift;
            }

            if (item.movable) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(drawX, drawY, radius + 4, 0, Math.PI * 2);
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 2.5;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.restore();
            }

            ctx.save();
            ctx.beginPath();
            ctx.arc(drawX, drawY + 2, radius, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.45)";
            ctx.fill();

            ctx.beginPath();
            ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
            ctx.fillStyle = "#fde047";
            ctx.fill();
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = "#713f12";
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(drawX, drawY, radius * 0.82, 0, Math.PI * 2);
            ctx.fillStyle = item.pal.main;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(drawX, drawY, radius * 0.56, 0, Math.PI * 2);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = countInSpot >= 2 ? 1.85 : 2.2;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(drawX, drawY, radius * 0.25, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fill();

            // Contador flotante solo con el número de pasos restantes
            if (item.remainingAnimSteps > 0) {
                const badgeW = 22;
                const badgeH = 14;
                const bx = drawX - badgeW / 2;
                const by = drawY - radius - badgeH - 3;

                ctx.fillStyle = "#09090b";
                ctx.beginPath();
                ctx.roundRect(bx, by, badgeW, badgeH, 5);
                ctx.fill();
                ctx.strokeStyle = "#fbbf24";
                ctx.lineWidth = 1.2;
                ctx.stroke();

                ctx.fillStyle = "#fde047";
                ctx.font = "800 9px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(
                    String(item.remainingAnimSteps),
                    drawX,
                    by + badgeH / 2
                );
            }

            ctx.restore();
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

        const hasAnyValidMove = (me.pieces || []).some(
            (pc) =>
                getMovableOptionsForPiece(
                    pc,
                    state.dice_remaining,
                    state.bonus_steps || 0,
                    me.seat_index,
                    players
                ).length > 0
        );

        if (!hasAnyValidMove) {
            passTurnByTimeout();
            return;
        }

        let closestPiece: ParchisPiece | null = null;
        let closestPt: { x: number; y: number } | null = null;
        let minDist = 36;

        for (const piece of me.pieces || []) {
            const opts = getMovableOptionsForPiece(
                piece,
                state.dice_remaining,
                state.bonus_steps || 0,
                me.seat_index,
                players
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
            state.bonus_steps || 0,
            me.seat_index,
            players
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

    const viewState = displayedState || gameState;
    const activePlayers: ParchisPlayerState[] = viewState?.players || [];
    const myPlayer: ParchisPlayerState | null =
        activePlayers.find((pl: ParchisPlayerState) => pl.user_id === userId) ||
        null;

    const isMyTurn =
        viewState !== null &&
        viewState.status === "playing" &&
        myPlayer !== null &&
        viewState.turn_seat === myPlayer.seat_index &&
        !isMovingPiece;
    const isHost =
        viewState !== null &&
        (viewState.host_user_id === userId || myPlayer?.seat_index === 0);
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
        viewState !== null &&
        viewState.status === "playing" &&
        topPlayer !== null &&
        viewState.turn_seat === topPlayer.seat_index;
    const bottomIsTurn =
        viewState !== null &&
        viewState.status === "playing" &&
        bottomPlayer !== null &&
        viewState.turn_seat === bottomPlayer.seat_index;

    const bottomName =
        bottomPlayer?.user_id === userId
            ? getCleanPlayerLabel(bottomPlayer, mainName)
            : getCleanPlayerLabel(bottomPlayer, "Jugador");
    const topName = topPlayer
        ? getCleanPlayerLabel(topPlayer, "Rival")
        : "Esperando rival...";

    const formatTeamBadge = (p: ParchisPlayerState | null) => {
        if (!p || viewState?.team_mode !== "2v2") return null;
        if (p.team) return `Eq ${p.team.toUpperCase()}`;
        return p.seat_index % 2 === 0 ? "Eq A" : "Eq B";
    };

    const activeDiceRemaining = Array.isArray(viewState?.dice_remaining)
        ? viewState.dice_remaining
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
              viewState?.bonus_steps || 0,
              myPlayer?.seat_index ?? 0,
              activePlayers
          )
        : [];

    const bonusStepsValue = Number(viewState?.bonus_steps || 0);
    const iWonGame =
        Boolean(viewState?.status === "finished") &&
        Array.isArray(viewState?.winners) &&
        viewState.winners.includes(userId);

    const effectivePlayersCount: MaxPlayers =
        matchMode === "duo" ? 4 : maxPlayers;

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

                        <div className="space-y-1.5">
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

                        <div className="space-y-1.5">
                            <label className="block text-[10px] font-bold uppercase text-zinc-500">
                                Modo de juego
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setMatchMode("solo")}
                                    className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                                        matchMode === "solo"
                                            ? "border-emerald-400 bg-emerald-500 text-black"
                                            : "border-zinc-800 bg-black text-zinc-400"
                                    }`}
                                >
                                    Individual
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMatchMode("duo");
                                        setMaxPlayers(4);
                                        if (!partyCode) {
                                            setPartyCode(makePartyCode());
                                        }
                                    }}
                                    className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                                        matchMode === "duo"
                                            ? "border-amber-300 bg-amber-400 text-black"
                                            : "border-zinc-800 bg-black text-zinc-400"
                                    }`}
                                >
                                    Equipo 2v2
                                </button>
                            </div>
                        </div>

                        {matchMode === "duo" && (
                            <div className="rounded-xl border border-amber-400/40 bg-zinc-900/70 p-2.5 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-amber-300">
                                        Escuadrón con tu amigo (Sala de 4)
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleCreateDuoPartyCode}
                                        className="text-[10px] font-bold text-emerald-400 hover:underline"
                                    >
                                        Nuevo código
                                    </button>
                                </div>

                                <div className="flex items-center justify-between gap-2 rounded-lg bg-black border border-zinc-800 px-2.5 py-1.5">
                                    <span className="text-[10px] text-zinc-400">
                                        Tu código de equipo:
                                    </span>
                                    <span className="text-xs font-black tracking-widest text-emerald-400">
                                        {partyCode || "------"}
                                    </span>
                                </div>

                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={joinPartyCode}
                                        onChange={(e) =>
                                            setJoinPartyCode(e.target.value)
                                        }
                                        placeholder="Código de tu amigo"
                                        className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-black px-2.5 py-1.5 text-xs text-white uppercase outline-none focus:border-amber-400"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleJoinDuoParty}
                                        className="rounded-lg bg-amber-400 px-3 py-1.5 text-[10px] font-black uppercase text-black hover:bg-amber-300"
                                    >
                                        Unir equipo
                                    </button>
                                </div>

                                {teammateName && (
                                    <p className="text-[10px] font-bold text-emerald-400">
                                        {teammateName} · Buscaremos sala 2v2 juntos
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
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
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold uppercase text-zinc-500">
                                    Jugadores
                                </label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {([2, 3, 4] as MaxPlayers[]).map((cnt) => {
                                        const disabledCnt =
                                            matchMode === "duo" && cnt !== 4;
                                        const isActive =
                                            effectivePlayersCount === cnt;
                                        return (
                                            <button
                                                key={cnt}
                                                type="button"
                                                disabled={disabledCnt}
                                                onClick={() => setMaxPlayers(cnt)}
                                                className={`rounded-lg border py-2 text-[11px] font-bold ${
                                                    isActive
                                                        ? "border-emerald-400 bg-emerald-500 text-black"
                                                        : "border-zinc-800 bg-black text-zinc-400"
                                                } disabled:opacity-35`}
                                            >
                                                {cnt}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        <button
                            type="button"
                            disabled={isConnecting || busyAction || isSearchingMatch}
                            onClick={() => void handleFindPublicMatch()}
                            className="w-full rounded-xl bg-emerald-500 py-3 text-xs font-black uppercase text-black hover:bg-emerald-400 disabled:opacity-50"
                        >
                            {busyAction || isConnecting || isSearchingMatch
                                ? matchMode === "duo"
                                    ? "Buscando sala 2v2 en equipo..."
                                    : "Buscando sala pública..."
                                : matchMode === "duo"
                                  ? "Buscar sala en equipo (2v2)"
                                  : "Buscar partida pública"}
                        </button>

                        <div className="border-t border-zinc-800 pt-3 space-y-2">
                            <p className="text-[10px] font-bold uppercase text-zinc-500">
                                Sala privada o código directo
                            </p>
                            <div className="flex items-center gap-2">
                                <input
                                    id="parchis-private"
                                    type="checkbox"
                                    checked={isPrivate}
                                    onChange={(e) =>
                                        setIsPrivate(e.target.checked)
                                    }
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
                                        className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-black px-2.5 py-1.5 text-xs text-white outline-none focus:border-emerald-500"
                                    />
                                )}
                                <button
                                    type="button"
                                    disabled={isConnecting || busyAction}
                                    onClick={() =>
                                        void handleCreatePrivateOrCustomRoom()
                                    }
                                    className="rounded-lg bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-[10px] font-bold uppercase text-white disabled:opacity-40"
                                >
                                    Crear
                                </button>
                            </div>

                            <div className="flex gap-2 pt-1">
                                <input
                                    type="text"
                                    value={joinRoomId}
                                    onChange={(e) =>
                                        setJoinRoomId(e.target.value)
                                    }
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
                                    Pozo: {money(getNetPotDisplay(viewState))}
                                </span>
                                {viewState?.room_code && (
                                    <span className="text-[10px] text-zinc-400 font-bold">
                                        Clave: {viewState.room_code}
                                    </span>
                                )}
                            </div>
                        </div>

                        {!isConnected || !viewState ? (
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
                                            const isExtraTurn =
                                                viewState.status === "playing" &&
                                                viewState.turn_seat ===
                                                    ep.seat_index;
                                            const epTeam = formatTeamBadge(ep);
                                            return (
                                                <div
                                                    key={ep.user_id}
                                                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 border ${
                                                        isExtraTurn
                                                            ? "bg-zinc-900 border-amber-400"
                                                            : "bg-black/40 border-white/10"
                                                    }`}
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
                                                    {epTeam && (
                                                        <span className="text-[9px] font-black text-amber-300">
                                                            {epTeam}
                                                        </span>
                                                    )}
                                                    {isExtraTurn && (
                                                        <span className="text-[10px] font-black text-amber-300 tabular-nums">
                                                            {turnSecondsLeft}s
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                <StarPlayerHud
                                    playerName={topName}
                                    teamLabel={formatTeamBadge(topPlayer)}
                                    palette={topPalette}
                                    dicePair={lastPairShown}
                                    diceRemaining={
                                        topIsTurn ? activeDiceRemaining : []
                                    }
                                    selectedDieValue={null}
                                    rolling={rollingDice && topIsTurn}
                                    isActiveTurn={topIsTurn}
                                    secondsLeft={turnSecondsLeft}
                                    canRoll={false}
                                    isMovingPiece={isMovingPiece}
                                    onRoll={sendRollDice}
                                    position="top"
                                />

                                <div className="w-full min-w-0 flex items-center justify-center overflow-hidden">
                                    <div
                                        className="relative w-full aspect-square max-h-[min(92vw,64vh)]"
                                        style={{ maxWidth: "min(100%, 64vh)" }}
                                    >
                                        {bonusStepsValue > 0 && (
                                            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-zinc-950/95 border border-amber-400 text-amber-300 text-[11px] font-black shadow-lg whitespace-nowrap">
                                                {bonusStepsValue} pasos
                                                {isMyTurn ? " · Elige ficha" : ""}
                                            </div>
                                        )}

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
                                                        {opt}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <StarPlayerHud
                                    playerName={bottomName}
                                    teamLabel={formatTeamBadge(bottomPlayer)}
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
                                    secondsLeft={turnSecondsLeft}
                                    canRoll={
                                        bottomPlayer !== null &&
                                        bottomPlayer.user_id === userId &&
                                        isMyTurn &&
                                        !viewState.must_move
                                    }
                                    isMovingPiece={isMovingPiece}
                                    onRoll={sendRollDice}
                                    position="bottom"
                                />

                                <p className="text-center text-[11px] text-zinc-300/85 truncate px-2">
                                    {viewState.last_event}
                                </p>

                                {viewState.status === "finished" && (
                                    <div className="bg-black/75 border border-emerald-400 rounded-2xl p-3.5 text-center space-y-2">
                                        <h3 className="text-sm font-black uppercase text-emerald-400">
                                            {iWonGame
                                                ? "¡Ganaste la partida!"
                                                : "Partida Finalizada"}
                                        </h3>
                                        {viewState.last_event && (
                                            <p className="text-xs text-zinc-200">
                                                {viewState.last_event}
                                            </p>
                                        )}
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
