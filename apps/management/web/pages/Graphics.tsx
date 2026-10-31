import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Switch, Textarea, cx, post, put } from "@tvsm/ui";
import { ImageUp, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelTabs } from "../components/ChannelPicker";
import { errorText, fmtTime, useChannelSelection, useChannels, type Graphics, type Position } from "../lib";

const POSITIONS: Position[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const corner = (p: Position) => ({ "top-left": "top-[5%] left-[5%]", "top-right": "top-[5%] right-[5%]", "bottom-left": "bottom-[5%] left-[5%]", "bottom-right": "bottom-[5%] right-[5%]" })[p];

function Preview({ g, logoUrl, channel }: { g: Graphics; logoUrl: string | null; channel: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-gradient-to-br from-slate-700 via-slate-800 to-slate-950 text-white">
      <div className="absolute inset-0 grid place-items-center text-sm text-white/20">{channel} · 1920×1080</div>
      {g.enabled && g.logo.enabled && (
        <div className={cx("absolute", corner(g.logo.position))} style={{ opacity: g.logo.opacity }}>
          {logoUrl ? <img src={logoUrl} alt="" className="max-h-[9cqh] max-w-[14cqw]" style={{ maxHeight: "9%", maxWidth: 140 }} /> : <div className="rounded bg-white/15 px-3 py-1.5 text-xs font-bold">LOGO</div>}
        </div>
      )}
      {g.enabled && g.clock.enabled && <div className={cx("absolute font-mono text-lg font-semibold drop-shadow", corner(g.clock.position))}>{fmtTime(now.getTime())}</div>}
      {g.enabled && g.upNext.enabled && (
        <div className="absolute bottom-[16%] left-[5%] flex text-xs sm:text-sm">
          <span className="rounded-l-md bg-brand px-3 py-1.5 font-bold uppercase">{t("mgmt.graphics.upNextTag")}</span>
          <span className="rounded-r-md bg-ink/85 px-3 py-1.5 font-semibold" style={{ background: "rgb(10 14 26 / 0.85)" }}>
            {t("mgmt.graphics.exampleTitle")} <span className="ml-2 text-blue-300">20:00</span>
          </span>
        </div>
      )}
      {g.enabled && g.ticker.enabled && g.ticker.text && (
        <div className="absolute right-0 bottom-0 left-0 truncate border-t-2 border-brand px-4 py-1.5 text-xs sm:text-sm" style={{ background: "rgb(10 14 26 / 0.9)" }}>
          {g.ticker.text}
        </div>
      )}
    </div>
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
        <PageHeader title={t("mgmt.graphics.title")} description={t("mgmt.graphics.intro")} />
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
        title={t("mgmt.graphics.title")}
        description={t("mgmt.graphics.intro")}
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
            <Switch checked={g.hideInCommercials} onChange={(v) => setG({ ...g, hideInCommercials: v })} label={t("mgmt.graphics.hideInAds")} />
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
              <Field label={`${t("mgmt.graphics.opacity")} (${Math.round(g.logo.opacity * 100)}%)`}>
                {(id) => <input id={id} type="range" min={0.1} max={1} step={0.05} value={g.logo.opacity} onChange={(e) => setG({ ...g, logo: { ...g.logo, opacity: Number(e.target.value) } })} className="accent-brand" />}
              </Field>
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
            <div className="space-y-3 border-t border-line pt-4">
              <Switch checked={g.ticker.enabled} onChange={(v) => setG({ ...g, ticker: { ...g.ticker, enabled: v } })} label={t("mgmt.graphics.ticker")} />
              <Textarea className="min-h-16 font-sans text-sm" value={g.ticker.text} placeholder={t("mgmt.graphics.tickerPlaceholder")} onChange={(e) => setG({ ...g, ticker: { ...g.ticker, text: e.target.value } })} />
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
    </>
  );
}
