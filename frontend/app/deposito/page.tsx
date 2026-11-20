"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";
import {
    ArrowLeft,
    ArrowRight,
    Check,
    CheckCircle2,
    Coins,
    Copy,
    Loader2,
    Clock3,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";

const API_URL = "https://casino-axiom.ethiodeploy.app";
const MIN_AMOUNT = 20;

type CryptoDeposit = {
    order_id: string;
    pay_address: string;
    pay_amount: string;
    pay_currency: string;
    amount_usd: number;
    payment_status: string;
    credited?: boolean;
};

type View = "form" | "details";

const STATUS_MESSAGES: Record<string, { title: string; subtitle: string }> = {
    waiting: {
        title: "Esperando confirmación",
        subtitle: "AXIOM detecta tu pago y acredita el saldo automáticamente.",
    },
    confirming: {
        title: "Confirmando en la red TRON",
        subtitle: "Pago detectado. Esperando confirmaciones...",
    },
    sending: {
        title: "Acreditando saldo",
        subtitle: "Confirmaciones listas. Aplicando tu saldo AXIOM...",
    },
    partially_paid: {
        title: "Pago incompleto",
        subtitle: "Se recibió un monto menor al mínimo.",
    },
    finished: {
        title: "¡Depósito confirmado y acreditado!",
        subtitle: "Tu saldo AXIOM ya está actualizado.",
    },
    failed: {
        title: "Depósito no completado",
        subtitle: "El pago falló. Intenta generar una nueva orden.",
    },
    expired: {
        title: "Orden expirada",
        subtitle: "El tiempo de pago expiró. Crea un nuevo depósito.",
    },
    refunded: {
        title: "Pago reembolsado",
        subtitle: "El pago fue reembolsado.",
    },
};

export default function DepositosPage() {
    const [view, setView] = useState<View>("form");
    const [token, setToken] = useState("");
    const [deposit, setDeposit] = useState<CryptoDeposit | null>(null);
    const [loading, setLoading] = useState(false);
    const [statusLoading, setStatusLoading] = useState(false);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [error, setError] = useState("");
    const [copiedAddress, setCopiedAddress] = useState(false);
    const [copiedAmount, setCopiedAmount] = useState(false);

    const statusRequestInFlight = useRef(false);

    const getFreshAccessToken = useCallback(async (): Promise<string> => {
        const { data, error } = await supabase.auth.getSession();

        if (error || !data.session) {
            throw new Error(
                "Tu sesión no está activa. Inicia sesión nuevamente."
            );
        }

        let session = data.session;

        if (
            session.expires_at &&
            session.expires_at * 1000 <= Date.now() + 60000
        ) {
            const { data: refreshed, error: refreshError } =
                await supabase.auth.refreshSession();

            if (refreshError || !refreshed.session) {
                throw new Error(
                    "No se pudo renovar tu sesión. Inicia sesión nuevamente."
                );
            }

            session = refreshed.session;
        }

        if (!session.access_token) {
            throw new Error("No se pudo obtener el token de tu sesión.");
        }

        return session.access_token;
    }, []);

    useEffect(() => {
        let active = true;

        const loadSession = async () => {
            try {
                const freshToken = await getFreshAccessToken();

                if (active) {
                    setToken(freshToken);
                    setError("");
                }
            } catch (err) {
                if (active) {
                    setToken("");
                    setError(
                        err instanceof Error
                            ? err.message
                            : "No se pudo verificar tu sesión."
                    );
                }
            } finally {
                if (active) setSessionLoading(false);
            }
        };

        loadSession();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            if (active) {
                setToken(session?.access_token || "");
            }
        });

        return () => {
            active = false;
            subscription.unsubscribe();
        };
    }, [getFreshAccessToken]);

    const goBack = () => {
        if (loading) return;

        setView("form");
        setDeposit(null);
        setError("");
        setCopiedAddress(false);
        setCopiedAmount(false);
    };

    const createCryptoDeposit = async () => {
        setError("");
        setLoading(true);

        try {
            const freshToken = await getFreshAccessToken();

            const response = await fetch(
                `${API_URL}/crypto/deposits/create`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${freshToken}`,
                    },
                    body: JSON.stringify({
                        amount: MIN_AMOUNT,
                    }),
                }
            );

            if (!response.ok) {
                let message =
                    "No se pudo generar el depósito. Intenta nuevamente.";

                try {
                    const data = await response.json();
                    const serverMessage = String(
                        data.detail || data.message || data.error || ""
                    );

                    if (
                        response.status === 401 ||
                        response.status === 403
                    ) {
                        message =
                            "Tu sesión no está activa. Inicia sesión nuevamente.";
                    } else if (serverMessage) {
                        message = serverMessage;
                    }
                } catch {
                    // Mantener mensaje general.
                }

                throw new Error(message);
            }

            const data = await response.json();

            if (
                !data.success ||
                !data.order_id ||
                !data.pay_address ||
                data.pay_amount === undefined
            ) {
                throw new Error(
                    "El servidor no devolvió los datos necesarios para el pago."
                );
            }

            const currency = String(
                data.pay_currency || "usdttrc20"
            ).toLowerCase();

            if (currency !== "usdttrc20") {
                throw new Error(
                    "El servidor no generó un pago USDT TRC20."
                );
            }

            setDeposit({
                order_id: String(data.order_id),
                pay_address: String(data.pay_address),
                pay_amount: String(data.pay_amount),
                pay_currency: currency,
                amount_usd: Number(data.amount_usd ?? MIN_AMOUNT),
                payment_status: String(
                    data.payment_status || "waiting"
                ).toLowerCase(),
                credited: false,
            });

            setView("details");
            setError("");
        } catch (err) {
            console.error("Error al crear depósito:", err);

            setError(
                err instanceof TypeError
                    ? "No se pudo conectar con AXIOM. Intenta nuevamente."
                    : err instanceof Error
                        ? err.message
                        : "No se pudo crear el depósito."
            );
        } finally {
            setLoading(false);
        }
    };

    const refreshDepositStatus = useCallback(async () => {
        if (!deposit?.order_id || statusRequestInFlight.current) return;

        statusRequestInFlight.current = true;
        setStatusLoading(true);

        try {
            const freshToken = await getFreshAccessToken();

            const response = await fetch(
                `${API_URL}/crypto/deposits/${encodeURIComponent(
                    deposit.order_id
                )}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${freshToken}`,
                    },
                    cache: "no-store",
                }
            );

            if (!response.ok) {
                throw new Error(
                    `No se pudo consultar el estado (${response.status}).`
                );
            }

            const data = await response.json();

            const newStatus = String(
                data.payment_status ||
                data.status ||
                deposit.payment_status
            ).toLowerCase();

            const wasFinished =
                deposit.payment_status.toLowerCase() === "finished" ||
                Boolean(deposit.credited);
            const nowFinished =
                newStatus === "finished" || Boolean(data.credited);

            setDeposit((previous) =>
                previous
                    ? {
                        ...previous,
                        payment_status: newStatus,
                        credited: Boolean(data.credited),
                    }
                    : previous
            );

            if (!wasFinished && nowFinished) {
                window.dispatchEvent(new Event("axiom:balance-updated"));
            }
        } catch (err) {
            console.error(
                "Error consultando estado del depósito:",
                err
            );
        } finally {
            statusRequestInFlight.current = false;
            setStatusLoading(false);
        }
    }, [
        deposit?.credited,
        deposit?.order_id,
        deposit?.payment_status,
        getFreshAccessToken,
    ]);

    useEffect(() => {
        if (view !== "details" || !deposit?.order_id) {
            return;
        }

        const status = deposit.payment_status.toLowerCase();

        if (
            ["finished", "failed", "expired", "refunded"].includes(status) ||
            deposit.credited
        ) {
            return;
        }

        const interval = window.setInterval(() => {
            refreshDepositStatus();
        }, 5000);

        return () => window.clearInterval(interval);
    }, [
        deposit?.credited,
        deposit?.order_id,
        deposit?.payment_status,
        refreshDepositStatus,
        view,
    ]);

    const copyAddress = async () => {
        if (!deposit?.pay_address) return;

        try {
            await navigator.clipboard.writeText(deposit.pay_address);
            setCopiedAddress(true);
            window.setTimeout(() => setCopiedAddress(false), 1800);
        } catch {
            setError("No se pudo copiar la dirección.");
        }
    };

    const copyAmount = async () => {
        if (!deposit?.pay_amount) return;

        try {
            await navigator.clipboard.writeText(String(deposit.pay_amount));
            setCopiedAmount(true);
            window.setTimeout(() => setCopiedAmount(false), 1800);
        } catch {
            setError("No se pudo copiar el monto.");
        }
    };

    const currentStatus = (deposit?.payment_status || "waiting").toLowerCase();
    const isFinished = currentStatus === "finished" || Boolean(deposit?.credited);
    const isFailed = ["failed", "expired", "refunded"].includes(currentStatus);

    const statusInfo = STATUS_MESSAGES[currentStatus] || {
        title: `Estado: ${currentStatus}`,
        subtitle: "Verificación automática del pago.",
    };

    return (
        <main className="min-h-screen bg-[#080b0a] text-white">
            <Header />

            <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
                <button
                    type="button"
                    onClick={() => {
                        if (view === "details") {
                            goBack();
                        } else {
                            window.history.back();
                        }
                    }}
                    className="mb-6 flex items-center gap-2 rounded-lg border border-white/10 bg-[#111714] px-3 py-2 text-xs font-semibold text-zinc-400 transition hover:border-emerald-500/40 hover:text-white"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Volver
                </button>

                <h1 className="mb-5 text-xl font-bold">
                    Depósitos
                </h1>

                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[220px_1fr]">
                    {/* OPCIÓN USDT */}
                    <button
                        type="button"
                        onClick={() => {
                            if (view !== "details") {
                                setView("form");
                                setError("");
                            }
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left transition ${
                            view === "form"
                                ? "border-emerald-500/50 bg-[#111c16]"
                                : "border-white/10 bg-[#111714] hover:border-emerald-500/40"
                        }`}
                    >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
                            <Coins className="h-5 w-5 text-emerald-400" />
                        </div>

                        <div className="min-w-0">
                            <p className="text-sm font-bold">
                                USDT TRC20
                            </p>

                            <p className="mt-1 text-xs text-emerald-400">
                                Mínimo $20
                            </p>
                        </div>

                        <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-zinc-500" />
                    </button>

                    {/* PANEL DERECHO */}
                    <div className="min-w-0 rounded-xl border border-white/10 bg-[#111714] p-4 sm:p-5">
                        {view === "form" && (
                            <>
                                <div className="mb-5 flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                                        <Coins className="h-5 w-5 text-emerald-400" />
                                    </div>

                                    <div>
                                        <h2 className="text-base font-bold">
                                            Depósito USDT
                                        </h2>

                                        <p className="text-xs text-zinc-500">
                                            Red TRON (TRC20) · Detección automática
                                        </p>
                                    </div>
                                </div>

                                <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
                                    <p className="text-xs text-zinc-400">
                                        Mínimo
                                    </p>

                                    <p className="mt-1 text-xl font-bold text-emerald-400">
                                        $20.00 USD
                                    </p>

                                    <p className="mt-1 text-xs text-zinc-500">
                                        AXIOM detecta tu pago y acredita el saldo automáticamente.
                                    </p>
                                </div>

                                {error && (
                                    <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                                        {error}
                                    </p>
                                )}

                                <button
                                    type="button"
                                    onClick={createCryptoDeposit}
                                    disabled={
                                        loading ||
                                        sessionLoading ||
                                        !token
                                    }
                                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-sm font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {loading ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Generando dirección...
                                        </>
                                    ) : sessionLoading ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Verificando sesión...
                                        </>
                                    ) : (
                                        <>
                                            Generar depósito (Mínimo $20)
                                            <ArrowRight className="h-4 w-4" />
                                        </>
                                    )}
                                </button>
                            </>
                        )}

                        {view === "details" && deposit && (
                            <>
                                <div className="mb-5 flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                                        <Coins className="h-5 w-5 text-emerald-400" />
                                    </div>

                                    <div>
                                        <h2 className="text-base font-bold">
                                            Enviar USDT
                                        </h2>

                                        <p className="text-xs text-zinc-500">
                                            TRON (TRC20) · {deposit.order_id}
                                        </p>
                                    </div>
                                </div>

                                <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                                    <p className="text-xs text-zinc-500">
                                        Mínimo del depósito
                                    </p>

                                    <p className="mt-1 text-2xl font-bold text-emerald-400">
                                        ${deposit.amount_usd.toFixed(2)} USD
                                    </p>

                                    <div className="mt-2 flex items-center justify-between gap-2">
                                        <p className="text-sm text-zinc-300">
                                            Envía{" "}
                                            <span className="font-mono font-bold text-white">
                                                {deposit.pay_amount} USDT
                                            </span>{" "}
                                            por TRC20
                                        </p>

                                        <button
                                            type="button"
                                            onClick={copyAmount}
                                            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400"
                                        >
                                            {copiedAmount ? "Monto copiado" : "Copiar monto"}
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-4">
                                    <p className="mb-2 text-xs font-semibold text-zinc-300">
                                        Dirección de recepción
                                    </p>

                                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 p-3">
                                        <p className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-200">
                                            {deposit.pay_address}
                                        </p>

                                        <button
                                            type="button"
                                            onClick={copyAddress}
                                            className="shrink-0 rounded-lg border border-white/10 p-2 text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400"
                                            aria-label="Copiar dirección"
                                        >
                                            {copiedAddress ? (
                                                <Check className="h-4 w-4 text-emerald-400" />
                                            ) : (
                                                <Copy className="h-4 w-4" />
                                            )}
                                        </button>
                                    </div>

                                    {copiedAddress && (
                                        <p className="mt-2 text-xs text-emerald-400">
                                            Dirección copiada.
                                        </p>
                                    )}
                                </div>

                                <div
                                    className={`mt-4 rounded-lg border p-3 ${
                                        isFinished
                                            ? "border-emerald-500/30 bg-emerald-500/10"
                                            : isFailed
                                                ? "border-red-500/30 bg-red-500/10"
                                                : "border-white/10 bg-black/20"
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            {isFinished ? (
                                                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                                            ) : isFailed ? (
                                                <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                                            ) : (
                                                <Clock3 className="h-4 w-4 shrink-0 text-amber-400" />
                                            )}

                                            <div>
                                                <p className="text-xs font-semibold">
                                                    {statusInfo.title}
                                                </p>

                                                <p className="mt-1 text-xs text-zinc-400">
                                                    {statusInfo.subtitle}
                                                </p>
                                            </div>
                                        </div>

                                        {!isFinished && !isFailed && (
                                            <button
                                                type="button"
                                                onClick={refreshDepositStatus}
                                                disabled={statusLoading}
                                                className="rounded-lg border border-white/10 p-2 text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50"
                                                aria-label="Actualizar estado"
                                            >
                                                {statusLoading ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <RefreshCw className="h-4 w-4" />
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3">
                                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />

                                    <p className="text-xs leading-relaxed text-zinc-400">
                                        Envía únicamente USDT por la red TRON (TRC20) y utiliza el monto indicado.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={goBack}
                                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:border-emerald-500/40 hover:text-white"
                                >
                                    <ArrowLeft className="h-4 w-4" />
                                    Volver
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}