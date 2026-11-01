import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ChevronDown, Globe, Pencil, Play, Plus, Radio, Satellite, Send, Square, Trash2, Tv, Youtube, Facebook, Twitch, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { errorText, fmtTime, useGet, type Channel, type LiveSource } from "../lib";

type PlatformKind = "custom" | "youtube" | "facebook" | "twitch";
interface Destination {
  id: number;
  name: string;
  platform: PlatformKind;
  url: string;
  server: string;
  hasKey: boolean;
  keyHint: string | null;
  masked: string;
  enabled: boolean;
  usedBy: number;
}
type RelayState = "starting" | "live" | "retrying" | "off" | "disabled";
interface Output {
  id: number;
  name: string;
  source: "channel" | "remote";
  studioId: number | null;
  casparChannel: number | null;
  liveSourceId: number | null;
  encoder: "x264" | "nvenc";
  videoKbps: number;
  audioKbps: number;
  resolution: "source" | "720p";
  deinterlace: boolean;
  extraArgs: string;
  active: boolean;
  destinationIds: number[];
  status: {
    state: "off" | "waiting" | "starting" | "live" | "error";
    reason: string | null;
    encoderError: string | null;
    destinations: { id: number; state: RelayState; liveSince: string | null; kbps: number | null; error: string | null; restarts: number }[];
  };
}
interface Studio {
  id: number;
  name: string;
  status: { connected: boolean; channels?: number[] | null };
}
interface DestForm {
  id?: number;
  name: string;
  platform: PlatformKind;
  url: string;
  streamKey: string;
  hasKey: boolean;
  enabled: boolean;
}
interface OutForm {
  id?: number;
  name: string;
  source: "channel" | "remote";
  studioId: string;
  casparChannel: string;
  liveSourceId: string;
  encoder: "x264" | "nvenc";
  videoKbps: string;
  audioKbps: string;
  resolution: "source" | "720p";
  deinterlace: boolean;
  extraArgs: string;
  destinationIds: number[];
}

const PLATFORM_ICON = { custom: Server, youtube: Youtube, facebook: Facebook, twitch: Twitch } as const;

function PlatformIcon({ p, className }: { p: PlatformKind; className?: string }) {
  const Icon = PLATFORM_ICON[p] ?? Globe;
  return <Icon className={className ?? "size-4"} />;
}

function StateBadge({ state }: { state: Output["status"]["state"] | RelayState }) {
  const { t } = useTranslation();
  const tone = ({ live: "ok", starting: "brand", waiting: "warn", retrying: "warn", error: "danger", off: "neutral", disabled: "neutral" } as const)[state];
  return (
    <Badge tone={tone}>
      {state === "live" && <span className="size-1.5 animate-pulse rounded-full bg-ok" />} {t(`mgmt.outputs.state.${state}`)}
    </Badge>
  );
}

function HowItWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const chain = (keys: string[]) => (
    <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
      {keys.map((k, i) => (
        <span key={k} className="flex items-center gap-2">
          <span className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-fg">{t(`mgmt.outputs.how.chain.${k}`)}</span>
          {i < keys.length - 1 && <span aria-hidden>→</span>}
        </span>
      ))}
    </div>
  );
  return (
    <Card>
      <button className="flex w-full items-center gap-3 px-5 py-4 text-left" onClick={onToggle} aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-md bg-brand/10 text-brand">
          <Send className="size-4" />
        </span>
        <span className="flex-1">
          <span className="block font-semibold">{t("mgmt.outputs.how.title")}</span>
          <span className="block text-sm text-muted">{t("mgmt.outputs.how.intro")}</span>
        </span>
        <ChevronDown className={cx("size-4 text-muted transition", open && "rotate-180")} />
      </button>
      {open && (
        <CardBody className="space-y-4 border-t border-line">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-line p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Tv className="size-4 text-brand" /> {t("mgmt.outputs.how.channel.title")}
              </p>
              <p className="mb-3 text-sm text-muted">{t("mgmt.outputs.how.channel.text")}</p>
              {chain(["casparcg", "encoder", "ingest", "relay", "destinations"])}
            </div>
            <div className="rounded-lg border border-line p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Satellite className="size-4 text-brand" /> {t("mgmt.outputs.how.remote.title")}
              </p>
              <p className="mb-3 text-sm text-muted">{t("mgmt.outputs.how.remote.text")}</p>
              {chain(["contributor", "ingest", "relay", "destinations"])}
            </div>
          </div>
          <ol className="grid gap-3 md:grid-cols-3">
            {["dest", "stream", "start"].map((k, i) => (
              <li key={k} className="rounded-lg border border-line p-4">
                <span className="mb-2 grid size-6 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{i + 1}</span>
                <p className="text-sm font-semibold">{t(`mgmt.outputs.how.${k}.title`)}</p>
                <p className="mt-1 text-sm text-muted">{t(`mgmt.outputs.how.${k}.text`)}</p>
              </li>
            ))}
          </ol>
          <Alert tone="neutral">{t("mgmt.outputs.how.network")}</Alert>
        </CardBody>
      )}
    </Card>
  );
}

const emptyDest = (): DestForm => ({ name: "", platform: "custom", url: "", streamKey: "", hasKey: false, enabled: true });

export function OutputsPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const canOperate = roleAtLeast(user?.role, "operator");
  const data = useGet<{ outputs: Output[]; destinations: Destination[]; presets: Record<string, string> }>("/api/stream-outputs", 3000);
  const studios = useGet<{ studios: Studio[] }>("/api/studios", 10_000);
  const channels = useGet<{ channels: Channel[] }>("/api/channels");
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources", 10_000);
  const [how, setHow] = useState<boolean | null>(null);
  const [dest, setDest] = useState<DestForm | null>(null);
  const [out, setOut] = useState<OutForm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const outputs = data.data?.outputs ?? [];
  const dests = data.data?.destinations ?? [];
  const remotes = (live.data?.sources ?? []).filter((s) => s.kind === "rtmp");
  const studioList = studios.data?.studios ?? [];
  const howOpen = how ?? (data.data ? outputs.length === 0 : false);
  const destOf = (id: number) => dests.find((d) => d.id === id);

  /** "TV channel name (Studio 1, output 1)" for a CasparCG channel. */
  const channelLabel = (studioId: number | null, ch: number | null) => {
    const tv = channels.data?.channels.find((c) => c.studioId === studioId && c.casparChannel === ch);
    const st = studioList.find((s) => s.id === studioId);
    const where = t("mgmt.outputs.studioOutput", { studio: st?.name ?? "–", n: ch ?? "–" });
    return tv ? `${tv.name} · ${where}` : where;
  };
  const sourceLabel = (o: Output) => (o.source === "channel" ? channelLabel(o.studioId, o.casparChannel) : t("mgmt.outputs.remoteLabel", { name: remotes.find((r) => r.id === o.liveSourceId)?.name ?? "–" }));

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(id);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };

  const saveDest = async () => {
    if (!dest) return;
    setFormErr(null);
    const body = { name: dest.name, platform: dest.platform, url: dest.url.trim(), streamKey: dest.streamKey.trim() || undefined, enabled: dest.enabled };
    try {
      if (dest.id) await put(`/api/stream-destinations/${dest.id}`, body);
      else await post("/api/stream-destinations", body);
      setDest(null);
      await data.reload();
    } catch (e) {
      setFormErr(errorText(t, e));
    }
  };
  const saveOut = async () => {
    if (!out) return;
    setFormErr(null);
    const body = {
      name: out.name,
      source: out.source,
      studioId: Number(out.studioId) || null,
      casparChannel: Number(out.casparChannel) || null,
      liveSourceId: Number(out.liveSourceId) || null,
      encoder: out.encoder,
      videoKbps: Number(out.videoKbps) || 4500,
      audioKbps: Number(out.audioKbps) || 160,
      resolution: out.resolution,
      deinterlace: out.deinterlace,
      extraArgs: out.extraArgs,
      destinationIds: out.destinationIds,
    };
    try {
      if (out.id) await put(`/api/stream-outputs/${out.id}`, body);
      else await post("/api/stream-outputs", body);
      setOut(null);
      await data.reload();
    } catch (e) {
      setFormErr(errorText(t, e));
    }
  };

  const newOut = (): OutForm => {
    const tv = channels.data?.channels.find((c) => c.studioId);
    return {
      name: "",
      source: "channel",
      studioId: String(tv?.studioId ?? studioList[0]?.id ?? ""),
      casparChannel: String(tv?.casparChannel ?? studioList[0]?.status.channels?.[0] ?? 1),
      liveSourceId: String(remotes[0]?.id ?? ""),
      encoder: "x264",
      videoKbps: "4500",
      audioKbps: "160",
      resolution: "source",
      deinterlace: true,
      extraArgs: "",
      destinationIds: dests.length === 1 ? [dests[0]!.id] : [],
    };
  };
  const editOut = (o: Output): OutForm => ({
    id: o.id,
    name: o.name,
    source: o.source,
    studioId: String(o.studioId ?? ""),
    casparChannel: String(o.casparChannel ?? ""),
    liveSourceId: String(o.liveSourceId ?? ""),
    encoder: o.encoder,
    videoKbps: String(o.videoKbps),
    audioKbps: String(o.audioKbps),
    resolution: o.resolution,
    deinterlace: o.deinterlace,
    extraArgs: o.extraArgs,
    destinationIds: o.destinationIds,
  });
  const setO = <K extends keyof OutForm>(k: K, v: OutForm[K]) => out && setOut({ ...out, [k]: v });
  const setD = <K extends keyof DestForm>(k: K, v: DestForm[K]) => dest && setDest({ ...dest, [k]: v });
  const presetServer = (p: PlatformKind) => (p === "custom" ? "" : (data.data?.presets[p] ?? ""));
  const outChannels = studioList.find((s) => s.id === Number(out?.studioId))?.status.channels;

  return (
    <>
      <PageHeader
        title={t("mgmt.outputs.title")}
        description={t("mgmt.outputs.intro")}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => (setFormErr(null), setDest(emptyDest()))}>
                {t("mgmt.outputs.addDest")}
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => (setFormErr(null), setOut(newOut()))}>
                {t("mgmt.outputs.addStream")}
              </Button>
            </>
          )
        }
      />
      <div className="space-y-6">
        <HowItWorks open={howOpen} onToggle={() => setHow(!howOpen)} />
        {err && <Alert tone="danger">{err}</Alert>}

        <Card>
          <CardHeader icon={<Radio className="size-4" />} title={t("mgmt.outputs.streams")} description={t("mgmt.outputs.streamsIntro")} />
          <ul className="divide-y divide-line">
            {outputs.map((o) => (
              <li key={o.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{o.name}</p>
                      <StateBadge state={o.status.state} />
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                      {o.source === "channel" ? <Tv className="size-3.5" /> : <Satellite className="size-3.5" />}
                      {sourceLabel(o)}
                      {o.source === "channel" && ` · ${o.videoKbps / 1000} Mbit/s${o.resolution === "720p" ? " · 720p" : ""}${o.encoder === "nvenc" ? " · NVENC" : ""}`}
                    </p>
                    {o.status.reason && <p className={cx("mt-1 text-xs", o.status.state === "error" ? "text-danger" : "text-warn")}>{t(`mgmt.outputs.reason.${o.status.reason}`)}</p>}
                    {o.status.encoderError && <p className="mt-1 text-xs text-danger">{t("mgmt.outputs.encoderError", { message: o.status.encoderError })}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canOperate &&
                      (o.active ? (
                        <Button size="sm" variant="secondary" loading={busy === o.id} icon={<Square className="size-3.5" />} onClick={() => confirm(t("mgmt.outputs.confirmStop", { name: o.name })) && void act(o.id, () => post(`/api/stream-outputs/${o.id}/active`, { on: false }))}>
                          {t("mgmt.outputs.stop")}
                        </Button>
                      ) : (
                        <Button size="sm" loading={busy === o.id} disabled={!o.destinationIds.length} icon={<Play className="size-3.5" />} onClick={() => void act(o.id, () => post(`/api/stream-outputs/${o.id}/active`, { on: true }))}>
                          {t("mgmt.outputs.start")}
                        </Button>
                      ))}
                    {canEdit && (
                      <>
                        <Button size="sm" variant="ghost" aria-label={t("common.edit")} icon={<Pencil className="size-3.5" />} onClick={() => (setFormErr(null), setOut(editOut(o)))} />
                        <Button size="sm" variant="ghost" aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} onClick={() => confirm(t("mgmt.devices.confirmDelete", { name: o.name })) && void act(o.id, () => del(`/api/stream-outputs/${o.id}`))} />
                      </>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {o.status.destinations.map((ds) => {
                    const d = destOf(ds.id);
                    if (!d) return null;
                    return (
                      <div key={ds.id} className="flex min-w-56 items-start gap-2 rounded-md border border-line bg-surface-2/50 px-3 py-2" title={ds.error ?? undefined}>
                        <PlatformIcon p={d.platform} className="mt-0.5 size-4 text-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{d.name}</span>
                            {o.active && <StateBadge state={ds.state} />}
                          </div>
                          {ds.state === "live" && (
                            <p className="text-xs text-muted">
                              {[ds.kbps != null ? `${(ds.kbps / 1000).toFixed(1)} Mbit/s` : null, ds.liveSince ? t("mgmt.remote.since", { time: fmtTime(ds.liveSince) }) : null].filter(Boolean).join(" · ")}
                            </p>
                          )}
                          {ds.error && ds.state !== "live" && <p className="max-w-80 truncate text-xs text-danger">{ds.error}</p>}
                        </div>
                      </div>
                    );
                  })}
                  {!o.destinationIds.length && <p className="text-xs text-warn">{t("mgmt.outputs.reason.no_destinations")}</p>}
                </div>
              </li>
            ))}
            {data.data && !outputs.length && <li className="px-5 py-8 text-center text-sm text-muted">{t("mgmt.outputs.noStreams")}</li>}
          </ul>
        </Card>

        <Card>
          <CardHeader icon={<Globe className="size-4" />} title={t("mgmt.outputs.destinations")} description={t("mgmt.outputs.destinationsIntro")} />
          <ul className="divide-y divide-line">
            {dests.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <span className="grid size-8 place-items-center rounded-md bg-brand/10 text-brand">
                  <PlatformIcon p={d.platform} />
                </span>
                <div className="min-w-48 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{d.name}</p>
                    <Badge tone="neutral">{t(`mgmt.outputs.platform.${d.platform}`)}</Badge>
                    {!d.enabled && <Badge tone="warn">{t("mgmt.outputs.disabled")}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-muted">{d.masked}</p>
                </div>
                <span className="text-xs text-muted">{t("mgmt.outputs.usedBy", { count: d.usedBy })}</span>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("common.edit")}
                      icon={<Pencil className="size-3.5" />}
                      onClick={() => (setFormErr(null), setDest({ id: d.id, name: d.name, platform: d.platform, url: d.url, streamKey: "", hasKey: d.hasKey, enabled: d.enabled }))}
                    />
                    <Button size="sm" variant="ghost" aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} onClick={() => confirm(t("mgmt.devices.confirmDelete", { name: d.name })) && void act(-d.id, () => del(`/api/stream-destinations/${d.id}`))} />
                  </div>
                )}
              </li>
            ))}
            {data.data && !dests.length && <li className="px-5 py-8 text-center text-sm text-muted">{t("mgmt.outputs.noDestinations")}</li>}
          </ul>
        </Card>
      </div>

      {/* ---- destination dialog ---- */}
      <Dialog
        open={!!dest}
        onClose={() => setDest(null)}
        title={t(dest?.id ? "mgmt.outputs.editDest" : "mgmt.outputs.addDest")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDest(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveDest()} disabled={!dest?.name || (dest.platform === "custom" && !dest.url) || (dest.platform !== "custom" && !dest.hasKey && !dest.streamKey)}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {dest && (
          <div className="space-y-4">
            {formErr && <Alert tone="danger">{formErr}</Alert>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["custom", "youtube", "facebook", "twitch"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDest({ ...dest, platform: p, name: dest.name || (p === "custom" ? "" : t(`mgmt.outputs.platform.${p}`)), url: p === "custom" ? dest.url : "" })}
                  className={cx("flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition", dest.platform === p ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-fg")}
                >
                  <PlatformIcon p={p} className="size-5" />
                  {t(`mgmt.outputs.platform.${p}`)}
                </button>
              ))}
            </div>
            <Field label={t("common.name")}>{(id) => <Input id={id} value={dest.name} placeholder={t("mgmt.outputs.form.destNamePlaceholder")} onChange={(e) => setD("name", e.target.value)} />}</Field>
            <Field label={t("mgmt.outputs.form.server")} hint={t(`mgmt.outputs.form.serverHint.${dest.platform}`)}>
              {(id) => <Input id={id} className="font-mono text-[12.5px]" value={dest.url} placeholder={presetServer(dest.platform) || "rtmp://stream.example.org/live"} onChange={(e) => setD("url", e.target.value)} />}
            </Field>
            <Field label={t("mgmt.outputs.form.key")} hint={t(`mgmt.outputs.form.keyHint.${dest.platform}`)}>
              {(id) => <Input id={id} type="password" autoComplete="off" className="font-mono text-[12.5px]" value={dest.streamKey} placeholder={dest.hasKey ? t("mgmt.outputs.form.keyKeep") : ""} onChange={(e) => setD("streamKey", e.target.value)} />}
            </Field>
            <Switch checked={dest.enabled} onChange={(v) => setD("enabled", v)} label={t("mgmt.outputs.form.enabled")} description={t("mgmt.outputs.form.enabledHint")} />
          </div>
        )}
      </Dialog>

      {/* ---- stream dialog ---- */}
      <Dialog
        open={!!out}
        wide
        onClose={() => setOut(null)}
        title={t(out?.id ? "mgmt.outputs.editStream" : "mgmt.outputs.addStream")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOut(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void saveOut()} disabled={!out?.name || (out.source === "channel" ? !out.studioId || !out.casparChannel : !out.liveSourceId)}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {out && (
          <div className="space-y-5">
            {formErr && <Alert tone="danger">{formErr}</Alert>}
            <Field label={t("common.name")}>{(id) => <Input id={id} value={out.name} placeholder={t("mgmt.outputs.form.streamNamePlaceholder")} onChange={(e) => setO("name", e.target.value)} />}</Field>
            <div>
              <p className="mb-2 text-sm font-medium">{t("mgmt.outputs.form.source")}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["channel", "remote"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setO("source", s)}
                    className={cx("flex items-start gap-3 rounded-lg border p-3 text-left transition", out.source === s ? "border-brand bg-brand/10" : "border-line hover:bg-surface-2")}
                  >
                    {s === "channel" ? <Tv className="mt-0.5 size-4 text-brand" /> : <Satellite className="mt-0.5 size-4 text-brand" />}
                    <span>
                      <span className="block text-sm font-semibold">{t(`mgmt.outputs.form.source_${s}`)}</span>
                      <span className="block text-xs text-muted">{t(`mgmt.outputs.form.source_${s}Hint`)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {out.source === "channel" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("mgmt.channels.studio")}>
                    {(id) => (
                      <Select id={id} value={out.studioId} onChange={(e) => setO("studioId", e.target.value)}>
                        <option value="">–</option>
                        {studioList.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("mgmt.outputs.form.channel")} hint={t("mgmt.outputs.form.channelHint")}>
                    {(id) =>
                      outChannels?.length ? (
                        <Select id={id} value={out.casparChannel} onChange={(e) => setO("casparChannel", e.target.value)}>
                          {!outChannels.includes(Number(out.casparChannel)) && <option value={out.casparChannel}>{t("mgmt.remote.form.missingOutput", { n: out.casparChannel })}</option>}
                          {outChannels.map((c) => (
                            <option key={c} value={c}>
                              {channelLabel(Number(out.studioId), c)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input id={id} type="number" min={1} max={16} value={out.casparChannel} onChange={(e) => setO("casparChannel", e.target.value)} />
                      )
                    }
                  </Field>
                </div>
                <div className="rounded-lg border border-line p-4">
                  <p className="mb-3 text-sm font-semibold">{t("mgmt.outputs.form.encoding")}</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label={t("mgmt.outputs.form.videoKbps")}>{(id) => <Input id={id} type="number" min={300} max={25000} step={500} value={out.videoKbps} onChange={(e) => setO("videoKbps", e.target.value)} />}</Field>
                    <Field label={t("mgmt.outputs.form.audioKbps")}>
                      {(id) => (
                        <Select id={id} value={out.audioKbps} onChange={(e) => setO("audioKbps", e.target.value)}>
                          {["96", "128", "160", "192", "256"].map((v) => (
                            <option key={v} value={v}>
                              {v} kbit/s
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t("mgmt.outputs.form.resolution")}>
                      {(id) => (
                        <Select id={id} value={out.resolution} onChange={(e) => setO("resolution", e.target.value as OutForm["resolution"])}>
                          <option value="source">{t("mgmt.outputs.form.resSource")}</option>
                          <option value="720p">720p (1280×720)</option>
                        </Select>
                      )}
                    </Field>
                    <Field label={t("mgmt.outputs.form.encoder")} className="sm:col-span-3">
                      {(id) => (
                        <Select id={id} value={out.encoder} onChange={(e) => setO("encoder", e.target.value as OutForm["encoder"])}>
                          <option value="x264">{t("mgmt.outputs.form.encX264")}</option>
                          <option value="nvenc">{t("mgmt.outputs.form.encNvenc")}</option>
                        </Select>
                      )}
                    </Field>
                  </div>
                  <div className="mt-4">
                    <Switch checked={out.deinterlace} onChange={(v) => setO("deinterlace", v)} label={t("mgmt.outputs.form.deinterlace")} description={t("mgmt.outputs.form.deinterlaceHint")} />
                  </div>
                  <details className="mt-4 rounded-md border border-line">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("mgmt.remote.form.advanced")}</summary>
                    <div className="border-t border-line p-3">
                      <Field label={t("mgmt.outputs.form.extraArgs")} hint={t("mgmt.outputs.form.extraArgsHint")}>
                        {(id) => <Input id={id} className="font-mono text-[12.5px]" value={out.extraArgs} placeholder="-profile:v high" onChange={(e) => setO("extraArgs", e.target.value)} />}
                      </Field>
                    </div>
                  </details>
                </div>
              </>
            ) : (
              <>
                <Field label={t("mgmt.outputs.form.remote")} hint={t("mgmt.outputs.form.remoteHint")}>
                  {(id) => (
                    <Select id={id} value={out.liveSourceId} onChange={(e) => setO("liveSourceId", e.target.value)}>
                      <option value="">–</option>
                      {remotes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {live.data && !remotes.length && (
                  <Alert tone="warn">
                    {t("mgmt.outputs.form.noRemote")}{" "}
                    <Link className="font-medium underline" to="/remote">
                      {t("mgmt.nav.remote")}
                    </Link>
                  </Alert>
                )}
                <Alert tone="neutral">{t("mgmt.outputs.form.remoteNote")}</Alert>
              </>
            )}

            <div>
              <p className="mb-2 text-sm font-medium">{t("mgmt.outputs.form.destinations")}</p>
              {dests.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {dests.map((d) => {
                    const on = out.destinationIds.includes(d.id);
                    return (
                      <label key={d.id} className={cx("flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition", on ? "border-brand bg-brand/5" : "border-line hover:bg-surface-2")}>
                        <input type="checkbox" checked={on} onChange={() => setO("destinationIds", on ? out.destinationIds.filter((x) => x !== d.id) : [...out.destinationIds, d.id])} />
                        <PlatformIcon p={d.platform} className="size-4 text-muted" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{d.name}</span>
                          <span className="block truncate font-mono text-[11px] text-muted">{d.masked}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <Alert tone="warn">{t("mgmt.outputs.form.noDest")}</Alert>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
