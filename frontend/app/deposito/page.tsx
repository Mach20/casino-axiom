
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
    QrCode,
    Clock3,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";

const API_URL = "https://casino-axiom.ethiodeploy.app";

const MIN_AMOUNT = 20;
const MAX_AMOUNT = 10000;

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

type View = "home" | "crypto" | "crypto-details";

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
    const [amount, setAmount] = useState("20");
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
        setAmount("20");
        setDeposit(null);
        setError("");
        setCopied(false);
    };

    const selectCrypto = (crypto: CryptoOption) => {
        setSelectedCrypto(crypto);
        setError("");
        setAmount("20");
    };

    const createCryptoDeposit = async () => {
        setError("");

        const value = Number(amount);

        if (
            !Number.isFinite(value) ||
            value < MIN_AMOUNT ||
            value > MAX_AMOUNT ||
            Math.round(value * 100) !== value * 100
        ) {
            setError(
                "Ingresa un monto válido entre $20 y $10.000."
            );
            return;
        }

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
                        amount: value,
                        pay_currency: selectedCrypto.apiCurrency,
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
                        serverMessage.toLowerCase().includes("mínimo") ||
                        serverMessage.toLowerCase().includes("minimal") ||
                        serverMessage.toLowerCase().includes("amount_minimal")
                    ) {
                        message =
                            "No se pudo generar el depósito con ese monto.";
                    } else if (
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
                    data.pay_currency || selectedCrypto.apiCurrency
                ),
                amount_usd: Number(data.amount_usd ?? value),
                payment_status: String(
                    data.payment_status || "waiting"
                ),
            });

            setView("crypto-details");
            setError("");
        } catch (err) {
            console.error(
                "Error al crear depósito crypto:",
                err
            );

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
            view !== "crypto-details" ||
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
            await navigator.clipboard.writeText(
                deposit.pay_address
            );

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

            {/* PANTALLA PRINCIPAL */}

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

                        {/* IZQUIERDA: MÉTODOS */}

                        <div>
                            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-zinc-500">
                                Método de pago
                            </p>

                            <button
                                type="button"
                                onClick={() => {
                                    setError("");
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
                                    <p className="mt-1 text-xs text-zinc-500">
                                        BTC, ETH, LTC, USDT, BNB
                                    </p>
                                </div>

                                <ArrowRight className="h-4 w-4 text-emerald-400" />
                            </button>
                        </div>

                        {/* DERECHA */}

                        <div className="flex min-h-[250px] items-center justify-center rounded-2xl border border-white/10 bg-[#111714] p-8 text-center">
                            <div>
                                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
                                    <Wallet className="h-8 w-8 text-emerald-400" />
                                </div>

                                <h2 className="mt-5 text-xl font-bold">
                                    Métodos de pago
                                </h2>

                                <p className="mt-2 max-w-sm text-sm text-zinc-500">
                                    Selecciona Criptomonedas para ver
                                    las monedas disponibles y realizar
                                    tu depósito.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* SELECCIÓN DE CRIPTOMONEDAS */}

            {view === "crypto" && (
                <section className="min-h-[calc(100vh-80px)]">
                    <div className="mx-auto max-w-7xl px-5 py-7 sm:py-10">

                        <button
                            type="button"
                            onClick={goHome}
                            disabled={loading}
                            className="mb-8 flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white disabled:opacity-50"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Volver a depósitos
                        </button>

                        <div className="grid items-start gap-5 md:grid-cols-[270px_1fr]">

                            {/* COLUMNA IZQUIERDA */}

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

                                <div className="mt-4 rounded-xl border border-white/10 bg-[#111714] p-4">
                                    <p className="text-xs font-semibold text-zinc-400">
                                        Límites de depósito
                                    </p>

                                    <div className="mt-3 flex justify-between text-sm">
                                        <span className="text-zinc-500">
                                            Mínimo
                                        </span>
                                        <span className="font-bold">
                                            $20 USD
                                        </span>
                                    </div>

                                    <div className="mt-2 flex justify-between text-sm">
                                        <span className="text-zinc-500">
                                            Máximo
                                        </span>
                                        <span className="font-bold">
                                            $10.000 USD
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* COLUMNA DERECHA */}

                            <div className="rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-7">

                                <div className="mb-6">
                                    <h1 className="text-2xl font-bold">
                                        Criptomonedas
                                    </h1>

                                    <p className="mt-2 text-sm text-zinc-400">
                                        Selecciona la moneda con la que deseas depositar.
                                    </p>
                                </div>

                                {/* MONEDAS */}

                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">

                                    {CRYPTO_OPTIONS.map((crypto) => {
                                        const selected =
                                            selectedCrypto.id === crypto.id;

                                        return (
                                            <button
                                                key={crypto.id}
                                                type="button"
                                                disabled={loading}
                                                onClick={() => selectCrypto(crypto)}
                                                className={`relative flex items-center gap-3 rounded-xl border p-4 text-left transition ${
                                                    selected
                                                        ? "border-emerald-500 bg-emerald-500/[0.08]"
                                                        : "border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/[0.03]"
                                                }`}
                                            >
                                                <CryptoIcon
                                                    currency={crypto}
                                                    size="small"
                                                />

                                                <div className="min-w-0 flex-1">
                                                    <p className="font-bold">
                                                        {crypto.name}
                                                    </p>
                                                    <p className="mt-1 text-xs text-zinc-500">
                                                        {crypto.symbol}
                                                    </p>
                                                </div>

                                                {selected && (
                                                    <Check className="h-5 w-5 text-emerald-400" />
                                                )}
                                            </button>
                                        );
                                    })}

                                </div>

                                {/* FORMULARIO */}

                                <div className="mt-8 border-t border-white/10 pt-7">

                                    <div className="mb-6 flex items-center gap-3">
                                        <CryptoIcon
                                            currency={selectedCrypto}
                                            size="small"
                                        />

                                        <div>
                                            <h2 className="font-bold">
                                                Depositar {selectedCrypto.name}
                                            </h2>
                                            <p className="mt-1 text-xs text-zinc-500">
                                                {selectedCrypto.network}
                                            </p>
                                        </div>
                                    </div>

                                    <label className="mb-2 block text-sm font-medium text-zinc-300">
                                        Valor a depositar
                                    </label>

                                    <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-4 transition focus-within:border-emerald-500">
                                        <span className="text-xl font-bold text-zinc-500">
                                            $
                                        </span>

                                        <input
                                            type="number"
                                            min={MIN_AMOUNT}
                                            max={MAX_AMOUNT}
                                            step="0.01"
                                            value={amount}
                                            onChange={(event) =>
                                                setAmount(event.target.value)
                                            }
                                            className="w-full bg-transparent px-3 py-4 text-xl font-bold outline-none"
                                            placeholder="20.00"
                                            disabled={loading}
                                        />

                                        <span className="text-xs text-zinc-500">
                                            USD
                                        </span>
                                    </div>

                                    <p className="mt-2 text-xs text-zinc-500">
                                        El importe se calcula en dólares.
                                        El sistema mostrará la cantidad de
                                        {` ${selectedCrypto.symbol}`} que debes enviar.
                                    </p>

                                    {error && (
                                        <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
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
                                        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-4 font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Generando depósito...
                                            </>
                                        ) : sessionLoading ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Verificando sesión...
                                            </>
                                        ) : (
                                            <>
                                                Continuar
                                                <ArrowRight className="h-5 w-5" />
                                            </>
                                        )}
                                    </button>

                                    <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
                                        <p className="text-sm font-semibold">
                                            ¿Cómo depositar?
                                        </p>

                                        <ol className="mt-3 list-inside list-decimal space-y-2 text-xs leading-relaxed text-zinc-400">
                                            <li>
                                                Selecciona tu criptomoneda.
                                            </li>
                                            <li>
                                                Ingresa el valor en dólares.
                                            </li>
                                            <li>
                                                Presiona Continuar.
                                            </li>
                                            <li>
                                                Envía la cantidad indicada a la dirección generada.
                                            </li>
                                        </ol>
                                    </div>

                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            )}

            {/* DATOS DEL DEPÓSITO */}

            {view === "crypto-details" && deposit && (
                <section className="min-h-[calc(100vh-80px)]">
                    <div className="mx-auto max-w-5xl px-5 py-7 sm:py-10">

                        <button
                            type="button"
                            onClick={goHome}
                            className="mb-8 flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Volver a depósitos
                        </button>

                        <div className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-8">

                            <div className="text-center">
                                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
                                    <CryptoIcon
                                        currency={selectedCrypto}
                                    />
                                </div>

                                <h1 className="mt-5 text-2xl font-bold">
                                    Envía tu {selectedCrypto.symbol}
                                </h1>

                                <p className="mt-2 text-sm text-zinc-400">
                                    Red: {selectedCrypto.network}
                                </p>
                            </div>

                            <div className="mt-7 rounded-xl border border-white/10 bg-black/20 p-5 text-center">
                                <p className="text-xs text-zinc-500">
                                    Valor del depósito
                                </p>

                                <p className="mt-2 text-3xl font-bold text-emerald-400">
                                    ${deposit.amount_usd.toFixed(2)} USD
                                </p>

                                <p className="mt-3 text-sm text-zinc-400">
                                    Envía {deposit.pay_amount}{" "}
                                    {selectedCrypto.symbol}
                                </p>
                            </div>

                            <div className="mt-6">
                                <p className="mb-2 text-sm font-semibold">
                                    Dirección de recepción
                                </p>

                                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
                                    <p className="min-w-0 flex-1 break-all font-mono text-sm text-zinc-200">
                                        {deposit.pay_address}
                                    </p>

                                    <button
                                        type="button"
                                        onClick={copyAddress}
                                        className="shrink-0 rounded-lg border border-white/10 p-3 text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400"
                                        aria-label="Copiar dirección"
                                    >
                                        {copied ? (
                                            <Check className="h-4 w-4" />
                                        ) : (
                                            <Copy className="h-4 w-4" />
                                        )}
                                    </button>
                                </div>

                                {copied && (
                                    <p className="mt-2 text-xs text-emerald-400">
                                        Dirección copiada.
                                    </p>
                                )}
                            </div>

                            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
                                <p className="text-xs text-zinc-500">
                                    Número de operación
                                </p>

                                <p className="mt-1 break-all font-semibold">
                                    #{deposit.order_id}
                                </p>
                            </div>

                            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
                                <div className="flex items-center justify-between gap-3">

                                    <div className="flex items-center gap-3">
                                        {isFinished ? (
                                            <Check className="h-5 w-5 text-emerald-400" />
                                        ) : isFailed ? (
                                            <AlertTriangle className="h-5 w-5 text-red-400" />
                                        ) : (
                                            <Clock3 className="h-5 w-5 text-amber-400" />
                                        )}

                                        <div>
                                            <p className="text-sm font-semibold">
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
                                            className="rounded-lg border border-white/10 p-3 text-zinc-300 transition hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50"
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

                            <div className="mt-6 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
                                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />

                                <p className="text-xs leading-relaxed text-zinc-400">
                                    Verifica cuidadosamente la red,
                                    la moneda y el monto antes de enviar.
                                    No envíes otros tokens ni utilices
                                    una red diferente. Un envío incorrecto
                                    puede ocasionar la pérdida de tus fondos.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={goHome}
                                className="mt-7 w-full rounded-xl border border-white/10 px-5 py-4 font-semibold text-zinc-200 transition hover:border-emerald-500/40 hover:text-white"
                            >
                                Volver a depósitos
                            </button>

                        </div>
                    </div>
                </section>
            )}
        </main>
    );
}
