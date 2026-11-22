"use client";

import { useEffect, useRef, useCallback, type PointerEvent } from "react";

export interface ParchisPiece {
    id: number;
    stage: number;
    pos: number;
    steps_walked: number;
}

export interface ParchisPlayerState {
    user_id: string;
    player_name?: string;
    cedula?: string;
    seat_index: number;
    team: string | null;
    wallet: string;
    connected: boolean;
    pieces: ParchisPiece[];
}

export interface ParchisState {
    type: string;
    room_id: string;
    host_user_id?: string;
    host_name?: string;
    host_cedula?: string;
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

interface ParchisBoardCanvasProps {
    gameState: ParchisState;
    currentUserId: string;
    onMovePiece: (pieceId: number) => void;
}

const SEAT_PALETTE = [
    { name: "Rojo", main: "#ef4444", dark: "#7f1d1d", soft: "rgba(239,68,68,0.22)" },
    { name: "Azul", main: "#3b82f6", dark: "#1e3a8a", soft: "rgba(59,130,246,0.22)" },
    { name: "Verde", main: "#22c55e", dark: "#14532d", soft: "rgba(34,197,94,0.22)" },
    { name: "Amarillo", main: "#eab308", dark: "#713f12", soft: "rgba(234,179,8,0.22)" },
];

const TRACK_LEN = 68;
const SAFE_SPOTS = new Set([0, 5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63]);
const START_SPOTS: Record<number, number> = { 0: 0, 1: 17, 2: 34, 3: 51 };

// Si hay exactamente 2 jugadores, se colocan en esquinas opuestas (0 y 2)
export function getVisualCorner(
    seatIndex: number,
    totalPlayers: number
): number {
    if (totalPlayers === 2) {
        return seatIndex === 0 ? 0 : 2;
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
    const d = cellSize * 0.62;
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

export default function ParchisBoardCanvas({
    gameState,
    currentUserId,
    onMovePiece,
}: ParchisBoardCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stateRef = useRef<ParchisState>(gameState);
    stateRef.current = gameState;

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const size = Math.max(
            280,
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

        ctx.fillStyle = "#090d0b";
        ctx.fillRect(0, 0, size, size);

        const pad = size * 0.03;
        const inner = size - pad * 2;
        const cell = inner / 15;

        ctx.fillStyle = "#f4efe2";
        ctx.fillRect(pad, pad, inner, inner);

        // Pasillos de llegada
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

        // Cuadrícula de casillas
        ctx.strokeStyle = "rgba(24, 24, 27, 0.35)";
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

        // Seguros y salidas
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
                ctx.beginPath();
                ctx.arc(px, py, Math.max(4, cell * 0.19), 0, Math.PI * 2);
                ctx.fillStyle = startEntry ? "#ffffff" : "#d97706";
                ctx.fill();
                ctx.lineWidth = 1;
                ctx.strokeStyle = "#18181b";
                ctx.stroke();
            }
        }

        const st = stateRef.current;
        const players = Array.isArray(st.players) ? st.players : [];
        const activeCorners = new Set(
            players.map((p) => getVisualCorner(p.seat_index, players.length))
        );

        const homes = [
            { corner: 0, gx: 0, gy: 0 },
            { corner: 1, gx: 9, gy: 0 },
            { corner: 2, gx: 9, gy: 9 },
            { corner: 3, gx: 0, gy: 9 },
        ];

        // Dibujar las 4 esquinas: solo activas con nombre del jugador
        for (const h of homes) {
            const isActive = activeCorners.has(h.corner);
            const pal = SEAT_PALETTE[h.corner];
            const hx0 = pad + h.gx * cell;
            const hy0 = pad + h.gy * cell;
            const hSize = cell * 6;

            ctx.fillStyle = isActive ? pal.main : "#27272a";
            ctx.fillRect(hx0, hy0, hSize, hSize);
            ctx.strokeStyle = "#18181b";
            ctx.lineWidth = 2;
            ctx.strokeRect(hx0, hy0, hSize, hSize);

            const inset = cell * 1.15;
            ctx.fillStyle = isActive ? "#f4efe2" : "#18181b";
            ctx.beginPath();
            ctx.roundRect(
                hx0 + inset,
                hy0 + inset,
                hSize - inset * 2,
                hSize - inset * 2,
                cell * 0.45
            );
            ctx.fill();

            const occupant = players.find(
                (p) => getVisualCorner(p.seat_index, players.length) === h.corner
            );

            if (occupant) {
                const isTurn =
                    st.status === "playing" && st.turn_seat === occupant.seat_index;
                if (isTurn) {
                    ctx.save();
                    ctx.strokeStyle = "#10b981";
                    ctx.lineWidth = 4;
                    ctx.strokeRect(hx0 + 2, hy0 + 2, hSize - 4, hSize - 4);
                    ctx.restore();
                }

                // Etiqueta con el nombre del jugador en su esquina
                const labelText =
                    occupant.player_name ||
                    `Jugador ${occupant.seat_index + 1}`;
                ctx.save();
                ctx.fillStyle = "rgba(9, 9, 11, 0.88)";
                ctx.beginPath();
                ctx.roundRect(hx0 + 4, hy0 + 4, hSize - 8, cell * 0.95, 6);
                ctx.fill();

                ctx.fillStyle = isTurn ? "#34d399" : "#ffffff";
                ctx.font = `bold ${Math.max(9, Math.floor(cell * 0.44))}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(
                    labelText.slice(0, 16),
                    hx0 + hSize / 2,
                    hy0 + 4 + (cell * 0.95) / 2
                );
                ctx.restore();

                const center = getHomeCenter(h.corner);
                for (let pid = 0; pid < 4; pid++) {
                    const slot = getHomeSlotOffset(pid, cell);
                    ctx.beginPath();
                    ctx.arc(
                        center.x * size + slot.dx,
                        center.y * size + slot.dy,
                        cell * 0.36,
                        0,
                        Math.PI * 2
                    );
                    ctx.fillStyle = pal.soft;
                    ctx.fill();
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = pal.main;
                    ctx.stroke();
                }
            }
        }

        // Meta central
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

        const me = players.find((p) => p.user_id === currentUserId);
        const isMyTurn = Boolean(
            st.status === "playing" &&
                me &&
                st.turn_seat === me.seat_index &&
                st.must_move &&
                st.dice !== null
        );
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);

        // Solo fichas de jugadores activos
        for (const p of players) {
            const corner = getVisualCorner(p.seat_index, players.length);
            const pal = SEAT_PALETTE[corner];

            for (const piece of p.pieces || []) {
                const pt = getPieceBoardPoint(piece, corner, size);
                const canMoveThis = Boolean(
                    isMyTurn &&
                        p.user_id === currentUserId &&
                        ((piece.stage === -1 && st.dice === 5) ||
                            piece.stage === 0 ||
                            piece.stage === 100)
                );
                const radius = Math.max(8, cell * 0.36);

                if (canMoveThis) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, radius + 3 + pulse * 3, 0, Math.PI * 2);
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
                ctx.arc(pt.x, pt.y, radius * 0.6, 0, Math.PI * 2);
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
    }, [currentUserId]);

    useEffect(() => {
        let running = true;
        const loop = () => {
            if (!running) return;
            render();
            requestAnimationFrame(loop);
        };
        const id = requestAnimationFrame(loop);
        return () => {
            running = false;
            cancelAnimationFrame(id);
        };
    }, [render]);

    const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
        const st = stateRef.current;
        const players = Array.isArray(st.players) ? st.players : [];
        const me = players.find((p) => p.user_id === currentUserId);
        if (
            !me ||
            st.status !== "playing" ||
            st.turn_seat !== me.seat_index ||
            !st.must_move ||
            st.dice === null
        ) {
            return;
        }

        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const size = Math.max(
            280,
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
            onMovePiece(closestId);
        }
    };

    return (
        <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            className="w-full h-full max-w-[min(82vh,780px)] aspect-square rounded-2xl border-2 border-zinc-700 shadow-2xl cursor-pointer touch-none"
            style={{ touchAction: "none" }}
        />
    );
}