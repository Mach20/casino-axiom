
"use client";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold">
          Algo salió mal
        </h1>

        <p className="mt-3 text-zinc-400">
          No pudimos completar tu solicitud.
          Inténtalo nuevamente.
        </p>

        <button
          onClick={() => reset()}
          className="mt-6 rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-black"
        >
          Intentar nuevamente
        </button>
      </div>
    </main>
  );
}
