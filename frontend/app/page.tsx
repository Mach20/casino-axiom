
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Header from "./components/Header";

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
    <div className="min-h-screen bg-black text-white flex flex-col justify-between select-none font-sans">

      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 space-y-8 flex flex-col justify-center">

        <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 h-[320px] sm:h-[420px]">

          {slides.map((imgUrl, index) => (
            <div
              key={index}
              className={`absolute inset-0 w-full h-full transition-opacity duration-500 ${
                index === currentSlide
                  ? "opacity-100 z-10"
                  : "opacity-0 z-0"
              }`}
            >
              <img
                src={imgUrl}
                alt={`Anuncio ${index + 1}`}
                className="w-full h-full object-cover"
              />
            </div>
          ))}

          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 z-20">
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentSlide(index)}
                className={`w-3 h-3 rounded-full transition-all ${
                  index === currentSlide
                    ? "bg-emerald-500"
                    : "bg-zinc-700"
                }`}
              />
            ))}
          </div>

        </section>

        <section>

          <h3 className="text-sm font-black text-zinc-300 uppercase tracking-wider mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            Juegos Online
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* TARJETA 1: X vs O */}

            <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl p-5 hover:border-emerald-500/50 transition-all flex flex-col justify-between">

              <div>

                <div className="flex justify-between items-start mb-3">

                  <span className="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-2.5 py-1 rounded-lg border border-emerald-800/60 uppercase">
                    online
                  </span>

                  <span className="text-xs text-zinc-500 font-mono">
                    Min: $0.10
                  </span>

                </div>

                <h4 className="text-2xl font-black text-white uppercase tracking-wider mb-2">
                  X vs O
                </h4>

                <p className="text-xs text-zinc-400 leading-relaxed mb-6">
                  3 en raya multijugador en tiempo real con apuestas y salas privadas.
                </p>

              </div>

              <Link
                href="/game"
                className="w-full py-3 bg-zinc-900 hover:bg-emerald-500 hover:text-black text-zinc-300 font-black text-xs uppercase tracking-wider rounded-xl transition-all text-center border border-zinc-800 block cursor-pointer"
              >
                Jugar Ahora
              </Link>

            </div>

            {/* TARJETA 2: Snake Arena */}

            <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl p-5 hover:border-emerald-500/50 transition-all flex flex-col justify-between">

              <div>

                <div className="flex justify-between items-start mb-3">

                  <span className="text-[10px] bg-emerald-950 text-emerald-400 font-bold px-2.5 py-1 rounded-lg border border-emerald-800/60 uppercase">
                    Online
                  </span>

                  <span className="text-xs text-zinc-500 font-mono">
                    Min: $1
                  </span>

                </div>

                <h4 className="text-2xl font-black text-white uppercase tracking-wider mb-2">
                  Snake
                </h4>

                <p className="text-xs text-zinc-400 leading-relaxed mb-6">
                  Controla tu serpiente, come bolitas para crecer, sobrevive a otros jugadores y retírate cuando quieras.
                </p>

              </div>

              <Link
                href="/snake"
                className="w-full py-3 bg-zinc-900 hover:bg-yellow-400 hover:text-black text-zinc-300 font-black text-xs uppercase tracking-wider rounded-xl transition-all text-center border border-zinc-800 block cursor-pointer"
              >
                Jugar Ahora
              </Link>

            </div>

            {/* TARJETA 3: Billar */}

          </div>

        </section>

      </main>

      <footer className="w-full border-t border-zinc-900 bg-zinc-950 py-6 text-center text-xs text-zinc-600">
        <p className="font-bold text-zinc-500 uppercase tracking-widest text-[10px]">
          AXIOM
        </p>
      </footer>

    </div>
  );
}
