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
type BodyStyle = "connected" | "scales" | "pulse" | "trail";
type EyeStyle = "classic" | "laser" | "sleepy" | "angry";
type AccessoryStyle = "none" | "crown" | "bandana" | "halo";

interface SkinPreset {
    id: string;
    name: string;
    primary: string;
    secondary: string;
    glow: string;
    bodyStyle: BodyStyle;
    eyes: EyeStyle;
    accessory: AccessoryStyle;
}

const SKIN_PRESETS: SkinPreset[] = [
    {
        id: "emerald",
        name: "Esmeralda",
        primary: "#10b981",
        secondary: "#047857",
        glow: "#34d399",
        bodyStyle: "connected",
        eyes: "classic",
        accessory: "none",
    },
    {
        id: "cyber",
        name: "Ciber Neón",
        primary: "#06b6d4",
        secondary: "#4f46e5",
        glow: "#22d3ee",
        bodyStyle: "pulse",
        eyes: "laser",
        accessory: "bandana",
    },
    {
        id: "magma",
        name: "Magma",
        primary: "#f97316",
        secondary: "#b91c1c",
        glow: "#fb923c",
        bodyStyle: "scales",
        eyes: "angry",
        accessory: "none",
    },
    {
        id: "royal",
        name: "Dorado Real",
        primary: "#eab308",
        secondary: "#a16207",
        glow: "#facc15",
        bodyStyle: "trail",
        eyes: "classic",
        accessory: "crown",
    },
    {
        id: "phantom",
        name: "Fantasma",
        primary: "#a855f7",
        secondary: "#581c87",
        glow: "#c084fc",
        bodyStyle: "trail",
        eyes: "sleepy",
        accessory: "halo",
    },
];

const WORLD_WIDTH = 20000;
const WORLD_HEIGHT = 20000;
const MIN_BOOST_SEGMENTS = 6;

const SNAKE_BETS: Record<SnakeBet, { amount: number; room: string }> = {
    "0.20": { amount: 0.2, room: "snake_020" },
    "10": { amount: 10, room: "snake_1000" },
    "50": { amount: 50, room: "snake_5000" },
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

function drawSnakeVisual(
    ctx: CanvasRenderingContext2D,
    options: {
        body: { x: number; y: number; radius?: number }[];
        angle: number;
        primaryColor: string;
        secondaryColor: string;
        glowColor: string;
        bodyStyle: BodyStyle;
        eyes: EyeStyle;
        accessory: AccessoryStyle;
        baseHeadRadius?: number;
        baseBodyRadius?: number;
        scale?: number;
        time?: number;
        isBoosting?: boolean;
    }
) {
    const {
        body,
        angle,
        primaryColor,
        secondaryColor,
        glowColor,
        bodyStyle,
        eyes,
        accessory,
        baseHeadRadius = 12,
        baseBodyRadius = 9,
        scale = 1,
        time = 0,
        isBoosting = false,
    } = options;

    if (!Array.isArray(body) || body.length === 0) return;

    // Al acelerar se contrae visualmente el grosor y el largo de la cola
    const shrinkRatio = isBoosting ? 0.84 : 1;
    const renderBody =
        isBoosting && body.length > MIN_BOOST_SEGMENTS
            ? body.slice(0, Math.max(MIN_BOOST_SEGMENTS, Math.floor(body.length * 0.88)))
            : body;

    const effectiveBodyRadius = baseBodyRadius * shrinkRatio;
    const effectiveHeadRadius = baseHeadRadius * (isBoosting ? 0.92 : 1);

    if (bodyStyle === "trail" && renderBody.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(renderBody[0].x, renderBody[0].y);
        for (let i = 1; i < renderBody.length; i++) {
            ctx.lineTo(renderBody[i].x, renderBody[i].y);
        }
        ctx.strokeStyle = glowColor;
        ctx.globalAlpha = isBoosting ? 0.35 : 0.22;
        ctx.lineWidth = Math.max(7, effectiveBodyRadius * 1.7);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
    }

    if (bodyStyle === "connected" && renderBody.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(renderBody[0].x, renderBody[0].y);
        for (let i = 1; i < renderBody.length; i++) {
            ctx.lineTo(renderBody[i].x, renderBody[i].y);
        }
        ctx.strokeStyle = secondaryColor;
        ctx.lineWidth = Math.max(8, effectiveBodyRadius * 1.85);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
    }

    for (let i = renderBody.length - 1; i >= 1; i--) {
        const seg = renderBody[i];
        const ratio = i / Math.max(renderBody.length, 1);
        const taper = Math.max(0.42, 1 - ratio * 0.48);
        const radius = Math.max(
            4,
            Number(seg.radius ?? baseBodyRadius) * shrinkRatio * taper
        );
        const fill = i % 2 === 0 ? primaryColor : secondaryColor;

        ctx.save();
        ctx.beginPath();
        ctx.arc(seg.x, seg.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = (isBoosting ? 14 : bodyStyle === "pulse" ? 11 : 4) / scale;
        ctx.fill();
        ctx.shadowBlur = 0;

        if (bodyStyle === "scales") {
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1.3 / scale;
            ctx.beginPath();
            ctx.arc(seg.x, seg.y, radius * 0.72, -Math.PI * 0.65, Math.PI * 0.65);
            ctx.stroke();
        } else if (bodyStyle === "pulse" && i % 2 === 0) {
            ctx.strokeStyle = "rgba(255,255,255,0.75)";
            ctx.lineWidth = 1.4 / scale;
            ctx.beginPath();
            ctx.arc(seg.x, seg.y, radius * 0.52, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(
            seg.x - radius * 0.25,
            seg.y - radius * 0.25,
            Math.max(1.5, radius * 0.2),
            0,
            Math.PI * 2
        );
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.fill();
        ctx.restore();
    }

    const head = renderBody[0];
    const headRadius = Math.max(
        9,
        Number(head.radius ?? baseHeadRadius) * (isBoosting ? 0.92 : 1)
    );

    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(angle);

    const tongueFlick = Math.sin(time * 0.014);
    if (tongueFlick > 0.25) {
        const tongueLen = headRadius * (0.55 + tongueFlick * 0.25);
        ctx.save();
        ctx.strokeStyle = "#fb7185";
        ctx.lineWidth = Math.max(1.6, headRadius * 0.13) / scale;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(headRadius * 0.85, 0);
        ctx.lineTo(headRadius * 0.85 + tongueLen, 0);
        ctx.lineTo(headRadius * 0.85 + tongueLen + 4, -3.5);
        ctx.moveTo(headRadius * 0.85 + tongueLen, 0);
        ctx.lineTo(headRadius * 0.85 + tongueLen + 4, 3.5);
        ctx.stroke();
        ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(
        headRadius * 0.08,
        0,
        headRadius * 1.16,
        headRadius * 0.98,
        0,
        0,
        Math.PI * 2
    );
    ctx.fillStyle = primaryColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = (isBoosting ? 18 : 14) / scale;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1.4 / scale;
    ctx.stroke();

    const eyeOffsetX = headRadius * 0.34;
    const eyeOffsetY = headRadius * 0.48;

    if (eyes === "sleepy") {
        ctx.strokeStyle = "#09090b";
        ctx.lineWidth = 2.4 / scale;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(eyeOffsetX - 3, -eyeOffsetY);
        ctx.lineTo(eyeOffsetX + 3, -eyeOffsetY);
        ctx.moveTo(eyeOffsetX - 3, eyeOffsetY);
        ctx.lineTo(eyeOffsetX + 3, eyeOffsetY);
        ctx.stroke();
    } else {
        const eyeRadius = Math.max(3, headRadius * 0.26);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(eyeOffsetX, -eyeOffsetY, eyeRadius, 0, Math.PI * 2);
        ctx.arc(eyeOffsetX, eyeOffsetY, eyeRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = eyes === "laser" ? "#ef4444" : "#09090b";
        ctx.beginPath();
        ctx.arc(
            eyeOffsetX + eyeRadius * 0.35,
            -eyeOffsetY,
            eyeRadius * 0.56,
            0,
            Math.PI * 2
        );
        ctx.arc(
            eyeOffsetX + eyeRadius * 0.35,
            eyeOffsetY,
            eyeRadius * 0.56,
            0,
            Math.PI * 2
        );
        ctx.fill();

        if (eyes === "angry") {
            ctx.strokeStyle = "#09090b";
            ctx.lineWidth = 2.2 / scale;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(eyeOffsetX - 3.5, -eyeOffsetY - 4);
            ctx.lineTo(eyeOffsetX + 3.5, -eyeOffsetY - 1);
            ctx.moveTo(eyeOffsetX - 3.5, eyeOffsetY + 4);
            ctx.lineTo(eyeOffsetX + 3.5, eyeOffsetY + 1);
            ctx.stroke();
        }
    }

    if (accessory === "crown") {
        ctx.fillStyle = "#facc15";
        ctx.strokeStyle = "#ca8a04";
        ctx.lineWidth = 1.2 / scale;
        ctx.beginPath();
        ctx.moveTo(-headRadius * 0.45, -headRadius * 0.55);
        ctx.lineTo(-headRadius * 0.7, -headRadius * 1.32);
        ctx.lineTo(-headRadius * 0.1, -headRadius * 0.82);
        ctx.lineTo(headRadius * 0.15, -headRadius * 1.42);
        ctx.lineTo(headRadius * 0.65, -headRadius * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    } else if (accessory === "bandana") {
        ctx.fillStyle = "#f43f5e";
        ctx.beginPath();
        ctx.roundRect(
            -headRadius * 0.72,
            -headRadius * 0.88,
            headRadius * 0.48,
            headRadius * 1.76,
            3
        );
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-headRadius * 0.72, -headRadius * 0.25);
        ctx.lineTo(-headRadius * 1.45, -headRadius * 0.65);
        ctx.lineTo(-headRadius * 1.35, -headRadius * 0.05);
        ctx.closePath();
        ctx.fill();
    } else if (accessory === "halo") {
        ctx.strokeStyle = "#fde047";
        ctx.lineWidth = 2.4 / scale;
        ctx.beginPath();
        ctx.ellipse(
            -headRadius * 0.1,
            -headRadius * 1.28,
            headRadius * 0.75,
            headRadius * 0.24,
            0,
            0,
            Math.PI * 2
        );
        ctx.stroke();
    }

    ctx.restore();
}

function SnakeStudioPreview({
    primaryColor,
    secondaryColor,
    glowColor,
    bodyStyle,
    eyes,
    accessory,
    presetName,
}: {
    primaryColor: string;
    secondaryColor: string;
    glowColor: string;
    bodyStyle: BodyStyle;
    eyes: EyeStyle;
    accessory: AccessoryStyle;
    presetName: string;
}) {
    const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = previewCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let frameId = 0;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = canvas.clientWidth || 320;
        const cssHeight = canvas.clientHeight || 144;

        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);

        const render = (time: number) => {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssWidth, cssHeight);

            ctx.fillStyle = "#060a08";
            ctx.fillRect(0, 0, cssWidth, cssHeight);

            ctx.strokeStyle = "rgba(52, 211, 153, 0.08)";
            ctx.lineWidth = 1;
            for (let x = 0; x <= cssWidth; x += 24) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, cssHeight);
                ctx.stroke();
            }
            for (let y = 0; y <= cssHeight; y += 24) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(cssWidth, y);
                ctx.stroke();
            }

            const centerY = cssHeight * 0.56;
            const startX = Math.min(cssWidth - 48, cssWidth * 0.76);
            const segments: { x: number; y: number }[] = [];

            for (let i = 0; i < 14; i++) {
                const x = startX - i * 15;
                const wave = Math.sin(time * 0.0045 - i * 0.5) * 10;
                segments.push({ x, y: centerY + wave });
            }

            const head = segments[0];
            const next = segments[1] || { x: head.x - 15, y: head.y };
            const angle = Math.atan2(head.y - next.y, head.x - next.x);

            drawSnakeVisual(ctx, {
                body: segments,
                angle,
                primaryColor,
                secondaryColor,
                glowColor,
                bodyStyle,
                eyes,
                accessory,
                baseHeadRadius: 12.5,
                baseBodyRadius: 9.5,
                scale: 1,
                time,
            });

            frameId = requestAnimationFrame(render);
        };

        frameId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(frameId);
    }, [
        primaryColor,
        secondaryColor,
        glowColor,
        bodyStyle,
        eyes,
        accessory,
    ]);

    return (
        <div className="bg-black border border-zinc-800 rounded-2xl p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">
                    Vista previa en vivo
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">
                    {presetName}
                </span>
            </div>

            <canvas
                ref={previewCanvasRef}
                className="w-full h-32 sm:h-36 rounded-xl border border-zinc-900 block"
            />
        </div>
    );
}

export default function SnakeGamePage() {
    const [userId, setUserId] = useState<string | null>(null);
    const [accessToken, setAccessToken] = useState("");
    const [isAuthLoading, setIsAuthLoading] = useState(true);

    const [playBalance, setPlayBalance] = useState(0);
    const [bonusBalance, setBonusBalance] = useState(0);
    const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

    const [selectedPresetId, setSelectedPresetId] = useState<string>("emerald");
    const [customColor, setCustomColor] = useState("#10b981");
    const [secondaryColor, setSecondaryColor] = useState("#047857");
    const [bodyStyle, setBodyStyle] = useState<BodyStyle>("connected");
    const [snakeEyes, setSnakeEyes] = useState<EyeStyle>("classic");
    const [snakeAccessory, setSnakeAccessory] =
        useState<AccessoryStyle>("none");

    const customColorRef = useRef("#10b981");
    const secondaryColorRef = useRef("#047857");
    const bodyStyleRef = useRef<BodyStyle>("connected");
    const snakeEyesRef = useRef<EyeStyle>("classic");
    const snakeAccessoryRef = useRef<AccessoryStyle>("none");

    const [selectedBet, setSelectedBet] = useState<SnakeBet>("0.20");
    const selectedBetRef = useRef<number>(0.2);

    const [isInSnakeGame, setIsInSnakeGame] = useState(false);
    const [snakeRoomId, setSnakeRoomId] = useState("");

    const [isAlive, setIsAlive] = useState(true);
    const [cashedOut, setCashedOut] = useState(false);
    const [finalPayout, setFinalPayout] = useState(0);
    const [score, setScore] = useState(0);
    const [snakeBalance, setSnakeBalance] = useState(0.2);
    const [isConnected, setIsConnected] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState(
        "Preparando arena..."
    );
    const [cashOutProcessing, setCashOutProcessing] = useState(false);
    const [cashOutSeconds, setCashOutSeconds] = useState(0);
    const [joystickKnob, setJoystickKnob] = useState({ x: 0, y: 0 });
    const [joystickActive, setJoystickActive] = useState(false);

    const [modal, setModal] = useState({
        isOpen: false,
        title: "",
        message: "",
    });

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const joystickBaseRef = useRef<HTMLDivElement | null>(null);
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
    const lastSteerSentRef = useRef(0);
    const boostPointerIdRef = useRef<number | null>(null);
    const joystickPointerIdRef = useRef<number | null>(null);

    const applyPreset = (preset: SkinPreset) => {
        setSelectedPresetId(preset.id);
        setCustomColor(preset.primary);
        setSecondaryColor(preset.secondary);
        setBodyStyle(preset.bodyStyle);
        setSnakeEyes(preset.eyes);
        setSnakeAccessory(preset.accessory);

        customColorRef.current = preset.primary;
        secondaryColorRef.current = preset.secondary;
        bodyStyleRef.current = preset.bodyStyle;
        snakeEyesRef.current = preset.eyes;
        snakeAccessoryRef.current = preset.accessory;
    };

    const showAlert = useCallback((title: string, message: string) => {
        setModal({ isOpen: true, title, message });
    }, []);

    const closeModal = () => {
        setModal({ isOpen: false, title: "", message: "" });
    };

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

    const sendSteerAngle = useCallback((angle: number, throttleMs = 20) => {
        if (!Number.isFinite(angle)) return;
        const now = performance.now();
        if (now - lastSteerSentRef.current < throttleMs) return;
        lastSteerSentRef.current = now;

        const ws = snakeSocketRef.current;
        if (!connectedRef.current || !aliveRef.current) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        try {
            ws.send(JSON.stringify({ type: "STEER", angle }));
        } catch (error) {
            console.error("Error enviando dirección:", error);
        }
    }, []);

    const steerTowardsClientPoint = useCallback(
        (clientX: number, clientY: number) => {
            if (!connectedRef.current || !aliveRef.current) return;

            const canvas = canvasRef.current;
            const state = gameStateRef.current;
            const uid = userIdRef.current;

            if (!canvas || !state || !uid) return;

            const snake = state.snakes?.[uid];
            if (
                !snake?.alive ||
                !Array.isArray(snake.body) ||
                !snake.body.length
            )
                return;

            const head = snake.body[0];
            if (typeof head?.x !== "number" || typeof head?.y !== "number")
                return;

            const rect = canvas.getBoundingClientRect();
            const pointerX = clientX - rect.left;
            const pointerY = clientY - rect.top;

            const scale = Math.min(
                1.25,
                Math.max(0.55, Math.min(rect.width, rect.height) / 720)
            );

            const worldX = head.x + (pointerX - rect.width / 2) / scale;
            const worldY = head.y + (pointerY - rect.height / 2) / scale;
            const angle = Math.atan2(worldY - head.y, worldX - head.x);

            sendSteerAngle(angle, 20);
        },
        [sendSteerAngle]
    );

    const stopBoost = useCallback(() => {
        const ws = snakeSocketRef.current;

        if (!boostActiveRef.current) return;

        boostActiveRef.current = false;

        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: "BOOST_STOP" }));
            } catch (error) {
                console.error("Error deteniendo aceleración:", error);
            }
        }
    }, []);

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

        // No acelerar si ya se encogió hasta el mínimo de segmentos
        if (Array.isArray(snake.body) && snake.body.length <= MIN_BOOST_SEGMENTS) {
            return;
        }

        boostActiveRef.current = true;

        try {
            ws.send(JSON.stringify({ type: "BOOST_START" }));
        } catch (error) {
            boostActiveRef.current = false;
            console.error("Error iniciando aceleración:", error);
        }
    }, []);

    const updateJoystickFromClientPoint = (clientX: number, clientY: number) => {
        const base = joystickBaseRef.current;
        if (!base) return;

        const rect = base.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const maxRadius = Math.max(24, rect.width * 0.34);

        const dx = clientX - cx;
        const dy = clientY - cy;
        const dist = Math.hypot(dx, dy);

        if (dist < 4) {
            setJoystickKnob({ x: 0, y: 0 });
            return;
        }

        const clampedDist = Math.min(dist, maxRadius);
        const angle = Math.atan2(dy, dx);
        const knobX = Math.cos(angle) * clampedDist;
        const knobY = Math.sin(angle) * clampedDist;

        setJoystickKnob({ x: knobX, y: knobY });
        sendSteerAngle(angle, 20);
    };

    const handleJoystickPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        joystickPointerIdRef.current = e.pointerId;

        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}

        setJoystickActive(true);
        updateJoystickFromClientPoint(e.clientX, e.clientY);
    };

    const handleJoystickPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!joystickActive) return;
        if (
            joystickPointerIdRef.current !== null &&
            e.pointerId !== joystickPointerIdRef.current
        ) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        updateJoystickFromClientPoint(e.clientX, e.clientY);
    };

    const handleJoystickPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        if (
            joystickPointerIdRef.current !== null &&
            e.pointerId !== joystickPointerIdRef.current
        ) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        joystickPointerIdRef.current = null;
        setJoystickActive(false);
        setJoystickKnob({ x: 0, y: 0 });

        try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
        } catch {}
    };

    const handleCanvasPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;

        e.preventDefault();
        boostPointerIdRef.current = e.pointerId;

        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}

        if (e.pointerType === "mouse") {
            steerTowardsClientPoint(e.clientX, e.clientY);
        }

        startBoost();
    };

    const handleCanvasPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
        if (e.pointerType !== "mouse") return;
        steerTowardsClientPoint(e.clientX, e.clientY);
    };

    const handleCanvasPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
        if (
            boostPointerIdRef.current !== null &&
            e.pointerId !== boostPointerIdRef.current
        ) {
            return;
        }

        boostPointerIdRef.current = null;
        stopBoost();

        try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
        } catch {}
    };

    const renderCanvas = useCallback((now = 0) => {
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
            ctx.fillStyle = "#10b981";
            ctx.font = "bold 16px Arial";
            ctx.fillText(
                "CONECTANDO CON AXIOM ARENA",
                width / 2,
                height / 2 - 14
            );

            ctx.fillStyle = "#a1a1aa";
            ctx.font = "12px Arial";
            ctx.fillText(
                "Esperando respuesta del servidor",
                width / 2,
                height / 2 + 14
            );
            return;
        }

        const state = gameStateRef.current;

        if (!state || !state.snakes) {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#10b981";
            ctx.font = "bold 14px Arial";
            ctx.fillText("ESPERANDO JUGADORES", width / 2, height / 2);
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

        ctx.strokeStyle = "#166534";
        ctx.lineWidth = 5 / scale;
        ctx.strokeRect(0, 0, worldWidth, worldHeight);

        if (Array.isArray(state.foods)) {
            for (const food of state.foods) {
                if (typeof food?.x !== "number" || typeof food?.y !== "number")
                    continue;

                const radius = Number(food.radius || 9);

                if (
                    food.x < left - radius ||
                    food.x > right + radius ||
                    food.y < top - radius ||
                    food.y > bottom + radius
                )
                    continue;

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

        if (Array.isArray(state.coins)) {
            for (const coin of state.coins) {
                if (typeof coin?.x !== "number" || typeof coin?.y !== "number")
                    continue;

                if (
                    coin.x < left - 30 ||
                    coin.x > right + 30 ||
                    coin.y < top - 30 ||
                    coin.y > bottom + 30
                )
                    continue;

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

        Object.entries(state.snakes).forEach(([uid, value]: [string, any]) => {
            if (
                !value?.alive ||
                !Array.isArray(value.body) ||
                value.body.length === 0
            )
                return;

            const isOwnSnake = uid === userIdRef.current;
            const snakeBoosting = isOwnSnake
                ? boostActiveRef.current || Boolean(value.boosting)
                : Boolean(value.boosting);

            const primaryColor = isOwnSnake
                ? customColorRef.current
                : value.color || "#f43f5e";
            const secondaryColor = isOwnSnake
                ? secondaryColorRef.current
                : value.secondary_color || "#9f1239";

            const visibleBody = value.body.filter(
                (seg: any) =>
                    typeof seg?.x === "number" &&
                    typeof seg?.y === "number" &&
                    seg.x >= left - 60 &&
                    seg.x <= right + 60 &&
                    seg.y >= top - 60 &&
                    seg.y <= bottom + 60
            );

            if (visibleBody.length === 0) return;

            const head = value.body[0];
            const headRadius = Math.max(
                10,
                Number(head?.radius ?? value.radius ?? 12)
            );
            const bodyRadius = Math.max(6, Number(value.radius ?? 8.5));

            drawSnakeVisual(ctx, {
                body: value.body,
                angle: Number(value.angle || 0),
                primaryColor,
                secondaryColor,
                glowColor: primaryColor,
                bodyStyle: isOwnSnake
                    ? bodyStyleRef.current
                    : value.body_style || "connected",
                eyes: isOwnSnake
                    ? snakeEyesRef.current
                    : value.eyes || "classic",
                accessory: isOwnSnake
                    ? snakeAccessoryRef.current
                    : value.accessory || "none",
                baseHeadRadius: headRadius,
                baseBodyRadius: bodyRadius,
                scale,
                time: now,
                isBoosting: snakeBoosting,
            });

            if (head) {
                const balance = Number(
                    value.balance ??
                        (typeof value.balance_micros === "number"
                            ? value.balance_micros / 1000000
                            : selectedBetRef.current)
                );

                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 13px Arial";
                ctx.shadowColor = "#000000";
                ctx.shadowBlur = 5 / scale;
                ctx.fillText(
                    money(balance),
                    head.x,
                    head.y - headRadius - 16
                );
                ctx.shadowBlur = 0;
            }
        });

        ctx.restore();

        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px Arial";
        ctx.fillText(`PUNTOS: ${Number(ownSnake?.score || 0)}`, 20, height - 20);

        ctx.textAlign = "right";
        ctx.fillStyle = "#10b981";
        ctx.fillText(
            `JUGADORES: ${
                Object.values(state.snakes).filter((snake: any) => snake?.alive)
                    .length
            }`,
            width - 20,
            height - 20
        );
    }, []);

    useEffect(() => {
        if (!isInSnakeGame) return;

        let running = true;

        const loop = (now: number) => {
            if (!running) return;
            renderCanvas(now);
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

    const exitSnakeGame = useCallback(() => {
        stopBoost();
        boostPointerIdRef.current = null;
        joystickPointerIdRef.current = null;

        closingByUserRef.current = true;
        startingRef.current = false;

        connectedRef.current = false;
        aliveRef.current = false;
        readySentRef.current = false;
        cashOutSentRef.current = false;

        setJoystickActive(false);
        setJoystickKnob({ x: 0, y: 0 });
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

    const startSnakeGame = () => {
        if (startingRef.current || snakeSocketRef.current) {
            showAlert("Partida activa", "Ya existe una conexión de juego activa.");
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
        boostPointerIdRef.current = null;
        joystickPointerIdRef.current = null;

        boostActiveRef.current = false;

        const wsUrl = getWebSocketUrl(
            `/ws/snake/${encodeURIComponent(generatedRoomId)}` +
                `?user_id=${encodeURIComponent(userIdRef.current)}` +
                `&access_token=${encodeURIComponent(accessTokenRef.current)}` +
                `&bet=${encodeURIComponent(String(parsedBet))}` +
                `&wallet=${encodeURIComponent(selectedWallet)}` +
                `&color=${encodeURIComponent(customColorRef.current)}` +
                `&secondary_color=${encodeURIComponent(secondaryColorRef.current)}` +
                `&body_style=${encodeURIComponent(bodyStyleRef.current)}` +
                `&eyes=${encodeURIComponent(snakeEyesRef.current)}` +
                `&accessory=${encodeURIComponent(snakeAccessoryRef.current)}`
        );

        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

        try {
            const ws = new WebSocket(wsUrl);
            snakeSocketRef.current = ws;

            ws.onopen = () => {
                if (snakeSocketRef.current !== ws) return;

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

                setConnectionMessage("Esperando estado de la partida...");
            };

            ws.onmessage = (event) => {
                if (snakeSocketRef.current !== ws) return;

                try {
                    const data = JSON.parse(event.data);

                    if (data.type === "GAME_STATE") {
                        if (!data.snakes || typeof data.snakes !== "object") {
                            return;
                        }

                        gameStateRef.current = data;

                        if (data.room_id) {
                            setSnakeRoomId(String(data.room_id));
                        }

                        if (!connectedRef.current) {
                            connectedRef.current = true;
                            setIsConnected(true);
                            setConnectionMessage("Partida conectada");
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

                            // Detener aceleración automáticamente si alcanzó el tamaño mínimo
                            if (
                                boostActiveRef.current &&
                                Array.isArray(currentSnake.body) &&
                                currentSnake.body.length <= MIN_BOOST_SEGMENTS
                            ) {
                                stopBoost();
                            }

                            if (!alive) {
                                stopBoost();

                                if (!currentSnake.cashed_out) {
                                    setCashOutProcessing(false);
                                    setCashOutSeconds(0);
                                    cashOutSentRef.current = false;
                                }
                            }

                            setScore(Number(currentSnake.score || 0));

                            const currentBalance = Number(
                                currentSnake.balance ??
                                    (typeof currentSnake.balance_micros ===
                                    "number"
                                        ? currentSnake.balance_micros / 1000000
                                        : selectedBetRef.current)
                            );

                            setSnakeBalance(currentBalance);

                            if (currentSnake.cashout_pending) {
                                setCashOutProcessing(true);
                                setCashOutSeconds(
                                    Math.max(
                                        0,
                                        Math.ceil(
                                            Number(
                                                currentSnake.cashout_seconds ?? 0
                                            )
                                        )
                                    )
                                );
                            } else if (
                                cashOutSentRef.current &&
                                currentSnake.alive &&
                                Number(currentSnake.cashout_seconds ?? 0) <= 0
                            ) {
                                setCashOutSeconds(0);
                            }
                        }

                        return;
                    }

                    if (data.type === "CASHOUT_PENDING") {
                        cashOutSentRef.current = true;
                        setCashOutProcessing(true);
                        setCashOutSeconds(
                            Math.max(0, Number(data.seconds ?? 20))
                        );
                        stopBoost();
                        return;
                    }

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

            ws.onerror = () => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }

                if (snakeSocketRef.current === ws) {
                    setConnectionMessage("Reintentando enlace...");
                }
            };

            ws.onclose = (event) => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }

                if (snakeSocketRef.current !== ws) return;

                startingRef.current = false;
                boostActiveRef.current = false;

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

    const triggerCashOut = () => {
        const ws = snakeSocketRef.current;

        if (
            !connectedRef.current ||
            !aliveRef.current ||
            !ws ||
            ws.readyState !== WebSocket.OPEN ||
            cashOutSentRef.current
        )
            return;

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

    const activePreset =
        SKIN_PRESETS.find((p) => p.id === selectedPresetId) || null;

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
                            onClick={closeModal}
                            className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                        >
                            Entendido
                        </button>
                    </div>
                </div>
            )}

            <Header />

            <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-6 py-5 sm:py-8 flex flex-col items-center justify-center">
                {!isInSnakeGame ? (
                    <div className="w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-3xl p-4 sm:p-6 md:p-8 space-y-6 shadow-2xl">
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-4">
                            <Link
                                href="/"
                                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-emerald-400 font-bold uppercase transition-colors"
                            >
                                <span>&lsaquo;</span>
                                <span>Volver</span>
                            </Link>
                        </div>

                        <div className="text-center">
                            <h2 className="text-2xl sm:text-3xl font-black text-emerald-400 uppercase tracking-wider">
                                Snake Arena P2P
                            </h2>
                            <p className="text-xs text-zinc-400 mt-1">
                                Personaliza tu serpiente y elige tu sala de juego.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                            <div className="lg:col-span-7 bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-black uppercase tracking-wider text-zinc-200">
                                        Diseño de Serpiente
                                    </h3>
                                    <span className="text-[10px] font-mono text-zinc-400">
                                        {customColor}
                                    </span>
                                </div>

                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                        Estilos
                                    </label>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {SKIN_PRESETS.map((preset) => {
                                            const active =
                                                selectedPresetId === preset.id;
                                            return (
                                                <button
                                                    key={preset.id}
                                                    type="button"
                                                    onClick={() =>
                                                        applyPreset(preset)
                                                    }
                                                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-all ${
                                                        active
                                                            ? "bg-zinc-900 border-emerald-400 text-white"
                                                            : "bg-black/80 border-zinc-800 text-zinc-400 hover:text-white"
                                                    }`}
                                                >
                                                    <span
                                                        className="w-4 h-4 rounded-full shrink-0 border border-white/20"
                                                        style={{
                                                            background: `linear-gradient(135deg, ${preset.primary}, ${preset.secondary})`,
                                                        }}
                                                    />
                                                    <span className="text-[11px] font-bold truncate">
                                                        {preset.name}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="flex items-center justify-between bg-black border border-zinc-800 px-3.5 py-2.5 rounded-xl">
                                        <div>
                                            <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                                Color primario
                                            </span>
                                            <span className="text-[11px] font-mono text-emerald-400">
                                                {customColor}
                                            </span>
                                        </div>
                                        <input
                                            type="color"
                                            value={customColor}
                                            onChange={(e) => {
                                                setSelectedPresetId("custom");
                                                customColorRef.current =
                                                    e.target.value;
                                                setCustomColor(e.target.value);
                                            }}
                                            className="w-9 h-9 rounded-lg bg-transparent cursor-pointer border-0"
                                        />
                                    </div>

                                    <div className="flex items-center justify-between bg-black border border-zinc-800 px-3.5 py-2.5 rounded-xl">
                                        <div>
                                            <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                                                Color secundario
                                            </span>
                                            <span className="text-[11px] font-mono text-zinc-300">
                                                {secondaryColor}
                                            </span>
                                        </div>
                                        <input
                                            type="color"
                                            value={secondaryColor}
                                            onChange={(e) => {
                                                setSelectedPresetId("custom");
                                                secondaryColorRef.current =
                                                    e.target.value;
                                                setSecondaryColor(
                                                    e.target.value
                                                );
                                            }}
                                            className="w-9 h-9 rounded-lg bg-transparent cursor-pointer border-0"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                    <div>
                                        <label className="text-[10px] text-zinc-400 block mb-1 uppercase font-bold">
                                            Cuerpo
                                        </label>
                                        <select
                                            value={bodyStyle}
                                            onChange={(e) => {
                                                setSelectedPresetId("custom");
                                                const val = e.target
                                                    .value as BodyStyle;
                                                bodyStyleRef.current = val;
                                                setBodyStyle(val);
                                            }}
                                            className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                                        >
                                            <option value="connected">
                                                Continuo
                                            </option>
                                            <option value="scales">
                                                Escamas
                                            </option>
                                            <option value="pulse">Pulso</option>
                                            <option value="trail">Estela</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="text-[10px] text-zinc-400 block mb-1 uppercase font-bold">
                                            Ojos
                                        </label>
                                        <select
                                            value={snakeEyes}
                                            onChange={(e) => {
                                                setSelectedPresetId("custom");
                                                const val = e.target
                                                    .value as EyeStyle;
                                                snakeEyesRef.current = val;
                                                setSnakeEyes(val);
                                            }}
                                            className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                                        >
                                            <option value="classic">
                                                Clásicos
                                            </option>
                                            <option value="laser">Láser</option>
                                            <option value="sleepy">
                                                Dormidos
                                            </option>
                                            <option value="angry">
                                                Enfadados
                                            </option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="text-[10px] text-zinc-400 block mb-1 uppercase font-bold">
                                            Accesorio
                                        </label>
                                        <select
                                            value={snakeAccessory}
                                            onChange={(e) => {
                                                setSelectedPresetId("custom");
                                                const val = e.target
                                                    .value as AccessoryStyle;
                                                snakeAccessoryRef.current =
                                                    val;
                                                setSnakeAccessory(val);
                                            }}
                                            className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                                        >
                                            <option value="none">Ninguno</option>
                                            <option value="crown">Corona</option>
                                            <option value="bandana">
                                                Bandana
                                            </option>
                                            <option value="halo">Aureola</option>
                                        </select>
                                    </div>
                                </div>

                                <SnakeStudioPreview
                                    primaryColor={customColor}
                                    secondaryColor={secondaryColor}
                                    glowColor={customColor}
                                    bodyStyle={bodyStyle}
                                    eyes={snakeEyes}
                                    accessory={snakeAccessory}
                                    presetName={
                                        activePreset
                                            ? activePreset.name
                                            : "Personalizado"
                                    }
                                />
                            </div>

                            <div className="lg:col-span-5 bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-5">
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
                                            Jugar (${playBalance.toFixed(2)})
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
                                            Bono (${bonusBalance.toFixed(2)})
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label className="text-[10px] text-zinc-400 block mb-2 uppercase font-bold">
                                        Sala
                                    </label>

                                    <div className="grid grid-cols-3 gap-2">
                                        {(["0.20", "10", "50"] as SnakeBet[]).map(
                                            (bet) => (
                                                <button
                                                    key={bet}
                                                    type="button"
                                                    onClick={() => setSelectedBet(bet)}
                                                    className={`py-3 rounded-xl text-sm font-black border transition-all ${
                                                        selectedBet === bet
                                                            ? "bg-emerald-500 text-black border-emerald-400"
                                                            : "bg-black text-zinc-400 border-zinc-800 hover:border-emerald-500"
                                                    }`}
                                                >
                                                    ${Number(bet).toFixed(2)}
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    onClick={startSnakeGame}
                                    disabled={startingRef.current}
                                    className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs uppercase tracking-wider rounded-2xl shadow-lg active:scale-95 transition-all"
                                >
                                    Entrar a la Arena
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="fixed inset-x-0 top-[68px] bottom-0 z-20 bg-black overflow-hidden">
                        <div className="absolute top-3 left-3 right-3 sm:top-4 sm:left-4 sm:right-4 z-30 flex justify-between items-center gap-2 bg-zinc-950/90 backdrop-blur-md px-3 py-2.5 sm:p-3.5 rounded-2xl border border-zinc-800">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <button
                                    type="button"
                                    onClick={exitSnakeGame}
                                    className="px-3 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-red-400 text-xs font-bold uppercase rounded-xl border border-zinc-800 shrink-0"
                                >
                                    &lsaquo; Salir
                                </button>

                                <div className="min-w-0">
                                    <span className="block text-xs font-black text-emerald-400 uppercase truncate">
                                        Snake Arena
                                    </span>
                                    <span className="block text-[10px] text-zinc-400 truncate">
                                        {snakeRoomId}
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
                                <div className="text-right">
                                    <span className="block text-[9px] text-zinc-500 uppercase">
                                        Saldo
                                    </span>
                                    <span className="text-xs sm:text-sm font-black text-emerald-400">
                                        {money(snakeBalance)}
                                    </span>
                                </div>

                                <span
                                    className={`hidden md:inline text-[10px] font-bold uppercase ${
                                        isConnected
                                            ? "text-emerald-400"
                                            : "text-yellow-400"
                                    }`}
                                >
                                    {isConnected ? "Activo" : "Enlazando"}
                                </span>

                                {isConnected && isAlive && !cashedOut && (
                                    <button
                                        type="button"
                                        onClick={triggerCashOut}
                                        disabled={cashOutProcessing}
                                        className="px-3.5 py-2 bg-yellow-400 hover:bg-yellow-300 disabled:opacity-50 text-black font-black text-[10px] uppercase rounded-xl"
                                    >
                                        {cashOutProcessing
                                            ? `${cashOutSeconds}s`
                                            : "Retirarse"}
                                    </button>
                                )}
                            </div>
                        </div>

                        <canvas
                            ref={canvasRef}
                            onPointerDown={handleCanvasPointerDown}
                            onPointerMove={handleCanvasPointerMove}
                            onPointerUp={handleCanvasPointerUp}
                            onPointerCancel={handleCanvasPointerUp}
                            onLostPointerCapture={handleCanvasPointerUp}
                            onContextMenu={(e) => e.preventDefault()}
                            className="absolute inset-0 w-full h-full block cursor-crosshair touch-none select-none"
                            style={{ touchAction: "none" }}
                        />

                        {isConnected && isAlive && !cashedOut && (
                            <div
                                ref={joystickBaseRef}
                                onPointerDown={handleJoystickPointerDown}
                                onPointerMove={handleJoystickPointerMove}
                                onPointerUp={handleJoystickPointerUp}
                                onPointerCancel={handleJoystickPointerUp}
                                onLostPointerCapture={handleJoystickPointerUp}
                                onContextMenu={(e) => e.preventDefault()}
                                className="md:hidden fixed bottom-7 left-5 z-30 w-28 h-28 rounded-full bg-zinc-900/75 border-2 border-emerald-500/40 backdrop-blur-sm flex items-center justify-center touch-none select-none shadow-2xl"
                                style={{ touchAction: "none" }}
                            >
                                <div
                                    className="w-11 h-11 rounded-full bg-emerald-400 border-2 border-emerald-200 shadow-lg transition-transform duration-75"
                                    style={{
                                        transform: `translate(${joystickKnob.x}px, ${joystickKnob.y}px)`,
                                    }}
                                />
                            </div>
                        )}

                        {cashOutProcessing && isAlive && (
                            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-30 bg-yellow-400 text-black px-5 py-3 rounded-2xl text-center shadow-xl">
                                <span className="block text-[10px] font-black uppercase">
                                    Retiro en proceso
                                </span>
                                <span className="block text-2xl font-black">
                                    {cashOutSeconds}s
                                </span>
                            </div>
                        )}

                        {!isConnected && (
                            <div className="absolute bottom-5 left-0 right-0 text-center z-30 pointer-events-none px-4">
                                <span className="text-[10px] text-yellow-400 bg-black/80 border border-yellow-500/20 px-4 py-2 rounded-full">
                                    {connectionMessage}
                                </span>
                            </div>
                        )}

                        {(!isAlive || cashedOut) && (
                            <div className="absolute inset-0 bg-black/90 backdrop-blur-md z-40 flex flex-col items-center justify-center p-6 text-center space-y-4">
                                <h3 className="text-3xl font-black uppercase text-emerald-400">
                                    {cashedOut
                                        ? "Retiro exitoso"
                                        : "GAME OVER"}
                                </h3>

                                <p className="text-xs text-zinc-300 max-w-xs">
                                    {cashedOut
                                        ? `Acreditado ${money(finalPayout)} a tu billetera.`
                                        : "Tu serpiente quedó eliminada."}
                                </p>

                                <p className="text-sm text-zinc-400">
                                    Saldo final: {money(snakeBalance)}
                                </p>

                                <p className="text-sm text-zinc-400">
                                    Puntuación: {score}
                                </p>

                                <button
                                    type="button"
                                    onClick={exitSnakeGame}
                                    className="px-8 py-3.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                                >
                                    Volver a la arena
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {!isInSnakeGame && (
                <footer className="py-6 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
                    AXIOM Arena &copy; 2026. Todos los derechos reservados.
                </footer>
            )}
        </div>
    );
}