"use client";

interface ParchisRulesModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function ParchisRulesModal({
    isOpen,
    onClose,
}: ParchisRulesModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
            <div className="bg-zinc-950 border border-zinc-800 max-w-lg w-full rounded-3xl p-6 space-y-4 shadow-2xl">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                    <h3 className="text-base font-black uppercase text-emerald-400">
                        Reglas Clásicas del Parchís
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs font-bold text-zinc-300"
                    >
                        Cerrar
                    </button>
                </div>

                <ul className="space-y-2.5 text-xs text-zinc-300 leading-relaxed list-disc pl-4">
                    <li>
                        <strong className="text-white">Objetivo:</strong> Llevar tus
                        4 fichas desde tu casa hasta la meta central recorriendo el
                        tablero y subiendo por tu pasillo de color.
                    </li>
                    <li>
                        <strong className="text-white">Sacar ficha de casa:</strong>{" "}
                        Necesitas sacar <strong className="text-emerald-400">5</strong>{" "}
                        en el dado para sacar una ficha a tu casilla de salida.
                    </li>
                    <li>
                        <strong className="text-white">Casillas seguras:</strong> Las
                        casillas marcadas como seguras protegen las fichas de ser
                        capturadas.
                    </li>
                    <li>
                        <strong className="text-white">Capturas:</strong> Si caes en
                        una casilla no segura ocupada por una ficha rival, la envías
                        de vuelta a su casa.
                    </li>
                    <li>
                        <strong className="text-white">2 jugadores en esquinas opuestas:</strong>{" "}
                        En partidas de 2 jugadores, cada uno ocupa esquinas
                        opuestas para un duelo equilibrado.
                    </li>
                    <li>
                        <strong className="text-white">Anfitrión de sala:</strong>{" "}
                        Si el anfitrión abandona la sala, esta se cierra
                        automáticamente para todos los jugadores.
                    </li>
                </ul>

                <button
                    type="button"
                    onClick={onClose}
                    className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase rounded-2xl transition-all"
                >
                    Entendido
                </button>
            </div>
        </div>
    );
}