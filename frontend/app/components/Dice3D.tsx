"use client";

import { useEffect, useState } from "react";

interface Dice3DProps {
    value: number | null;
    rolling: boolean;
    onRoll: () => void;
    disabled: boolean;
}

const FACE_ROTATIONS: Record<number, { x: number; y: number }> = {
    1: { x: 0, y: 0 },
    2: { x: 0, y: -90 },
    3: { x: 0, y: -180 },
    4: { x: 0, y: 90 },
    5: { x: -90, y: 0 },
    6: { x: 90, y: 0 },
};

const PIPS: Record<number, number[]> = {
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
};

function CubeFace({
    num,
    transform,
}: {
    num: number;
    transform: string;
}) {
    const active = PIPS[num] || [];
    return (
        <div
            style={{ transform }}
            className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white via-zinc-100 to-zinc-300 border-2 border-zinc-400 shadow-inner p-2.5 grid grid-cols-3 grid-rows-3 place-items-center backface-hidden"
        >
            {Array.from({ length: 9 }).map((_, i) => (
                <span
                    key={i}
                    className={`w-3 h-3 rounded-full ${
                        active.includes(i)
                            ? num === 1 || num === 6
                                ? "bg-red-600 shadow-sm"
                                : "bg-zinc-900 shadow-sm"
                            : "bg-transparent"
                    }`}
                />
            ))}
        </div>
    );
}

export default function Dice3D({
    value,
    rolling,
    onRoll,
    disabled,
}: Dice3DProps) {
    const [spinAngle, setSpinAngle] = useState({ x: -20, y: 25 });

    useEffect(() => {
        if (rolling) {
            const id = setInterval(() => {
                setSpinAngle((prev) => ({
                    x: prev.x + 145,
                    y: prev.y + 190,
                }));
            }, 90);
            return () => clearInterval(id);
        }

        if (value && FACE_ROTATIONS[value]) {
            setSpinAngle(FACE_ROTATIONS[value]);
        }
    }, [rolling, value]);

    const half = 40; // mitad de 80px

    return (
        <div className="flex flex-col items-center gap-3">
            <div
                style={{ perspective: "600px" }}
                className="w-20 h-20 flex items-center justify-center"
            >
                <div
                    style={{
                        width: "80px",
                        height: "80px",
                        position: "relative",
                        transformStyle: "preserve-3d",
                        transform: `rotateX(${spinAngle.x}deg) rotateY(${spinAngle.y}deg)`,
                        transition: rolling
                            ? "transform 90ms linear"
                            : "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                >
                    <CubeFace num={1} transform={`translateZ(${half}px)`} />
                    <CubeFace
                        num={2}
                        transform={`rotateY(90deg) translateZ(${half}px)`}
                    />
                    <CubeFace
                        num={3}
                        transform={`rotateY(180deg) translateZ(${half}px)`}
                    />
                    <CubeFace
                        num={4}
                        transform={`rotateY(-90deg) translateZ(${half}px)`}
                    />
                    <CubeFace
                        num={5}
                        transform={`rotateX(90deg) translateZ(${half}px)`}
                    />
                    <CubeFace
                        num={6}
                        transform={`rotateX(-90deg) translateZ(${half}px)`}
                    />
                </div>
            </div>

            <button
                type="button"
                disabled={disabled || rolling}
                onClick={onRoll}
                className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-black text-xs uppercase rounded-xl shadow-lg transition-all"
            >
                {rolling ? "Girando..." : "Lanzar Dado"}
            </button>
        </div>
    );
}