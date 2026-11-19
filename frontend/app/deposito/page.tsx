
"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";
import {
    ArrowLeft,
    ArrowRight,
    Check,
    Copy,
    Loader2,
    Wallet,
    Clock3,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";

const API_URL = "https://casino-axiom.ethiodeploy.app";
const DEPOSIT_AMOUNT = 20;

type CryptoOption = {
    id: string;
    name: string;
    symbol: string;
    apiCurrency: string;
    network: string;
    color: string;
    description: string;
};

const CRYPTO_OPTIONS: CryptoOption[] = [
    {
        id: "btc",
        name: "Bitcoin",
        symbol: "BTC",
        apiCurrency: "btc",
        network: "Bitcoin",
        color: "#F7931A",
        description: "Red Bitcoin",
    },
    {
        id: "eth",
        name: "Ethereum",
        symbol: "ETH",
        apiCurrency: "eth",
        network: "Ethereum (ERC20)",
        color: "#627EEA",
        description: "Red Ethereum",
    },
    {
        id: "ltc",
        name: "Litecoin",
        symbol: "LTC",
        apiCurrency: "ltc",
        network: "Litecoin",
        color: "#B8B8B8",
        description: "Red Litecoin",
    },
    {
        id: "usdt",
        name: "Tether",
        symbol: "USDT",
        apiCurrency: "usdttrc20",
        network: "TRON (TRC20)",
        color: "#26A17B",
        description: "Red TRON",
    },
    {
        id: "bnb",
        name: "BNB",
        symbol: "BNB",
        apiCurrency: "bnbbsc",
        network: "BNB Smart Chain (BEP20)",
        color: "#F3BA2F",
        description: "Red BNB Smart Chain",
    },
];

type CryptoDeposit = {
    order_id: string;
    pay_address: string;
    pay_amount: string;
    pay_currency: string;
    amount_usd: number;
    payment_status: string;
};

type View = "home" | "crypto";

function CryptoIcon({
    currency,
    size = "large",
}: {
    currency: CryptoOption;
    size?: "small" | "large";
}) {
    const dimensions =
        size === "large"
            ? "h-14 w-14 text-2xl"
            : "h-10 w-10 text-lg";

    return (
        <div
            className={`flex shrink-0 items-center justify-center rounded-full font-extrabold ${dimensions}`}
            style={{
                backgroundColor: `${currency.color}18`,
                color: currency.color,
                border: `1px solid ${currency.color}45`,
            }}
        >
            {currency.symbol === "BTC" ? (
                <span>₿</span>
            ) : currency.symbol === "ETH" ? (
                <svg
                    viewBox="0 0 32 32"
                    className="h-7 w-7"
                    fill="currentColor"
                >
                    <path d="M16 2L7 16l9 5.5 9-5.5L16 2z" opacity=".9" />
                    <path d="M7 18l9 12 9-12-9 5.5L7 18z" opacity=".6" />
                </svg>
            ) : currency.symbol === "LTC" ? (
                <span>Ł</span>
            ) : currency.symbol === "USDT" ? (
                <span>₮</span>
            ) : (
                <span className="text-xl">◆</span>
            )}
        </div>
    );
}

export default function DepositosPage() {
    const [view, setView] = useState<View>("home");
    const [token, setToken] = useState("");
    const [selectedCrypto, setSelectedCrypto] =
        useState<CryptoOption>(CRYPTO_OPTIONS[3]);

    const [deposit, setDeposit] = useState<CryptoDeposit | null>(null);
    const [loading, setLoading] = useState(false);
    const [statusLoading, setStatusLoading] = useState(false);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);

    const getFreshAccessToken = async (): Promise<string> => {
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
            throw new Error(
                "No se pudo obtener el token de tu sesión."
            );
        }

        return session.access_token;
    };

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
    }, []);

    const goHome = () => {
        if (loading) return;

        setView("home");
        setDeposit(null);
        setError("");
        setCopied(false);
    };

    const createCryptoDeposit = async (crypto: CryptoOption) => {
        if (loading || sessionLoading || !token) return;

        setSelectedCrypto(crypto);
        setDeposit(null);
        setError("");
        setCopied(false);
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
                        amount: DEPOSIT_AMOUNT,
                        pay_currency: crypto.apiCurrency,
                    }),
                }
            );

            if (!response.ok) {
                let message =
                    "No se pudo generar el depósito. Intenta nuevamente.";

                try {
                    const data = await response.json();

                    const serverMessage = String(
                        data.detail ||
                        data.message ||
                        data.error ||
                        ""
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

            setDeposit({
                order_id: String(data.order_id),
                pay_address: String(data.pay_address),
                pay_amount: String(data.pay_amount),
                pay_currency: String(
                    data.pay_currency || crypto.apiCurrency
                ),
                amount_usd: Number(data.amount_usd ?? DEPOSIT_AMOUNT),
                payment_status: String(
                    data.payment_status || "waiting"
                ),
            });

            setError("");
        } catch (err) {
            console.error("Error al crear depósito crypto:", err);

            setError(
                err instanceof TypeError
                    ? "No se pudo conectar con AXIOM. Intenta nuevamente."
                    : err instanceof Error
                        ? err.message
                        : "No se pudo crear el depósito crypto."
            );
        } finally {
            setLoading(false);
        }
    };

    const refreshDepositStatus = async () => {
        if (!deposit?.order_id || statusLoading) return;

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
                let message =
                    `No se pudo consultar el estado (${response.status}).`;

                try {
                    const data = await response.json();
                    message = data.detail || message;
                } catch {
                    // Mantener mensaje.
                }

                throw new Error(message);
            }

            const data = await response.json();

            const newStatus = String(
                data.payment_status ||
                data.status ||
                deposit.payment_status
            );

            setDeposit((previous) =>
                previous
                    ? {
                        ...previous,
                        payment_status: newStatus,
                    }
                    : previous
            );
        } catch (err) {
            console.error(
                "Error consultando estado del depósito:",
                err
            );
        } finally {
            setStatusLoading(false);
        }
    };

    useEffect(() => {
        if (
            view !== "crypto" ||
            !deposit?.order_id
        ) {
            return;
        }

        const status = deposit.payment_status.toLowerCase();

        if (
            ["finished", "failed", "expired", "refunded"].includes(status)
        ) {
            return;
        }

        const interval = window.setInterval(() => {
            refreshDepositStatus();
        }, 5000);

        return () => window.clearInterval(interval);
    }, [view, deposit?.order_id, deposit?.payment_status]);

    const copyAddress = async () => {
        if (!deposit?.pay_address) return;

        try {
            await navigator.clipboard.writeText(deposit.pay_address);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setError(
                "No se pudo copiar la dirección. Cópiala manualmente."
            );
        }
    };

    const getStatusLabel = (status: string) => {
        const normalized = status.toLowerCase();

        const labels: Record<string, string> = {
            waiting: "Esperando pago",
            confirming: "Confirmando pago",
            confirmed: "Pago confirmado",
            sending: "Procesando acreditación",
            finished: "Pago completado",
            failed: "Pago fallido",
            expired: "Pago expirado",
            refunded: "Pago reembolsado",
            partially_paid: "Pago parcial",
        };

        return labels[normalized] || status.toUpperCase();
    };

    const isFinished =
        deposit?.payment_status.toLowerCase() === "finished";

    const isFailed =
        deposit &&
        ["failed", "expired", "refunded"].includes(
            deposit.payment_status.toLowerCase()
        );

    return (
        <main className="min-h-screen bg-[#080b0a] text-white">
            <Header />

            {view === "home" && (
                <div className="mx-auto max-w-7xl px-5 py-8">
                    <button
                        type="button"
                        onClick={() => window.history.back()}
                        className="mb-8 flex items-center gap-2 rounded-xl border border-white/10 bg-[#111714] px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:border-emerald-500/40 hover:text-white"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Volver
                    </button>

                    <h1 className="mb-2 text-3xl font-bold">
                        Depósitos
                    </h1>

                    <p className="mb-8 text-sm text-zinc-400">
                        Selecciona tu método de pago.
                    </p>

                    <div className="grid gap-5 md:grid-cols-[270px_1fr]">
                        <div>
                            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-zinc-500">
                                Método de pago
                            </p>

                            <button
                                type="button"
                                onClick={() => {
                                    setError("");
                                    setDeposit(null);
                                    setView("crypto");
                                }}
                                className="flex w-full items-center gap-3 rounded-xl border border-emerald-500/40 bg-[#121b16] p-4 text-left transition hover:border-emerald-400 hover:bg-[#17231b]"
                            >
                                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
                                    <Wallet className="h-6 w-6 text-emerald-400" />
                                </div>

                                <div className="min-w-0 flex-1">
                                    <p className="font-bold">
                                        Criptomonedas
                                    </p>
                                </div>

                                <ArrowRight className="h-4 w-4 text-emerald-400" />
                            </button>
                        </div>

                        <div className="flex min-h-[250px] items-center justify-center rounded-2xl border border-white/10 bg-[#111714] p-8 text-center">
                            <div>
                                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                                    <Wallet className="h-8 w-8 text-emerald-400" />
                                </div>

                                <h2 className="mt-5 text-xl font-bold">
                                    Métodos de pago
                                </h2>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {view === "crypto" && (
                <section className="min-h-[calc(100vh-80px)]">
                    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
                        <button
                            type="button"
                            onClick={goHome}
                            disabled={loading}
                            className="mb-6 flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white disabled:opacity-50"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Volver a depósitos
                        </button>

                        <div className="grid min-h-[calc(100vh-180px)] items-stretch gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
                            {/* COLUMNA IZQUIERDA */}

                            <aside className="space-y-4">
                                <div>
                                    <p className="mb-3 text-xs font-bold uppercase tracking-wider text-zinc-500">
                                        Método de pago
                                    </p>

                                    <div className="flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-[#121b16] p-4">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-500/10">
                                            <Wallet className="h-6 w-6 text-emerald-400" />
                                        </div>

                                        <div>
                                            <p className="font-bold">
                                                Criptomonedas
                                            </p>
                                            <p className="mt-1 text-xs text-emerald-400">
                                                Seleccionado
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-xl border border-white/10 bg-[#111714] p-4">
                                    <p className="mb-4 text-xs font-bold uppercase tracking-wider text-zinc-500">
                                        Selecciona una moneda
                                    </p>

                                    <div className="space-y-2">
                                        {CRYPTO_OPTIONS.map((crypto) => {
                                            const selected =
                                                selectedCrypto.id === crypto.id;

                                            return (
                                                <button
                                                    key={crypto.id}
                                                    type="button"
                                                    disabled={loading || !!deposit}
                                                    onClick={() =>
                                                        createCryptoDeposit(crypto)
                                                    }
                                                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                                        selected
                                                            ? "border-emerald-500/60 bg-emerald-500/[0.09]"
                                                            : "border-white/[0.06] bg-black/20 hover:border-white/20 hover:bg-white/[0.03]"
                                                    }`}
                                                >
                                                    <CryptoIcon
                                                        currency={crypto}
                                                        size="small"
                                                    />

                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-bold">
                                                            {crypto.name}
                                                        </p>
                                                        <p className="mt-1 text-xs text-zinc-500">
                                                            {crypto.symbol}
                                                        </p>
                                                    </div>

                                                    {selected && (
                                                        <Check className="h-4 w-4 text-emerald-400" />
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </aside>

                            {/* PANEL DERECHO */}

                            <div className="flex min-h-[600px] min-w-0 flex-col rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-8 lg:p-10">
                                {loading ? (
                                    <div className="flex flex-1 flex-col items-center justify-center text-center">
                                        <Loader2 className="h-10 w-10 animate-spin text-emerald-400" />
                                        <h2 className="mt-6 text-xl font-bold">
                                            Generando dirección de depósito
                                        </h2>
                                        <p className="mt-2 text-sm text-zinc-400">
                                            Estamos preparando tu dirección para {selectedCrypto.name}.
                                        </p>
                                    </div>
                                ) : deposit ? (
                                    <>
                                        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 pb-7">
                                            <div className="flex items-center gap-4">
                                                <CryptoIcon
                                                    currency={selectedCrypto}
                                                    size="large"
                                                />

                                                <div>
                                                    <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                                                        Dirección de depósito
                                                    </p>
                                                    <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
                                                        {selectedCrypto.name}
                                                    </h1>
                                                    <p className="mt-1 text-sm text-zinc-400">
                                                        Red: {selectedCrypto.network}
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="rounded-lg border border-white/10 bg-black/20 px-4 py-3">
                                                <p className="text-xs text-zinc-500">
                                                    Estado del pago
                                                </p>
                                                <p className="mt-1 text-sm font-bold text-emerald-400">
                                                    {getStatusLabel(deposit.payment_status)}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="mt-7 grid gap-4 sm:grid-cols-2">
                                            <div className="rounded-xl border border-white/10 bg-black/20 p-5">
                                                <p className="text-sm text-zinc-500">
                                                    Valor del depósito
                                                </p>
                                                <p className="mt-2 text-2xl font-bold text-emerald-400">
                                                    ${deposit.amount_usd.toFixed(2)} USD
                                                </p>
                                            </div>

                                            <div className="rounded-xl border border-white/10 bg-black/20 p-5">
                                                <p className="text-sm text-zinc-500">
                                                    Cantidad exacta a enviar
                                                </p>
                                                <p className="mt-2 break-all text-2xl font-bold">
                                                    {deposit.pay_amount} {selectedCrypto.symbol}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="mt-8">
                                            <p className="mb-3 text-sm font-semibold">
                                                Dirección de recepción
                                            </p>

                                            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-black/30 p-4 sm:p-5">
                                                <p className="min-w-0 flex-1 break-all font-mono text-sm leading-relaxed text-zinc-200">
                                                    {deposit.pay_address}
                                                </p>

                                                <button
                                                    type="button"
                                                    onClick={copyAddress}
                                                    className="shrink-0 rounded-lg border border-white/10 p-3 text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400"
                                                    aria-label="Copiar dirección"
                                                >
                                                    {copied ? (
                                                        <Check className="h-5 w-5" />
                                                    ) : (
                                                        <Copy className="h-5 w-5" />
                                                    )}
                                                </button>
                                            </div>

                                            {copied && (
                                                <p className="mt-2 text-xs text-emerald-400">
                                                    Dirección copiada.
                                                </p>
                                            )}
                                        </div>

                                        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-5">
                                            <p className="text-xs text-zinc-500">
                                                Número de operación
                                            </p>
                                            <p className="mt-2 break-all font-semibold">
                                                #{deposit.order_id}
                                            </p>
                                        </div>

                                        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-5">
                                            <div className="flex flex-wrap items-center justify-between gap-4">
                                                <div className="flex items-center gap-3">
                                                    {isFinished ? (
                                                        <Check className="h-5 w-5 text-emerald-400" />
                                                    ) : isFailed ? (
                                                        <AlertTriangle className="h-5 w-5 text-red-400" />
                                                    ) : (
                                                        <Clock3 className="h-5 w-5 text-amber-400" />
                                                    )}

                                                    <div>
                                                        <p className="font-semibold">
                                                            {getStatusLabel(deposit.payment_status)}
                                                        </p>
                                                        <p className="mt-1 text-xs text-zinc-500">
                                                            {isFinished
                                                                ? "Consulta el saldo de tu cuenta AXIOM."
                                                                : "AXIOM consulta el estado del pago automáticamente."}
                                                        </p>
                                                    </div>
                                                </div>

                                                {!isFinished && !isFailed && (
                                                    <button
                                                        type="button"
                                                        onClick={refreshDepositStatus}
                                                        disabled={statusLoading}
                                                        className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50"
                                                    >
                                                        {statusLoading ? (
                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <RefreshCw className="h-4 w-4" />
                                                        )}
                                                        Actualizar
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        <div className="mt-6 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
                                            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                                            <p className="text-xs leading-relaxed text-zinc-400">
                                                Verifica cuidadosamente la red, la moneda y el monto antes de enviar. No envíes otros tokens ni utilices una red diferente. Un envío incorrecto puede ocasionar la pérdida de tus fondos.
                                            </p>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={goHome}
                                            className="mt-7 w-full rounded-xl border border-white/10 px-5 py-4 font-semibold text-zinc-200 transition hover:border-emerald-500/40 hover:text-white"
                                        >
                                            Volver a depósitos
                                        </button>
                                    </>
                                ) : (
                                    <div className="flex flex-1 flex-col items-center justify-center text-center">
                                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                                            <Wallet className="h-8 w-8 text-emerald-400" />
                                        </div>

                                        <h1 className="mt-6 text-2xl font-bold">
                                            Selecciona tu criptomoneda
                                        </h1>

                                        <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
                                            Al seleccionar una moneda se generará directamente tu dirección de depósito.
                                        </p>

                                        {error && (
                                            <div className="mt-6 w-full max-w-lg rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-left">
                                                <p className="text-sm text-red-400">
                                                    {error}
                                                </p>

                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        createCryptoDeposit(selectedCrypto)
                                                    }
                                                    disabled={loading || sessionLoading || !token}
                                                    className="mt-4 flex items-center gap-2 text-sm font-semibold text-white hover:text-emerald-400 disabled:opacity-50"
                                                >
                                                    Reintentar
                                                    <ArrowRight className="h-4 w-4" />
                                                </button>
                                            </div>
                                        )}

                                        {sessionLoading && (
                                            <p className="mt-5 flex items-center gap-2 text-sm text-zinc-500">
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                Verificando sesión...
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </section>
            )}
        </main>
    );
}
