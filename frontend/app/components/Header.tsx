"use client";

import { useState, useEffect, useRef, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

type AuthView = "none" | "login" | "register";

type NotificationItem = {
  id: string;
  user_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
};

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isBalanceOpen, setIsBalanceOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [docNumber, setDocNumber] = useState("");

  const [playBalance, setPlayBalance] = useState(0);
  const [withdrawBalance, setWithdrawBalance] = useState(0);
  const [bonusBalance, setBonusBalance] = useState(0);

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [readGlobalIds, setReadGlobalIds] = useState<string[]>([]);

  const [authView, setAuthView] = useState<AuthView>("none");

  const [modal, setModal] = useState({
    isOpen: false,
    title: "",
    message: "",
  });

  const [regData, setRegData] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    secondLastName: "",
    docType: "Cédula",
    docNumber: "",
    phone: "",
    birthDate: "",
    email: "",
    password: "",
    promoCode: "",
    bonusCode: "",
    referralCode: "",
    acceptsTerms: false,
  });

  const [loginData, setLoginData] = useState({
    email: "",
    password: "",
  });

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const notifChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const sessionVersionRef = useRef(0);
  const currentUserIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const showAlert = (title: string, message: string) => {
    setModal({ isOpen: true, title, message });
  };

  const closeModal = () => {
    setModal({ isOpen: false, title, message: "" });
  };

  const fetchUserBalances = async (userId: string) => {
    try {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select(
          "first_name, last_name, doc_number, balance, withdraw_balance, bonus_balance"
        )
        .eq("id", userId)
        .maybeSingle();

      if (error) throw error;

      if (profile && currentUserIdRef.current === userId && mountedRef.current) {
        setFirstName(
          `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
        );
        setDocNumber(profile.doc_number || "");
        setPlayBalance(Number(profile.balance) || 0);
        setWithdrawBalance(Number(profile.withdraw_balance) || 0);
        setBonusBalance(Number(profile.bonus_balance) || 0);
      }
    } catch (err) {
      console.error("Error cargando saldos:", err);
    }
  };

  const fetchNotifications = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, user_id, title, message, is_read, created_at")
        .or(`user_id.eq.${userId},user_id.is.null`)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;

      if (data && currentUserIdRef.current === userId && mountedRef.current) {
        setNotifications(data as NotificationItem[]);
      }
    } catch (err) {
      console.error("Error cargando notificaciones:", err);
    }
  };

  // Cargar IDs globales ya leídos desde localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("axiom_read_global_notifs");
      if (saved) {
        setReadGlobalIds(JSON.parse(saved));
      }
    } catch {
      // Ignorar si localStorage no está disponible
    }
  }, []);

  // SESIÓN, SALDOS Y NOTIFICACIONES EN TIEMPO REAL
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    const removeChannels = async () => {
      const profileCh = channelRef.current;
      channelRef.current = null;
      if (profileCh) {
        try {
          await supabase.removeChannel(profileCh);
        } catch (err) {
          console.error("Error cerrando canal de saldos:", err);
        }
      }

      const notifCh = notifChannelRef.current;
      notifChannelRef.current = null;
      if (notifCh) {
        try {
          await supabase.removeChannel(notifCh);
        } catch (err) {
          console.error("Error cerrando canal de notificaciones:", err);
        }
      }
    };

    const handleSession = async (session: any) => {
      const version = ++sessionVersionRef.current;

      if (disposed || !mountedRef.current) return;

      if (!session) {
        currentUserIdRef.current = null;

        setIsLoggedIn(false);
        setFirstName("");
        setDocNumber("");
        setPlayBalance(0);
        setWithdrawBalance(0);
        setBonusBalance(0);
        setNotifications([]);
        setIsNotifOpen(false);

        await removeChannels();
        return;
      }

      const userId = session.user.id;
      currentUserIdRef.current = userId;
      setIsLoggedIn(true);

      await removeChannels();

      if (
        disposed ||
        !mountedRef.current ||
        version !== sessionVersionRef.current ||
        currentUserIdRef.current !== userId
      ) {
        return;
      }

      await Promise.all([
        fetchUserBalances(userId),
        fetchNotifications(userId),
      ]);

      if (
        disposed ||
        !mountedRef.current ||
        version !== sessionVersionRef.current ||
        currentUserIdRef.current !== userId
      ) {
        return;
      }

      // Canal de saldos
      const profileChannel = supabase
        .channel(`profile-balances-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "profiles",
            filter: `id=eq.${userId}`,
          },
          (payload) => {
            const profile = payload.new as any;

            if (!mountedRef.current || currentUserIdRef.current !== userId) {
              return;
            }

            setFirstName(
              `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
            );
            setDocNumber(profile.doc_number || "");
            setPlayBalance(Number(profile.balance) || 0);
            setWithdrawBalance(Number(profile.withdraw_balance) || 0);
            setBonusBalance(Number(profile.bonus_balance) || 0);
          }
        )
        .subscribe();

      // Canal de notificaciones (personales y globales)
      const notifChannel = supabase
        .channel(`user-notifications-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
          },
          (payload) => {
            const newNotif = payload.new as NotificationItem;

            if (!mountedRef.current || currentUserIdRef.current !== userId) {
              return;
            }

            if (newNotif.user_id === userId || newNotif.user_id === null) {
              setNotifications((prev) => {
                if (prev.some((n) => n.id === newNotif.id)) return prev;
                return [newNotif, ...prev].slice(0, 20);
              });
            }
          }
        )
        .subscribe();

      if (
        disposed ||
        version !== sessionVersionRef.current ||
        currentUserIdRef.current !== userId
      ) {
        await supabase.removeChannel(profileChannel);
        await supabase.removeChannel(notifChannel);
        return;
      }

      channelRef.current = profileChannel;
      notifChannelRef.current = notifChannel;
    };

    const checkSession = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!disposed && mountedRef.current) {
          await handleSession(session);
        }
      } catch (err) {
        console.error("Error verificando sesión:", err);
      }
    };

    void checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void handleSession(session);
    });

    const refreshData = () => {
      const userId = currentUserIdRef.current;

      if (
        document.visibilityState === "visible" &&
        userId &&
        mountedRef.current
      ) {
        void fetchUserBalances(userId);
        void fetchNotifications(userId);
      }
    };

    window.addEventListener("focus", refreshData);
    document.addEventListener("visibilitychange", refreshData);

    return () => {
      disposed = true;
      mountedRef.current = false;
      sessionVersionRef.current++;
      currentUserIdRef.current = null;

      subscription.unsubscribe();

      window.removeEventListener("focus", refreshData);
      document.removeEventListener("visibilitychange", refreshData);

      void removeChannels();
    };
  }, []);

  // MARCAR NOTIFICACIONES COMO LEÍDAS
  const isNotificationRead = (notif: NotificationItem) => {
    if (notif.user_id === null) {
      return readGlobalIds.includes(notif.id);
    }
    return notif.is_read;
  };

  const unreadCount = notifications.filter((n) => !isNotificationRead(n)).length;

  const markAsRead = async (notif: NotificationItem) => {
    if (isNotificationRead(notif)) return;

    if (notif.user_id === null) {
      const updated = [...readGlobalIds, notif.id];
      setReadGlobalIds(updated);
      try {
        localStorage.setItem("axiom_read_global_notifs", JSON.stringify(updated));
      } catch {
        // Ignorar
      }
      return;
    }

    setNotifications((prev) =>
      prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n))
    );

    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", notif.id);
  };

  const markAllAsRead = async () => {
    const userId = currentUserIdRef.current;
    if (!userId) return;

    const globalIds = notifications
      .filter((n) => n.user_id === null)
      .map((n) => n.id);

    if (globalIds.length > 0) {
      const merged = Array.from(new Set([...readGlobalIds, ...globalIds]));
      setReadGlobalIds(merged);
      try {
        localStorage.setItem("axiom_read_global_notifs", JSON.stringify(merged));
      } catch {
        // Ignorar
      }
    }

    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));

    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", userId)
      .eq("is_read", false);
  };

  // REGISTRO
  const handleRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();

    try {
      const { data: existingDoc, error: docError } = await supabase
        .from("profiles")
        .select("id")
        .eq("doc_number", regData.docNumber)
        .maybeSingle();

      if (docError) throw docError;

      if (existingDoc) {
        showAlert(
          "Documento Duplicado",
          "Ya existe una cuenta registrada con este número de documento."
        );
        return;
      }

      const enteredReferralCode = regData.referralCode.trim().toUpperCase();
      let referredBy: string | null = null;

      if (enteredReferralCode) {
        const { data: referrer, error: referralError } = await supabase
          .from("profiles")
          .select("id")
          .eq("referral_code", enteredReferralCode)
          .maybeSingle();

        if (referralError) throw referralError;

        if (!referrer) {
          showAlert(
            "Código de Referido Inválido",
            "El código de referido que ingresaste no existe. Verifica el código o deja el campo vacío para continuar sin referido."
          );
          return;
        }

        referredBy = referrer.id;
      }

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: regData.email,
        password: regData.password,
      });

      if (authError) throw authError;

      if (authData.user) {
        const ownReferralCode =
          "AX" +
          authData.user.id.replace(/-/g, "").slice(0, 8).toUpperCase();

        const { error: profileError } = await supabase.from("profiles").insert([
          {
            id: authData.user.id,
            first_name: regData.firstName,
            middle_name: regData.middleName,
            last_name: regData.lastName,
            second_last_name: regData.secondLastName,
            doc_type: regData.docType,
            doc_number: regData.docNumber,
            phone: regData.phone,
            birth_date: regData.birthDate,
            promo_code: regData.promoCode,
            bonus_code: regData.bonusCode,
            referral_code: ownReferralCode,
            referred_by: referredBy,
            balance: 0.0,
            withdraw_balance: 0.0,
            bonus_balance: 0.0,
          },
        ]);

        if (profileError) throw profileError;
      }

      showAlert(
        "¡Registro Exitoso!",
        "Tu cuenta ha sido creada en AXIOM. Ya puedes iniciar sesión."
      );

      setAuthView("none");

      setRegData({
        firstName: "",
        middleName: "",
        lastName: "",
        secondLastName: "",
        docType: "Cédula",
        docNumber: "",
        phone: "",
        birthDate: "",
        email: "",
        password: "",
        promoCode: "",
        bonusCode: "",
        referralCode: "",
        acceptsTerms: false,
      });
    } catch (error: any) {
      showAlert("Error de Registro", error.message);
    }
  };

  // INICIO DE SESIÓN
  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginData.email,
        password: loginData.password,
      });

      if (error) throw error;

      showAlert("¡Bienvenido!", "Sesión iniciada correctamente.");
      setAuthView("none");
      setLoginData({ email: "", password: "" });
    } catch (error: any) {
      showAlert("Error de Autenticación", error.message);
    }
  };

  // INTERFAZ
  return (
    <>
      {isMenuOpen && (
        <div
          onClick={() => setIsMenuOpen(false)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40 transition-opacity"
        />
      )}

      {/* BARRA LATERAL */}
      <aside
        className={`fixed top-0 left-0 h-full w-72 bg-zinc-950 border-r border-zinc-800 z-50 p-6 flex flex-col justify-between transform transition-transform duration-300 ${
          isMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="space-y-6">
          {/* ARRIBA: USUARIO + ID (CÉDULA) + CERRAR */}
          <div className="flex items-start justify-between gap-2 pb-4 border-b border-zinc-900">
            <div className="min-w-0">
              {isLoggedIn ? (
                <>
                  <p className="text-sm font-black text-white truncate">
                    {firstName || "Usuario AXIOM"}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-emerald-400">
                    ID:{" "}
                    <span className="font-mono text-zinc-200">
                      {docNumber || "No registrado"}
                    </span>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-black text-white">Invitado</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    ID: Sin sesión activa
                  </p>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              className="text-zinc-500 hover:text-white text-xl font-bold shrink-0"
            >
              ✕
            </button>
          </div>

          {/* NAVEGACIÓN PRINCIPAL */}
          <nav className="space-y-2">
            <a
              href="/"
              onClick={() => setIsMenuOpen(false)}
              className="flex items-center gap-3 px-4 py-3 bg-zinc-900 text-emerald-400 font-bold text-xs uppercase tracking-wider rounded-xl border border-zinc-800"
            >
              Juegos Online
            </a>
          </nav>
        </div>

        {/* HASTA ABAJO: SOLO NOMBRES COMO ENLACES */}
        <div className="pt-4 border-t border-zinc-900 flex flex-col space-y-2.5 text-xs font-semibold text-zinc-400">
          <a
            href="/legal?tab=terminos"
            onClick={() => setIsMenuOpen(false)}
            className="hover:text-emerald-400 transition"
          >
            Términos y Condiciones
          </a>
          <a
            href="/legal?tab=juego"
            onClick={() => setIsMenuOpen(false)}
            className="hover:text-emerald-400 transition"
          >
            Políticas de Juego
          </a>
          <a
            href="/legal?tab=kyc"
            onClick={() => setIsMenuOpen(false)}
            className="hover:text-emerald-400 transition"
          >
            Política KYC y AML
          </a>
        </div>
      </aside>

      <header className="w-full bg-zinc-950/90 border-b border-zinc-900 sticky top-0 z-30 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setIsMenuOpen(true)}
              className="p-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl border border-zinc-800 transition-all active:scale-95"
            >
              <span className="text-lg leading-none">☰</span>
            </button>

            <h1 className="text-xl font-black text-emerald-400 tracking-widest uppercase">
              AXIOM
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {!isLoggedIn ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAuthView("login")}
                  className="px-3.5 py-2 text-xs font-bold text-zinc-300 hover:text-white uppercase transition-all"
                >
                  Iniciar Sesión
                </button>

                <button
                  type="button"
                  onClick={() => setAuthView("register")}
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95"
                >
                  Registrarse
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 sm:gap-3">
                <span className="text-xs sm:text-sm font-bold text-white max-w-[100px] sm:max-w-none truncate">
                  {firstName}
                </span>

                <a
                  href="/deposito"
                  className="flex items-center gap-2 px-3 py-2 bg-emerald-500 hover:bg-emerald-400 text-black border border-emerald-400 rounded-xl transition-all shadow-lg shadow-emerald-500/10 active:scale-95"
                >
                  <span className="text-[10px] sm:text-xs font-black uppercase tracking-wide">
                    + Depositar
                  </span>
                </a>

                {/* DROPDOWN DE SALDO */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setIsBalanceOpen(!isBalanceOpen);
                      setIsNotifOpen(false);
                    }}
                    className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3.5 py-2 rounded-xl transition-all"
                  >
                    <span className="text-[10px] text-zinc-400 font-bold uppercase">
                      Saldo:
                    </span>
                    <span className="text-xs font-black text-emerald-400">
                      ${playBalance.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-zinc-500">▼</span>
                  </button>

                  {isBalanceOpen && (
                    <div className="absolute right-0 mt-2 w-56 bg-zinc-900 border border-zinc-800 rounded-2xl p-4 shadow-2xl z-50 text-xs space-y-3">
                      <div className="flex justify-between items-center border-b border-zinc-800/80 pb-2">
                        <span className="text-zinc-400 font-medium">
                          Saldo:
                        </span>
                        <span className="font-black text-emerald-400">
                          ${playBalance.toFixed(2)}
                        </span>
                      </div>

                      <div className="flex justify-between items-center border-b border-zinc-800/80 pb-2">
                        <span className="text-zinc-400 font-medium">
                          Saldo para Retirar:
                        </span>
                        <span className="font-black text-white">
                          ${withdrawBalance.toFixed(2)}
                        </span>
                      </div>

                      <div className="flex justify-between items-center">
                        <span className="text-zinc-400 font-medium">
                          Saldo Bono:
                        </span>
                        <span className="font-black text-yellow-400">
                          ${bonusBalance.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* CAMPANA DE NOTIFICACIONES */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setIsNotifOpen(!isNotifOpen);
                      setIsBalanceOpen(false);
                    }}
                    title="Notificaciones"
                    aria-label="Notificaciones"
                    className="relative flex items-center justify-center p-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-xl transition-all active:scale-95"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                    </svg>

                    {unreadCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-emerald-500 text-black text-[10px] font-black rounded-full flex items-center justify-center shadow">
                        {unreadCount > 9 ? "9+" : unreadCount}
                      </span>
                    )}
                  </button>

                  {isNotifOpen && (
                    <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl z-50 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
                        <span className="text-xs font-black uppercase tracking-wider text-emerald-400">
                          Mensajes ({unreadCount})
                        </span>

                        {unreadCount > 0 && (
                          <button
                            type="button"
                            onClick={markAllAsRead}
                            className="text-[11px] font-bold text-zinc-400 hover:text-white transition"
                          >
                            Marcar leídos
                          </button>
                        )}
                      </div>

                      <div className="max-h-80 overflow-y-auto divide-y divide-zinc-800/80">
                        {notifications.length === 0 ? (
                          <div className="p-6 text-center text-xs text-zinc-500">
                            No tienes mensajes nuevos.
                          </div>
                        ) : (
                          notifications.map((notif) => {
                            const read = isNotificationRead(notif);
                            return (
                              <div
                                key={notif.id}
                                onClick={() => markAsRead(notif)}
                                className={`p-3.5 cursor-pointer transition hover:bg-zinc-800/60 ${
                                  read ? "opacity-65" : "bg-emerald-500/[0.04]"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs font-bold text-white">
                                    {notif.title}
                                  </p>
                                  {!read && (
                                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                                  )}
                                </div>

                                <p className="mt-1 text-xs text-zinc-300 leading-relaxed">
                                  {notif.message}
                                </p>

                                <p className="mt-1.5 text-[10px] text-zinc-500">
                                  {new Date(notif.created_at).toLocaleString(
                                    "es-EC",
                                    {
                                      day: "2-digit",
                                      month: "short",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    }
                                  )}
                                </p>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* BOTÓN PERFIL */}
                <a
                  href="/perfil"
                  title="Mi perfil"
                  aria-label="Mi perfil"
                  className="flex items-center justify-center p-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-xl transition-all active:scale-95"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 21a8 8 0 0 0-16 0" />
                    <circle cx="12" cy="8" r="4" />
                  </svg>
                </a>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* MODAL DE AUTENTICACIÓN */}
      {authView !== "none" && (
        <div className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-md flex items-start justify-center overflow-y-auto p-4">
          <div
            className={`w-full ${
              authView === "register" ? "max-w-2xl" : "max-w-md"
            } bg-zinc-950 border border-zinc-800 rounded-3xl p-8 shadow-2xl space-y-6 my-auto`}
          >
            {authView === "login" ? (
              <>
                <div className="text-center">
                  <h2 className="text-2xl font-black uppercase text-emerald-400 tracking-wider">
                    Iniciar Sesión
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1">
                    Ingresa a tu cuenta en AXIOM
                  </p>
                </div>

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Correo Electrónico
                    </label>
                    <input
                      type="email"
                      required
                      value={loginData.email}
                      onChange={(e) =>
                        setLoginData({ ...loginData, email: e.target.value })
                      }
                      placeholder="tucorreo@dominio.com"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Contraseña
                    </label>
                    <input
                      type="password"
                      required
                      value={loginData.password}
                      onChange={(e) =>
                        setLoginData({ ...loginData, password: e.target.value })
                      }
                      placeholder="••••••••"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95"
                  >
                    Entrar
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="text-center">
                  <h2 className="text-2xl font-black uppercase text-emerald-400 tracking-wider">
                    Crear Cuenta
                  </h2>
                  <p className="text-xs text-zinc-500 mt-1">
                    Completa tus datos personales para unirte a AXIOM
                  </p>
                </div>

                <form
                  onSubmit={handleRegisterSubmit}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-4"
                >
                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Primer Nombre
                    </label>
                    <input
                      type="text"
                      required
                      value={regData.firstName}
                      onChange={(e) =>
                        setRegData({ ...regData, firstName: e.target.value })
                      }
                      placeholder="Ingrese su primer nombre"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Segundo Nombre
                    </label>
                    <input
                      type="text"
                      value={regData.middleName}
                      onChange={(e) =>
                        setRegData({ ...regData, middleName: e.target.value })
                      }
                      placeholder="Ingrese su segundo nombre"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Primer Apellido
                    </label>
                    <input
                      type="text"
                      required
                      value={regData.lastName}
                      onChange={(e) =>
                        setRegData({ ...regData, lastName: e.target.value })
                      }
                      placeholder="Ingrese su primer apellido"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Segundo Apellido
                    </label>
                    <input
                      type="text"
                      value={regData.secondLastName}
                      onChange={(e) =>
                        setRegData({
                          ...regData,
                          secondLastName: e.target.value,
                        })
                      }
                      placeholder="Ingrese su segundo apellido"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="sm:col-span-2 grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                        Tipo Doc.
                      </label>
                      <select
                        value={regData.docType}
                        onChange={(e) =>
                          setRegData({ ...regData, docType: e.target.value })
                        }
                        className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                      >
                        <option value="Cédula">Cédula</option>
                        <option value="Pasaporte">Pasaporte</option>
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                        Número de Documento
                      </label>
                      <input
                        type="text"
                        required
                        value={regData.docNumber}
                        onChange={(e) =>
                          setRegData({
                            ...regData,
                            docNumber: e.target.value,
                          })
                        }
                        placeholder="Número de cédula o pasaporte"
                        className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Número de Celular
                    </label>
                    <input
                      type="tel"
                      required
                      value={regData.phone}
                      onChange={(e) =>
                        setRegData({ ...regData, phone: e.target.value })
                      }
                      placeholder="09xxxxxxxx"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Fecha de Nacimiento
                    </label>
                    <input
                      type="date"
                      required
                      value={regData.birthDate}
                      onChange={(e) =>
                        setRegData({ ...regData, birthDate: e.target.value })
                      }
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Correo Electrónico
                    </label>
                    <input
                      type="email"
                      required
                      value={regData.email}
                      onChange={(e) =>
                        setRegData({ ...regData, email: e.target.value })
                      }
                      placeholder="tucorreo@dominio.com"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Contraseña
                    </label>
                    <input
                      type="password"
                      required
                      value={regData.password}
                      onChange={(e) =>
                        setRegData({ ...regData, password: e.target.value })
                      }
                      placeholder="••••••••"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Código de Bono (Opcional)
                    </label>
                    <input
                      type="text"
                      value={regData.bonusCode}
                      onChange={(e) =>
                        setRegData({ ...regData, bonusCode: e.target.value })
                      }
                      placeholder="BONUS10"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-zinc-400 block mb-1">
                      Código de Referido (Opcional)
                    </label>
                    <input
                      type="text"
                      value={regData.referralCode}
                      onChange={(e) =>
                        setRegData({
                          ...regData,
                          referralCode: e.target.value.toUpperCase(),
                        })
                      }
                      placeholder="AX12AB34CD"
                      className="w-full bg-black border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="sm:col-span-2 pt-2 space-y-4">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        required
                        checked={regData.acceptsTerms}
                        onChange={(e) =>
                          setRegData({
                            ...regData,
                            acceptsTerms: e.target.checked,
                          })
                        }
                        className="mt-1 h-4 w-4 accent-emerald-500 shrink-0 cursor-pointer"
                      />

                      <span className="text-xs text-zinc-300 leading-relaxed">
                        Declaro que soy mayor de 18 años y acepto los{" "}
                        <a
                          href="/legal?tab=terminos"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-emerald-400 font-bold underline hover:text-emerald-300"
                        >
                          Términos y Condiciones
                        </a>
                        , las{" "}
                        <a
                          href="/legal?tab=juego"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-emerald-400 font-bold underline hover:text-emerald-300"
                        >
                          Políticas de Juego
                        </a>{" "}
                        y la{" "}
                        <a
                          href="/legal?tab=kyc"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-emerald-400 font-bold underline hover:text-emerald-300"
                        >
                          Política KYC
                        </a>{" "}
                        de AXIOM.
                      </span>
                    </label>

                    <button
                      type="submit"
                      className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95"
                    >
                      Completar Registro
                    </button>
                  </div>
                </form>
              </>
            )}

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => setAuthView("none")}
                className="text-xs text-zinc-500 hover:text-white underline"
              >
                ← Volver al inicio
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE ALERTAS */}
      {modal.isOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 w-full max-w-sm rounded-2xl p-6 shadow-2xl text-center space-y-4">
            <h3 className="text-lg font-black uppercase text-emerald-400 tracking-wider">
              {modal.title}
            </h3>

            <p className="text-xs text-zinc-300 leading-relaxed">
              {modal.message}
            </p>

            <button
              type="button"
              onClick={closeModal}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all active:scale-95"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
}