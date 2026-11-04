import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Switch, cx, post, put } from "@tvsm/ui";
import { CalendarClock, ImageUp, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelTabs } from "../components/ChannelPicker";
import { HourStartCard, LayersCard } from "../components/ChannelLayers";
import { TickerCard, TickerStrip, useTickerItems } from "../components/TickerCard";
import { errorText, fmtTime, layersOf, LINEUP_DEFAULTS, LOGO_OFFSET, LOGO_SIZE, logoOf, tickerOf, useChannelSelection, useChannels, type Graphics, type LineupSettings, type Position } from "../lib";

const POSITIONS: Position[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const corner = (p: Position) => ({ "top-left": "top-[5%] left-[5%]", "top-right": "top-[5%] right-[5%]", "bottom-left": "bottom-[5%] left-[5%]", "bottom-right": "bottom-[5%] right-[5%]" })[p];

/** Pixels on the 1920x1080 frame as a share of the preview's width (the preview is a size container). */
const px = (n: number) => `${(n / 19.2).toFixed(3)}cqw`;

/** The logo as the overlay draws it: `size` px high, inside the safe area (96 x 54 px), moved by the offsets. */
function LogoPreview({ logo, url }: { logo: Graphics["logo"]; url: string | null }) {
  const l = logoOf(logo);
  if (l.fullFrame) return <div className="absolute inset-0" style={{ opacity: l.opacity }}>{url && <img src={url} alt="" className="size-full" />}</div>;
  const v = l.position.startsWith("bottom") ? "bottom" : "top";
  const h = l.position.endsWith("left") ? "left" : "right";
  return (
    <div className="absolute" style={{ opacity: l.opacity, [v]: px(54 + l.offsetY), [h]: px(96 + l.offsetX) }}>
      {url ? (
        <img src={url} alt="" className="block w-auto" style={{ height: px(l.size), maxWidth: px(1728) }} />
      ) : (
        <div className="grid place-items-center rounded bg-white/15 px-3 font-bold" style={{ height: px(l.size), fontSize: px(l.size * 0.35) }}>
          LOGO
        </div>
      )}
    </div>
  );
}

function Preview({ g, logoUrl, channel }: { g: Graphics; logoUrl: string | null; channel: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(new Date());
  const ticker = tickerOf(g);
  const { items: tickerItems } = useTickerItems(ticker);
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-gradient-to-br from-slate-700 via-slate-800 to-slate-950 text-white" style={{ containerType: "inline-size" }}>
      <div className="absolute inset-0 grid place-items-center text-sm text-white/20">{channel} · 1920×1080</div>
      {g.enabled && g.logo.enabled && <LogoPreview logo={g.logo} url={logoUrl} />}
      {g.enabled && g.clock.enabled && <div className={cx("absolute font-mono text-lg font-semibold drop-shadow", corner(g.clock.position))}>{fmtTime(now.getTime())}</div>}
      {g.enabled && g.upNext.enabled && (
        <div className="absolute bottom-[16%] left-[5%] flex text-xs sm:text-sm">
          <span className="rounded-l-md bg-brand px-3 py-1.5 font-bold uppercase">{t("mgmt.graphics.upNextTag")}</span>
          <span className="rounded-r-md bg-ink/85 px-3 py-1.5 font-semibold" style={{ background: "rgb(10 14 26 / 0.85)" }}>
            {t("mgmt.graphics.exampleTitle")} <span className="ml-2 text-blue-300">20:00</span>
          </span>
        </div>
      )}
      {g.enabled && g.subtitles.enabled && (
        <div className="absolute right-[8%] bottom-[14%] left-[8%] text-center">
          <span className={cx("inline-block rounded px-2 py-0.5 font-semibold", g.subtitles.size === "small" ? "text-[11px]" : g.subtitles.size === "large" ? "text-base" : "text-sm")} style={{ background: "rgb(10 14 26 / 0.72)" }}>
            {t("mgmt.graphics.subtitleExample")}
          </span>
        </div>
      )}
      {g.enabled && ticker.enabled && tickerItems.length > 0 && <TickerStrip t={ticker} items={tickerItems} className="absolute right-0 bottom-0 left-0" />}
    </div>
  );
}

/** One slider with its value as a number field next to it, for the logo size and position. */
function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex items-center gap-3">
          <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 accent-brand" />
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
            <Input type="number" min={min} max={max} step={step} value={value} onChange={(e) => e.target.value !== "" && onChange(clamp(Number(e.target.value)))} className="h-8 w-20! text-right text-[13px]" aria-label={label} />
            {unit}
          </span>
        </div>
      )}
    </Field>
  );
}

/** Size, position and opacity of the channel logo. */
function LogoControls({ logo, onChange }: { logo: Graphics["logo"]; onChange: (l: Graphics["logo"]) => void }) {
  const { t } = useTranslation();
  const l = logoOf(logo);
  const set = (p: Partial<Graphics["logo"]>) => onChange({ ...l, ...p });
  return (
    <div className="space-y-3">
      <Switch checked={l.fullFrame} onChange={(v) => set({ fullFrame: v })} label={t("mgmt.graphics.logoFullFrame")} description={t("mgmt.graphics.logoFullFrameHint")} />
      {!l.fullFrame && (
        <>
          <Slider label={t("mgmt.graphics.logoSize")} value={l.size} min={LOGO_SIZE.min} max={LOGO_SIZE.max} step={2} unit="px" onChange={(size) => set({ size })} />
          <div className="space-y-3">
            <Slider label={t("mgmt.graphics.logoOffsetX")} value={l.offsetX} min={LOGO_OFFSET.min} max={LOGO_OFFSET.max} unit="px" onChange={(offsetX) => set({ offsetX })} />
            <Slider label={t("mgmt.graphics.logoOffsetY")} value={l.offsetY} min={LOGO_OFFSET.min} max={LOGO_OFFSET.max} unit="px" onChange={(offsetY) => set({ offsetY })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">{t("mgmt.graphics.logoSizeHint")}</p>
            <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => set({ size: LOGO_SIZE.default, offsetX: 0, offsetY: 0 })}>
              {t("mgmt.graphics.logoReset")}
            </Button>
          </div>
        </>
      )}
      <Field label={`${t("mgmt.graphics.opacity")} (${Math.round(l.opacity * 100)}%)`}>
        {(id) => <input id={id} type="range" min={0.1} max={1} step={0.05} value={l.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} className="accent-brand" />}
      </Field>
    </div>
  );
}

/** Settings and live preview of the "coming up" slide (programmes of the coming hour). */
function LineupCard({ channelId, value, onChange }: { channelId: number; value: LineupSettings; onChange: (v: LineupSettings) => void }) {
  const { t } = useTranslation();
  // The preview page is rendered by the server from the real schedule; wait a moment while typing.
  const [src, setSrc] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setSrc(`/lineup/page.html?channel=${channelId}&preview=1&settings=${encodeURIComponent(JSON.stringify(value))}`), 400);
    return () => clearTimeout(h);
  }, [channelId, value]);
  return (
    <Card className="mt-6">
      <CardHeader title={t("mgmt.lineup.settingsTitle")} description={t("mgmt.lineup.settingsIntro")} actions={<CalendarClock className="size-5 text-muted" />} />
      <CardBody className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <div className="space-y-2">
          <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">{src && <iframe title={t("mgmt.lineup.settingsTitle")} src={src} className="size-full border-0" />}</div>
          <p className="text-xs text-muted">{t("mgmt.lineup.previewHint")}</p>
        </div>
        <div className="space-y-4">
          <Field label={t("mgmt.lineup.heading")} hint={t("mgmt.lineup.headingHint")}>
            {(id) => <Input id={id} value={value.heading} maxLength={80} placeholder={t("mgmt.lineup.headingPlaceholder")} onChange={(e) => onChange({ ...value, heading: e.target.value })} />}
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("mgmt.lineup.language")}>
              {(id) => (
                <Select id={id} value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value as LineupSettings["language"] })}>
                  <option value="nl">Nederlands</option>
                  <option value="en">English</option>
                </Select>
              )}
            </Field>
            <Field label={t("mgmt.lineup.minutesAhead")}>
              {(id) => (
                <Select id={id} value={value.minutesAhead} onChange={(e) => onChange({ ...value, minutesAhead: Number(e.target.value) })}>
                  {[30, 60, 90, 120, 180].map((m) => (
                    <option key={m} value={m}>
                      {t("mgmt.lineup.minutes", { count: m })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("mgmt.lineup.maxRows")}>{(id) => <Input id={id} type="number" min={2} max={10} value={value.maxRows} onChange={(e) => onChange({ ...value, maxRows: Math.min(10, Math.max(2, Number(e.target.value) || 7)) })} />}</Field>
          </div>
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">{t("mgmt.lineup.howTo")}</p>
        </div>
      </CardBody>
    </Card>
  );
}

export function GraphicsPage() {
  const { t } = useTranslation();
  const { channels, reload } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const [g, setG] = useState<Graphics | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  useEffect(() => {
    setG(channel?.graphics ?? null);
    setMsg(null);
  }, [channel]);
  if (!channel || !g)
    return (
      <>
        <PageHeader title={t("mgmt.plan.channelTitle")} description={t("mgmt.plan.channelIntro")} />
        {channels && !channels.length && <Alert tone="warn">{t("mgmt.control.noChannelsIntro")}</Alert>}
      </>
    );
  const save = async () => {
    try {
      await put(`/api/channels/${channel.id}/graphics`, g);
      setMsg({ tone: "ok", text: t("common.saved") });
      void reload();
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        await post(`/api/channels/${channel.id}/logo`, { dataUrl: r.result });
        void reload();
      } catch (e) {
        setMsg({ tone: "danger", text: errorText(t, e) });
      }
    };
    r.readAsDataURL(file);
  };
  const logoUrl = g.logo.file ? `/graphics/${channel.id}/logo?v=${encodeURIComponent(g.logo.file)}` : null;
  const pos = (value: Position, on: (p: Position) => void) => (
    <Select className="h-8 w-auto! text-[13px]" value={value} onChange={(e) => on(e.target.value as Position)}>
      {POSITIONS.map((p) => (
        <option key={p} value={p}>
          {t(`mgmt.graphics.positions.${p}`)}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <PageHeader
        title={t("mgmt.plan.channelTitle")}
        description={t("mgmt.plan.channelIntro")}
        actions={
          <Button icon={<Save className="size-4" />} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        }
      />
      {channels && <ChannelTabs channels={channels} value={channel} onChange={setChannel} />}
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <Preview g={g} logoUrl={logoUrl} channel={channel.name} />
          <p className="text-xs text-muted">{t("mgmt.graphics.previewHint")}</p>
        </div>
        <Card>
          <CardHeader title={channel.name} />
          <CardBody className="space-y-5">
            <Switch checked={g.enabled} onChange={(v) => setG({ ...g, enabled: v })} label={t("mgmt.graphics.enabled")} description={t("mgmt.graphics.enabledHint")} />
            <div className="space-y-3 border-t border-line pt-4">
              <div className="flex items-center justify-between gap-3">
                <Switch checked={g.logo.enabled} onChange={(v) => setG({ ...g, logo: { ...g.logo, enabled: v } })} label={t("mgmt.graphics.logo")} />
                {pos(g.logo.position, (p) => setG({ ...g, logo: { ...g.logo, position: p } }))}
              </div>
              <div className="flex items-center gap-3">
                <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">
                  <ImageUp className="size-4" />
                  {t("mgmt.graphics.uploadLogo")}
                  <input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
                </label>
                <span className="text-xs text-muted">{t("mgmt.graphics.logoHint")}</span>
              </div>
              <LogoControls logo={g.logo} onChange={(logo) => setG({ ...g, logo })} />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <Switch checked={g.clock.enabled} onChange={(v) => setG({ ...g, clock: { ...g.clock, enabled: v } })} label={t("mgmt.graphics.clock")} />
              {pos(g.clock.position, (p) => setG({ ...g, clock: { ...g.clock, position: p } }))}
            </div>
            <div className="space-y-3 border-t border-line pt-4">
              <Switch checked={g.upNext.enabled} onChange={(v) => setG({ ...g, upNext: { ...g.upNext, enabled: v } })} label={t("mgmt.graphics.upNext")} description={t("mgmt.graphics.upNextHint")} />
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("mgmt.graphics.secondsBefore")}>{(id) => <Input id={id} type="number" min={5} max={600} value={g.upNext.secondsBeforeEnd} onChange={(e) => setG({ ...g, upNext: { ...g.upNext, secondsBeforeEnd: Number(e.target.value) || 60 } })} />}</Field>
                <Field label={t("mgmt.graphics.showFor")}>{(id) => <Input id={id} type="number" min={3} max={120} value={g.upNext.durationSeconds} onChange={(e) => setG({ ...g, upNext: { ...g.upNext, durationSeconds: Number(e.target.value) || 12 } })} />}</Field>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <Switch checked={g.ticker.enabled} onChange={(v) => setG({ ...g, ticker: { ...tickerOf(g), enabled: v } })} label={t("mgmt.graphics.ticker")} description={t("mgmt.ticker.shortHint")} />
              <a href="#ticker" className="shrink-0 text-xs font-medium text-brand hover:underline">
                {t("mgmt.ticker.settingsLink")}
              </a>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <Switch checked={g.subtitles.enabled} onChange={(v) => setG({ ...g, subtitles: { ...g.subtitles, enabled: v } })} label={t("mgmt.graphics.subtitles")} description={t("mgmt.graphics.subtitlesHint")} />
              <Select className="h-8 w-auto! text-[13px]" value={g.subtitles.size} onChange={(e) => setG({ ...g, subtitles: { ...g.subtitles, size: e.target.value as Graphics["subtitles"]["size"] } })}>
                {(["small", "medium", "large"] as const).map((sz) => (
                  <option key={sz} value={sz}>
                    {t(`mgmt.graphics.size_${sz}`)}
                  </option>
                ))}
              </Select>
            </div>
            <details className="border-t border-line pt-4 text-sm">
              <summary className="cursor-pointer font-medium">{t("mgmt.graphics.advanced")}</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label={t("mgmt.graphics.template")}>{(id) => <Input id={id} value={g.template} onChange={(e) => setG({ ...g, template: e.target.value })} />}</Field>
                <Field label={t("mgmt.graphics.layer")}>{(id) => <Input id={id} type="number" value={g.layer} onChange={(e) => setG({ ...g, layer: Number(e.target.value) || 20 })} />}</Field>
              </div>
            </details>
          </CardBody>
        </Card>
      </div>
      <div id="ticker" className="scroll-mt-4">
        <TickerCard value={tickerOf(g)} onChange={(ticker) => setG({ ...g, ticker })} />
      </div>
      <HourStartCard value={g.hourStart ?? { enabled: false, blockId: null }} onChange={(hourStart) => setG({ ...g, hourStart })} />
      <LayersCard g={g} layers={layersOf(g)} onChange={(layers) => setG({ ...g, layers, hideInCommercials: true })} />
      <LineupCard channelId={channel.id} value={g.lineup ?? LINEUP_DEFAULTS} onChange={(lineup) => setG({ ...g, lineup })} />
    </>
  );
}
