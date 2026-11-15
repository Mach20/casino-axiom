
"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-3xl font-bold text-emerald-400">
            AXIOM
          </h1>

          <p className="mt-4 text-zinc-400">
            Estamos teniendo dificultades.
            Inténtalo nuevamente.
          </p>

          <button
            onClick={() => reset()}
            className="mt-6 rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-black"
          >
            Volver a intentar
          </button>
        </div>
      </body>
    </html>
  );
}
