import { cx } from "@tvsm/ui";
import { useTranslation } from "react-i18next";
import { fmtDuration } from "../lib";

export interface HourBarPart {
  label: string;
  ms: number;
  kind: "start" | "media" | "auto" | "beeldkrant" | "webcam" | "live" | "lineup" | "commercial" | "filler" | "fill";
}
const HOUR = 3600_000;
const TONE: Record<HourBarPart["kind"], string> = {
  start: "bg-brand-dark text-white",
  media: "bg-brand text-white",
  auto: "bg-brand-light text-white",
  beeldkrant: "bg-[var(--tvsm-info)] text-white",
  webcam: "bg-ok text-white",
  live: "bg-onair text-white",
  lineup: "bg-brand-dark text-white",
  commercial: "bg-warn text-white",
  filler: "bg-surface-2 text-muted",
  fill: "text-white",
};

/**
 * One hour as a bar: the fixed start, the block's items and what fills the rest (a beeldkrant or webcam, striped).
 * A part with `ms` 0 and kind "fill" takes whatever is left of the hour.
 */
export function HourBar({ parts }: { parts: HourBarPart[] }) {
  const { t } = useTranslation();
  const used = parts.filter((p) => p.kind !== "fill").reduce((s, p) => s + p.ms, 0);
  const left = Math.max(0, HOUR - used);
  const fill = parts.find((p) => p.kind === "fill");
  const shown = parts.filter((p) => p.kind !== "fill" && p.ms > 0);
  const over = used > HOUR;
  const scale = Math.max(HOUR, used);
  return (
    <div>
      <div className="flex h-10 overflow-hidden rounded-lg border border-line bg-surface-2">
        {shown.map((p, i) => (
          <div key={i} title={`${p.label} · ${fmtDuration(p.ms)}`} className={cx("min-w-1 truncate border-r-2 border-surface px-1.5 py-1 text-[11px] leading-tight font-semibold", TONE[p.kind])} style={{ flex: `${Math.max(p.ms, scale / 150)} 0 0` }}>
            {p.label}
          </div>
        ))}
        {left > 0 &&
          (fill ? (
            <div className="truncate px-2 py-1 text-[11px] leading-tight font-semibold text-white" style={{ flex: `${left} 0 0`, background: "repeating-linear-gradient(135deg, var(--tvsm-info) 0 8px, color-mix(in srgb, var(--tvsm-info) 70%, transparent) 8px 16px)" }} title={fill.label}>
              {t("mgmt.plan.bar.fill", { name: fill.label })}
            </div>
          ) : (
            <div className="truncate px-2 py-1 text-[11px] leading-tight text-muted" style={{ flex: `${left} 0 0` }}>
              {t("mgmt.plan.bar.empty", { time: fmtDuration(left) })}
            </div>
          ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
        <span>:00</span>
        <span>:15</span>
        <span>:30</span>
        <span>:45</span>
        <span>:60</span>
      </div>
      {over && <p className="mt-1 text-xs text-warn">{t("mgmt.plan.bar.over", { time: fmtDuration(used - HOUR) })}</p>}
    </div>
  );
}
