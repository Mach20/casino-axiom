"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase";

const API = "https://casino-axiom.ethiodeploy.app";

type Section = "resumen" | "clientes" | "bonos" | "retiros" | "depositos";

type Client = {
  id: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  second_last_name?: string;
  doc_type?: string;
  doc_number?: string;
  phone?: string;
  birth_date?: string;
  balance?: number;
  withdraw_balance?: number;
  bonus_balance?: number;
  referral_code?: string;
  bonus_code?: string;
};

type Bonus = {
  id: number;
  code: string;
  amount: number;
  is_active: boolean;
  starts_at?: string;
  expires_at?: string;
  max_uses?: number;
  uses_count?: number;
};

type RequestRow = {
  id: string | number;
  user_id: string;
  amount: number;
  status: string;
  method?: string;
  bank_name?: string;
  account_type?: string;
  account_number?: string;
  account_holder?: string;
  document_number?: string;
  bank_fee?: number;
  net_amount?: number;
  admin_note?: string;
  created_at?: string;
  receipt_path?: string;
  payment_url?: string;
  provider_reference?: string;
  client?: Client;
};

const money = (value: number | undefined) =>
  `$${Number(value || 0).toFixed(2)}`;

const dateText = (value?: string) =>
  value ? new Date(value).toLocaleString("es-EC") : "—";

const clientName = (client?: Client) => {
  if (!client) return "Cliente";
  return [
    client.first_name,
    client.middle_name,
    client.last_name,
    client.second_last_name,
  ]
    .filter(Boolean)
    .join(" ") || "Cliente";
};

export default function AdminPage() {
  const [section, setSection] = useState<Section>("resumen");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [summary, setSummary] = useState<any>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientTotal, setClientTotal] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  
  const [bonuses, setBonuses] = useState<Bonus[]>([]);
  const [bonusSearch, setBonusSearch] = useState("");

  const [deposits, setDeposits] = useState<RequestRow[]>([]);
  const [withdrawals, setWithdrawals] = useState<RequestRow[]>([]);
  const [requestFilter, setRequestFilter] = useState("");
  const [requestSearch, setRequestSearch] = useState("");

  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [wallet, setWallet] = useState("play");
  const [walletAmount, setWalletAmount] = useState("");

  const [bonusCode, setBonusCode] = useState("");
  const [bonusAmount, setBonusAmount] = useState("");
  const [bonusMaxUses, setBonusMaxUses] = useState("");
  const [bonusStarts, setBonusStarts] = useState("");
  const [bonusExpires, setBonusExpires] = useState("");

  const [adminNote, setAdminNote] = useState("");

  const api = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail || data.message || "No se pudo completar la operación."
        );
      }

      return data;
    },
    [token]
  );

  const loadSection = useCallback(async () => {
    if (!token) return;

    setLoading(true);
    setError("");
    setNotice("");

    try {
      if (section === "resumen") {
        setSummary(await api("/admin/summary"));
      }

      if (section === "clientes") {
        const query = new URLSearchParams({
          q: clientSearch,
          limit: "100",
          offset: "0",
        });

        const data = await api(`/admin/clients?${query.toString()}`);
        setClients(data.clients || []);
        setClientTotal(data.total || 0);
      }

      if (section === "bonos") {
        const data = await api("/admin/bonuses");
        setBonuses(data.bonuses || []);
      }

      if (section === "retiros") {
        const query = requestFilter
          ? `?status=${encodeURIComponent(requestFilter)}`
          : "";
        const data = await api(`/admin/withdrawals${query}`);
        setWithdrawals(data.withdrawals || []);
      }

      if (section === "depositos") {
        const query = requestFilter
          ? `?status=${encodeURIComponent(requestFilter)}`
          : "";
        const data = await api(`/admin/deposits${query}`);
        setDeposits(data.deposits || []);
      }
    } catch (err: any) {
      setError(err.message || "Error cargando información.");
    } finally {
      setLoading(false);
    }
  }, [token, section, clientSearch, requestFilter, api]);

  useEffect(() => {
    let active = true;

    const initialize = async () => {
      const { data } = await supabase.auth.getSession();

      if (!active) return;

      if (!data.session) {
        setError("Debes iniciar sesión para entrar al administrador.");
        setLoading(false);
        return;
      }

      setToken(data.session.access_token);
    };

    initialize();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (active) {
          setToken(session?.access_token || "");
          if (!session) {
            setError("Tu sesión ha terminado. Inicia sesión nuevamente.");
          }
        }
      }
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (token) loadSection();
  }, [token, loadSection]);

  const perform = async (
    operation: () => Promise<any>,
    successMessage: string
  ) => {
    setBusy(true);
    setError("");
    setNotice("");

    try {
      await operation();
      setNotice(successMessage);
      await loadSection();
    } catch (err: any) {
      setError(err.message || "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  };

  const saveClient = async () => {
    if (!editingClient) return;

    const fields = [
      "first_name",
      "middle_name",
      "last_name",
      "second_last_name",
      "doc_type",
      "doc_number",
      "phone",
      "birth_date",
      "bonus_code",
      "referral_code",
    ];

    const payload: Record<string, any> = {};

    fields.forEach((field) => {
      payload[field] = (editingClient as any)[field] || null;
    });

    await perform(
      async () => {
        await api(`/admin/clients/${editingClient.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setEditingClient(null);
      },
      "Datos del cliente actualizados."
    );
  };

  const adjustWallet = async (userId: string) => {
    const amount = Number(walletAmount);

    if (!Number.isFinite(amount) || amount === 0) {
      setError("Ingresa un monto válido distinto de cero.");
      return;
    }

    await perform(
      () =>
        api(`/admin/clients/${userId}/balance`, {
          method: "POST",
          body: JSON.stringify({ wallet, amount }),
        }),
      "Saldo ajustado correctamente."
    );

    setWalletAmount("");
  };

  const createBonus = async (event: React.FormEvent) => {
    event.preventDefault();

    await perform(
      () =>
        api("/admin/bonuses", {
          method: "POST",
          body: JSON.stringify({
            code: bonusCode.trim().toUpperCase(),
            amount: Number(bonusAmount),
            max_uses: bonusMaxUses ? Number(bonusMaxUses) : null,
            starts_at: bonusStarts
              ? new Date(bonusStarts).toISOString()
              : null,
            expires_at: bonusExpires
              ? new Date(bonusExpires).toISOString()
              : null,
            is_active: true,
          }),
        }),
      "Bono creado correctamente."
    );

    setBonusCode("");
    setBonusAmount("");
    setBonusMaxUses("");
    setBonusStarts("");
    setBonusExpires("");
  };

  const toggleBonus = async (bonus: Bonus) => {
    await perform(
      () =>
        api(`/admin/bonuses/${bonus.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: !bonus.is_active }),
        }),
      bonus.is_active ? "Bono desactivado." : "Bono activado."
    );
  };

  const updateBonus = async (bonus: Bonus) => {
    const amount = window.prompt(
      "Nuevo monto del bono:",
      String(bonus.amount)
    );

    if (amount === null) return;

    const maxUses = window.prompt(
      "Máximo de usos (vacío = sin límite):",
      bonus.max_uses == null ? "" : String(bonus.max_uses)
    );

    if (maxUses === null) return;

    await perform(
      () =>
        api(`/admin/bonuses/${bonus.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            amount: Number(amount),
            max_uses: maxUses.trim() ? Number(maxUses) : null,
          }),
        }),
      "Bono actualizado."
    );
  };

  const requestAction = async (
    type: "deposit" | "withdrawal",
    id: string | number,
    action: "approve" | "reject" | "complete"
  ) => {
    const labels: Record<string, string> = {
      approve: "aprobar",
      reject: "rechazar",
      complete: "marcar como completado",
    };

    if (!window.confirm(`¿Confirmas ${labels[action]} esta solicitud?`)) {
      return;
    }

    const base = type === "deposit" ? "deposits" : "withdrawals";

    const body =
      action === "approve" && type === "deposit"
        ? undefined
        : JSON.stringify({ admin_note: adminNote || null });

    await perform(
      () =>
        api(`/admin/${base}/${id}/${action}`, {
          method: "POST",
          ...(body ? { body } : {}),
        }),
      "Solicitud actualizada correctamente."
    );

    setAdminNote("");
  };

  // Filtrado local en tiempo real para bonos y solicitudes
  const filteredBonuses = useMemo(() => {
    if (!bonusSearch.trim()) return bonuses;
    const term = bonusSearch.toLowerCase();
    return bonuses.filter((b) => b.code.toLowerCase().includes(term));
  }, [bonuses, bonusSearch]);

  const filteredWithdrawals = useMemo(() => {
    if (!requestSearch.trim()) return withdrawals;
    const term = requestSearch.toLowerCase();
    return withdrawals.filter(
      (r) =>
        String(r.id).toLowerCase().includes(term) ||
        clientName(r.client).toLowerCase().includes(term) ||
        (r.document_number && r.document_number.toLowerCase().includes(term))
    );
  }, [withdrawals, requestSearch]);

  const filteredDeposits = useMemo(() => {
    if (!requestSearch.trim()) return deposits;
    const term = requestSearch.toLowerCase();
    return deposits.filter(
      (r) =>
        String(r.id).toLowerCase().includes(term) ||
        clientName(r.client).toLowerCase().includes(term) ||
        (r.document_number && r.document_number.toLowerCase().includes(term))
    );
  }, [deposits, requestSearch]);

  const menu: { id: Section; label: string; icon: string }[] = [
    { id: "resumen", label: "Resumen", icon: "▦" },
    { id: "clientes", label: "Clientes", icon: "♙" },
    { id: "bonos", label: "Bonos", icon: "◇" },
    { id: "retiros", label: "Retiros", icon: "↗" },
    { id: "depositos", label: "Depósitos", icon: "↙" },
  ];

  const inputClass =
    "w-full rounded-xl border border-zinc-700/80 bg-zinc-900/90 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";

  const buttonClass =
    "rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-emerald-400 active:scale-95 disabled:opacity-50";

  const secondaryButton =
    "rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800 hover:border-zinc-600 active:scale-95 disabled:opacity-50";

  const statusStyle = (status: string) => {
    if (["aprobado", "confirmado", "completado"].includes(status)) {
      return "border-emerald-800 bg-emerald-950/80 text-emerald-300";
    }
    if (status === "rechazado") {
      return "border-red-900 bg-red-950/80 text-red-300";
    }
    return "border-amber-800 bg-amber-950/80 text-amber-300";
  };

  if (!token) {
    return (
      <main className="min-h-screen bg-zinc-950 p-6 text-white flex items-center justify-center">
        <div className="mx-auto max-w-md w-full rounded-3xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl backdrop-blur-md">
          <div className="mb-3 text-3xl font-black tracking-widest text-emerald-400">
            AXIOM
          </div>
          <h1 className="text-xl font-bold">Administrador</h1>
          <p className="mt-3 text-sm text-zinc-400">
            {error || "Verificando sesión..."}
          </p>
          <a
            href="/"
            className="mt-6 inline-block rounded-xl bg-emerald-500 px-6 py-3 font-bold text-black transition hover:bg-emerald-400"
          >
            Volver al inicio
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-white selection:bg-emerald-500 selection:text-black">
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 text-lg font-black tracking-widest text-emerald-400">
              AXIOM
            </div>
            <div>
              <div className="text-sm font-semibold">Panel de Control</div>
              <div className="text-xs text-zinc-500">Gestión General</div>
            </div>
          </div>
          <a
            href="/"
            className="rounded-xl border border-zinc-700/80 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
          >
            ← Ir al Lobby
          </a>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* Navegación por Pestañas */}
        <div className="mb-8 flex flex-wrap gap-2 border-b border-zinc-800/60 pb-5">
          {menu.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setSection(item.id);
                setRequestFilter("");
                setRequestSearch("");
                setBonusSearch("");
                setError("");
                setNotice("");
              }}
              className={`flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold transition-all ${
                section === item.id
                  ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/20"
                  : "border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-white"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              {menu.find((item) => item.id === section)?.label}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Administración y control en tiempo real de operaciones AXIOM.
            </p>
          </div>

          <button
            onClick={loadSection}
            disabled={loading || busy}
            className={secondaryButton}
          >
            ↻ Sincronizar
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-300 backdrop-blur-sm">
            {error}
          </div>
        )}

        {notice && (
          <div className="mb-6 rounded-2xl border border-emerald-900/60 bg-emerald-950/40 p-4 text-sm text-emerald-300 backdrop-blur-sm">
            {notice}
          </div>
        )}

        {(loading || busy) && (
          <div className="mb-6 flex items-center gap-2 text-sm text-emerald-400 font-medium">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            {busy ? "Procesando operación..." : "Cargando información..."}
          </div>
        )}

        {/* RESUMEN */}
        {section === "resumen" && (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {[
              {
                label: "Total de clientes registrados",
                value: summary?.total_clients,
                prefix: "",
              },
              {
                label: "Dinero para jugar (Saldos)",
                value: summary?.money_play,
                prefix: "$",
              },
              {
                label: "Dinero para retirar",
                value: summary?.money_withdraw,
                prefix: "$",
              },
              {
                label: "Dinero activo en bonos",
                value: summary?.money_bonus,
                prefix: "$",
              },
              {
                label: "Comisión líquida AXIOM",
                value: summary?.axiom_commission,
                prefix: "$",
              },
            ].map((item) => (
              <div
                key={item.label}
                className="group relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/80 p-6 transition hover:border-zinc-700"
              >
                <div className="absolute -right-4 -top-4 h-24 w-24 rounded-full bg-emerald-500/5 transition group-hover:bg-emerald-500/10" />
                <p className="text-sm font-medium text-zinc-400">{item.label}</p>
                <p className="mt-4 text-3xl font-black text-emerald-400 tracking-tight">
                  {item.value == null
                    ? "—"
                    : item.prefix === "$"
                    ? money(item.value)
                    : Number(item.value).toLocaleString("es-EC")}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* CLIENTES */}
        {section === "clientes" && (
          <div>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row">
              <input
                className={inputClass}
                placeholder="🔍 Buscar por nombre, documento, teléfono o código..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadSection();
                }}
              />
              <button
                className={buttonClass}
                onClick={loadSection}
                disabled={loading}
              >
                Buscar
              </button>
            </div>

            <div className="mb-4 flex items-center justify-between text-sm text-zinc-400">
              <span>{clientTotal} clientes encontrados</span>
            </div>

            <div className="space-y-4">
              {clients.map((client) => (
                <div
                  key={client.id}
                  className="rounded-3xl border border-zinc-800 bg-zinc-900/80 p-6 transition hover:border-zinc-700/80 shadow-lg"
                >
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                    <div className="min-w-0">
                      <h3 className="text-lg font-bold text-white">
                        {clientName(client)}
                      </h3>
                      <p className="mt-0.5 break-all text-xs font-mono text-zinc-500">
                        ID: {client.id}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-4 text-sm text-zinc-300">
                        <span>Doc: <strong className="text-white">{client.doc_number || "—"}</strong></span>
                        <span>Tel: <strong className="text-white">{client.phone || "—"}</strong></span>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 rounded-2xl bg-zinc-950 p-4 border border-zinc-800 text-center">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Jugar</p>
                        <p className="mt-1 font-bold text-emerald-400">{money(client.balance)}</p>
                      </div>
                      <div className="border-x border-zinc-800 px-2">
                        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Retirar</p>
                        <p className="mt-1 font-bold text-white">{money(client.withdraw_balance)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-zinc-500">Bonos</p>
                        <p className="mt-1 font-bold text-amber-400">{money(client.bonus_balance)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-zinc-800/80 pt-4">
                    <button
                      className={secondaryButton}
                      onClick={() => setEditingClient({ ...client })}
                    >
                      Editar datos
                    </button>

                    <div className="flex flex-wrap items-center gap-2 ml-auto">
                      <select
                        className="rounded-xl border border-zinc-700/80 bg-zinc-950 px-3.5 py-2.5 text-sm text-white outline-none"
                        value={wallet}
                        onChange={(e) => setWallet(e.target.value)}
                      >
                        <option value="play">Saldo para jugar</option>
                        <option value="withdraw">Saldo para retirar</option>
                        <option value="bonus">Saldo de bonos</option>
                      </select>

                      <input
                        className="w-32 rounded-xl border border-zinc-700/80 bg-zinc-950 px-3.5 py-2.5 text-sm text-white outline-none"
                        type="number"
                        step="0.01"
                        placeholder="+/- Monto"
                        value={walletAmount}
                        onChange={(e) => setWalletAmount(e.target.value)}
                      />

                      <button
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => adjustWallet(client.id)}
                      >
                        Ajustar saldo
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {!loading && clients.length === 0 && (
                <p className="rounded-2xl border border-zinc-800 p-8 text-center text-zinc-500 bg-zinc-900/40">
                  No hay clientes para mostrar.
                </p>
              )}
            </div>

            {editingClient && (
              <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm">
                <div className="my-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
                  <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
                    <h2 className="text-xl font-bold">Editar información de cliente</h2>
                    <button
                      onClick={() => setEditingClient(null)}
                      className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    {[
                      ["first_name", "Primer nombre"],
                      ["middle_name", "Segundo nombre"],
                      ["last_name", "Primer apellido"],
                      ["second_last_name", "Segundo apellido"],
                      ["doc_type", "Tipo de documento"],
                      ["doc_number", "Número de documento"],
                      ["phone", "Teléfono"],
                      ["birth_date", "Fecha de nacimiento"],
                      ["bonus_code", "Código de bono"],
                      ["referral_code", "Código de referido"],
                    ].map(([field, label]) => (
                      <label key={field} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        {label}
                        <input
                          className={`${inputClass} mt-1.5`}
                          type={field === "birth_date" ? "date" : "text"}
                          value={(editingClient as any)[field] || ""}
                          onChange={(e) =>
                            setEditingClient({
                              ...editingClient,
                              [field]: e.target.value,
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>

                  <div className="mt-6 flex justify-end gap-3 border-t border-zinc-800 pt-4">
                    <button
                      className={secondaryButton}
                      onClick={() => setEditingClient(null)}
                    >
                      Cancelar
                    </button>
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={saveClient}
                    >
                      Guardar cambios
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* BONOS */}
        {section === "bonos" && (
          <div className="space-y-6">
            <form
              onSubmit={createBonus}
              className="rounded-3xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-lg"
            >
              <h2 className="mb-4 text-lg font-bold">Crear nuevo código de bono</h2>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Código
                  <input
                    className={`${inputClass} mt-1.5 uppercase`}
                    value={bonusCode}
                    onChange={(e) => setBonusCode(e.target.value)}
                    placeholder="EJEMPLO10"
                    required
                  />
                </label>

                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Monto del bono ($)
                  <input
                    className={`${inputClass} mt-1.5`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={bonusAmount}
                    onChange={(e) => setBonusAmount(e.target.value)}
                    required
                  />
                </label>

                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Máximo de usos
                  <input
                    className={`${inputClass} mt-1.5`}
                    type="number"
                    min="1"
                    value={bonusMaxUses}
                    onChange={(e) => setBonusMaxUses(e.target.value)}
                    placeholder="Sin límite"
                  />
                </label>

                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Fecha de inicio
                  <input
                    className={`${inputClass} mt-1.5`}
                    type="datetime-local"
                    value={bonusStarts}
                    onChange={(e) => setBonusStarts(e.target.value)}
                  />
                </label>

                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Fecha de vencimiento
                  <input
                    className={`${inputClass} mt-1.5`}
                    type="datetime-local"
                    value={bonusExpires}
                    onChange={(e) => setBonusExpires(e.target.value)}
                  />
                </label>
              </div>

              <button
                className={`${buttonClass} mt-5`}
                disabled={busy}
                type="submit"
              >
                Crear bono
              </button>
            </form>

            {/* Buscador de Bonos */}
            <div className="flex items-center gap-3">
              <input
                className={inputClass}
                placeholder="🔍 Buscar bono por código..."
                value={bonusSearch}
                onChange={(e) => setBonusSearch(e.target.value)}
              />
            </div>

            <div className="space-y-4">
              {filteredBonuses.map((bonus) => (
                <div
                  key={bonus.id}
                  className="flex flex-col justify-between gap-4 rounded-3xl border border-zinc-800 bg-zinc-900/80 p-5 sm:flex-row sm:items-center shadow-lg"
                >
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-xl font-black text-emerald-400">
                        {bonus.code}
                      </h3>
                      <span
                        className={`rounded-full border px-3 py-0.5 text-xs font-semibold ${
                          bonus.is_active
                            ? "border-emerald-800 bg-emerald-950/80 text-emerald-300"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {bonus.is_active ? "Activo" : "Inactivo"}
                      </span>
                    </div>

                    <p className="mt-2 text-sm text-zinc-300">
                      Monto: <strong className="text-white">{money(bonus.amount)}</strong> · Usos: <strong className="text-white">{bonus.uses_count || 0}</strong>
                      {bonus.max_uses != null
                        ? ` / ${bonus.max_uses}`
                        : " / Sin límite"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Inicio: {dateText(bonus.starts_at)} · Vence: {dateText(bonus.expires_at)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className={secondaryButton}
                      onClick={() => updateBonus(bonus)}
                    >
                      Editar
                    </button>
                    <button
                      className={buttonClass}
                      onClick={() => toggleBonus(bonus)}
                      disabled={busy}
                    >
                      {bonus.is_active ? "Desactivar" : "Activar"}
                    </button>
                  </div>
                </div>
              ))}

              {!loading && filteredBonuses.length === 0 && (
                <p className="rounded-2xl border border-zinc-800 p-8 text-center text-zinc-500 bg-zinc-900/40">
                  No se encontraron bonos con ese criterio.
                </p>
              )}
            </div>
          </div>
        )}

        {/* RETIROS */}
        {section === "retiros" && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                className={inputClass}
                placeholder="🔍 Buscar retiros por cliente, ID o documento..."
                value={requestSearch}
                onChange={(e) => setRequestSearch(e.target.value)}
              />
              <select
                className={`${inputClass} sm:max-w-xs`}
                value={requestFilter}
                onChange={(e) => setRequestFilter(e.target.value)}
              >
                <option value="">Todos los estados</option>
                <option value="pendiente">Pendientes</option>
                <option value="aprobado">Aprobados</option>
                <option value="rechazado">Rechazados</option>
                <option value="completado">Completados</option>
              </select>
            </div>

            <div className="space-y-4">
              {filteredWithdrawals.map((row) => (
                <div
                  key={row.id}
                  className="rounded-3xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-lg"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold text-white">
                        {clientName(row.client)}
                      </h3>
                      <p className="mt-0.5 break-all text-xs font-mono text-zinc-500">
                        Solicitud ID: {row.id} · Usuario ID: {row.user_id}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyle(
                        row.status
                      )}`}
                    >
                      {row.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="mt-5 grid gap-4 rounded-2xl bg-zinc-950 p-4 border border-zinc-800 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Monto solicitado</p>
                      <p className="mt-1 font-bold">{money(row.amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Comisión bancaria</p>
                      <p className="mt-1 font-bold">{money(row.bank_fee)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Neto a pagar</p>
                      <p className="mt-1 font-bold text-emerald-400">{money(row.net_amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Fecha de solicitud</p>
                      <p className="mt-1 text-sm text-zinc-300">{dateText(row.created_at)}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-950/50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <p className="text-zinc-400">Banco: <strong className="text-white">{row.bank_name || "—"}</strong></p>
                    <p className="text-zinc-400">Tipo cuenta: <strong className="text-white">{row.account_type || "—"}</strong></p>
                    <p className="text-zinc-400">Nro Cuenta: <strong className="text-white">{row.account_number || "—"}</strong></p>
                    <p className="text-zinc-400">Titular: <strong className="text-white">{row.account_holder || "—"}</strong></p>
                    <p className="text-zinc-400">Documento: <strong className="text-white">{row.document_number || "—"}</strong></p>
                  </div>

                  {row.status === "pendiente" && (
                    <div className="mt-5 space-y-3 border-t border-zinc-800 pt-4">
                      <input
                        className={inputClass}
                        placeholder="Nota administrativa o motivo (opcional)"
                        value={adminNote}
                        onChange={(e) => setAdminNote(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => requestAction("withdrawal", row.id, "approve")}
                        >
                          Aprobar Retiro
                        </button>
                        <button
                          className="rounded-xl border border-red-800 bg-red-950 px-4 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-900 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => requestAction("withdrawal", row.id, "reject")}
                        >
                          Rechazar
                        </button>
                        <button
                          className="rounded-xl border border-emerald-800 bg-emerald-950 px-4 py-2.5 text-sm font-bold text-emerald-200 transition hover:bg-emerald-900 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => requestAction("withdrawal", row.id, "complete")}
                        >
                          Marcar Completado
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {!loading && filteredWithdrawals.length === 0 && (
                <p className="rounded-2xl border border-zinc-800 p-8 text-center text-zinc-500 bg-zinc-900/40">
                  No hay solicitudes de retiro para mostrar.
                </p>
              )}
            </div>
          </div>
        )}

        {/* DEPÓSITOS */}
        {section === "depositos" && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                className={inputClass}
                placeholder="🔍 Buscar depósitos por cliente, ID o documento..."
                value={requestSearch}
                onChange={(e) => setRequestSearch(e.target.value)}
              />
              <select
                className={`${inputClass} sm:max-w-xs`}
                value={requestFilter}
                onChange={(e) => setRequestFilter(e.target.value)}
              >
                <option value="">Todos los estados</option>
                <option value="pendiente">Pendientes</option>
                <option value="aprobado">Aprobados</option>
                <option value="rechazado">Rechazados</option>
                <option value="completado">Completados</option>
              </select>
            </div>

            <div className="space-y-4">
              {filteredDeposits.map((row) => (
                <div
                  key={row.id}
                  className="rounded-3xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-lg"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold text-white">
                        {clientName(row.client)}
                      </h3>
                      <p className="mt-0.5 break-all text-xs font-mono text-zinc-500">
                        Depósito ID: {row.id} · Usuario ID: {row.user_id}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyle(
                        row.status
                      )}`}
                    >
                      {row.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="mt-5 grid gap-4 rounded-2xl bg-zinc-950 p-4 border border-zinc-800 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Monto depositado</p>
                      <p className="mt-1 font-bold text-emerald-400">{money(row.amount)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Método / Canal</p>
                      <p className="mt-1 font-bold text-white">{row.method || "Transferencia"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-zinc-500">Fecha de depósito</p>
                      <p className="mt-1 text-sm text-zinc-300">{dateText(row.created_at)}</p>
                    </div>
                  </div>

                  {row.status === "pendiente" && (
                    <div className="mt-5 space-y-3 border-t border-zinc-800 pt-4">
                      <input
                        className={inputClass}
                        placeholder="Nota administrativa (opcional)"
                        value={adminNote}
                        onChange={(e) => setAdminNote(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => requestAction("deposit", row.id, "approve")}
                        >
                          Aprobar Depósito
                        </button>
                        <button
                          className="rounded-xl border border-red-800 bg-red-950 px-4 py-2.5 text-sm font-bold text-red-200 transition hover:bg-red-900 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => requestAction("deposit", row.id, "reject")}
                        >
                          Rechazar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {!loading && filteredDeposits.length === 0 && (
                <p className="rounded-2xl border border-zinc-800 p-8 text-center text-zinc-500 bg-zinc-900/40">
                  No hay solicitudes de depósito para mostrar.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}