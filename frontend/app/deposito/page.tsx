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
    MessageCircle,
    ShieldCheck,
    Wallet,
    QrCode,
    ExternalLink,
    Clock3,
    AlertTriangle,
} from "lucide-react";

const API_URL = "https://casino-axiom.ethiodeploy.app";
const WHATSAPP_URL =
    "https://wa.me/593992241485?text=Hola%2C%20quiero%20realizar%20un%20dep%C3%B3sito%20en%20AXIOM.";
const MIN_AMOUNT = 10;
const MAX_AMOUNT = 10000;

type CryptoDeposit = {
    deposit_id: number | string;
    address: string;
    amount_usdt: number | string;
    network: string;
    status?: string;
    expires_at?: string;
    qr_code_url?: string;
};

type View = "home" | "crypto" | "crypto-details";

export default function DepositosPage() {
    const [view, setView] = useState<View>("home");
    const [token, setToken] = useState("");
    const [amount, setAmount] = useState("10");
    const [deposit, setDeposit] = useState<CryptoDeposit | null>(null);
    const [loading, setLoading] = useState(false);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);

    const getFreshAccessToken = async (): Promise<string> => {
        const { data, error } = await supabase.auth.getSession();

        if (error || !data.session) {
            throw new Error("Tu sesión no está activa. Inicia sesión nuevamente.");
        }

        let session = data.session;

        if (
            session.expires_at &&
            session.expires_at * 1000 <= Date.now() + 60000
        ) {
            const { data: refreshed, error: refreshError } =
                await supabase.auth.refreshSession();

            if (refreshError || !refreshed.session) {
                throw new Error("No se pudo renovar tu sesión. Inicia sesión nuevamente.");
            }

            session = refreshed.session;
        }

        if (!session.access_token) {
            throw new Error("No se pudo obtener el token de tu sesión.");
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
            if (active) setToken(session?.access_token || "");
        });

        return () => {
            active = false;
            subscription.unsubscribe();
        };
    }, []);

    const goHome = () => {
        if (loading) return;
        setView("home");
        setAmount("10");
        setDeposit(null);
        setError("");
        setCopied(false);
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
            setError("Ingresa un monto válido entre $10 y $10.000.");
            return;
        }

        setLoading(true);

        try {
            const freshToken = await getFreshAccessToken();

            // Este endpoint debe implementarse en el backend FastAPI.
            const response = await fetch(`${API_URL}/crypto/deposits/request`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${freshToken}`,
                },
                body: JSON.stringify({
                    amount_usd: value,
                    network: "TRON",
                    token: "USDT",
                }),
            });

            if (!response.ok) {
                let message = `Error del servidor (${response.status}).`;
                try {
                    const data = await response.json();
                    message = data.detail || data.message || data.error || message;
                } catch {
                    // Mantener el mensaje HTTP si la respuesta no es JSON.
                }
                throw new Error(message);
            }

            const data = await response.json();

            if (
                !data.success ||
                !data.deposit_id ||
                !data.address ||
                data.amount_usdt === undefined
            ) {
                throw new Error(
                    "El servidor no devolvió los datos necesarios para el depósito crypto."
                );
            }

            setDeposit({
                deposit_id: data.deposit_id,
                address: String(data.address),
                amount_usdt: data.amount_usdt,
                network: String(data.network || "TRON (TRC20)"),
                status: String(data.status || "pending"),
                expires_at: data.expires_at,
                qr_code_url: data.qr_code_url,
            });
            setView("crypto-details");
        } catch (err) {
            console.error("Error al crear depósito crypto:", err);
            setError(
                err instanceof TypeError
                    ? "No se pudo conectar con AXIOM. Comprueba que el backend esté disponible y que CORS esté configurado."
                    : err instanceof Error
                      ? err.message
                      : "No se pudo crear el depósito crypto."
            );
        } finally {
            setLoading(false);
        }
    };

    const copyAddress = async () => {
        if (!deposit?.address) return;
        try {
            await navigator.clipboard.writeText(deposit.address);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setError("No se pudo copiar la dirección. Cópiala manualmente.");
        }
    };

    return (
        <main className="min-h-screen bg-[#080b0a] text-white">
            <Header />

            {view === "home" && (
                <div className="mx-auto max-w-6xl px-5 py-8">
                    <div className="mb-7">
                        <button
                            type="button"
                            onClick={() => window.history.back()}
                            className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#111714] px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:border-emerald-500/40 hover:bg-[#141e18] hover:text-white"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Retroceder
                        </button>
                    </div>

                    <div className="mb-8">
                        <h1 className="text-3xl font-bold">Depositar fondos</h1>
                        <p className="mt-2 text-sm text-zinc-400">
                            Elige cómo deseas ingresar fondos a tu cuenta AXIOM.
                        </p>
                    </div>

                    <div className="grid max-w-4xl gap-5 md:grid-cols-2">
                        <a
                            href={WHATSAPP_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group flex min-h-44 items-center gap-4 rounded-2xl border border-white/10 bg-[#111714] p-6 text-left transition hover:border-emerald-500/50 hover:bg-[#141e18]"
                        >
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10">
                                <MessageCircle className="h-7 w-7 text-emerald-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="font-bold">Transferencia bancaria</p>
                                <p className="mt-2 text-sm text-zinc-400">
                                    Solicita tu depósito directamente por WhatsApp.
                                </p>
                                <p className="mt-3 text-xs font-semibold text-emerald-400">
                                    Contactar al 099 224 1485
                                </p>
                            </div>
                            <ExternalLink className="h-5 w-5 shrink-0 text-zinc-500 transition group-hover:text-emerald-400" />
                        </a>

                        <button
                            type="button"
                            onClick={() => {
                                setError("");
                                setView("crypto");
                            }}
                            className="group flex min-h-44 items-center gap-4 rounded-2xl border border-emerald-500/25 bg-[#111714] p-6 text-left transition hover:border-emerald-400/70 hover:bg-[#141e18]"
                        >
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10">
                                <Wallet className="h-7 w-7 text-emerald-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="font-bold">Depósito con crypto</p>
                                <p className="mt-2 text-sm text-zinc-400">
                                    Deposita con USDT utilizando la red TRON (TRC20).
                                </p>
                                <p className="mt-3 text-xs font-semibold text-emerald-400">
                                    Ver depósito crypto
                                </p>
                            </div>
                            <ArrowRight className="h-5 w-5 shrink-0 text-zinc-500 transition group-hover:translate-x-1 group-hover:text-emerald-400" />
                        </button>
                    </div>

                    <div className="mt-7 flex max-w-4xl gap-3 rounded-xl border border-white/10 bg-[#111714] p-4">
                        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                        <p className="text-xs leading-relaxed text-zinc-400">
                            Los depósitos crypto deben verificarse en la blockchain antes
                            de acreditar cualquier saldo. Nunca envíes fondos por una red
                            distinta a la indicada en la solicitud.
                        </p>
                    </div>
                </div>
            )}

            {view === "crypto" && (
                <section className="min-h-[calc(100vh-80px)]">
                    <div className="mx-auto max-w-5xl px-5 py-7 sm:py-10">
                        <button
                            type="button"
                            onClick={goHome}
                            disabled={loading}
                            className="mb-8 flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white disabled:opacity-50"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Volver a depósitos
                        </button>

                        <div className="mb-8 flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
                                <Wallet className="h-7 w-7 text-emerald-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold">Depósito con USDT</h1>
                                <p className="mt-1 text-sm text-zinc-400">
                                    Red TRON (TRC20)
                                </p>
                            </div>
                        </div>

                        <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-8">
                            <div className="mb-6 flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-4">
                                <div>
                                    <p className="text-sm font-semibold">Tether USD (USDT)</p>
                                    <p className="mt-1 text-xs text-zinc-500">
                                        Red seleccionada: TRON / TRC20
                                    </p>
                                </div>
                                <span className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-400">
                                    USDT
                                </span>
                            </div>

                            <label className="mb-2 block text-sm font-medium text-zinc-300">
                                Monto que deseas depositar (USD)
                            </label>
                            <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-4 transition focus-within:border-emerald-500">
                                <span className="text-xl font-bold text-zinc-500">$</span>
                                <input
                                    type="number"
                                    min={MIN_AMOUNT}
                                    max={MAX_AMOUNT}
                                    step="0.01"
                                    value={amount}
                                    onChange={(event) => setAmount(event.target.value)}
                                    className="w-full bg-transparent px-3 py-4 text-xl font-bold outline-none"
                                    placeholder="10.00"
                                />
                                <span className="text-xs text-zinc-500">USD</span>
                            </div>

                            <div className="mt-3 flex justify-between text-xs text-zinc-500">
                                <span>Mínimo $10</span>
                                <span>Máximo $10.000</span>
                            </div>

                            <div className="mt-6 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.05] p-4">
                                <div className="flex gap-3">
                                    <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                                    <p className="text-xs leading-relaxed text-zinc-400">
                                        AXIOM debe generar una solicitud de depósito y verificar
                                        la transferencia en la blockchain. No envíes USDT hasta
                                        que aparezca una dirección válida en la siguiente pantalla.
                                    </p>
                                </div>
                            </div>

                            {error && (
                                <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                                    {error}
                                </p>
                            )}

                            <button
                                type="button"
                                onClick={createCryptoDeposit}
                                disabled={loading || sessionLoading || !token}
                                className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-4 font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {loading ? (
                                    <>
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                        Generando solicitud...
                                    </>
                                ) : sessionLoading ? (
                                    <>
                                        <Loader2 className="h-5 w-5 animate-spin" />
                                        Verificando sesión...
                                    </>
                                ) : (
                                    <>
                                        Generar depósito USDT
                                        <ArrowRight className="h-5 w-5" />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </section>
            )}

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
                                    <QrCode className="h-8 w-8 text-emerald-400" />
                                </div>
                                <h1 className="mt-5 text-2xl font-bold">
                                    Envía tu USDT
                                </h1>
                                <p className="mt-2 text-sm text-zinc-400">
                                    Usa exclusivamente la red {deposit.network}.
                                </p>
                            </div>

                            <div className="mt-7 rounded-xl border border-white/10 bg-black/20 p-5 text-center">
                                <p className="text-xs text-zinc-500">Monto exacto</p>
                                <p className="mt-2 text-3xl font-bold text-emerald-400">
                                    {deposit.amount_usdt} USDT
                                </p>
                            </div>

                            {deposit.qr_code_url && (
                                <div className="mt-6 flex justify-center">
                                    <img
                                        src={deposit.qr_code_url}
                                        alt="Código QR de la dirección de depósito"
                                        className="h-48 w-48 rounded-xl bg-white p-2"
                                    />
                                </div>
                            )}

                            <div className="mt-6">
                                <p className="mb-2 text-sm font-semibold">
                                    Dirección de recepción
                                </p>
                                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
                                    <p className="min-w-0 flex-1 break-all font-mono text-sm text-zinc-200">
                                        {deposit.address}
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

                            <div className="mt-6 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                                    <p className="text-xs text-zinc-500">Solicitud</p>
                                    <p className="mt-1 font-semibold">
                                        #{deposit.deposit_id}
                                    </p>
                                </div>
                                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                                    <p className="text-xs text-zinc-500">Estado</p>
                                    <p className="mt-1 font-semibold text-amber-400">
                                        {deposit.status || "PENDIENTE"}
                                    </p>
                                </div>
                            </div>

                            <div className="mt-6 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
                                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                                <p className="text-xs leading-relaxed text-zinc-400">
                                    Verifica la red y el monto antes de enviar. No envíes
                                    otros tokens ni uses otra red. El saldo solo debe
                                    acreditarse después de la confirmación on-chain.
                                </p>
                            </div>

                            {deposit.expires_at && (
                                <p className="mt-4 flex items-center justify-center gap-2 text-xs text-zinc-500">
                                    <Clock3 className="h-4 w-4" />
                                    Válido hasta: {new Date(deposit.expires_at).toLocaleString()}
                                </p>
                            )}

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
