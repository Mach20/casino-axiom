
"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";
import {
    Landmark,
    ArrowLeft,
    ArrowRight,
    Copy,
    Check,
    Upload,
    Loader2,
    CheckCircle2,
    FileText,
    ShieldCheck
} from "lucide-react";

const API_URL = "https://casino-axiom.ethiodeploy.app";

const BANK = {
    name: "Banco Guayaquil",
    type: "Cuenta de ahorros",
    number: "0049154300",
    holder: "Mauricio Chávez",
    identification: "1728815018"
};

const MIN_AMOUNT = 10;
const MAX_AMOUNT = 10000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

type View = "home" | "transfer" | "receipt" | "success";

// IMPORTANTE: este componente debe estar fuera de DepositosPage.
function StepIndicator({ current }: { current: number }) {
    const steps = ["Monto", "Transferencia", "Comprobante"];

    return (
        <div className="mb-9 grid grid-cols-3 gap-2">
            {steps.map((label, index) => {
                const number = index + 1;
                const active = number <= current;

                return (
                    <div key={label}>
                        <div
                            className={`h-1 rounded-full ${
                                active ? "bg-emerald-400" : "bg-white/10"
                            }`}
                        />
                        <p
                            className={`mt-2 text-[11px] ${
                                active ? "text-emerald-400" : "text-zinc-600"
                            }`}
                        >
                            {number}. {label}
                        </p>
                    </div>
                );
            })}
        </div>
    );
}

export default function DepositosPage() {
    const [view, setView] = useState<View>("home");
    const [token, setToken] = useState("");
    const [amount, setAmount] = useState("10");

    const [depositId, setDepositId] = useState<number | null>(null);
    const [reference, setReference] = useState("");
    const [receipt, setReceipt] = useState<File | null>(null);
    const [receiptPreview, setReceiptPreview] = useState("");

    const [loading, setLoading] = useState(false);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState("");

    const fileInput = useRef<HTMLInputElement>(null);

    // Crear y liberar la vista previa del comprobante.
    useEffect(() => {
        if (!receipt || !receipt.type.startsWith("image/")) {
            setReceiptPreview("");
            return;
        }

        const imageUrl = URL.createObjectURL(receipt);
        setReceiptPreview(imageUrl);

        return () => {
            URL.revokeObjectURL(imageUrl);
        };
    }, [receipt]);

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

        const freshToken = session.access_token;

        if (!freshToken) {
            throw new Error("No se pudo obtener el token de tu sesión.");
        }

        return freshToken;
    };

    // Cargar sesión y escuchar cambios de autenticación.
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
                console.error("Error al verificar sesión:", err);

                if (active) {
                    setToken("");
                    setError(
                        err instanceof Error
                            ? err.message
                            : "No se pudo verificar tu sesión."
                    );
                }
            } finally {
                if (active) {
                    setSessionLoading(false);
                }
            }
        };

        loadSession();

        const {
            data: { subscription }
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
        setAmount("10");
        setDepositId(null);
        setReference("");
        setReceipt(null);
        setReceiptPreview("");
        setError("");
        setCopied("");

        if (fileInput.current) {
            fileInput.current.value = "";
        }
    };

    const goBack = () => {
        if (loading) return;

        setError("");

        if (view === "receipt") {
            setView("transfer");
            setReceipt(null);
            setReceiptPreview("");

            if (fileInput.current) {
                fileInput.current.value = "";
            }

            return;
        }

        if (view === "transfer") {
            setView("home");
            return;
        }

        if (view === "success") {
            goHome();
        }
    };

    const copyValue = async (value: string, field: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(field);
            window.setTimeout(() => setCopied(""), 1800);
        } catch {
            setError(
                "No se pudo copiar. Selecciona el código y cópialo manualmente."
            );
        }
    };

    const readError = async (response: Response) => {
        try {
            const data = await response.json();

            return (
                data.detail ||
                data.message ||
                data.error ||
                `Error del servidor (${response.status}).`
            );
        } catch {
            return `El servidor respondió con un error (${response.status}).`;
        }
    };

    const createDeposit = async () => {
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

            const response = await fetch(`${API_URL}/deposits/request`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${freshToken}`
                },
                body: JSON.stringify({ amount: value })
            });

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const data = await response.json();

            if (!data.success || !data.deposit_id || !data.reference) {
                throw new Error(
                    "El servidor no devolvió los datos del depósito."
                );
            }

            setDepositId(Number(data.deposit_id));
            setReference(String(data.reference));
            setView("receipt");
        } catch (err) {
            console.error("Error al crear depósito:", err);

            if (err instanceof TypeError) {
                setError(
                    "No se pudo conectar con AXIOM. Comprueba que el servidor esté disponible y que CORS esté configurado en el backend."
                );
            } else {
                setError(
                    err instanceof Error
                        ? err.message
                        : "No se pudo generar el código de depósito."
                );
            }
        } finally {
            setLoading(false);
        }
    };

    const handleReceipt = (file?: File) => {
        setError("");
        setReceipt(null);
        setReceiptPreview("");

        if (!file) return;

        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "application/pdf"
        ];

        if (!allowedTypes.includes(file.type)) {
            setError("Selecciona un archivo JPG, PNG, WEBP o PDF.");

            if (fileInput.current) {
                fileInput.current.value = "";
            }

            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            setError("El comprobante no puede superar los 5 MB.");

            if (fileInput.current) {
                fileInput.current.value = "";
            }

            return;
        }

        setReceipt(file);
    };

    const uploadReceipt = async () => {
        setError("");

        if (!depositId || !receipt) {
            setError("Falta seleccionar el comprobante.");
            return;
        }

        setLoading(true);

        try {
            const freshToken = await getFreshAccessToken();

            const formData = new FormData();
            formData.append("file", receipt);

            const response = await fetch(
                `${API_URL}/deposits/${depositId}/receipt`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${freshToken}`
                    },
                    body: formData
                }
            );

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error(
                    data.message || "No se pudo guardar el comprobante."
                );
            }

            setView("success");
        } catch (err) {
            console.error("Error al enviar comprobante:", err);

            if (err instanceof TypeError) {
                setError(
                    "No se pudo conectar con AXIOM para enviar el comprobante. Comprueba que el servidor esté activo y que CORS esté configurado."
                );
            } else {
                setError(
                    err instanceof Error
                        ? err.message
                        : "No se pudo enviar el comprobante."
                );
            }
        } finally {
            setLoading(false);
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

                    <button
                        type="button"
                        onClick={() => {
                            setError("");
                            setView("transfer");
                        }}
                        className="group flex w-full max-w-md items-center gap-4 rounded-2xl border border-white/10 bg-[#111714] p-5 text-left transition hover:border-emerald-500/50 hover:bg-[#141e18]"
                    >
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10">
                            <Landmark className="h-7 w-7 text-emerald-400" />
                        </div>

                        <div className="flex-1">
                            <p className="font-bold">
                                Transferencia bancaria
                            </p>
                        </div>

                        <ArrowRight className="h-5 w-5 text-zinc-500 transition group-hover:translate-x-1 group-hover:text-emerald-400" />
                    </button>
                </div>
            )}

            {view !== "home" && (
                <section className="min-h-[calc(100vh-80px)] bg-[#080b0a]">
                    <div className="mx-auto max-w-5xl px-5 py-7 sm:py-10">
                        <button
                            type="button"
                            onClick={goBack}
                            disabled={loading}
                            className="mb-8 flex items-center gap-2 text-sm text-zinc-400 transition hover:text-white disabled:opacity-50"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Volver
                        </button>

                        <div className="mb-8 flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
                                <Landmark className="h-7 w-7 text-emerald-400" />
                            </div>

                            <div>
                                <h1 className="text-2xl font-bold">
                                    Transferencia bancaria
                                </h1>
                                <p className="mt-1 text-sm text-zinc-400">
                                    Deposita fondos en tu cuenta AXIOM
                                </p>
                            </div>
                        </div>

                        {view === "transfer" && (
                            <>
                                <StepIndicator current={1} />

                                <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-8">
                                    <h2 className="text-xl font-bold">
                                        Indica cuánto deseas depositar
                                    </h2>

                                    <p className="mb-7 mt-2 text-sm leading-relaxed text-zinc-400">
                                        Primero genera tu código único AXIOM.
                                        Lo necesitarás para identificar tu
                                        transferencia bancaria.
                                    </p>

                                    <label className="mb-2 block text-sm font-medium text-zinc-300">
                                        Monto en dólares
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
                                            placeholder="10.00"
                                        />
                                        <span className="text-xs text-zinc-500">
                                            USD
                                        </span>
                                    </div>

                                    <div className="mt-3 flex justify-between text-xs text-zinc-500">
                                        <span>Mínimo $10</span>
                                        <span>Máximo $10.000</span>
                                    </div>

                                    <div className="mt-7 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.05] p-4">
                                        <div className="flex gap-3">
                                            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                                            <p className="text-xs text-zinc-400">
                                                Tu solicitud tendrá un código de referencia.
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
                                        onClick={createDeposit}
                                        disabled={
                                            loading || sessionLoading || !token
                                        }
                                        className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-4 font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Generando código...
                                            </>
                                        ) : sessionLoading ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Verificando sesión...
                                            </>
                                        ) : (
                                            <>
                                                Generar código de depósito
                                                <ArrowRight className="h-5 w-5" />
                                            </>
                                        )}
                                    </button>
                                </div>
                            </>
                        )}

                        {view === "receipt" && (
                            <>
                                <StepIndicator current={2} />

                                <div className="grid gap-6 lg:grid-cols-2">
                                    <div className="rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-7">
                                        <h2 className="text-lg font-bold">
                                            1. Datos para transferir
                                        </h2>

                                        <p className="mb-6 mt-2 text-sm text-zinc-400">
                                            Transfiere el monto indicado.
                                        </p>

                                        <div className="space-y-5">
                                            {[
                                                ["Banco", BANK.name],
                                                ["Tipo de cuenta", BANK.type],
                                                ["Número de cuenta", BANK.number],
                                                ["Titular", BANK.holder],
                                                ["Cédula", BANK.identification]
                                            ].map(([label, value]) => (
                                                <div
                                                    key={label}
                                                    className="flex items-center justify-between gap-3 border-b border-white/[0.07] pb-4 last:border-0 last:pb-0"
                                                >
                                                    <div>
                                                        <p className="text-xs text-zinc-500">
                                                            {label}
                                                        </p>
                                                        <p className="mt-1 break-all text-sm font-semibold text-white">
                                                            {value}
                                                        </p>
                                                    </div>

                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            copyValue(
                                                                value,
                                                                label
                                                            )
                                                        }
                                                        className="rounded-lg border border-white/10 p-2.5 text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-400"
                                                        aria-label={`Copiar ${label}`}
                                                    >
                                                        {copied === label ? (
                                                            <Check size={17} />
                                                        ) : (
                                                            <Copy size={17} />
                                                        )}
                                                    </button>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="mt-7 rounded-xl border border-white/10 bg-black/20 p-4">
                                            <p className="text-xs text-zinc-500">
                                                Monto que debes transferir
                                            </p>
                                            <p className="mt-1 text-2xl font-bold text-white">
                                                ${Number(amount).toFixed(2)} USD
                                            </p>
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-7">
                                        <h2 className="text-lg font-bold">
                                            2. Código para los comentarios
                                        </h2>

                                        <p className="mt-2 text-sm text-zinc-400">
                                            Incluye este código en la referencia de la transferencia.
                                        </p>

                                        <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-5">
                                            <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">
                                                Tu código único AXIOM
                                            </p>

                                            <p className="mt-3 break-all font-mono text-xl font-bold tracking-wide text-white sm:text-2xl">
                                                {reference}
                                            </p>

                                            <button
                                                type="button"
                                                onClick={() =>
                                                    copyValue(
                                                        reference,
                                                        "reference"
                                                    )
                                                }
                                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/30 px-3 py-3 text-sm font-semibold text-emerald-400 transition hover:bg-emerald-500/10"
                                            >
                                                {copied === "reference" ? (
                                                    <>
                                                        <Check size={17} />
                                                        Código copiado
                                                    </>
                                                ) : (
                                                    <>
                                                        <Copy size={17} />
                                                        Copiar código
                                                    </>
                                                )}
                                            </button>
                                        </div>

                                        <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
                                            <p className="text-sm font-semibold text-amber-300">
                                                Importante
                                            </p>
                                            <p className="mt-2 text-xs text-zinc-400">
                                                Usa el código tal como aparece.
                                            </p>
                                        </div>

                                        <div className="mt-7">
                                            <h3 className="font-bold">
                                                3. Adjunta tu comprobante
                                            </h3>

                                            <p className="mt-2 text-sm text-zinc-400">
                                                Adjunta la imagen o PDF del pago.
                                            </p>

                                            <input
                                                ref={fileInput}
                                                type="file"
                                                accept=".jpg,.jpeg,.png,.webp,.pdf"
                                                className="hidden"
                                                onChange={(event) =>
                                                    handleReceipt(
                                                        event.target.files?.[0]
                                                    )
                                                }
                                            />

                                            <button
                                                type="button"
                                                onClick={() =>
                                                    fileInput.current?.click()
                                                }
                                                className="mt-4 flex w-full items-center gap-3 rounded-xl border border-dashed border-emerald-500/30 bg-black/20 p-5 text-left transition hover:border-emerald-400"
                                            >
                                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
                                                    {receipt ? (
                                                        <FileText className="h-5 w-5 text-emerald-400" />
                                                    ) : (
                                                        <Upload className="h-5 w-5 text-emerald-400" />
                                                    )}
                                                </div>

                                                <div className="min-w-0 flex-1">
                                                    <p className="break-all text-sm font-semibold">
                                                        {receipt
                                                            ? receipt.name
                                                            : "Seleccionar comprobante"}
                                                    </p>
                                                    <p className="mt-1 text-xs text-zinc-500">
                                                        JPG, PNG, WEBP o PDF ·
                                                        Máximo 5 MB
                                                    </p>
                                                </div>
                                            </button>

                                            {receiptPreview && (
                                                <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/30 p-2">
                                                    <img
                                                        src={receiptPreview}
                                                        alt="Vista previa del comprobante"
                                                        className="max-h-[420px] w-full rounded-lg object-contain"
                                                    />
                                                </div>
                                            )}

                                            {receipt &&
                                                receipt.type === "application/pdf" && (
                                                    <p className="mt-3 text-sm text-emerald-400">
                                                        PDF seleccionado: {receipt.name}
                                                    </p>
                                                )}
                                        </div>

                                        {error && (
                                            <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                                                {error}
                                            </p>
                                        )}

                                        <button
                                            type="button"
                                            onClick={uploadReceipt}
                                            disabled={loading || !receipt}
                                            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-4 font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {loading ? (
                                                <>
                                                    <Loader2 className="h-5 w-5 animate-spin" />
                                                    Enviando comprobante...
                                                </>
                                            ) : (
                                                <>
                                                    Enviar comprobante
                                                    <ArrowRight className="h-5 w-5" />
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {view === "success" && (
                            <>
                                <StepIndicator current={3} />

                                <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-[#111714] p-8 text-center">
                                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
                                        <CheckCircle2 className="h-9 w-9 text-emerald-400" />
                                    </div>

                                    <h2 className="mt-6 text-2xl font-bold">
                                        Depósito enviado
                                    </h2>

                                    <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                                        Tu comprobante fue recibido y tu
                                        solicitud quedó registrada para
                                        revisión.
                                    </p>

                                    <div className="mt-7 rounded-xl border border-white/10 bg-black/20 p-5 text-left">
                                        <p className="text-xs text-zinc-500">
                                            Código único AXIOM
                                        </p>
                                        <p className="mt-2 break-all font-mono font-bold text-emerald-400">
                                            {reference}
                                        </p>

                                        <div className="mt-5 flex justify-between text-sm">
                                            <span className="text-zinc-400">
                                                Monto
                                            </span>
                                            <span className="font-bold">
                                                ${Number(amount).toFixed(2)}
                                            </span>
                                        </div>

                                        <div className="mt-3 flex justify-between text-sm">
                                            <span className="text-zinc-400">
                                                Solicitud
                                            </span>
                                            <span className="font-bold">
                                                #{depositId}
                                            </span>
                                        </div>

                                        <div className="mt-3 flex justify-between text-sm">
                                            <span className="text-zinc-400">
                                                Estado
                                            </span>
                                            <span className="font-bold text-amber-400">
                                                PENDIENTE
                                            </span>
                                        </div>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={goHome}
                                        className="mt-7 w-full rounded-xl bg-emerald-500 px-5 py-4 font-bold text-black transition hover:bg-emerald-400"
                                    >
                                        Finalizar
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </section>
            )}
        </main>
    );
}
