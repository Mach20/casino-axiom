"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import Link from "next/link";
import Header from "../components/Header";
import {
    UserRound, Users, Wallet, Landmark, Gift, LogOut,
    ChevronRight, Copy, Eye, EyeOff, ArrowLeftRight,
    Plus, X, Menu, LockKeyhole, Pencil, Trash2
} from "lucide-react";

type Section = "datos" | "referidos" | "retiros" | "verificacion" | "bancos" | "bonos";

type BankAccount = {
    id: string;
    bank_name: string;
    account_type: string;
    account_number: string;
    account_holder: string;
    document_number: string;
};

type Movement = {
    id: string;
    kind: "retiro" | "conversion";
    amount: number;
    status: string;
    created_at: string;
    bank_fee?: number;
    net_amount?: number;
};

const sections = [
    { id: "datos" as Section, title: "Datos del usuario", detail: "Información personal y seguridad", icon: UserRound },
    { id: "referidos" as Section, title: "Referidos", detail: "Código promocional y ganancias", icon: Users },
    { id: "retiros" as Section, title: "Retiros y transferencias", detail: "Administra tus fondos", icon: Wallet },
    // Reservado para una etapa futura: validación de identidad y mayoría de edad.
    // { id: "verificacion" as Section, title: "Verificar cuenta", detail: "Identidad y mayoría de edad", icon: ShieldCheck },
    { id: "bancos" as Section, title: "Cuentas bancarias", detail: "Cuentas para recibir retiros", icon: Landmark },
    { id: "bonos" as Section, title: "Canjear bono", detail: "Códigos promocionales", icon: Gift },
];

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div className="mb-6">
            <h2 className="text-xl font-bold text-white sm:text-2xl">{title}</h2>
            <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
        </div>
    );
}

function Input({
    label,
    placeholder,
    type = "text",
    readOnly = false,
    value
}: {
    label: string;
    placeholder?: string;
    type?: string;
    readOnly?: boolean;
    value?: string;
}) {
    return (
        <label className="block space-y-2">
            <span className="text-sm font-medium text-zinc-300">{label}</span>
            <input
                type={type}
                placeholder={placeholder}
                value={value}
                readOnly={readOnly}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500 read-only:opacity-60"
            />
        </label>
    );
}

export default function PerfilPage() {
    const [section, setSection] = useState<Section>("datos");
    const [mobileOpen, setMobileOpen] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [withdrawTab, setWithdrawTab] = useState<"retirar" | "convertir">("retirar");
    const [convertAmount, setConvertAmount] = useState("");
    const [bonusCode, setBonusCode] = useState("");
    const [bonusMessage, setBonusMessage] = useState("");
    const [bonusMessageType, setBonusMessageType] = useState<"success" | "error">("error");
    const [bonusBusy, setBonusBusy] = useState(false);
    const [chatMessage, setChatMessage] = useState("");
    const [bankForm, setBankForm] = useState(false);
    const [editingBankId, setEditingBankId] = useState<string | null>(null);
    const [profile, setProfile] = useState<any>(null);
    const [userEmail, setUserEmail] = useState("");
    const [profileLoading, setProfileLoading] = useState(true);
    const [profileError, setProfileError] = useState("");

    const [referralDashboard, setReferralDashboard] = useState<any>(null);
    const [referralLoading, setReferralLoading] = useState(false);
    const [referralError, setReferralError] = useState("");
    const [referralCopied, setReferralCopied] = useState(false);

    // Retiros y cuentas bancarias
    const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
    const [bankLoading, setBankLoading] = useState(false);
    const [bankName, setBankName] = useState("");
    const [bankType, setBankType] = useState("");
    const [bankNumber, setBankNumber] = useState("");
    const [bankHolder, setBankHolder] = useState("");
    const [bankDocument, setBankDocument] = useState("");
    const [withdrawAmount, setWithdrawAmount] = useState("");
    const [selectedBank, setSelectedBank] = useState("");
    const [withdrawBusy, setWithdrawBusy] = useState(false);
    const [convertBusy, setConvertBusy] = useState(false);
    const [bankActionBusy, setBankActionBusy] = useState(false);
    const [signOutBusy, setSignOutBusy] = useState(false);
    const [withdrawRequestKey, setWithdrawRequestKey] = useState<string | null>(null);
    const [conversionRequestKey, setConversionRequestKey] = useState<string | null>(null);
    const [bankMessage, setBankMessage] = useState("");
    const [bankMessageType, setBankMessageType] = useState<"success" | "error" | "info">("info");
    const [movements, setMovements] = useState<Movement[]>([]);
    const [movementsLoading, setMovementsLoading] = useState(false);

    const active = sections.find(s => s.id === section)!;

    useEffect(() => {
        let mounted = true;
        let profileChannel: ReturnType<typeof supabase.channel> | null = null;

        const loadProfile = async (userId: string, email: string) => {
            setProfileLoading(true);
            setProfileError("");
            setUserEmail(email || "");

            const { data, error } = await supabase
                .from("profiles")
                .select("id, first_name, middle_name, last_name, second_last_name, doc_type, doc_number, phone, birth_date, bonus_code, created_at, balance, withdraw_balance, bonus_balance, referral_code, referred_by")
                .eq("id", userId)
                .maybeSingle();

            if (!mounted) return;

            if (error) {
                setProfileError(error.message);
                setProfile(null);
            } else if (!data) {
                setProfileError("No encontramos un registro en profiles para esta cuenta.");
                setProfile(null);
            } else {
                setProfile(data);
            }

            setProfileLoading(false);

            if (profileChannel) await supabase.removeChannel(profileChannel);

            profileChannel = supabase
                .channel(`perfil-${userId}`)
                .on("postgres_changes", {
                    event: "UPDATE",
                    schema: "public",
                    table: "profiles",
                    filter: `id=eq.${userId}`,
                }, (payload) => {
                    if (mounted) setProfile(payload.new as any);
                })
                .subscribe();
        };

        const initialize = async () => {
            const { data: { session } } = await supabase.auth.getSession();

            if (!mounted) return;

            if (session?.user) {
                await loadProfile(session.user.id, session.user.email || "");
            } else {
                setProfileLoading(false);
                setProfileError("Inicia sesión para consultar tu perfil.");
            }
        };

        void initialize();

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!mounted) return;

            if (profileChannel) {
                void supabase.removeChannel(profileChannel);
                profileChannel = null;
            }

            if (session?.user) {
                void loadProfile(session.user.id, session.user.email || "");
            } else {
                setProfile(null);
                setReferralDashboard(null);
                setUserEmail("");
                setProfileLoading(false);
                setProfileError("Inicia sesión para consultar tu perfil.");
            }
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
            if (profileChannel) void supabase.removeChannel(profileChannel);
        };
    }, []);

    // ============================================================
    // CARGAR INFORMACIÓN DEL PROGRAMA DE REFERIDOS
    // ============================================================

    useEffect(() => {
        if (!profile?.id) {
            setReferralDashboard(null);
            return;
        }

        let mounted = true;

        const loadReferralDashboard = async () => {
            setReferralLoading(true);
            setReferralError("");

            const { data, error } = await supabase.rpc(
                "get_axiom_referral_dashboard"
            );

            if (!mounted) return;

            if (error) {
                console.error("Error cargando referidos:", error.message);
                setReferralError("No se pudo cargar la información de referidos.");
                setReferralDashboard(null);
            } else {
                setReferralDashboard(data);
            }

            setReferralLoading(false);
        };

        void loadReferralDashboard();

        return () => {
            mounted = false;
        };
    }, [profile?.id]);

    // ============================================================
    // CUENTAS BANCARIAS E HISTORIAL DE MOVIMIENTOS
    // ============================================================

    const loadBankAccounts = async (userId: string) => {
        setBankLoading(true);

        const { data, error } = await supabase
            .from("bank_accounts")
            .select("id, bank_name, account_type, account_number, account_holder, document_number")
            .eq("user_id", userId)
            .order("created_at", { ascending: false });

        if (!error) {
            const accounts = (data || []) as BankAccount[];
            setBankAccounts(accounts);

            setSelectedBank(current =>
                accounts.some(account => account.id === current)
                    ? current
                    : accounts[0]?.id || ""
            );
        } else {
            setBankAccounts([]);
        }

        setBankLoading(false);
    };

    const loadMovements = async (userId: string) => {
        setMovementsLoading(true);

        const [withdrawalsResult, conversionsResult] = await Promise.all([
            supabase
                .from("withdrawal_requests")
                .select("id, amount, bank_fee, net_amount, status, created_at")
                .eq("user_id", userId)
                .order("created_at", { ascending: false }),
            supabase
                .from("wallet_conversions")
                .select("id, amount, created_at")
                .eq("user_id", userId)
                .order("created_at", { ascending: false }),
        ]);

        const withdrawalItems: Movement[] = (withdrawalsResult.data || []).map((item: any) => ({
            id: item.id,
            kind: "retiro",
            amount: Number(item.amount),
            bank_fee: Number(item.bank_fee),
            net_amount: Number(item.net_amount),
            status: item.status,
            created_at: item.created_at,
        }));

        const conversionItems: Movement[] = (conversionsResult.data || []).map((item: any) => ({
            id: item.id,
            kind: "conversion",
            amount: Number(item.amount),
            status: "realizado",
            created_at: item.created_at,
        }));

        setMovements([...withdrawalItems, ...conversionItems]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));

        setMovementsLoading(false);
    };

    useEffect(() => {
        if (!profile?.id) {
            setBankAccounts([]);
            setMovements([]);
            return;
        }

        void loadBankAccounts(profile.id);
        void loadMovements(profile.id);
    }, [profile?.id]);

    // ============================================================
    // LIMPIAR FORMULARIO BANCARIO
    // ============================================================

    const resetBankForm = () => {
        setBankName("");
        setBankType("");
        setBankNumber("");
        setBankHolder("");
        setBankDocument("");
        setEditingBankId(null);
    };

    // ============================================================
    // AGREGAR O ACTUALIZAR CUENTA BANCARIA
    // ============================================================

    const saveBankAccount = async () => {
        if (!profile?.id) return;

        if (
            !bankName.trim() ||
            !bankType ||
            !bankNumber.trim() ||
            !bankHolder.trim() ||
            !bankDocument.trim()
        ) {
            setBankMessageType("error");
            setBankMessage("Completa todos los datos de la cuenta bancaria.");
            return;
        }

        setWithdrawBusy(true);
        setBankMessage("");

        const accountData = {
            bank_name: bankName.trim(),
            account_type: bankType,
            account_number: bankNumber.trim(),
            account_holder: bankHolder.trim(),
            document_number: bankDocument.trim(),
        };

        let error;

        if (editingBankId) {
            const result = await supabase
                .from("bank_accounts")
                .update(accountData)
                .eq("id", editingBankId)
                .eq("user_id", profile.id);

            error = result.error;
        } else {
            const result = await supabase
                .from("bank_accounts")
                .insert({
                    user_id: profile.id,
                    ...accountData,
                });

            error = result.error;
        }

        setWithdrawBusy(false);

        if (error) {
            setBankMessageType("error");
            setBankMessage(
                editingBankId
                    ? "No se pudo actualizar la cuenta. Inténtalo nuevamente."
                    : "No se pudo guardar la cuenta. Revisa los datos e inténtalo nuevamente."
            );
            return;
        }

        const wasEditing = Boolean(editingBankId);

        setBankMessageType("success");
        setBankMessage(
            wasEditing
                ? "Tu cuenta bancaria se actualizó correctamente."
                : "Tu cuenta bancaria se guardó correctamente."
        );

        resetBankForm();
        setBankForm(false);

        await loadBankAccounts(profile.id);
    };

    // ============================================================
    // CARGAR CUENTA EN EL FORMULARIO PARA EDITAR
    // ============================================================

    const editBankAccount = (account: BankAccount) => {
        setEditingBankId(account.id);
        setBankName(account.bank_name);
        setBankType(account.account_type);
        setBankNumber(account.account_number);
        setBankHolder(account.account_holder);
        setBankDocument(account.document_number);
        setBankForm(true);
        setBankMessage("");
    };

    // ============================================================
    // ELIMINAR CUENTA BANCARIA
    // ============================================================

    const deleteBankAccount = async (account: BankAccount) => {
        if (!profile?.id || bankActionBusy) return;

        const confirmed = window.confirm(
            `¿Estás seguro de que deseas eliminar la cuenta ${account.bank_name} terminada en ${account.account_number.slice(-4)}?`
        );

        if (!confirmed) return;

        setBankActionBusy(true);
        setBankMessage("");

        const { error } = await supabase
            .from("bank_accounts")
            .delete()
            .eq("id", account.id)
            .eq("user_id", profile.id);

        setBankActionBusy(false);

        if (error) {
            setBankMessageType("error");
            setBankMessage("No se pudo eliminar la cuenta. Inténtalo nuevamente.");
            return;
        }

        if (editingBankId === account.id) {
            resetBankForm();
            setBankForm(false);
        }

        setBankMessageType("success");
        setBankMessage("La cuenta bancaria se eliminó correctamente.");

        await loadBankAccounts(profile.id);
    };

    // ============================================================
    // CERRAR SESIÓN DIRECTAMENTE DESDE EL MENÚ
    // ============================================================

    const handleSignOut = async () => {
        if (signOutBusy) return;

        setSignOutBusy(true);

        const { error } = await supabase.auth.signOut();

        if (error) {
            setSignOutBusy(false);
            alert("No se pudo cerrar la sesión. Inténtalo nuevamente.");
            return;
        }

        window.location.assign("/");
    };

    const submitWithdrawal = async () => {
        const amount = Number(withdrawAmount);
        if (!profile?.id) return;

        if (!Number.isFinite(amount) || amount < 10) {
            setBankMessageType("error");
            setBankMessage("El retiro mínimo es de $10,00.");
            return;
        }

        if (!selectedBank) {
            setBankMessageType("error");
            setBankMessage("Primero registra y selecciona una cuenta bancaria.");
            return;
        }

        if (amount > Number(profile.withdraw_balance || 0)) {
            setBankMessageType("error");
            setBankMessage("No tienes saldo suficiente para este retiro.");
            return;
        }

        setWithdrawBusy(true);
        setBankMessage("");

        const requestKey = withdrawRequestKey || crypto.randomUUID();
        setWithdrawRequestKey(requestKey);

        const { data, error } = await supabase.rpc("request_bank_withdrawal", {
            p_bank_account_id: selectedBank,
            p_amount: amount,
            p_request_key: requestKey,
        });

        setWithdrawBusy(false);

        if (error || !data?.success) {
            setBankMessageType("error");
            setBankMessage("No se pudo registrar el retiro. Verifica tu saldo e inténtalo nuevamente.");
            return;
        }

        setWithdrawRequestKey(null);
        setBankMessageType("success");
        setBankMessage(`Solicitud registrada. Recibirás $${(amount - 0.50).toFixed(2)} después de la comisión bancaria. Tu solicitud está pendiente de revisión.`);
        setWithdrawAmount("");

        await Promise.all([
            loadMovements(profile.id),
            (async () => {
                const { data: updatedProfile } = await supabase
                    .from("profiles")
                    .select("id, first_name, middle_name, last_name, second_last_name, doc_type, doc_number, phone, birth_date, bonus_code, created_at, balance, withdraw_balance, bonus_balance, referral_code, referred_by")
                    .eq("id", profile.id)
                    .maybeSingle();

                if (updatedProfile) setProfile(updatedProfile);
            })(),
        ]);
    };

    const submitConversion = async () => {
        const amount = Number(convertAmount);
        if (!profile?.id) return;

        if (!Number.isFinite(amount) || amount <= 0) {
            setBankMessageType("error");
            setBankMessage("Ingresa un monto válido para convertir.");
            return;
        }

        if (amount > Number(profile.withdraw_balance || 0)) {
            setBankMessageType("error");
            setBankMessage("No tienes saldo suficiente para esta conversión.");
            return;
        }

        setConvertBusy(true);
        setBankMessage("");

        const transactionKey = conversionRequestKey || crypto.randomUUID();
        setConversionRequestKey(transactionKey);

        const { data, error } = await supabase.rpc("convert_withdraw_balance", {
            p_amount: amount,
            p_transaction_key: transactionKey,
        });

        setConvertBusy(false);

        if (error || !data?.success) {
            setBankMessageType("error");
            setBankMessage("No se pudo completar la conversión. Verifica tu saldo e inténtalo nuevamente.");
            return;
        }

        setConversionRequestKey(null);
        setBankMessageType("success");
        setBankMessage(`Se convirtieron $${amount.toFixed(2)} a tu saldo para jugar.`);
        setConvertAmount("");

        await Promise.all([
            loadMovements(profile.id),
            (async () => {
                const { data: updatedProfile } = await supabase
                    .from("profiles")
                    .select("id, first_name, middle_name, last_name, second_last_name, doc_type, doc_number, phone, birth_date, bonus_code, created_at, balance, withdraw_balance, bonus_balance, referral_code, referred_by").eq("id", profile.id)
                    .maybeSingle();

                if (updatedProfile) setProfile(updatedProfile);
            })(),
        ]);
    };

    const money = (value: unknown) => Number(value ?? 0).toFixed(2);

    const displayDate = (value?: string | null) =>
        value ? new Date(value).toLocaleDateString("es-EC") : "—";

    const selectSection = (id: Section) => {
        setSection(id);
        setMobileOpen(false);
    };

    const comingSoon = (feature: string) =>
        alert(`${feature}: lo conectaremos con Supabase en la siguiente etapa.`);

    const prepareBonusRedemption = async () => {
        const code = bonusCode.trim().toUpperCase();

        if (!code) {
            setBonusMessageType("error");
            setBonusMessage("Escribe un código promocional.");
            return;
        }

        if (!profile?.id) {
            setBonusMessageType("error");
            setBonusMessage("Inicia sesión para canjear un bono.");
            return;
        }

        if (bonusBusy) return;

        setBonusCode(code);
        setBonusBusy(true);
        setBonusMessage("");

        try {
            const { data, error } = await supabase.rpc("redeem_axiom_bonus", {
                p_code: code,
            });

            if (error) {
                const errorText = error.message.toLowerCase();

                if (errorText.includes("already") || errorText.includes("duplicate") || errorText.includes("unique")) {
                    setBonusMessage("Ya utilizaste este código promocional.");
                } else {
                    setBonusMessage("No se pudo canjear el código. Comprueba que sea válido e inténtalo nuevamente.");
                }

                setBonusMessageType("error");
                return;
            }

            if (!data?.success) {
                const reason = String(data?.message || data?.error || "").toLowerCase();

                if (reason.includes("already") || reason.includes("duplicate") || reason.includes("used") || reason.includes("utilizado")) {
                    setBonusMessage("Ya utilizaste este código promocional.");
                } else if (reason.includes("expired") || reason.includes("vencido") || reason.includes("expirado")) {
                    setBonusMessage("Este código promocional ha vencido.");
                } else if (reason.includes("inactive") || reason.includes("inactivo")) {
                    setBonusMessage("Este código promocional no está activo.");
                } else {
                    setBonusMessage("El código no es válido o no está disponible.");
                }

                setBonusMessageType("error");
                return;
            }

            setBonusMessageType("success");
            setBonusMessage(
                `¡Felicidades! se acreditaron $${Number(data.amount).toFixed(2)} a tu saldo.`
            );

            setBonusCode("");

            const { data: updatedProfile, error: profileRefreshError } = await supabase
                .from("profiles")
                .select("id, first_name, middle_name, last_name, second_last_name, doc_type, doc_number, phone, birth_date, bonus_code, created_at, balance, withdraw_balance, bonus_balance, referral_code, referred_by")
                .eq("id", profile.id)
                .maybeSingle();

            if (!profileRefreshError && updatedProfile) {
                setProfile(updatedProfile);
            }

        } catch {
            setBonusMessageType("error");
            setBonusMessage("Ocurrió un problema al procesar el código. Inténtalo nuevamente.");
        } finally {
            setBonusBusy(false);
        }
    };

    // ============================================================
    // COPIAR CÓDIGO DE REFERIDO
    // ============================================================

    const copyReferralCode = async () => {
        const code = referralDashboard?.referral_code;

        if (!code) {
            alert("Todavía no tienes un código de referido disponible.");
            return;
        }

        try {
            await navigator.clipboard.writeText(code);
            setReferralCopied(true);
            setTimeout(() => setReferralCopied(false), 2000);
        } catch {
            alert("No se pudo copiar el código. Inténtalo nuevamente.");
        }
    };

    const referralList = Array.isArray(referralDashboard?.referral_list)
        ? referralDashboard.referral_list
        : [];

    return (
        <>
            <Header />

            <main className="min-h-screen bg-[#090b0a] px-4 pb-12 pt-8 text-white sm:px-6 lg:px-8">
                <div className="mx-auto max-w-7xl">
                    <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.25em] text-emerald-400"></div>
                            <h1 className="text-3xl font-black sm:text-4xl">Mi perfil</h1>
                            <p className="mt-2 text-sm text-zinc-400">Administra tu cuenta.</p>
                        </div>

                        <Link href="/" className="inline-flex w-fit items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-300 hover:text-white">
                            Volver <ChevronRight className="h-4 w-4" />
                        </Link>
                    </header>

                    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                        <aside className="h-fit rounded-2xl border border-zinc-800 bg-[#101311] p-3">
                            <button onClick={() => setMobileOpen(v => !v)} className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left lg:hidden">
                                <span className="flex items-center gap-3">
                                    <active.icon className="h-5 w-5 text-emerald-400" />
                                    {active.title}
                                </span>
                                <Menu className="h-5 w-5" />
                            </button>

                            <nav className={`${mobileOpen ? "block" : "hidden"} space-y-1 lg:block`}>
                                {sections.map(item => {
                                    const Icon = item.icon;
                                    const selected = section === item.id;

                                    return (
                                        <button
                                            key={item.id}
                                            onClick={() => selectSection(item.id)}
                                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${selected ? "border border-emerald-500/20 bg-emerald-500/10 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-white"}`}
                                        >
                                            <Icon className={`h-5 w-5 shrink-0 ${selected ? "text-emerald-400" : ""}`} />
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-sm font-semibold">{item.title}</span>
                                                <span className="mt-0.5 block text-xs text-zinc-500">{item.detail}</span>
                                            </span>
                                            <ChevronRight className="h-4 w-4 shrink-0" />
                                        </button>
                                    );
                                })}

                                {/* BOTÓN DIRECTO PARA CERRAR SESIÓN */}
                                <button
                                    type="button"
                                    onClick={handleSignOut}
                                    disabled={signOutBusy}
                                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-red-400 transition hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <LogOut className="h-5 w-5 shrink-0" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-semibold">
                                            {signOutBusy ? "Cerrando sesión..." : "Cerrar sesión"}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-zinc-500">
                                            Salir de AXIOM
                                        </span>
                                    </span>
                                    <ChevronRight className="h-4 w-4 shrink-0" />
                                </button>
                            </nav>
                        </aside>

                        <section className="min-w-0 rounded-2xl border border-zinc-800 bg-[#101311] p-4 sm:p-6 lg:p-8">

                            {section === "datos" && <>
                                <Heading title="Datos del usuario" subtitle="Consulta tu información." />

                                {profileError && <div className="mb-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">{profileError}</div>}

                                <div className="mb-6 grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo</p>
                                        <p className="mt-2 text-2xl font-black text-emerald-400">${money(profile?.balance)}</p>
                                    </div>
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo para retirar</p>
                                        <p className="mt-2 text-2xl font-black">${money(profile?.withdraw_balance)}</p>
                                    </div>
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo bono</p>
                                        <p className="mt-2 text-2xl font-black text-yellow-400">${money(profile?.bonus_balance)}</p>
                                    </div>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Input label="Primer nombre" value={profile?.first_name || ""} placeholder={profileLoading ? "Cargando..." : "—"} readOnly />
                                    <Input label="Segundo nombre" value={profile?.middle_name || ""} placeholder="—" readOnly />
                                    <Input label="Primer apellido" value={profile?.last_name || ""} placeholder="—" readOnly />
                                    <Input label="Segundo apellido" value={profile?.second_last_name || ""} placeholder="—" readOnly />
                                    <Input label="Correo electrónico" value={userEmail} placeholder="—" readOnly />
                                    <Input label="Teléfono" value={profile?.phone || ""} placeholder="—" readOnly />
                                    <Input label="Tipo de documento" value={profile?.doc_type || ""} placeholder="—" readOnly />
                                    <Input label="Número de documento" value={profile?.doc_number || ""} placeholder="—" readOnly />
                                    <Input label="Fecha de nacimiento" value={displayDate(profile?.birth_date)} placeholder="—" readOnly />
                                </div>

                                <div className="my-8 border-t border-zinc-800" />

                                <div className="mb-5 flex items-center gap-2">
                                    <LockKeyhole className="h-5 w-5 text-emerald-400" />
                                    <h3 className="font-bold">Cambiar contraseña</h3>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <label className="block space-y-2 sm:col-span-2">
                                        <span className="text-sm font-medium text-zinc-300">Contraseña actual</span>
                                        <div className="relative">
                                            <input type={showPassword ? "text" : "password"} placeholder="Contraseña actual" className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 pr-12 text-sm outline-none focus:border-emerald-500" />
                                            <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500">
                                                {showPassword ? <EyeOff /> : <Eye />}
                                            </button>
                                        </div>
                                    </label>
                                    <Input label="Nueva contraseña" type="password" placeholder="Mínimo 8 caracteres" />
                                    <Input label="Confirmar contraseña" type="password" placeholder="Repite la contraseña" />
                                </div>

                                <button onClick={() => comingSoon("Cambio de contraseña")} className="mt-5 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-bold text-black hover:bg-emerald-400">
                                    Actualizar contraseña
                                </button>
                            </>}

                            {/* ================================================== */}
                            {/* REFERIDOS CONECTADOS A SUPABASE */}
                            {/* ================================================== */}

                            {section === "referidos" && <>
                                <Heading title="Programa de referidos" subtitle="Invita a tus amigos y recibe el 2% de sus apuestas." />

                                <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
                                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Código único</p>

                                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div>
                                            <p className="text-xl font-black text-white">
                                                {referralLoading ? "Cargando..." : referralDashboard?.referral_code || "Código no disponible"}
                                            </p>
                                            <p className="mt-1 text-xs text-zinc-400">
                                                Comparte este código para que tus amigos se registren en AXIOM.
                                            </p>
                                        </div>

                                        <button
                                            onClick={copyReferralCode}
                                            disabled={!referralDashboard?.referral_code || referralLoading}
                                            className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <Copy className="h-4 w-4" />
                                            {referralCopied ? "¡Copiado!" : "Copiar código"}
                                        </button>
                                    </div>
                                </div>

                                {referralError && (
                                    <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
                                        {referralError}
                                    </div>
                                )}

                                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Referidos</p>
                                        <p className="mt-2 text-2xl font-black">
                                            {referralLoading ? "..." : referralDashboard?.referrals ?? 0}
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Ganancias por referidos</p>
                                        <p className="mt-2 text-2xl font-black text-emerald-400">
                                            ${money(referralDashboard?.earnings)}
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo total para retirar</p>
                                        <p className="mt-2 text-2xl font-black">
                                            ${money(referralDashboard?.withdraw_balance)}
                                        </p>
                                    </div>
                                </div>

                                <p className="mt-3 text-xs text-zinc-500">
                                    El saldo para retirar incluye todas tus ganancias disponibles, no solamente las comisiones por referidos.
                                </p>

                                <div className="mt-6">
                                    <h3 className="mb-3 font-bold">Tus referidos</h3>

                                    {referralLoading ? (
                                        <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
                                            <p className="text-sm text-zinc-400">Cargando tus referidos...</p>
                                        </div>
                                    ) : referralList.length > 0 ? (
                                        <div className="overflow-hidden rounded-xl border border-zinc-800">
                                            <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3 text-xs font-semibold text-zinc-500">
                                                <span>Usuario referido</span>
                                                <span>Fecha de registro</span>
                                            </div>

                                            {referralList.map((person: any, index: number) => (
                                                <div
                                                    key={`${person.created_at || "referido"}-${index}`}
                                                    className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-zinc-800/70 px-4 py-4 last:border-b-0"
                                                >
                                                    <div className="flex min-w-0 items-center gap-3">
                                                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                                                            <Users className="h-4 w-4" />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="truncate text-sm font-semibold text-white">
                                                                {[person.first_name, person.last_name].filter(Boolean).join(" ") || "Usuario AXIOM"}
                                                            </p>
                                                            <p className="text-xs text-zinc-500">Referido</p>
                                                        </div>
                                                    </div>

                                                    <span className="text-right text-xs text-zinc-400">
                                                        {displayDate(person.created_at)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center">
                                            <Users className="mx-auto h-8 w-8 text-zinc-600" />
                                            <p className="mt-3 text-sm font-semibold text-zinc-300">Todavía no hay actividad</p>
                                            <p className="mt-1 text-xs text-zinc-500">
                                                Aquí aparecerán las personas que se registren con tu código.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </>}

                            {section === "retiros" && <>
                                <Heading title="Retiros y transferencias" subtitle="Solicita tu transferencia o convierte tu saldo en saldo para seguir jugando." />

                                <div className="mb-5 grid gap-3 sm:grid-cols-2">
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo para retirar</p>
                                        <p className="mt-2 text-3xl font-black">${money(profile?.withdraw_balance)}</p>
                                    </div>
                                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                        <p className="text-xs text-zinc-500">Saldo para jugar</p>
                                        <p className="mt-2 text-3xl font-black">${money(profile?.balance)}</p>
                                    </div>
                                </div>

                                {bankMessage && (
                                    <div className={`mb-5 rounded-xl border p-4 text-sm ${bankMessageType === "success"
                                        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                                        : bankMessageType === "error"
                                            ? "border-red-500/20 bg-red-500/5 text-red-300"
                                            : "border-zinc-700 bg-zinc-900 text-zinc-300"
                                        }`}>
                                        {bankMessage}
                                    </div>
                                )}

                                <div className="mb-5 flex rounded-xl bg-zinc-950 p-1">
                                    <button onClick={() => { setWithdrawTab("retirar"); setBankMessage(""); }} className={`flex-1 rounded-lg px-3 py-3 text-sm font-semibold ${withdrawTab === "retirar" ? "bg-emerald-500 text-black" : "text-zinc-400"}`}>
                                        Solicitar retiro
                                    </button>
                                    <button onClick={() => { setWithdrawTab("convertir"); setBankMessage(""); }} className={`flex-1 rounded-lg px-3 py-3 text-sm font-semibold ${withdrawTab === "convertir" ? "bg-emerald-500 text-black" : "text-zinc-400"}`}>
                                        Convertir
                                    </button>
                                </div>

                                {withdrawTab === "retirar" ? (
                                    <div className="space-y-4 rounded-xl border border-zinc-800 p-4 sm:p-5">
                                        <h3 className="font-bold">Transferencia bancaria</h3>

                                        <label className="block space-y-2">
                                            <span className="text-sm font-medium text-zinc-300">Monto que deseas retirar</span>
                                            <input
                                                value={withdrawAmount}
                                                onChange={e => setWithdrawAmount(e.target.value)}
                                                inputMode="decimal"
                                                placeholder="Mínimo $10.00"
                                                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none focus:border-emerald-500"
                                            />
                                        </label>

                                        <label className="block space-y-2">
                                            <span className="text-sm font-medium text-zinc-300">Elige tu cuenta bancaria</span>
                                            <select
                                                value={selectedBank}
                                                onChange={e => setSelectedBank(e.target.value)}
                                                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white"
                                            >
                                                <option value="">
                                                    {bankLoading ? "Cargando cuentas..." : "Selecciona una cuenta"}
                                                </option>
                                                {bankAccounts.map(account => (
                                                    <option key={account.id} value={account.id}>
                                                        {account.bank_name} · {account.account_type} · ****{account.account_number.slice(-4)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
                                            <div className="flex justify-between">
                                                <span>Comisión bancaria</span>
                                                <span>$0.50</span>
                                            </div>
                                            <div className="mt-2 flex justify-between font-semibold text-white">
                                                <span>Recibirás</span>
                                                <span>${Math.max(0, Number(withdrawAmount || 0) - 0.50).toFixed(2)}</span>
                                            </div>
                                            <p className="mt-2 text-xs text-zinc-500">
                                                Mínimo de retiro: $10. La comisión está incluida en el monto solicitado.
                                            </p>
                                        </div>

                                        <button
                                            onClick={submitWithdrawal}
                                            disabled={withdrawBusy || bankLoading || !bankAccounts.length}
                                            className="w-full rounded-xl bg-emerald-500 px-5 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {withdrawBusy ? "Procesando..." : "Solicitar retiro"}
                                        </button>

                                        {!bankAccounts.length && !bankLoading && (
                                            <p className="text-center text-xs text-zinc-500">
                                                Primero agrega una cuenta bancaria en la sección Cuentas bancarias.
                                            </p>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-4 rounded-xl border border-zinc-800 p-4 sm:p-5">
                                        <div className="flex items-center gap-2">
                                            <ArrowLeftRight className="h-5 w-5 text-emerald-400" />
                                            <h3 className="font-bold">Convertir saldo para retirar en saldo para jugar</h3>
                                        </div>

                                        <p className="text-sm text-zinc-400">
                                            Puedes convertir cualquier monto disponible, sin comisión.
                                        </p>

                                        <label className="block space-y-2">
                                            <span className="text-sm font-medium text-zinc-300">Monto a convertir</span>
                                            <input
                                                value={convertAmount}
                                                onChange={e => setConvertAmount(e.target.value)}
                                                inputMode="decimal"
                                                placeholder="0.00"
                                                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm outline-none focus:border-emerald-500"
                                            />
                                        </label>

                                        <button
                                            onClick={submitConversion}
                                            disabled={convertBusy}
                                            className="w-full rounded-xl bg-emerald-500 px-5 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {convertBusy ? "Convirtiendo..." : "Convertir saldo"}
                                        </button>
                                    </div>
                                )}

                                <div className="mt-6">
                                    <h3 className="mb-3 font-bold">Historial de movimientos</h3>

                                    {movementsLoading ? (
                                        <div className="rounded-xl border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
                                            Cargando movimientos...
                                        </div>
                                    ) : movements.length ? (
                                        <div className="overflow-hidden rounded-xl border border-zinc-800">
                                            {movements.map(movement => (
                                                <div key={`${movement.kind}-${movement.id}`} className="flex flex-col gap-2 border-b border-zinc-800 p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                                                    <div>
                                                        <p className="text-sm font-semibold text-white">
                                                            {movement.kind === "retiro" ? "Retiro bancario" : "Conversión a saldo para jugar"}
                                                        </p>
                                                        <p className="mt-1 text-xs text-zinc-500">
                                                            {new Date(movement.created_at).toLocaleString("es-EC")}
                                                        </p>
                                                        {movement.kind === "retiro" && (
                                                            <p className="mt-1 text-xs text-zinc-500">
                                                                Comisión: ${money(movement.bank_fee)} · Neto: ${money(movement.net_amount)}
                                                            </p>
                                                        )}
                                                    </div>

                                                    <div className="sm:text-right">
                                                        <p className="font-bold">${money(movement.amount)}</p>
                                                        <p className={`mt-1 text-xs font-semibold ${movement.status === "realizado" ? "text-emerald-400" :
                                                            movement.status === "rechazado" ? "text-red-400" : "text-amber-400"
                                                            }`}>
                                                            {movement.status === "pendiente" ? "Pendiente" : movement.status === "rechazado" ? "Rechazado" : "Realizado"}
                                                        </p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-xl border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
                                            Todavía no tienes movimientos.
                                        </div>
                                    )}
                                </div>
                            </>}

                            {/*
                             * VALIDACIÓN DE CUENTA — RESERVADA PARA MÁS ADELANTE.
                             * Se conserva este bloque para implementarlo cuando AXIOM
                             * habilite la revisión de identidad y mayoría de edad.
                             *
                            {section === "verificacion" && <>
                                <Heading title="Verificar cuenta" subtitle="Confirma tu identidad y que cumples con la mayoría de edad." />

                                <div className="mb-5 flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                                    <Clock3 className="h-5 w-5 shrink-0 text-amber-400" />
                                    <div>
                                        <p className="font-semibold text-amber-200">Estado de verificación: pendiente</p>
                                        <p className="mt-1 text-xs text-zinc-400">El estado real aparecerá al conectar el proceso.</p>
                                    </div>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-3">
                                    {["Confirmar identidad", "Comprobar mayoría de edad", "Revisión del equipo"].map((s, i) => (
                                        <div key={s} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                            <span className="text-xs font-bold text-emerald-400">PASO 0{i + 1}</span>
                                            <p className="mt-2 text-sm font-semibold">{s}</p>
                                        </div>
                                    ))}
                                </div>

                                <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                    <div className="mb-4 flex items-center gap-2">
                                        <CircleHelp className="h-5 w-5 text-emerald-400" />
                                        <h3 className="font-bold">Chat de verificación</h3>
                                        <span className="ml-auto text-[10px] text-zinc-500">Vista previa</span>
                                    </div>
                                    <div className="mb-4 min-h-36 rounded-xl bg-[#0b0e0c] p-4">
                                        <div className="max-w-[85%] rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300">
                                            Hola. Aquí podrás comunicarte con el equipo de AXIOM para recibir instrucciones y completar tu verificación.
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <input value={chatMessage} onChange={e => setChatMessage(e.target.value)} placeholder="Escribe tu mensaje..." className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm outline-none focus:border-emerald-500" />
                                        <button onClick={() => comingSoon("Chat de verificación")} className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-bold text-black">Enviar</button>
                                    </div>
                                </div>
                                <p className="mt-4 text-xs text-zinc-500">La verificación deberá ser revisada por personal autorizado. No envíes documentos por canales externos.</p>
                            </>}

                            */}

                            {section === "bancos" && <>
                                <Heading title="Cuentas bancarias" subtitle="Guarda las cuentas que utilizarás para recibir tus retiros." />

                                {bankMessage && (
                                    <div className={`mb-5 rounded-xl border p-4 text-sm ${bankMessageType === "success"
                                        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                                        : bankMessageType === "error"
                                            ? "border-red-500/20 bg-red-500/5 text-red-300"
                                            : "border-zinc-700 bg-zinc-900 text-zinc-300"
                                        }`}>
                                        {bankMessage}
                                    </div>
                                )}

                                <div className="mb-5 flex flex-col justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4 sm:flex-row sm:items-center">
                                    <div>
                                        <p className="font-semibold">Tus cuentas registradas</p>
                                        <p className="mt-1 text-xs text-zinc-500">
                                            {bankLoading ? "Cargando cuentas..." : `${bankAccounts.length} cuenta(s) registrada(s).`}
                                        </p>
                                    </div>

                                    <button
                                        onClick={() => {
                                            if (bankForm) {
                                                resetBankForm();
                                                setBankForm(false);
                                            } else {
                                                resetBankForm();
                                                setBankForm(true);
                                            }
                                            setBankMessage("");
                                        }}
                                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-bold text-black"
                                    >
                                        {bankForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                                        {bankForm ? "Cancelar" : "Agregar cuenta"}
                                    </button>
                                </div>

                                {bankAccounts.length > 0 && (
                                    <div className="mb-5 space-y-3">
                                        {bankAccounts.map(account => (
                                            <div key={account.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                                    <div className="flex items-start gap-3">
                                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
                                                            <Landmark className="h-5 w-5 text-emerald-400" />
                                                        </div>

                                                        <div className="min-w-0">
                                                            <p className="font-semibold text-white">{account.bank_name}</p>
                                                            <p className="mt-1 text-xs text-zinc-400">
                                                                {account.account_type} · ****{account.account_number.slice(-4)}
                                                            </p>
                                                            <p className="mt-1 text-xs text-zinc-500">{account.account_holder}</p>
                                                        </div>
                                                    </div>

                                                    <div className="flex gap-2 sm:shrink-0">
                                                        <button
                                                            type="button"
                                                            onClick={() => editBankAccount(account)}
                                                            disabled={bankActionBusy || withdrawBusy}
                                                            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 sm:flex-none"
                                                        >
                                                            <Pencil className="h-4 w-4" />
                                                            Editar
                                                        </button>

                                                        <button
                                                            type="button"
                                                            onClick={() => deleteBankAccount(account)}
                                                            disabled={bankActionBusy || withdrawBusy}
                                                            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50 sm:flex-none"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                            {bankActionBusy ? "Procesando..." : "Eliminar"}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {bankForm && (
                                    <div className="space-y-4 rounded-xl border border-zinc-800 p-4 sm:p-5">
                                        <h3 className="font-bold">
                                            {editingBankId ? "Editar cuenta bancaria" : "Registrar cuenta bancaria"}
                                        </h3>

                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <label className="block space-y-2">
                                                <span className="text-sm font-medium text-zinc-300">Nombre del banco</span>
                                                <select
                                                    value={bankName}
                                                    onChange={e => setBankName(e.target.value)}
                                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white"
                                                >
                                                    <option value="">Selecciona tu banco</option>
                                                    <option value="Banco Pichincha">Banco Pichincha</option>
                                                    <option value="Banco Guayaquil">Banco Guayaquil</option>
                                                    <option value="Banco del Pacífico">Banco del Pacífico</option>
                                                    <option value="Banco Bolivariano">Banco Bolivariano</option>
                                                    <option value="Produbanco">Produbanco</option>
                                                    <option value="Banco Internacional">Banco Internacional</option>
                                                    <option value="Banco del Austro">Banco del Austro</option>
                                                    <option value="Banco Solidario">Banco Solidario</option>
                                                    <option value="Banco de Loja">Banco de Loja</option>
                                                    <option value="BanEcuador">BanEcuador</option>
                                                    <option value="Banco General Rumiñahui">Banco General Rumiñahui</option>
                                                    <option value="Otros">Otros</option>
                                                </select>
                                            </label>

                                            <label className="block space-y-2">
                                                <span className="text-sm font-medium text-zinc-300">Tipo de cuenta</span>
                                                <select
                                                    value={bankType}
                                                    onChange={e => setBankType(e.target.value)}
                                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white"
                                                >
                                                    <option value="">Selecciona</option>
                                                    <option value="Ahorros">Ahorros</option>
                                                    <option value="Corriente">Corriente</option>
                                                </select>
                                            </label>

                                            <label className="block space-y-2">
                                                <span className="text-sm font-medium text-zinc-300">Número de cuenta</span>
                                                <input
                                                    value={bankNumber}
                                                    onChange={e => setBankNumber(e.target.value)}
                                                    inputMode="numeric"
                                                    placeholder="Número de cuenta bancaria"
                                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none focus:border-emerald-500"
                                                />
                                            </label>

                                            <label className="block space-y-2">
                                                <span className="text-sm font-medium text-zinc-300">Titular de la cuenta</span>
                                                <input
                                                    value={bankHolder}
                                                    onChange={e => setBankHolder(e.target.value)}
                                                    placeholder="Nombre completo"
                                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none focus:border-emerald-500"
                                                />
                                            </label>

                                            <label className="block space-y-2 sm:col-span-2">
                                                <span className="text-sm font-medium text-zinc-300">Cédula del titular</span>
                                                <input
                                                    value={bankDocument}
                                                    onChange={e => setBankDocument(e.target.value)}
                                                    inputMode="numeric"
                                                    placeholder="Número de identificación"
                                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-white outline-none focus:border-emerald-500"
                                                />
                                            </label>
                                        </div>

                                        <div className="flex flex-col gap-2 sm:flex-row">
                                            <button
                                                onClick={saveBankAccount}
                                                disabled={withdrawBusy}
                                                className="w-full rounded-xl bg-emerald-500 px-5 py-3 font-bold text-black disabled:opacity-50"
                                            >
                                                {withdrawBusy
                                                    ? (editingBankId ? "Actualizando..." : "Guardando...")
                                                    : (editingBankId ? "Guardar cambios" : "Guardar cuenta bancaria")}
                                            </button>

                                            {editingBankId && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        resetBankForm();
                                                        setBankForm(false);
                                                        setBankMessage("");
                                                    }}
                                                    disabled={withdrawBusy}
                                                    className="w-full rounded-xl border border-zinc-700 px-5 py-3 font-semibold text-zinc-300 hover:bg-zinc-900 sm:w-auto"
                                                >
                                                    Cancelar edición
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </>}

                            {section === "bonos" && <>
                                <Heading
                                    title="Canjear bono"
                                    subtitle="Introduce un código promocional y recibe tu beneficio."
                                />



                                <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-7">
                                    <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10">
                                        <Gift className="h-7 w-7 text-emerald-400" />
                                    </div>

                                    <h3 className="text-center text-lg font-bold text-white">
                                        Canjea tu código
                                    </h3>

                                    <p className="mx-auto mt-2 max-w-md text-center text-sm text-zinc-500">
                                        Introduce tu cupon.
                                    </p>

                                    <div className="mx-auto mt-6 flex max-w-lg flex-col gap-3 sm:flex-row">
                                        <input
                                            value={bonusCode}
                                            onChange={e => {
                                                setBonusCode(e.target.value.toUpperCase());
                                                setBonusMessage("");
                                            }}
                                            onKeyDown={e => {
                                                if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    void prepareBonusRedemption();
                                                }
                                            }}
                                            placeholder="ESCRIBE TU CÓDIGO"
                                            maxLength={40}
                                            disabled={bonusBusy}
                                            className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-[#090b0a] px-4 py-3 text-center text-sm font-bold tracking-widest text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500 disabled:opacity-50"
                                        />

                                        <button
                                            type="button"
                                            onClick={prepareBonusRedemption}
                                            disabled={bonusBusy || !bonusCode.trim()}
                                            className="rounded-xl bg-emerald-500 px-6 py-3 text-sm font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {bonusBusy ? "Canjeando..." : "Canjear"}
                                        </button>
                                    </div>

                                    {bonusMessage && (
                                        <div className={`mx-auto mt-4 max-w-lg rounded-xl border p-4 text-center text-sm font-semibold ${bonusMessageType === "success"
                                            ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300"
                                            : "border-red-500/20 bg-red-500/5 text-red-300"
                                            }`}>
                                            {bonusMessage}
                                        </div>
                                    )}
                                </div>

                                <div className="mt-7">
                                    <div className="mb-3 flex items-center justify-between">
                                        <h3 className="font-bold text-white">Mis bonos</h3>
                                        <span className="text-xs text-zinc-500">Historial</span>
                                    </div>

                                    <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950/50 p-8 text-center">
                                        <Gift className="mx-auto h-8 w-8 text-zinc-600" />
                                        <p className="mt-3 text-sm font-semibold text-zinc-300">
                                            Historial de bonos
                                        </p>
                                        <p className="mt-1 text-xs text-zinc-500">
                                            Aquí aparecerán tus códigos canjeados y los beneficios recibidos.
                                        </p>
                                    </div>
                                </div>
                            </>}
                        </section>
                    </div>
                </div>
            </main>
        </>
    );
}