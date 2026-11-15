
export default function NotFound() {
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">
          Página no encontrada
        </h1>

        <p className="mt-3 text-zinc-400">
          Esta página no está disponible.
        </p>

        <a
          href="/"
          className="inline-block mt-6 rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-black"
        >
          Volver al inicio
        </a>
      </div>
    </main>
  );
}
