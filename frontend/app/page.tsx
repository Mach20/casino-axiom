"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Header from "./components/Header";

const GAMES = [
  {
    id: "x-vs-o",
    badge: "Online",
    minBet: "Min: $0.25",
    title: "X vs O",
    description:
      "3 en raya multijugador en tiempo real con apuestas y salas privadas.",
    href: "/game",
    hoverClass: "hover:bg-emerald-500 hover:text-black hover:border-emerald-400",
  },
  {
    id: "snake",
    badge: "Online",
    minBet: "Min: $0.20",
    title: "Snake",
    description:
      "Controla tu serpiente, come bolitas para crecer, sobrevive a otros jugadores y retírate cuando quieras.",
    href: "/snake",
    hoverClass: "hover:bg-yellow-400 hover:text-black hover:border-yellow-400",
  },
  {
    id: "parchis",
    badge: "Online",
    minBet: "Min: $0.25",
    title: "Parchis",
    description:
      "Compite contra otros jugadores y tú con tus amigos en este tablero, demuestra tus habilidades.",
    href: "/parchis",
    hoverClass: "hover:bg-yellow-400 hover:text-black hover:border-yellow-400",
  },
];

export default function Home() {
  const [currentSlide, setCurrentSlide] = useState(0);

  const slides = [
    "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1600&q=80",
    "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1600&q=80",
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length);
    }, 5000);

    return () => clearInterval(timer);
  }, [slides.length]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col justify-between select-none font-sans overflow-x-hidden">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-5 md:px-6 py-5 sm:py-8 space-y-6 sm:space-y-8">
        {/* CARRUSEL / BANNER PRINCIPAL */}
        <section className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-zinc-800 bg-zinc-950 h-48 sm:h-64 md:h-[320px] lg:h-[360px]">
          {slides.map((imgUrl, index) => (
            <div
              key={index}
              className={`absolute inset-0 w-full h-full transition-opacity duration-500 ${
                index === currentSlide
                  ? "opacity-100 z-10 pointer-events-auto"
                  : "opacity-0 z-0 pointer-events-none"
              }`}
            >
              <img
                src={imgUrl}
                alt={`Anuncio ${index + 1}`}
                className="w-full h-full object-cover object-center"
              />
            </div>
          ))}

          <div className="absolute bottom-3 sm:bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 z-20 px-2.5 py-1.5 rounded-full bg-black/40 backdrop-blur-sm">
            {slides.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`Ir al anuncio ${index + 1}`}
                onClick={() => setCurrentSlide(index)}
                className={`h-2.5 sm:h-3 rounded-full transition-all cursor-pointer ${
                  index === currentSlide
                    ? "w-6 sm:w-7 bg-emerald-500"
                    : "w-2.5 sm:w-3 bg-zinc-600 hover:bg-zinc-400"
                }`}
              />
            ))}
          </div>
        </section>

        {/* SECCIÓN DE 3 JUEGOS */}
        <section id="juegos-online" className="w-full min-w-0">
          <h3 className="text-xs sm:text-sm font-black text-zinc-300 uppercase tracking-wider mb-3.5 sm:mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
            <span>Juegos Online</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-5 w-full">
            {GAMES.map((game) => (
              <article
                key={game.id}
                className="w-full min-w-0 bg-zinc-950 border border-zinc-800/80 rounded-2xl p-4 sm:p-5 hover:border-emerald-500/50 transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex justify-between items-center gap-2 mb-3">
                    <span className="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-2.5 py-1 rounded-lg border border-emerald-800/60 uppercase shrink-0">
                      {game.badge}
                    </span>

                    <span className="text-[11px] sm:text-xs text-zinc-400 sm:text-zinc-500 font-mono whitespace-nowrap">
                      {game.minBet}
                    </span>
                  </div>

                  <h4 className="text-xl sm:text-2xl font-black text-white uppercase tracking-wider mb-2 break-words">
                    {game.title}
                  </h4>

                  <p className="text-xs sm:text-[13px] text-zinc-400 leading-relaxed mb-5 sm:mb-6">
                    {game.description}
                  </p>
                </div>

                <Link
                  href={game.href}
                  className={`w-full py-3 px-4 bg-zinc-900 text-zinc-200 font-black text-xs uppercase tracking-wider rounded-xl transition-all text-center border border-zinc-800 block cursor-pointer active:scale-[0.99] ${game.hoverClass}`}
                >
                  Jugar Ahora
                </Link>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="w-full border-t border-zinc-900 bg-zinc-950 py-5 sm:py-6 px-4 text-center text-xs text-zinc-600">
        <p className="font-bold text-zinc-500 uppercase tracking-widest text-[10px]">
          AXIOM
        </p>
      </footer>
    </div>
  );
}