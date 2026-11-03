import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Switch, Textarea, brandColor, cx, post } from "@tvsm/ui";
import { Newspaper, Palette, RefreshCw, Rss } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useGet, type TickerSettings } from "../lib";

interface Feed {
  id: number;
  name: string;
  enabled: boolean;
  refreshMinutes: number;
  itemCount: number;
  lastError: string | null;
}

const rgba = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})` : hex;
};
const tickerHeight = (fontSize: number) => Math.round(fontSize * 2) + 4;

/** What the ticker scrolls right now with these settings (the server reads the feeds' newest headlines). */
export function useTickerItems(t: TickerSettings) {
  const [items, setItems] = useState<string[]>([]);
  const [headlines, setHeadlines] = useState(0);
  const key = JSON.stringify([t.source, t.text, t.feedIds, t.maxItems, t.maxAgeHours, t.showTime]);
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => {
      post<{ items: string[]; headlines: number }>("/api/ticker/preview", t)
        .then((r) => live && (setItems(r.items), setHeadlines(r.headlines)))
        .catch(() => live && setItems([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { items, headlines };
}

/**
 * The ticker as it looks on air, scaled to the width of its box (the picture is 1920 px wide), scrolling at the
 * real speed. Used in the channel preview and in the ticker settings.
 */
export function TickerStrip({ t, items, className }: { t: TickerSettings; items: string[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const run = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.offsetWidth / 1920 || 0.4));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Two copies of the line next to each other, moved left and put back after one copy: an endless line.
  useEffect(() => {
    let x = 0;
    let last = 0;
    let raf = 0;
    const step = (ts: number) => {
      const el = run.current;
      if (el) {
        const dt = last ? Math.min(100, ts - last) : 0;
        last = ts;
        const half = el.scrollWidth / 2;
        x -= (t.speed * scale * dt) / 1000;
        if (half > 0 && -x >= half) x += half;
        el.style.transform = `translateX(${x}px)`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [t.speed, scale]);
  const h = tickerHeight(t.fontSize) * scale;
  const line = (copy: number) => (
    <span key={copy} className="inline-flex shrink-0 items-center" style={{ minWidth: box.current?.offsetWidth ?? undefined }}>
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center whitespace-nowrap">
          <span className={cx(t.uppercase && "uppercase")}>{it}</span>
          <span className="font-bold" style={{ color: t.colors.accent, padding: `0 ${0.9 * t.fontSize * scale}px` }}>
            {t.separator || "   "}
          </span>
        </span>
      ))}
    </span>
  );
  return (
    <div ref={box} className={cx("flex w-full overflow-hidden", className)} style={{ height: h, background: rgba(t.colors.background, t.backgroundOpacity), borderTop: `${Math.max(1, 4 * scale)}px solid ${t.colors.accent}`, color: t.colors.text, fontSize: t.fontSize * scale, fontWeight: t.bold ? 700 : 400 }}>
      {t.label && (
        <span className="flex shrink-0 items-center font-extrabold tracking-wide uppercase" style={{ background: t.colors.accent, color: t.colors.labelText, padding: `0 ${t.fontSize * scale}px` }}>
          {t.label}
        </span>
      )}
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={run} className="absolute inset-y-0 left-0 flex items-center will-change-transform">
          {items.length > 0 && [line(0), line(1)]}
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: ReactNode; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2.5 rounded-md border border-line px-2.5 py-2 text-[13px]">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block font-mono text-[11px] text-muted">{value}</span>
      </span>
    </label>
  );
}

function Range({ label, value, min, max, step = 1, onChange, ends }: { label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; ends?: [string, string] }) {
  return (
    <Field label={label}>
      {(id) => (
        <div>
          <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-brand" />
          {ends && (
            <div className="flex justify-between text-[11px] text-muted">
              <span>{ends[0]}</span>
              <span>{ends[1]}</span>
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

const SOURCES = ["text", "rss", "both"] as const;
const SPEEDS = [
  ["slow", 70],
  ["normal", 120],
  ["fast", 200],
] as const;

/** Settings of the news ticker: what it shows (fixed text, RSS headlines or both) and how it looks and moves. */
export function TickerCard({ value: t, onChange }: { value: TickerSettings; onChange: (v: TickerSettings) => void }) {
  const { t: tr } = useTranslation();
  const feeds = useGet<{ feeds: Feed[] }>("/api/rss/feeds", 60_000);
  const { items, headlines } = useTickerItems(t);
  const set = (p: Partial<TickerSettings>) => onChange({ ...t, ...p });
  const color = (k: keyof TickerSettings["colors"]) => (v: string) => set({ colors: { ...t.colors, [k]: v } });
  const feedList = feeds.data?.feeds ?? [];
  const useRss = t.source !== "text";
  const useText = t.source !== "rss";
  const chosen = feedList.filter((f) => t.feedIds.includes(f.id));
  const slowestFeed = chosen.length ? Math.max(...chosen.map((f) => f.refreshMinutes)) : null;
  const toggleFeed = (id: number, on: boolean) => set({ feedIds: on ? [...t.feedIds, id] : t.feedIds.filter((x) => x !== id) });
  const houseStyle = () => set({ colors: { background: brandColor("sidebar", "#2A1430").toUpperCase(), text: "#FFFFFF", accent: brandColor("accent", "#E92E7F").toUpperCase(), labelText: "#FFFFFF" }, backgroundOpacity: 0.92 });

  return (
    <Card className="mt-6">
      <CardHeader title={tr("mgmt.ticker.title")} description={tr("mgmt.ticker.intro")} icon={<Newspaper className="size-5" />} />
      <CardBody className="space-y-6">
        <Switch checked={t.enabled} onChange={(v) => set({ enabled: v })} label={tr("mgmt.ticker.enabled")} description={tr("mgmt.ticker.enabledHint")} />
        <div className="space-y-2">
          <div className="overflow-hidden rounded-lg bg-gradient-to-br from-slate-700 via-slate-800 to-slate-950 pt-10">
            {items.length ? <TickerStrip t={t} items={items} /> : <div className="px-4 py-3 text-center text-xs text-white/60">{tr("mgmt.ticker.previewEmpty")}</div>}
          </div>
          <p className="text-xs text-muted">{useRss ? tr("mgmt.ticker.previewHintRss", { count: headlines }) : tr("mgmt.ticker.previewHint")}</p>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          {/* What it shows */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">{tr("mgmt.ticker.whatTitle")}</h3>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface-2 p-1">
              {SOURCES.map((s) => (
                <button key={s} type="button" onClick={() => set({ source: s })} className={cx("rounded-md px-2 py-1.5 text-[13px] font-medium transition", t.source === s ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
                  {tr(`mgmt.ticker.source_${s}`)}
                </button>
              ))}
            </div>
            {useText && (
              <Field label={tr("mgmt.ticker.text")} hint={tr("mgmt.ticker.textHint")}>
                {(id) => <Textarea id={id} className="min-h-20 font-sans text-sm" value={t.text} placeholder={tr("mgmt.graphics.tickerPlaceholder")} onChange={(e) => set({ text: e.target.value })} />}
              </Field>
            )}
            {useRss && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{tr("mgmt.ticker.feeds")}</span>
                  <Link to="/beeldkrant/feeds" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                    <Rss className="size-3.5" />
                    {tr("mgmt.ticker.manageFeeds")}
                  </Link>
                </div>
                {feeds.data && !feedList.length && <Alert tone="warn">{tr("mgmt.ticker.noFeeds")}</Alert>}
                <div className="space-y-1.5">
                  {feedList.map((f) => (
                    <label key={f.id} className={cx("flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition", t.feedIds.includes(f.id) ? "border-brand bg-brand/5" : "border-line hover:bg-surface-2")}>
                      <input type="checkbox" className="size-4 accent-brand" checked={t.feedIds.includes(f.id)} onChange={(e) => toggleFeed(f.id, e.target.checked)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{f.name}</span>
                        <span className="block text-xs text-muted">
                          {tr("mgmt.ticker.feedInfo", { count: f.itemCount, minutes: f.refreshMinutes })}
                          {!f.enabled && ` · ${tr("mgmt.ticker.feedOff")}`}
                          {f.lastError && ` · ${tr("mgmt.ticker.feedError")}`}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label={tr("mgmt.ticker.maxItems")}>{(id) => <Input id={id} type="number" min={1} max={50} value={t.maxItems} onChange={(e) => set({ maxItems: Math.min(50, Math.max(1, Number(e.target.value) || 10)) })} />}</Field>
                  <Field label={tr("mgmt.ticker.maxAge")}>
                    {(id) => (
                      <Select id={id} value={t.maxAgeHours} onChange={(e) => set({ maxAgeHours: Number(e.target.value) })}>
                        {[6, 12, 24, 48, 72, 168, 0].map((h) => (
                          <option key={h} value={h}>
                            {h ? tr("mgmt.ticker.hours", { count: h }) : tr("mgmt.ticker.noLimit")}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={tr("mgmt.ticker.refresh")}>
                    {(id) => (
                      <Select id={id} value={t.refreshMinutes} onChange={(e) => set({ refreshMinutes: Number(e.target.value) })}>
                        {[1, 2, 5, 10, 15, 30, 60].map((m) => (
                          <option key={m} value={m}>
                            {tr("mgmt.ticker.everyMinutes", { count: m })}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <Switch checked={t.showTime} onChange={(v) => set({ showTime: v })} label={tr("mgmt.ticker.showTime")} description={tr("mgmt.ticker.showTimeHint")} />
                {slowestFeed != null && (
                  <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
                    <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
                    {tr("mgmt.ticker.refreshHint", { minutes: slowestFeed })}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* How it looks */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{tr("mgmt.ticker.lookTitle")}</h3>
              <Button variant="ghost" size="sm" icon={<Palette className="size-4" />} onClick={houseStyle}>
                {tr("mgmt.ticker.houseStyle")}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
              <Field label={tr("mgmt.ticker.label")} hint={tr("mgmt.ticker.labelHint")}>
                {(id) => <Input id={id} value={t.label} maxLength={30} placeholder={tr("mgmt.ticker.labelPlaceholder")} onChange={(e) => set({ label: e.target.value })} />}
              </Field>
              <Field label={tr("mgmt.ticker.separator")}>
                {(id) => (
                  <div className="flex flex-wrap gap-1.5">
                    <Input id={id} className="w-16! text-center" value={t.separator} maxLength={12} onChange={(e) => set({ separator: e.target.value })} />
                    {["•", "|", "/", "◆", "+++"].map((s) => (
                      <button key={s} type="button" onClick={() => set({ separator: s })} className={cx("h-10 min-w-9 rounded-md border px-2 text-sm", t.separator === s ? "border-brand bg-brand/10" : "border-line hover:bg-surface-2")}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </div>
            <div>
              <Range label={`${tr("mgmt.ticker.speed")} (${t.speed} px/s)`} value={t.speed} min={20} max={400} step={5} onChange={(v) => set({ speed: v })} ends={[tr("mgmt.ticker.slow"), tr("mgmt.ticker.fast")]} />
              <div className="mt-1 flex gap-1.5">
                {SPEEDS.map(([k, v]) => (
                  <button key={k} type="button" onClick={() => set({ speed: v })} className={cx("rounded-md border px-2.5 py-1 text-xs font-medium", t.speed === v ? "border-brand bg-brand/10" : "border-line hover:bg-surface-2")}>
                    {tr(`mgmt.ticker.speed_${k}`)}
                  </button>
                ))}
              </div>
            </div>
            <Range label={`${tr("mgmt.ticker.fontSize")} (${t.fontSize} px)`} value={t.fontSize} min={18} max={64} onChange={(v) => set({ fontSize: v })} ends={[tr("mgmt.ticker.small"), tr("mgmt.ticker.large")]} />
            <div className="grid grid-cols-2 gap-3">
              <Switch checked={t.bold} onChange={(v) => set({ bold: v })} label={tr("mgmt.ticker.bold")} />
              <Switch checked={t.uppercase} onChange={(v) => set({ uppercase: v })} label={tr("mgmt.ticker.uppercase")} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ColorField label={tr("mgmt.ticker.colorBackground")} value={t.colors.background} onChange={color("background")} />
              <ColorField label={tr("mgmt.ticker.colorText")} value={t.colors.text} onChange={color("text")} />
              <ColorField label={tr("mgmt.ticker.colorAccent")} value={t.colors.accent} onChange={color("accent")} />
              <ColorField label={tr("mgmt.ticker.colorLabelText")} value={t.colors.labelText} onChange={color("labelText")} />
            </div>
            <Range label={`${tr("mgmt.ticker.opacity")} (${Math.round(t.backgroundOpacity * 100)}%)`} value={t.backgroundOpacity} min={0.2} max={1} step={0.02} onChange={(v) => set({ backgroundOpacity: v })} />
          </div>
        </div>
        <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">{tr("mgmt.ticker.layersHint")}</p>
      </CardBody>
    </Card>
  );
}
