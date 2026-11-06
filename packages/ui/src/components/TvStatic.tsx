import { useEffect, useRef, useState } from "react";

/** Resolution of the snow: low on purpose, scaled up with hard edges so the pixels show. */
const W = 200;
const H = 112;
const FPS = 24;

/**
 * A screen without signal: flickering black-and-white snow with a rolling band, and now and then the
 * station logo breaking through, as if the tuner almost finds the channel. Respects reduced motion.
 */
export function TvStatic({ logo }: { logo: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [logoOn, setLogoOn] = useState(false);
  const [still] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    let band = 0;
    const draw = () => {
      band = (band + 1.6) % (H + 40);
      for (let y = 0; y < H; y++) {
        // A soft brighter band rolls down the screen, like a badly synced picture.
        const d = Math.abs(y - band + 20);
        const lift = d < 20 ? (20 - d) * 3 : 0;
        for (let x = 0; x < W; x++) {
          const r = Math.random();
          const v = Math.min(255, ((r < 0.45 ? r * 90 : 110 + r * 145) | 0) + lift); // mostly near black or near white
          px[y * W + x] = 0xff000000 | (v << 16) | (v << 8) | v;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    if (still) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 1000 / FPS) {
        last = t;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  // The logo comes through every few seconds for a moment.
  useEffect(() => {
    if (still) return setLogoOn(true);
    let timer: ReturnType<typeof setTimeout>;
    const cycle = (on: boolean) => {
      setLogoOn(on);
      timer = setTimeout(() => cycle(!on), on ? 2400 : 3500 + Math.random() * 4500);
    };
    timer = setTimeout(() => cycle(true), 1400);
    return () => clearTimeout(timer);
  }, [still]);

  return (
    <div className="tv-screen absolute inset-0 bg-black" aria-hidden>
      <canvas
        ref={canvas}
        width={W}
        height={H}
        className="absolute inset-0 size-full transition-opacity duration-300"
        style={{ imageRendering: "pixelated", opacity: logoOn ? 0.55 : 1 }}
      />
      <div className={`absolute inset-0 grid place-items-center ${logoOn ? (still ? "opacity-80" : "tv-logo-on") : "opacity-0"}`}>
        <img src={logo} alt="" className="tv-logo w-[46%] max-w-md" draggable={false} />
      </div>
      {/* scanlines, vignette and glass reflection */}
      <div className="tv-scanlines absolute inset-0" />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgb(0 0 0 / 0.65) 100%)" }} />
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, rgb(255 255 255 / 0.10) 0%, transparent 35%)" }} />
    </div>
  );
}
