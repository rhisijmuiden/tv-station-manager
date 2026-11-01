import { useTranslation } from "react-i18next";
import { fmtDuration, type ClockLayout } from "../lib";

const HOUR = 3600_000;

/** Point on a circle; 0 ms = 12 o'clock, clockwise. */
const pt = (ms: number, r: number) => {
  const a = (ms / HOUR) * 2 * Math.PI - Math.PI / 2;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)] as const;
};
const arc = (from: number, to: number, r0: number, r1: number) => {
  const to2 = Math.min(to, from + HOUR - 1);
  const large = to2 - from > HOUR / 2 ? 1 : 0;
  const [ax, ay] = pt(from, r1);
  const [bx, by] = pt(to2, r1);
  const [cx, cy] = pt(to2, r0);
  const [dx, dy] = pt(from, r0);
  return `M${ax} ${ay}A${r1} ${r1} 0 ${large} 1 ${bx} ${by}L${cx} ${cy}A${r0} ${r0} 0 ${large} 0 ${dx} ${dy}Z`;
};

/**
 * An hour clock drawn as a ring: fixed blocks in their own colour, programme windows striped in the brand colour.
 * `colors` maps a segment index to a colour (the block's colour).
 */
export function ClockRing({ layout, colors, size = 180, highlight }: { layout: ClockLayout; colors: (index: number) => string | undefined; size?: number; highlight?: number | null }) {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={t("mgmt.clocks.ringLabel")} className="shrink-0">
      <defs>
        <pattern id="tvsm-program" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="3" fill="var(--color-brand, #3B6CFF)" opacity="0.18" />
          <rect width="1.2" height="3" fill="var(--color-brand, #3B6CFF)" opacity="0.35" />
        </pattern>
      </defs>
      <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="14" />
      {layout.segments.map((s) =>
        s.durationMs > 0 && s.offsetMs < HOUR ? (
          <path
            key={s.index}
            d={arc(s.offsetMs, Math.min(HOUR, s.offsetMs + s.durationMs), 37, 51 - 0.5)}
            fill={s.kind === "program" ? "url(#tvsm-program)" : (colors(s.index) ?? "#64748B")}
            stroke="var(--color-surface, #fff)"
            strokeWidth="0.6"
            opacity={highlight == null || highlight === s.index ? 1 : 0.35}
          >
            <title>{`${fmtDuration(s.offsetMs)} · ${s.kind === "program" ? t("mgmt.clocks.program") : s.title || ""} (${fmtDuration(s.durationMs)})`}</title>
          </path>
        ) : null,
      )}
      {size >= 100 && [0, 15, 30, 45].map((m) => {
        const [x, y] = pt(m * 60_000, 31);
        return (
          <text key={m} x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize="5" fill="currentColor" opacity="0.5" fontFamily="var(--tvsm-font-mono)">
            :{String(m).padStart(2, "0")}
          </text>
        );
      })}
      {size >= 100 && (
        <>
          <text x="50" y="47" textAnchor="middle" fontSize="8" fontWeight="600" fill="currentColor">
            {fmtDuration(layout.programMs)}
          </text>
          <text x="50" y="56" textAnchor="middle" fontSize="4.2" fill="currentColor" opacity="0.6">
            {t("mgmt.clocks.programPerHour")}
          </text>
        </>
      )}
    </svg>
  );
}
