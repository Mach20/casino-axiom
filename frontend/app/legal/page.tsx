"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Header from "../components/Header";
import {
    ArrowLeft,
    FileText,
    ShieldCheck,
    UserCheck,
    AlertTriangle,
} from "lucide-react";

type LegalTab = "terminos" | "juego" | "kyc";

const TABS: { id: LegalTab; label: string; icon: typeof FileText }[] = [
    { id: "terminos", label: "Términos y Condiciones", icon: FileText },
    { id: "juego", label: "Políticas de Juego", icon: ShieldCheck },
    { id: "kyc", label: "Política KYC y AML", icon: UserCheck },
];

function LegalContent() {
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState<LegalTab>("terminos");

    useEffect(() => {
        const tabParam = searchParams.get("tab");
        if (
            tabParam === "terminos" ||
            tabParam === "juego" ||
            tabParam === "kyc"
        ) {
            setActiveTab(tabParam);
        }
    }, [searchParams]);

    const handleTabChange = (tab: LegalTab) => {
        setActiveTab(tab);
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState({}, "", url.toString());
    };

    return (
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-5 sm:py-8">
            <button
                type="button"
                onClick={() => window.history.back()}
                className="mb-6 flex w-fit items-center gap-2 rounded-lg border border-white/10 bg-[#111714] px-3 py-2 text-xs font-semibold text-zinc-400 transition hover:border-emerald-500/40 hover:text-white"
            >
                <ArrowLeft className="h-4 w-4" />
                Volver
            </button>

            <div className="mb-6">
                <h1 className="text-2xl font-black uppercase tracking-wide text-white">
                    Marco Legal y Políticas
                </h1>
                <p className="mt-1 text-xs text-zinc-400">
                    Normativas vigentes de operación, seguridad y juego en AXIOM · Última actualización: Noviembre 2026
                </p>
            </div>

            {/* PESTAÑAS */}
            <div className="mb-6 flex flex-wrap gap-2">
                {TABS.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => handleTabChange(tab.id)}
                            className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-bold transition ${
                                isActive
                                    ? "border-emerald-500 bg-emerald-500 text-black shadow-lg shadow-emerald-500/10"
                                    : "border-white/10 bg-[#111714] text-zinc-300 hover:border-emerald-500/40 hover:text-white"
                            }`}
                        >
                            <Icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* CONTENIDO DE CADA PESTAÑA */}
            <div className="rounded-2xl border border-white/10 bg-[#111714] p-5 sm:p-7 text-xs sm:text-sm text-zinc-300 leading-relaxed space-y-6">
                {activeTab === "terminos" && (
                    <>
                        <div className="border-b border-white/10 pb-4">
                            <h2 className="text-lg font-black uppercase text-emerald-400">
                                1. Términos y Condiciones de Uso
                            </h2>
                            <p className="mt-1 text-xs text-zinc-400">
                                Al crear una cuenta y utilizar los servicios de AXIOM, aceptas íntegramente las siguientes condiciones.
                            </p>
                        </div>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                1.1. Elegibilidad y Registro
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    El acceso está estrictamente limitado a personas mayores de <strong>18 años</strong> o la mayoría de edad legal en su jurisdicción.
                                </li>
                                <li>
                                    Cada usuario puede mantener únicamente <strong>una (1) cuenta activa</strong> asociada a su número de cédula o pasaporte y correo electrónico. La creación de cuentas duplicadas conllevará el cierre inmediato y la retención de bonos.
                                </li>
                                <li>
                                    El usuario es responsable de mantener la confidencialidad de sus credenciales de acceso.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                1.2. Depósitos y Retiros (USDT TRC20)
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    Los depósitos mediante criptomonedas se procesan exclusivamente en <strong>USDT bajo la red TRON (TRC20)</strong> con un monto mínimo de <strong>$20.00 USD</strong>.
                                </li>
                                <li>
                                    AXIOM no se hace responsable por fondos enviados a direcciones incorrectas o a través de redes distintas a TRON (TRC20).
                                </li>
                                <li>
                                    Los retiros se procesan desde el <strong>Saldo para Retirar</strong> hacia una dirección USDT TRC20 perteneciente al titular de la cuenta, previa verificación de identidad (KYC).
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                1.3. Bonos, Promociones y Referidos
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    El <strong>Saldo Bono</strong> está sujeto a requisitos de apuesta (*rollover*) antes de poder transferirse al Saldo para Retirar.
                                </li>
                                <li>
                                    Queda prohibido el uso de estrategias de arbitraje, apuestas opuestas sin riesgo o abuso del programa de referidos mediante cuentas propias.
                                </li>
                            </ul>
                        </section>
                    </>
                )}

                {activeTab === "juego" && (
                    <>
                        <div className="border-b border-white/10 pb-4">
                            <h2 className="text-lg font-black uppercase text-emerald-400">
                                2. Políticas de Juego y Juego Responsable
                            </h2>
                            <p className="mt-1 text-xs text-zinc-400">
                                En AXIOM promovemos el entretenimiento seguro, transparente y bajo control del jugador.
                            </p>
                        </div>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                2.1. Transparencia e Integridad de las Partidas
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    Todos los resultados de los juegos disponibles en AXIOM operan mediante algoritmos certificados de generación aleatoria (RNG) o proveedores oficiales auditados.
                                </li>
                                <li>
                                    El uso de bots, scripts automatizados o explotación de fallos técnicos resultará en la anulación de las jugadas y suspensión permanente de la cuenta.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                2.2. Compromiso de Juego Responsable
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    El juego debe ser una forma de ocio y nunca un medio para generar ingresos ni resolver problemas financieros.
                                </li>
                                <li>
                                    Recomendamos establecer un presupuesto fijo antes de jugar y evitar intentar recuperar pérdidas de forma impulsiva.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                2.3. Límites y Autoexclusión
                            </h3>
                            <p className="text-zinc-400">
                                Cualquier jugador puede solicitar la <strong>autoexclusión temporal</strong> (7 días, 30 días o 6 meses) o el <strong>cierre definitivo</strong> de su cuenta comunicándose con soporte. Durante el período de autoexclusión no se permitirán depósitos ni acceso a las salas de juego.
                            </p>
                        </section>
                    </>
                )}

                {activeTab === "kyc" && (
                    <>
                        <div className="border-b border-white/10 pb-4">
                            <h2 className="text-lg font-black uppercase text-emerald-400">
                                3. Política KYC (Conoce a tu Cliente) y Prevención AML
                            </h2>
                            <p className="mt-1 text-xs text-zinc-400">
                                Medidas de verificación de identidad y prevención de lavado de activos y financiamiento ilícito.
                            </p>
                        </div>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                3.1. ¿Cuándo se solicita la verificación KYC?
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    Antes de procesar la <strong>primera solicitud de retiro</strong> de fondos.
                                </li>
                                <li>
                                    Cuando se detecten discrepancias entre los datos registrados (nombre, cédula o pasaporte) y la actividad de la cuenta.
                                </li>
                                <li>
                                    En controles preventivos de seguridad o depósitos acumulados elevados.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                3.2. Documentación Requerida
                            </h3>
                            <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                                <li>
                                    <strong>Documento de identidad vigente:</strong> Fotografía nítida por ambos lados (anverso y reverso) de tu Cédula de Identidad o Pasaporte.
                                </li>
                                <li>
                                    <strong>Prueba de vida (Selfie):</strong> Fotografía del titular sosteniendo su documento de identidad junto a su rostro, sin filtros ni recortes.
                                </li>
                                <li>
                                    Los datos del documento deben coincidir exactamente con los ingresados al crear la cuenta en AXIOM.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <h3 className="font-bold text-white">
                                3.3. Tiempos de Revisión y Confidencialidad
                            </h3>
                            <p className="text-zinc-400">
                                Nuestro equipo de cumplimiento revisa las solicitudes KYC en un plazo máximo de <strong>24 a 48 horas hábiles</strong>. Recibirás una notificación directa en tu cuenta una vez aprobada o si se requiere repetir alguna fotografía. Toda la documentación se almacena cifrada bajo estricto acceso privado.
                            </p>
                        </section>

                        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3.5 text-xs text-zinc-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                            <p>
                                El envío de documentos adulterados o pertenecientes a terceros implicará el bloqueo permanente de la cuenta y la notificación a las autoridades competentes.
                            </p>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default function LegalPage() {
    return (
        <main className="min-h-screen bg-[#080b0a] text-white">
            <Header />
            <Suspense
                fallback={
                    <div className="mx-auto max-w-4xl px-4 py-10 text-xs text-zinc-400">
                        Cargando políticas...
                    </div>
                }
            >
                <LegalContent />
            </Suspense>
        </main>
    );
}