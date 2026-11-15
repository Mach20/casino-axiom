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
type SnakeBet = "0.20" | "10" | "50";

const WORLD_WIDTH = 20000;
const WORLD_HEIGHT = 20000;

const SNAKE_BETS: Record<SnakeBet, { amount: number; room: string }> = {
    "0.20": { amount: 0.20, room: "snake_020" },
    "10": { amount: 10, room: "snake_1000" },
    "50": { amount: 50, room: "snake_5000" },
};

// Valor de cada moneda que deja la aceleración, según la sala.
const BOOST_COIN_VALUES: Record<SnakeBet, number> = {
    "0.20": 0.01,
    "10": 0.50,
    "50": 2.50,
};

function money(value: number): string {
    return `$${Number(value || 0).toFixed(2)}`;
}

function getCoinValue(item: any): number {
    if (typeof item?.value_micros === "number") {
        return item.value_micros / 1000000;
    }
    return Number(item?.value ?? 0);
}

/* VISTA PREVIA DE LA SERPIENTE */
function SnakePreview({
    color,
    pattern,
    eyes,
    accessory,
}: {
    color: string;
    pattern: string;
    eyes: string;
    accessory: string;
}) {
    const segments = [
        { x: 35, y: 55 },
        { x: 58, y: 55 },
        { x: 81, y: 55 },
        { x: 104, y: 55 },
        { x: 127, y: 55 },
        { x: 150, y: 55 },
        { x: 173, y: 55 },
    ];

    return (
        <div className="bg-black border border-zinc-800 rounded-xl p-4 mt-3">
            <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] text-zinc-400 font-bold uppercase">
                    Vista previa de tu serpiente
                </span>
                <span className="text-[9px] text-emerald-400 font-bold uppercase">
                    En vivo
                </span>
            </div>

            <div className="h-28 rounded-lg bg-[#080d0b] border border-zinc-900 flex items-center justify-center overflow-hidden">
                <svg
                    viewBox="0 0 210 110"
                    className="w-full max-w-[280px] h-full"
                    role="img"
                    aria-label="Vista previa de la serpiente personalizada"
                >
                    <defs>
                        <filter id="snakePreviewGlow">
                            <feGaussianBlur stdDeviation="3" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {segments.slice(1).map((segment, index) => (
                        <g key={index}>
                            <circle
                                cx={segment.x}
                                cy={segment.y}
                                r="10"
                                fill={color}
                                filter="url(#snakePreviewGlow)"
                            />
                            {pattern === "stripes" && index % 2 === 0 && (
                                <path
                                    d={`M ${segment.x - 5} ${segment.y - 6} L ${segment.x + 5} ${segment.y + 6}`}
                                    stroke="white"
                                    strokeWidth="3"
                                    strokeLinecap="round"
                                />
                            )}
                            {pattern === "spots" && (
                                <circle
                                    cx={segment.x}
                                    cy={segment.y}
                                    r="3"
                                    fill="#111111"
                                />
                            )}
                            {pattern === "neon" && (
                                <circle
                                    cx={segment.x}
                                    cy={segment.y}
                                    r="7"
                                    fill="none"
                                    stroke="white"
                                    strokeWidth="1.5"
                                />
                            )}
                        </g>
                    ))}

                    <circle
                        cx="35"
                        cy="55"
                        r="12"
                        fill={color}
                        filter="url(#snakePreviewGlow)"
                    />

                    {pattern === "stripes" && (
                        <path
                            d="M 27 48 L 43 62"
                            stroke="white"
                            strokeWidth="3"
                            strokeLinecap="round"
                        />
                    )}

                    {pattern === "spots" && (
                        <circle cx="35" cy="55" r="4" fill="#111111" />
                    )}

                    {pattern === "neon" && (
                        <circle
                            cx="35"
                            cy="55"
                            r="8"
                            fill="none"
                            stroke="white"
                            strokeWidth="1.5"
                        />
                    )}

                    {eyes === "sleepy" ? (
                        <g
                            stroke="#111827"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                        >
                            <path d="M 31 51 L 36 51" />
                            <path d="M 31 59 L 36 59" />
                        </g>
                    ) : (
                        <g fill={eyes === "laser" ? "#ff334f" : "white"}>
                            <circle cx="39" cy="50" r="2.5" />
                            <circle cx="39" cy="60" r="2.5" />
                        </g>
                    )}

                    {accessory === "crown" && (
                        <path
                            d="M 25 43 L 27 30 L 34 38 L 40 29 L 44 43 Z"
                            fill="#facc15"
                            stroke="#ca8a04"
                            strokeWidth="1"
                        />
                    )}

                    {accessory === "bandana" && (
                        <path
                            d="M 26 52 Q 35 47 44 52 L 42 58 Q 35 54 28 58 Z"
                            fill="#f43f5e"
                        />
                    )}

                    {accessory === "halo" && (
                        <ellipse
                            cx="35"
                            cy="37"
                            rx="12"
                            ry="4"
                            fill="none"
                            stroke="#fde68a"
                            strokeWidth="2.5"
                        />
                    )}
                </svg>
            </div>

            <p className="text-[9px] text-zinc-500 text-center mt-2">
                Así se verá tu serpiente dentro de la arena.
            </p>
        </div>
    );
}

export default function SnakeGamePage() {
    // AUTENTICACIÓN
    const [userId, setUserId] = useState<string | null>(null);
    const [accessToken, setAccessToken] = useState("");
    const [isAuthLoading, setIsAuthLoading] = useState(true);

    // SALDOS
    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

    // PERSONALIZACIÓN
    const [customColor, setCustomColor] = useState("#34d399");
    const [snakePattern, setSnakePattern] = useState("solid");
    const [snakeEyes, setSnakeEyes] = useState("classic");
    const [snakeAccessory, setSnakeAccessory] = useState("none");

    const snakePatternRef = useRef("solid");
    const snakeEyesRef = useRef("classic");
    const snakeAccessoryRef = useRef("none");

    // APUESTA
    const [selectedBet, setSelectedBet] = useState<SnakeBet>("0.20");
    const selectedBetRef = useRef<number>(0.20);

    const [isInSnakeGame, setIsInSnakeGame] = useState(false);
    const [snakeRoomId, setSnakeRoomId] = useState("");

    // PARTIDA
    const [isAlive, setIsAlive] = useState(true);
    const [cashedOut, setCashedOut] = useState(false);
    const [finalPayout, setFinalPayout] = useState(0);
    const [score, setScore] = useState(0);
    const [snakeBalance, setSnakeBalance] = useState(0.20);
    const [isConnected, setIsConnected] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState(
        "Conectando con el servidor..."
    );
    const [cashOutProcessing, setCashOutProcessing] = useState(false);
    const [cashOutSeconds, setCashOutSeconds] = useState(0);
    const [isBoosting, setIsBoosting] = useState(false);

    const [modal, setModal] = useState({
        isOpen: false,
        title: "",
        message: "",
    });

    // REFERENCIAS
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const snakeSocketRef = useRef<WebSocket | null>(null);
    const gameStateRef = useRef<any>(null);

    const userIdRef = useRef<string | null>(null);
    const accessTokenRef = useRef("");

    const animationFrameRef = useRef<number | null>(null);

    const connectedRef = useRef(false);
    const aliveRef = useRef(true);
    const readySentRef = useRef(false);
    const closingByUserRef = useRef(false);
    const cashOutSentRef = useRef(false);
    const boostActiveRef = useRef(false);
    const startingRef = useRef(false);

    const showAlert = useCallback((title: string, message: string) => {
        setModal({ isOpen: true, title, message });
    }, []);

    const closeModal = () => {
        setModal({ isOpen: false, title: "", message: "" });
    };

    // URL DEL BACKEND
    const getWebSocketUrl = useCallback((endpoint: string) => {
        const configuredUrl =
            process.env.NEXT_PUBLIC_WS_URL ||
            "wss://casino-axiom.ethiodeploy.app";

        let backendUrl = configuredUrl.trim().replace(/\/+$/, "");

        if (backendUrl.startsWith("https://")) {
            backendUrl = "wss://" + backendUrl.slice(8);
        } else if (backendUrl.startsWith("http://")) {
            backendUrl = "ws://" + backendUrl.slice(7);
        }

        return `${backendUrl}${endpoint}`;
    }, []);

    // ACTUALIZAR SALDOS
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

    // AUTENTICACIÓN
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

    // DETENER ACELERACIÓN
    const stopBoost = useCallback(() => {
        const ws = snakeSocketRef.current;

        if (!boostActiveRef.current) return;

        boostActiveRef.current = false;
        setIsBoosting(false);

        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: "BOOST_STOP" }));
            } catch (error) {
                console.error("Error deteniendo aceleración:", error);
            }
        }
    }, []);

    // MANTENER ACELERACIÓN
    const startBoost = useCallback(() => {
        const ws = snakeSocketRef.current;

        if (
            !connectedRef.current ||
            !aliveRef.current ||
            !ws ||
            ws.readyState !== WebSocket.OPEN ||
            boostActiveRef.current ||
            cashOutSentRef.current
        ) {
            return;
        }

        const state = gameStateRef.current;
        const snake = state?.snakes?.[userIdRef.current || ""];

        if (!snake?.alive || !snake?.ready) return;

        boostActiveRef.current = true;
        setIsBoosting(true);

        try {
            ws.send(JSON.stringify({ type: "BOOST_START" }));
        } catch (error) {
            boostActiveRef.current = false;
            setIsBoosting(false);
            console.error("Error iniciando aceleración:", error);
        }
    }, []);

    const handleBoostPointerDown = (
        e: PointerEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();

        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch { }

        startBoost();
    };

    const handleBoostPointerUp = (
        e: PointerEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        stopBoost();

        try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
        } catch { }
    };

    // DIBUJAR CANVAS
    const renderCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const width = canvas.clientWidth;
        const height = canvas.clientHeight;

        if (!width || !height) return;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#050505";
        ctx.fillRect(0, 0, width, height);

        if (!connectedRef.current) {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#34d399";
            ctx.font = "bold 17px Arial";
            ctx.fillText(
                "CONECTANDO CON AXIOM ARENA...",
                width / 2,
                height / 2 - 15
            );

            ctx.fillStyle = "#a1a1aa";
            ctx.font = "12px Arial";
            ctx.fillText(
                "Esperando respuesta del servidor",
                width / 2,
                height / 2 + 15
            );
            return;
        }

        const state = gameStateRef.current;

        if (!state || !state.snakes) {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#34d399";
            ctx.font = "bold 14px Arial";
            ctx.fillText("ESPERANDO JUGADORES...", width / 2, height / 2);
            return;
        }

        const worldWidth = Number(state.world?.width || WORLD_WIDTH);
        const worldHeight = Number(state.world?.height || WORLD_HEIGHT);

        const ownSnake = state.snakes[userIdRef.current || ""];
        const ownHead = ownSnake?.body?.[0];

        const cameraX =
            typeof ownHead?.x === "number" ? ownHead.x : worldWidth / 2;

        const cameraY =
            typeof ownHead?.y === "number" ? ownHead.y : worldHeight / 2;

        const scale = Math.min(
            1.25,
            Math.max(0.55, Math.min(width, height) / 720)
        );

        const viewWorldWidth = width / scale;
        const viewWorldHeight = height / scale;

        const left = cameraX - viewWorldWidth / 2;
        const top = cameraY - viewWorldHeight / 2;
        const right = left + viewWorldWidth;
        const bottom = top + viewWorldHeight;

        ctx.save();

        ctx.translate(
            width / 2 - cameraX * scale,
            height / 2 - cameraY * scale
        );

        ctx.scale(scale, scale);

        ctx.fillStyle = "#080d0b";
        ctx.fillRect(left, top, viewWorldWidth, viewWorldHeight);

        // CUADRÍCULA
        ctx.strokeStyle = "rgba(52,211,153,0.10)";
        ctx.lineWidth = 1 / scale;

        const gridStartX = Math.max(0, Math.floor(left / 60) * 60);
        const gridEndX = Math.min(worldWidth, right);
        const gridStartY = Math.max(0, Math.floor(top / 60) * 60);
        const gridEndY = Math.min(worldHeight, bottom);

        for (let x = gridStartX; x <= gridEndX; x += 60) {
            ctx.beginPath();
            ctx.moveTo(x, Math.max(0, top));
            ctx.lineTo(x, Math.min(worldHeight, bottom));
            ctx.stroke();
        }

        for (let y = gridStartY; y <= gridEndY; y += 60) {
            ctx.beginPath();
            ctx.moveTo(Math.max(0, left), y);
            ctx.lineTo(Math.min(worldWidth, right), y);
            ctx.stroke();
        }

        // LÍMITES
        ctx.strokeStyle = "#166534";
        ctx.lineWidth = 5 / scale;
        ctx.strokeRect(0, 0, worldWidth, worldHeight);

        // COMIDA
        if (Array.isArray(state.foods)) {
            for (const food of state.foods) {
                if (
                    typeof food?.x !== "number" ||
                    typeof food?.y !== "number"
                ) continue;

                const radius = Number(food.radius || 9);

                if (
                    food.x < left - radius ||
                    food.x > right + radius ||
                    food.y < top - radius ||
                    food.y > bottom + radius
                ) continue;

                const color = food.color || "#ffffff";

                ctx.beginPath();
                ctx.arc(food.x, food.y, radius + 4, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = 12 / scale;
                ctx.fill();

                ctx.shadowBlur = 0;

                ctx.beginPath();
                ctx.arc(
                    food.x,
                    food.y,
                    Math.max(2, radius - 3),
                    0,
                    Math.PI * 2
                );
                ctx.fillStyle = "#ffffff";
                ctx.fill();
            }
        }

        // MONEDAS
        if (Array.isArray(state.coins)) {
            for (const coin of state.coins) {
                if (
                    typeof coin?.x !== "number" ||
                    typeof coin?.y !== "number"
                ) continue;

                if (
                    coin.x < left - 30 ||
                    coin.x > right + 30 ||
                    coin.y < top - 30 ||
                    coin.y > bottom + 30
                ) continue;

                const value = getCoinValue(coin);

                ctx.beginPath();
                ctx.arc(coin.x, coin.y, 15, 0, Math.PI * 2);
                ctx.fillStyle = "#facc15";
                ctx.shadowColor = "#facc15";
                ctx.shadowBlur = 15 / scale;
                ctx.fill();

                ctx.shadowBlur = 0;

                ctx.beginPath();
                ctx.arc(coin.x, coin.y, 10, 0, Math.PI * 2);
                ctx.fillStyle = "#fef3c7";
                ctx.fill();

                ctx.fillStyle = "#713f12";
                ctx.font = "bold 11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("$", coin.x, coin.y);

                ctx.fillStyle = "#fde68a";
                ctx.font = "bold 11px Arial";
                ctx.fillText(money(value), coin.x, coin.y - 23);
            }
        }

        // SERPIENTES
        Object.entries(state.snakes).forEach(([uid, value]: [string, any]) => {
            if (
                !value?.alive ||
                !Array.isArray(value.body) ||
                value.body.length === 0
            ) return;

            const color =
                value.color ||
                (uid === userIdRef.current ? "#34d399" : "#f43f5e");

            value.body.forEach((segment: any, index: number) => {
                if (
                    typeof segment?.x !== "number" ||
                    typeof segment?.y !== "number"
                ) return;

                if (
                    segment.x < left - 40 ||
                    segment.x > right + 40 ||
                    segment.y < top - 40 ||
                    segment.y > bottom + 40
                ) return;

                // Utiliza el radio enviado por el backend.
                // Si el backend todavía no lo envía, conserva el tamaño anterior.
                const defaultRadius = index === 0 ? 12 : 8;
                const radius = Math.max(
                    3,
                    Number(
                        segment.radius ??
                        value.radius ??
                        defaultRadius
                    )
                );

                const isOwnSnake = uid === userIdRef.current;
                const pattern = isOwnSnake
                    ? snakePatternRef.current
                    : value.pattern || "solid";

                ctx.beginPath();
                ctx.arc(segment.x, segment.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.shadowColor = color;
                ctx.shadowBlur = (index === 0 ? 14 : 5) / scale;
                ctx.fill();

                ctx.shadowBlur = 0;

                if (pattern === "stripes" && index % 2 === 0) {
                    ctx.beginPath();
                    ctx.arc(
                        segment.x,
                        segment.y,
                        radius * 0.58,
                        0,
                        Math.PI * 2
                    );
                    ctx.fillStyle = "rgba(255,255,255,0.72)";
                    ctx.fill();
                } else if (pattern === "spots" && index % 2 === 0) {
                    ctx.beginPath();
                    ctx.arc(
                        segment.x,
                        segment.y,
                        Math.max(2, radius * 0.28),
                        0,
                        Math.PI * 2
                    );
                    ctx.fillStyle = "rgba(8,8,8,0.65)";
                    ctx.fill();
                } else if (pattern === "neon") {
                    ctx.beginPath();
                    ctx.arc(
                        segment.x,
                        segment.y,
                        radius * 0.7,
                        0,
                        Math.PI * 2
                    );
                    ctx.strokeStyle = "rgba(255,255,255,0.85)";
                    ctx.lineWidth = 1.5 / scale;
                    ctx.stroke();
                }

                if (index > 0) {
                    ctx.beginPath();
                    ctx.arc(
                        segment.x - 2,
                        segment.y - 2,
                        Math.max(1.5, radius * 0.2),
                        0,
                        Math.PI * 2
                    );
                    ctx.fillStyle = "rgba(255,255,255,0.35)";
                    ctx.fill();
                }
            });

            const head = value.body[0];

            if (head) {
                ctx.save();
                ctx.translate(head.x, head.y);
                ctx.rotate(Number(value.angle || 0));

                const isOwnSnake = uid === userIdRef.current;
                const eyes = isOwnSnake
                    ? snakeEyesRef.current
                    : value.eyes || "classic";
                const accessory = isOwnSnake
                    ? snakeAccessoryRef.current
                    : value.accessory || "none";

                const headRadius = Math.max(
                    8,
                    Number(head.radius ?? value.radius ?? 12)
                );

                if (eyes === "sleepy") {
                    ctx.strokeStyle = "#111827";
                    ctx.lineWidth = 2.5 / scale;
                    ctx.beginPath();
                    ctx.moveTo(2, -5);
                    ctx.lineTo(8, -5);
                    ctx.moveTo(2, 5);
                    ctx.lineTo(8, 5);
                    ctx.stroke();
                } else {
                    ctx.fillStyle = eyes === "laser" ? "#ff334f" : "#ffffff";
                    ctx.beginPath();
                    ctx.arc(headRadius * 0.4, -headRadius * 0.4, 2.5, 0, Math.PI * 2);
                    ctx.arc(headRadius * 0.4, headRadius * 0.4, 2.5, 0, Math.PI * 2);
                    ctx.fill();
                }

                if (accessory === "crown") {
                    ctx.fillStyle = "#facc15";
                    ctx.beginPath();
                    ctx.moveTo(-8, -8);
                    ctx.lineTo(-5, -17);
                    ctx.lineTo(0, -10);
                    ctx.lineTo(5, -17);
                    ctx.lineTo(9, -8);
                    ctx.closePath();
                    ctx.fill();
                } else if (accessory === "bandana") {
                    ctx.fillStyle = "#f43f5e";
                    ctx.fillRect(-9, -3, 8, 6);
                } else if (accessory === "halo") {
                    ctx.strokeStyle = "#fde68a";
                    ctx.lineWidth = 2 / scale;
                    ctx.beginPath();
                    ctx.ellipse(0, -15, 10, 3.5, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }

                ctx.restore();

                const balance = Number(
                    value.balance ??
                    (
                        typeof value.balance_micros === "number"
                            ? value.balance_micros / 1000000
                            : selectedBetRef.current
                    )
                );

                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 13px Arial";
                ctx.shadowColor = "#000000";
                ctx.shadowBlur = 5 / scale;
                ctx.fillText(money(balance), head.x, head.y - headRadius - 15);
                ctx.shadowBlur = 0;
            }
        });

        ctx.restore();

        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px Arial";
        ctx.fillText(
            `PUNTOS: ${Number(ownSnake?.score || 0)}`,
            20,
            height - 20
        );

        ctx.textAlign = "right";
        ctx.fillStyle = "#34d399";
        ctx.fillText(
            `JUGADORES: ${Object.values(state.snakes).filter(
                (snake: any) => snake?.alive
            ).length
            }`,
            width - 20,
            height - 20
        );
    }, []);

    // ANIMACIÓN
    useEffect(() => {
        if (!isInSnakeGame) return;

        let running = true;

        const loop = () => {
            if (!running) return;
            renderCanvas();
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
    }, [isInSnakeGame, renderCanvas]);

    // TAMAÑO DEL CANVAS
    useEffect(() => {
        if (!isInSnakeGame) return;

        const resizeCanvas = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const rect = canvas.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);

            const width = Math.max(1, Math.floor(rect.width * dpr));
            const height = Math.max(1, Math.floor(rect.height * dpr));

            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }

            const ctx = canvas.getContext("2d");

            if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        resizeCanvas();

        const observer = new ResizeObserver(resizeCanvas);

        if (canvasRef.current) observer.observe(canvasRef.current);

        window.addEventListener("resize", resizeCanvas);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", resizeCanvas);
        };
    }, [isInSnakeGame]);

    // CERRAR PARTIDA
    const exitSnakeGame = useCallback(() => {
        stopBoost();

        closingByUserRef.current = true;
        startingRef.current = false;

        connectedRef.current = false;
        aliveRef.current = false;
        readySentRef.current = false;
        cashOutSentRef.current = false;

        setCashOutProcessing(false);
        setCashOutSeconds(0);
        setIsConnected(false);
        setIsInSnakeGame(false);
        setIsAlive(false);

        gameStateRef.current = null;

        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }

        const ws = snakeSocketRef.current;
        snakeSocketRef.current = null;

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
    }, [loadUserBalances, stopBoost]);

    // INICIAR PARTIDA
    const startSnakeGame = () => {
        if (startingRef.current || snakeSocketRef.current) {
            showAlert(
                "Partida activa",
                "Ya existe una conexión de juego activa."
            );
            return;
        }

        const betConfig = SNAKE_BETS[selectedBet];
        const parsedBet = betConfig.amount;
        const generatedRoomId = betConfig.room;

        if (!userIdRef.current || !accessTokenRef.current) {
            showAlert(
                "Error de sesión",
                "No se detectó una sesión válida. Vuelve a iniciar sesión."
            );
            return;
        }

        const available =
            selectedWallet === "play" ? playBalance : bonusBalance;

        if (available < parsedBet) {
            showAlert(
                "Saldo insuficiente",
                `Necesitas al menos ${money(parsedBet)} en la billetera seleccionada.`
            );
            return;
        }

        startingRef.current = true;
        selectedBetRef.current = parsedBet;

        setSnakeRoomId(generatedRoomId);
        setIsInSnakeGame(true);
        setIsAlive(true);
        aliveRef.current = true;

        setCashedOut(false);
        setFinalPayout(0);
        setScore(0);
        setSnakeBalance(parsedBet);

        setCashOutProcessing(false);
        setCashOutSeconds(0);
        setIsConnected(false);
        connectedRef.current = false;

        setConnectionMessage("Conectando con el servidor...");

        gameStateRef.current = null;
        readySentRef.current = false;
        cashOutSentRef.current = false;
        closingByUserRef.current = false;

        boostActiveRef.current = false;
        setIsBoosting(false);

        const wsUrl = getWebSocketUrl(
            `/ws/snake/${encodeURIComponent(generatedRoomId)}` +
            `?user_id=${encodeURIComponent(userIdRef.current)}` +
            `&access_token=${encodeURIComponent(accessTokenRef.current)}` +
            `&bet=${encodeURIComponent(String(parsedBet))}` +
            `&wallet=${encodeURIComponent(selectedWallet)}` +
            `&color=${encodeURIComponent(customColor)}` +
            `&pattern=${encodeURIComponent(snakePattern)}` +
            `&eyes=${encodeURIComponent(snakeEyes)}` +
            `&accessory=${encodeURIComponent(snakeAccessory)}`
        );

        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

        try {
            const ws = new WebSocket(wsUrl);
            snakeSocketRef.current = ws;

            ws.onopen = () => {
                if (snakeSocketRef.current !== ws) return;

                console.log("Snake WebSocket conectado.");

                if (heartbeatTimer) clearInterval(heartbeatTimer);

                heartbeatTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: "PING" }));
                        } catch (heartbeatError) {
                            console.error(
                                "Error enviando heartbeat Snake:",
                                heartbeatError
                            );
                        }
                    }
                }, 20000);

                setConnectionMessage(
                    "Conectado. Esperando estado de la partida..."
                );
            };

            ws.onmessage = (event) => {
                if (snakeSocketRef.current !== ws) return;

                try {
                    const data = JSON.parse(event.data);

                    console.log("Snake servidor:", data);

                    if (data.type === "GAME_STATE") {
                        if (
                            !data.snakes ||
                            typeof data.snakes !== "object"
                        ) {
                            console.error("GAME_STATE sin serpientes:", data);
                            return;
                        }

                        gameStateRef.current = data;

                        if (data.room_id) {
                            setSnakeRoomId(String(data.room_id));
                        }

                        if (!connectedRef.current) {
                            connectedRef.current = true;
                            setIsConnected(true);
                            setConnectionMessage("Partida conectada.");
                        }

                        if (
                            !readySentRef.current &&
                            ws.readyState === WebSocket.OPEN
                        ) {
                            readySentRef.current = true;
                            ws.send(JSON.stringify({ type: "READY" }));
                        }

                        const currentSnake =
                            data.snakes[userIdRef.current || ""];

                        if (currentSnake) {
                            const alive = Boolean(currentSnake.alive);

                            aliveRef.current = alive;

                            if (!(cashOutSentRef.current && !alive)) {
                                setIsAlive(alive);
                            }

                            if (!alive) {
                                stopBoost();

                                // Si murió durante la cuenta regresiva,
                                // el retiro queda cancelado.
                                if (!currentSnake.cashed_out) {
                                    setCashOutProcessing(false);
                                    setCashOutSeconds(0);
                                    cashOutSentRef.current = false;
                                }
                            }

                            setScore(Number(currentSnake.score || 0));

                            const currentBalance = Number(
                                currentSnake.balance ??
                                (
                                    typeof currentSnake.balance_micros === "number"
                                        ? currentSnake.balance_micros / 1000000
                                        : selectedBetRef.current
                                )
                            );

                            setSnakeBalance(currentBalance);

                            // Cuenta regresiva oficial enviada por el backend.
                            if (currentSnake.cashout_pending) {
                                setCashOutProcessing(true);
                                setCashOutSeconds(
                                    Math.max(
                                        0,
                                        Math.ceil(
                                            Number(currentSnake.cashout_seconds ?? 0)
                                        )
                                    )
                                );
                            } else if (
                                cashOutSentRef.current &&
                                currentSnake.alive
                            ) {
                                // El servidor ya no informa un retiro pendiente.
                                // El evento CASHOUT_CANCELLED también lo limpia.
                                if (
                                    Number(currentSnake.cashout_seconds ?? 0) <= 0 &&
                                    !currentSnake.cashout_pending
                                ) {
                                    setCashOutSeconds(0);
                                }
                            }
                        }

                        return;
                    }

                    // EL SERVIDOR INICIÓ EL RETIRO DE 20 SEGUNDOS
                    if (data.type === "CASHOUT_PENDING") {
                        cashOutSentRef.current = true;
                        setCashOutProcessing(true);
                        setCashOutSeconds(
                            Math.max(0, Number(data.seconds ?? 20))
                        );
                        stopBoost();
                        return;
                    }

                    // EL RETIRO SE CANCELÓ, POR EJEMPLO, POR MUERTE
                    if (data.type === "CASHOUT_CANCELLED") {
                        cashOutSentRef.current = false;
                        setCashOutProcessing(false);
                        setCashOutSeconds(0);

                        if (data.message) {
                            setConnectionMessage(String(data.message));
                        }

                        return;
                    }

                    if (
                        data.type === "CASHOUT_SUCCESS" ||
                        data.type === "CASH_OUT_SUCCESS"
                    ) {
                        stopBoost();

                        const payout = Number(
                            data.payout ?? data.amount ?? 0
                        );

                        setCashedOut(true);
                        setFinalPayout(payout);

                        aliveRef.current = false;
                        setIsAlive(false);

                        cashOutSentRef.current = false;
                        setCashOutProcessing(false);
                        setCashOutSeconds(0);

                        void loadUserBalances();

                        return;
                    }

                    if (data.type === "ERROR") {
                        console.error(
                            "Error del servidor:",
                            data.message
                        );

                        stopBoost();

                        cashOutSentRef.current = false;
                        setCashOutProcessing(false);
                        setCashOutSeconds(0);
                        startingRef.current = false;

                        showAlert(
                            "Error del servidor",
                            data.message || "No se pudo iniciar la partida."
                        );

                        exitSnakeGame();
                        return;
                    }
                } catch (error) {
                    console.error(
                        "Error procesando mensaje WebSocket:",
                        error
                    );
                }
            };

            ws.onerror = (error) => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }

                console.error("Error WebSocket Snake:", error);

                if (snakeSocketRef.current === ws) {
                    setConnectionMessage(
                        "Error de conexión con el servidor."
                    );
                }
            };

            ws.onclose = (event) => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }

                console.log(
                    "Snake WebSocket cerrado:",
                    event.code,
                    event.reason
                );

                if (snakeSocketRef.current !== ws) return;

                startingRef.current = false;
                boostActiveRef.current = false;
                setIsBoosting(false);

                snakeSocketRef.current = null;

                connectedRef.current = false;
                setIsConnected(false);

                readySentRef.current = false;

                setCashOutProcessing(false);
                setCashOutSeconds(0);

                if (!closingByUserRef.current) {
                    setIsInSnakeGame(false);

                    if (event.code !== 1000) {
                        showAlert(
                            "Conexión perdida",
                            event.reason ||
                            `El servidor cerró la conexión (código ${event.code}).`
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

            console.error("No se pudo crear WebSocket:", error);

            startingRef.current = false;
            snakeSocketRef.current = null;

            setIsInSnakeGame(false);

            showAlert(
                "Error de conexión",
                "No se pudo establecer una conexión con AXIOM Arena."
            );
        }
    };

    // MOVIMIENTO CON MOUSE O TÁCTIL
    const handlePointerMove = (
        e: PointerEvent<HTMLCanvasElement>
    ) => {
        if (!connectedRef.current || !aliveRef.current) return;

        const canvas = canvasRef.current;
        const ws = snakeSocketRef.current;
        const state = gameStateRef.current;
        const uid = userIdRef.current;

        if (
            !canvas ||
            !ws ||
            ws.readyState !== WebSocket.OPEN ||
            !state ||
            !uid
        ) return;

        const snake = state.snakes?.[uid];

        if (
            !snake?.alive ||
            !Array.isArray(snake.body) ||
            !snake.body.length
        ) return;

        const head = snake.body[0];

        if (
            typeof head?.x !== "number" ||
            typeof head?.y !== "number"
        ) return;

        const rect = canvas.getBoundingClientRect();

        const pointerX = e.clientX - rect.left;
        const pointerY = e.clientY - rect.top;

        const scale = Math.min(
            1.25,
            Math.max(0.55, Math.min(rect.width, rect.height) / 720)
        );

        const worldX =
            head.x + (pointerX - rect.width / 2) / scale;

        const worldY =
            head.y + (pointerY - rect.height / 2) / scale;

        const angle = Math.atan2(
            worldY - head.y,
            worldX - head.x
        );

        if (!Number.isFinite(angle)) return;

        try {
            ws.send(JSON.stringify({ type: "STEER", angle }));
        } catch (error) {
            console.error("Error enviando dirección:", error);
        }
    };

    // RETIRARSE
    const triggerCashOut = () => {
        const ws = snakeSocketRef.current;

        if (
            !connectedRef.current ||
            !aliveRef.current ||
            !ws ||
            ws.readyState !== WebSocket.OPEN ||
            cashOutSentRef.current
        ) return;

        stopBoost();

        cashOutSentRef.current = true;
        setCashOutProcessing(true);
        setCashOutSeconds(20);

        try {
            ws.send(JSON.stringify({ type: "CASH_OUT" }));
        } catch (error) {
            cashOutSentRef.current = false;
            setCashOutProcessing(false);
            setCashOutSeconds(0);
            console.error("Error enviando retiro:", error);

            showAlert(
                "Error de retiro",
                "No se pudo enviar la solicitud al servidor."
            );
        }
    };

    // VALOR DE MONEDA DE ACELERACIÓN PARA LA SALA SELECCIONADA
    const boostCoinValue = BOOST_COIN_VALUES[selectedBet];

    // CARGA
    if (isAuthLoading) {
        return (
            <div className="min-h-screen bg-black text-white flex flex-col">
                <Header />
                <main className="flex-1 flex items-center justify-center">
                    <p className="text-xs uppercase tracking-widest text-emerald-400 font-bold animate-pulse">
                        Cargando AXIOM Arena...
                    </p>
                </main>
            </div>
        );
    }

    // SIN SESIÓN
    if (!userId) {
        return (
            <div className="min-h-screen bg-black text-white flex flex-col">
                <Header />

                <main className="flex-1 flex items-center justify-center p-4">
                    <div className="max-w-md w-full bg-zinc-950 border border-zinc-800 rounded-3xl p-8 text-center space-y-6">
                        <h2 className="text-xl font-black uppercase">
                            Acceso restringido
                        </h2>

                        <p className="text-xs text-zinc-400">
                            Debes iniciar sesión para ingresar a las arenas.
                        </p>

                        <Link
                            href="/"
                            className="block w-full py-3 bg-emerald-500 text-black font-black text-xs uppercase rounded-xl"
                        >
                            Iniciar sesión
                        </Link>
                    </div>
                </main>
            </div>
        );
    }

    // INTERFAZ
    return (
        <div className="min-h-screen bg-black text-white flex flex-col select-none font-sans overflow-x-hidden">

            {/* MODAL */}
            {modal.isOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
                    <div className="bg-zinc-950 border border-zinc-800 w-full max-w-sm rounded-2xl p-6 text-center space-y-4">
                        <h3 className="text-lg font-black uppercase text-emerald-400">
                            {modal.title}
                        </h3>

                        <p className="text-xs text-zinc-300 leading-relaxed">
                            {modal.message}
                        </p>

                        <button
                            onClick={closeModal}
                            className="w-full py-2.5 bg-emerald-500 text-black font-black text-xs uppercase rounded-xl"
                        >
                            Entendido
                        </button>
                    </div>
                </div>
            )}

            <Header />

            {/* CONTENIDO */}
            <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 flex flex-col items-center justify-center">
                {!isInSnakeGame ? (
                    <div className="max-w-md w-full bg-zinc-950 border border-zinc-800 rounded-3xl p-8 space-y-6 shadow-2xl">
                        <div className="border-b border-zinc-900 pb-3">
                            <Link
                                href="/"
                                className="text-xs text-zinc-400 hover:text-emerald-400 font-bold uppercase"
                            >
                                ← Volver al menú principal
                            </Link>
                        </div>

                        <div className="text-center">
                            <h2 className="text-2xl font-black text-emerald-400 uppercase tracking-wider">
                                Snake Arena P2P
                            </h2>

                            <p className="text-xs text-zinc-400 mt-1">
                                Personaliza tu serpiente y entra a la arena.
                            </p>
                        </div>

                        {/* PERSONALIZACIÓN */}
                        <div>
                            <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                Apariencia de tu serpiente
                            </label>

                            <div className="flex items-center gap-3 bg-black border border-zinc-800 p-3 rounded-xl">
                                <input
                                    type="color"
                                    value={customColor}
                                    onChange={(e) => setCustomColor(e.target.value)}
                                    className="w-10 h-10 rounded-lg bg-transparent cursor-pointer"
                                />

                                <div>
                                    <span className="text-xs font-mono text-emerald-400 font-bold block">
                                        {customColor}
                                    </span>
                                    <span className="text-[9px] text-zinc-500">
                                        Elige el color de tu serpiente
                                    </span>
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2 mt-3">
                                <div>
                                    <label className="text-[9px] text-zinc-500 block mb-1 uppercase font-bold">
                                        Piel
                                    </label>
                                    <select
                                        value={snakePattern}
                                        onChange={(e) => {
                                            snakePatternRef.current = e.target.value;
                                            setSnakePattern(e.target.value);
                                        }}
                                        className="w-full bg-black border border-zinc-800 rounded-lg p-2 text-[10px] text-zinc-200"
                                    >
                                        <option value="solid">Lisa</option>
                                        <option value="stripes">Rayas</option>
                                        <option value="spots">Manchas</option>
                                        <option value="neon">Neón</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="text-[9px] text-zinc-500 block mb-1 uppercase font-bold">
                                        Ojos
                                    </label>
                                    <select
                                        value={snakeEyes}
                                        onChange={(e) => {
                                            snakeEyesRef.current = e.target.value;
                                            setSnakeEyes(e.target.value);
                                        }}
                                        className="w-full bg-black border border-zinc-800 rounded-lg p-2 text-[10px] text-zinc-200"
                                    >
                                        <option value="classic">Clásicos</option>
                                        <option value="laser">Láser</option>
                                        <option value="sleepy">Dormidos</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="text-[9px] text-zinc-500 block mb-1 uppercase font-bold">
                                        Accesorio
                                    </label>
                                    <select
                                        value={snakeAccessory}
                                        onChange={(e) => {
                                            snakeAccessoryRef.current = e.target.value;
                                            setSnakeAccessory(e.target.value);
                                        }}
                                        className="w-full bg-black border border-zinc-800 rounded-lg p-2 text-[10px] text-zinc-200"
                                    >
                                        <option value="none">Ninguno</option>
                                        <option value="crown">Corona</option>
                                        <option value="bandana">Bandana</option>
                                        <option value="halo">Aureola</option>
                                    </select>
                                </div>
                            </div>

                            {/* VISTA PREVIA EN VIVO */}
                            <SnakePreview
                                color={customColor}
                                pattern={snakePattern}
                                eyes={snakeEyes}
                                accessory={snakeAccessory}
                            />
                        </div>

                        {/* BILLETERA */}
                        <div>
                            <label className="text-[10px] text-zinc-400 block mb-1 uppercase font-bold">
                                Billetera de origen
                            </label>

                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    onClick={() => setSelectedWallet("play")}
                                    className={`py-3 rounded-xl text-xs font-black uppercase border ${selectedWallet === "play"
                                            ? "bg-emerald-500 text-black border-emerald-400"
                                            : "bg-black text-zinc-400 border-zinc-800"
                                        }`}
                                >
                                    Jugar (${playBalance.toFixed(2)})
                                </button>

                                <button
                                    onClick={() => setSelectedWallet("bonus")}
                                    className={`py-3 rounded-xl text-xs font-black uppercase border ${selectedWallet === "bonus"
                                            ? "bg-yellow-400 text-black border-yellow-300"
                                            : "bg-black text-zinc-400 border-zinc-800"
                                        }`}
                                >
                                    Bono (${bonusBalance.toFixed(2)})
                                </button>
                            </div>
                        </div>

                        {/* APUESTA */}
                        <div>
                            <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                Selecciona tu apuesta
                            </label>

                            <div className="grid grid-cols-3 gap-2">
                                {(["0.20", "10", "50"] as SnakeBet[]).map((bet) => (
                                    <button
                                        key={bet}
                                        type="button"
                                        onClick={() => setSelectedBet(bet)}
                                        className={`py-3 rounded-xl text-sm font-black border transition-all ${selectedBet === bet
                                                ? "bg-emerald-500 text-black border-emerald-400"
                                                : "bg-black text-zinc-400 border-zinc-800 hover:border-emerald-500"
                                            }`}
                                    >
                                        ${Number(bet).toFixed(2)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* INICIAR */}
                        <button
                            onClick={startSnakeGame}
                            disabled={startingRef.current}
                            className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs uppercase rounded-xl shadow-lg active:scale-95 transition-all"
                        >
                            Entrar a la Arena
                        </button>

                        <p className="text-[9px] text-zinc-500 text-center -mt-4">
                            Apuestas: $0.20 · $10.00 · $50.00 · Comisión de retiro: 6%
                        </p>

                        <p className="text-[10px] text-zinc-500 text-center">
                            Categoría de sala: {SNAKE_BETS[selectedBet].room}
                        </p>

                        <p className="text-[9px] text-zinc-500 text-center">
                            Moneda al acelerar: {money(BOOST_COIN_VALUES[selectedBet])} cada segundo.
                        </p>
                    </div>
                ) : (
                    <div className="fixed inset-x-0 top-[70px] bottom-0 z-20 bg-black overflow-hidden">

                        {/* BARRA SUPERIOR */}
                        <div className="absolute top-4 left-4 right-4 z-30 flex justify-between items-center bg-zinc-950/90 backdrop-blur-md p-3 rounded-2xl border border-zinc-800">
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={exitSnakeGame}
                                    className="px-3.5 py-2 bg-zinc-900 text-zinc-300 hover:text-red-400 text-xs font-bold uppercase rounded-xl border border-zinc-800"
                                >
                                    ← Salir
                                </button>

                                <div>
                                    <span className="block text-xs font-black text-emerald-400 uppercase">
                                        Snake Arena
                                    </span>
                                    <span className="block text-[10px] text-zinc-400">
                                        Sala: {snakeRoomId}
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="text-right">
                                    <span className="block text-[9px] text-zinc-500 uppercase">
                                        Tu saldo
                                    </span>
                                    <span className="text-sm font-black text-emerald-400">
                                        {money(snakeBalance)}
                                    </span>
                                </div>

                                <span
                                    className={`hidden sm:inline text-[10px] font-bold uppercase ${isConnected
                                            ? "text-emerald-400"
                                            : "text-yellow-400"
                                        }`}
                                >
                                    {isConnected ? "Conectado" : "Conectando"}
                                </span>

                                {isConnected && isAlive && !cashedOut && (
                                    <button
                                        onClick={triggerCashOut}
                                        disabled={cashOutProcessing}
                                        className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 disabled:opacity-50 text-black font-black text-[10px] uppercase rounded-xl"
                                    >
                                        {cashOutProcessing
                                            ? `Retiro: ${cashOutSeconds}s`
                                            : "Retirarse"}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* CANVAS */}
                        <canvas
                            ref={canvasRef}
                            onPointerMove={handlePointerMove}
                            className="absolute inset-0 w-full h-full block cursor-crosshair touch-none"
                        />

                        {/* MENSAJE DE CUENTA REGRESIVA */}
                        {cashOutProcessing && isAlive && (
                            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-30 bg-yellow-400 text-black px-5 py-3 rounded-xl text-center shadow-xl">
                                <span className="block text-[10px] font-black uppercase">
                                    Retiro en proceso
                                </span>
                                <span className="block text-2xl font-black">
                                    {cashOutSeconds}s
                                </span>
                                <span className="block text-[9px] font-bold">
                                    ¡Mantente vivo hasta que termine!
                                </span>
                            </div>
                        )}

                        {/* ACELERAR */}
                        {isConnected && isAlive && !cashedOut && (
                            <button
                                type="button"
                                onPointerDown={handleBoostPointerDown}
                                onPointerUp={handleBoostPointerUp}
                                onPointerCancel={stopBoost}
                                onLostPointerCapture={stopBoost}
                                onContextMenu={(e) => e.preventDefault()}
                                className={`absolute bottom-8 right-6 z-30 w-28 h-28 rounded-full border-4 font-black text-xs uppercase shadow-2xl select-none touch-none transition-all active:scale-95 ${isBoosting
                                        ? "bg-yellow-300 border-yellow-100 text-black scale-105 shadow-yellow-400/40"
                                        : "bg-yellow-500/90 border-yellow-300 text-black hover:bg-yellow-400"
                                    }`}
                                style={{ touchAction: "none" }}
                            >
                                <span className="block text-2xl mb-1">
                                    ⚡
                                </span>

                                {isBoosting ? "Acelerando" : "Acelerar"}

                                <span className="block text-[9px] mt-1 opacity-70">
                                    {money(boostCoinValue)} / segundo
                                </span>
                            </button>
                        )}

                        {/* CONEXIÓN */}
                        {!isConnected && (
                            <div className="absolute bottom-5 left-0 right-0 text-center z-30 pointer-events-none">
                                <span className="text-[10px] text-yellow-400 bg-black/70 px-4 py-2 rounded-full">
                                    {connectionMessage}
                                </span>
                            </div>
                        )}

                        {/* GAME OVER */}
                        {(!isAlive || cashedOut) && (
                            <div className="absolute inset-0 bg-black/90 backdrop-blur-md z-40 flex flex-col items-center justify-center p-6 text-center space-y-4">
                                <h3 className="text-3xl font-black uppercase text-emerald-400">
                                    {cashedOut
                                        ? "¡Retiro exitoso!"
                                        : "GAME OVER"}
                                </h3>

                                <p className="text-xs text-zinc-300">
                                    {cashedOut
                                        ? `Has acreditado ${money(finalPayout)} a tu saldo para retirar.`
                                        : "Tu serpiente ha muerto."}
                                </p>

                                <p className="text-sm text-zinc-400">
                                    Saldo final: {money(snakeBalance)}
                                </p>

                                <p className="text-sm text-zinc-400">
                                    Puntuación: {score}
                                </p>

                                <button
                                    onClick={exitSnakeGame}
                                    className="px-8 py-3 bg-emerald-500 text-black font-black text-xs uppercase rounded-xl"
                                >
                                    Volver a la arena
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {/* FOOTER */}
            {!isInSnakeGame && (
                <footer className="py-6 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
                    AXIOM SNAKE IO ARENA
                </footer>
            )}
        </div>
    );
}