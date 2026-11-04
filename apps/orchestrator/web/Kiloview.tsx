import { Alert, ApiError, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowLeft, ArrowLeftRight, ArrowRight, ChevronDown, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { COMMON_FORMATS, type KiloviewKind, type KiloviewSnapshot, type KvOutput, type KvStream } from "../server/kiloviewlogic";
import type { Issue } from "../server/monitorlogic";

interface Kiloview {
  id: string;
  name: string;
  kind: KiloviewKind;
  host: string;
  username: string;
  hasPassword: boolean;
  location: string;
  notes: string;
  expectedFormat: string;
  watch: string[] | null;
  online: boolean;
  lastError: string | null;
  lastSeenAt: string | null;
  snapshot: KiloviewSnapshot | null;
  issues: Issue[];
}

const mbit = (kbps: number | null) => (kbps == null ? "–" : kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10000 ? 1 : 2)} Mbit/s` : `${Math.round(kbps)} kbit/s`);

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`orch.kiloview.err_${e.code}`, { defaultValue: t(`orch.teranex.err_${e.code}`, { defaultValue: e.message }) }) : String(e));
}
function useIssue() {
  const { t } = useTranslation();
  return (i: Issue) => t(`orch.mon.issue.${i.code}`, { ...i.params, defaultValue: i.code });
}

function Status({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={cx("relative size-2.5 rounded-full", on ? "bg-ok" : "bg-danger")}>{on && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40" />}</span>
      <span className={on ? "text-ok" : "text-danger"}>{on ? t("orch.nodes.online") : t("orch.nodes.offline")}</span>
    </span>
  );
}

function KiloviewDialog({ kv, onClose, onDone }: { kv?: Kiloview; onClose: () => void; onDone: (d: Kiloview) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({
    name: kv?.name ?? "",
    kind: kv?.kind ?? ("encoder" as KiloviewKind),
    host: kv?.host ?? "",
    username: kv?.username ?? "admin",
    password: "",
    location: kv?.location ?? "",
    notes: kv?.notes ?? "",
    expectedFormat: kv?.expectedFormat ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; product?: string | null; firmware?: string | null; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(kv ? await put<Kiloview>(`/api/kiloview/${kv.id}`, f) : await post<Kiloview>("/api/kiloview", f));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      setTested(await post("/api/kiloview/test", { ...f, id: kv?.id }));
    } catch (e) {
      setTested({ ok: false, error: err(e) });
    } finally {
      setTesting(false);
    }
  };
  const canSave = !!f.name && !!f.host && !!f.username && (!!kv?.hasPassword || !!f.password);
  return (
    <Dialog
      open
      onClose={onClose}
      title={kv ? t("orch.kiloview.edit") : t("orch.kiloview.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" loading={testing} onClick={test} disabled={!f.host || !f.username}>
            {t("orch.kiloview.test")}
          </Button>
          <Button loading={busy} onClick={save} disabled={!canSave}>
            {kv ? t("common.save") : t("orch.kiloview.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {tested && (
          <Alert tone={tested.ok ? "ok" : "danger"}>
            {tested.ok ? t("orch.kiloview.testOk", { product: tested.product ?? "Kiloview", firmware: tested.firmware ?? "?" }) : t(`orch.kiloview.fail_${tested.error}`, { defaultValue: t("orch.kiloview.testFail", { error: tested.error }) })}
          </Alert>
        )}
        <Field label={t("orch.kiloview.kind")}>
          {(id) => (
            <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as KiloviewKind })}>
              <option value="encoder">{t("orch.kiloview.kind_encoder_long")}</option>
              <option value="decoder">{t("orch.kiloview.kind_decoder_long")}</option>
            </Select>
          )}
        </Field>
        <Field label={t("orch.atem.name")}>{(id) => <Input id={id} value={f.name} placeholder={f.kind === "encoder" ? "E3 Beverwijk" : "D260 Velsen"} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t("orch.atem.host")} hint={t("orch.kiloview.hostHint")}>
          {(id) => <Input id={id} className="font-mono" value={f.host} placeholder="10.40.5.52" onChange={(e) => setF({ ...f, host: e.target.value })} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("orch.kiloview.username")}>{(id) => <Input id={id} autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
          <Field label={t("orch.kiloview.password")} hint={kv?.hasPassword ? t("orch.kiloview.passwordKeep") : undefined}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.password} placeholder={kv?.hasPassword ? "••••••••" : ""} onChange={(e) => setF({ ...f, password: e.target.value })} />}
          </Field>
        </div>
        <Field label={`${f.kind === "encoder" ? t("orch.kiloview.expectedIn") : t("orch.kiloview.expectedOut")} (${t("common.optional")})`} hint={t("orch.kiloview.expectedHint")}>
          {(id) => (
            <>
              <Input id={id} className="font-mono" list={`${id}-formats`} value={f.expectedFormat} placeholder="1080i50" maxLength={32} onChange={(e) => setF({ ...f, expectedFormat: e.target.value })} />
              <datalist id={`${id}-formats`}>
                {COMMON_FORMATS.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label={`${t("orch.atem.location")} (${t("common.optional")})`}>
          {(id) => <Input id={id} value={f.location} placeholder={t("orch.atem.locationPlaceholder")} onChange={(e) => setF({ ...f, location: e.target.value })} />}
        </Field>
        <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>
          {(id) => <Textarea id={id} className="font-sans text-sm" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}
        </Field>
        <p className="flex items-start gap-2 text-xs text-muted">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          {t("orch.kiloview.readOnly")}
        </p>
      </div>
    </Dialog>
  );
}

/** Dark "device display" box with a big value, like on the Teranex page. */
function Panel({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "warn" }) {
  return (
    <div className={cx("min-w-0 rounded-lg border p-4", tone === "danger" ? "border-[var(--tvsm-danger)] bg-[color-mix(in_oklab,var(--tvsm-danger)_18%,transparent)]" : "border-white/10 bg-black/30")}>
      <p className="text-[10px] tracking-widest text-white/45 uppercase">{label}</p>
      <p className={cx("truncate font-mono text-2xl font-semibold tabular-nums sm:text-3xl", tone === "danger" ? "text-[var(--tvsm-danger)]" : tone === "warn" ? "text-[var(--tvsm-warning)]" : "text-white")}>{value}</p>
      {sub && <p className="mt-1 truncate text-xs text-white/55">{sub}</p>}
    </div>
  );
}

function Watch({ on, admin, onChange }: { on: boolean; admin: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <label className={cx("inline-flex items-center gap-1.5 text-xs", admin ? "cursor-pointer" : "opacity-70")} title={t("orch.kiloview.watchHint")}>
      <input type="checkbox" className="size-3.5 accent-[var(--tvsm-brand)]" checked={on} disabled={!admin} onChange={(e) => onChange(e.target.checked)} />
      {t("orch.kiloview.watch")}
    </label>
  );
}

function StreamRow({ s, watched, admin, onWatch }: { s: KvStream; watched: boolean; admin: boolean; onWatch: (v: boolean) => void }) {
  const { t } = useTranslation();
  const bad = watched && !s.running;
  return (
    <li className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3", !s.enabled && "opacity-60")}>
      <span className={cx("size-2.5 shrink-0 rounded-full", s.running ? "bg-ok" : bad ? "animate-pulse bg-danger" : "bg-line")} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {s.name} <Badge>{s.type.toUpperCase().replace("_", " ")}</Badge>
        </p>
        <p className="truncate text-xs text-muted">{s.target ? <Mono>{s.target}</Mono> : t("orch.kiloview.noTarget")}</p>
      </div>
      <Badge tone={s.running ? "ok" : bad ? "danger" : "neutral"}>{!s.enabled ? t("orch.kiloview.disabled") : s.running ? t("orch.kiloview.running") : t("orch.kiloview.stopped")}</Badge>
      <Watch on={watched} admin={admin} onChange={onWatch} />
    </li>
  );
}

function EncoderView({ kv, admin, onWatch }: { kv: Kiloview; admin: boolean; onWatch: (key: string, on: boolean) => void }) {
  const { t } = useTranslation();
  const e = kv.snapshot!.encoder!;
  const live = kv.online;
  const noSig = live && e.input.signal === false;
  const watch = new Set(kv.watch ?? []);
  const mismatch = kv.issues.some((i) => i.code === "input_format");
  return (
    <>
      <Card>
        <CardHeader title={t("orch.teranex.signalPath")} description={t("orch.kiloview.encoderIntro")} icon={<ArrowLeftRight className="size-4" />} />
        <CardBody>
          <div className="rounded-xl bg-[color-mix(in_oklab,var(--tvsm-sidebar)_92%,black)] p-5 text-white">
            <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <Panel label={`${t("orch.teranex.input")} · ${e.activeInput ?? "–"}`} value={!live ? "––" : noSig ? t("orch.teranex.noSignalShort") : (e.input.format ?? "––")} sub={live ? (e.input.raw ?? "–") : "–"} tone={noSig ? "danger" : mismatch ? "warn" : undefined} />
              <ArrowRight className="hidden size-6 text-white/30 lg:block" />
              <Panel label={t("orch.kiloview.encoder")} value={live ? mbit(e.video?.bitrateKbps ?? null) : "––"} sub={live && e.video ? [e.video.codec, e.video.mode, e.video.width && `${e.video.width}x${e.video.height}`, e.video.fps && `${e.video.fps} fps`].filter(Boolean).join(" · ") : "–"} />
              <ArrowRight className="hidden size-6 text-white/30 lg:block" />
              <Panel
                label={t("orch.kiloview.streams")}
                value={live ? `${e.streams.filter((s) => s.running).length} / ${e.streams.filter((s) => s.enabled).length}` : "––"}
                sub={live ? t("orch.kiloview.streamsRunning") : "–"}
                tone={live && kv.issues.some((i) => i.code === "stream_stopped") ? "danger" : undefined}
              />
            </div>
            {live && e.audio && (
              <p className="mt-3 text-xs text-white/55">
                {t("orch.teranex.audio")}: {[e.audio.source, e.audio.sampling && `${e.audio.sampling / 1000} kHz`, e.audio.channels && `${e.audio.channels} ch`, e.audio.mute ? t("orch.kiloview.muted") : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t("orch.kiloview.streams")} description={t("orch.kiloview.streamsIntro")} />
        <ul className="divide-y divide-line text-sm">
          {e.streams.map((s) => (
            <StreamRow key={s.id} s={s} watched={watch.has(s.id)} admin={admin} onWatch={(v) => onWatch(s.id, v)} />
          ))}
        </ul>
      </Card>
    </>
  );
}

function OutputBlock({ o, watched, admin, onWatch, want }: { o: KvOutput; watched: boolean; admin: boolean; onWatch: (v: boolean) => void; want: string }) {
  const { t } = useTranslation();
  const bad = watched && o.playing !== true;
  const wrong = !!want && watched && !!o.format && o.format.replace(/\s+/g, "").toLowerCase() !== want.replace(/\s+/g, "").toLowerCase();
  return (
    <div className={cx("rounded-xl bg-[color-mix(in_oklab,var(--tvsm-sidebar)_92%,black)] p-5 text-white", bad && "ring-2 ring-[var(--tvsm-danger)]")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {o.connector ?? `Output ${o.id}`} <span className="text-xs font-normal text-white/50">· output {o.id}</span>
        </p>
        <span className="rounded-md bg-white/90 px-2 py-1 text-fg">
          <Watch on={watched} admin={admin} onChange={onWatch} />
        </span>
      </div>
      <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <Panel
          label={`${t("orch.kiloview.source")}${o.source ? ` · ${o.source.type.toUpperCase().replace("_", " ")}` : ""}`}
          value={!o.source ? "––" : o.playing ? (o.streamFormat ?? "OK") : t("orch.kiloview.noPictureShort")}
          sub={o.source ? `${o.source.name}${o.playing ? ` · ${mbit(o.bitrateKbps)}` : ""}` : t("orch.kiloview.noSource")}
          tone={bad ? "danger" : undefined}
        />
        <ArrowRight className="hidden size-6 text-white/30 lg:block" />
        <Panel label={`${t("orch.teranex.output")} · ${o.connector ?? "–"}`} value={o.format ?? "––"} sub={o.codec ?? "–"} tone={wrong ? "warn" : undefined} />
      </div>
    </div>
  );
}

function DecoderView({ kv, admin, onWatch }: { kv: Kiloview; admin: boolean; onWatch: (key: string, on: boolean) => void }) {
  const { t } = useTranslation();
  const d = kv.snapshot!.decoder!;
  const watch = new Set(kv.watch ?? []);
  return (
    <Card>
      <CardHeader title={t("orch.teranex.signalPath")} description={t("orch.kiloview.decoderIntro")} icon={<ArrowLeftRight className="size-4" />} />
      <CardBody className="space-y-4">
        {d.outputs.map((o) => (
          <OutputBlock key={o.id} o={o} watched={watch.has(o.id)} admin={admin} onWatch={(v) => onWatch(o.id, v)} want={kv.expectedFormat} />
        ))}
      </CardBody>
    </Card>
  );
}

function RawData({ s }: { s: KiloviewSnapshot }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <CardHeader title={t("orch.teranex.allSettings")} description={t("orch.kiloview.rawIntro")} actions={<ChevronDown className={cx("size-5 text-muted transition", open && "rotate-180")} />} />
      </button>
      {open && (
        <CardBody className="space-y-4 pt-0">
          {Object.entries(s.raw).map(([path, v]) => (
            <div key={path}>
              <p className="mb-1 font-mono text-[11px] font-semibold text-muted">GET {path}</p>
              <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[11px] leading-snug">{JSON.stringify(v, null, 2)}</pre>
            </div>
          ))}
        </CardBody>
      )}
    </Card>
  );
}

function Detail({ id }: { id: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const issue = useIssue();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [d, setD] = useState<{ kiloview: Kiloview; events: { type: string; message: string; at: string }[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => get<typeof d>(`/api/kiloview/${id}`).then(setD), [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 3000);
    return () => clearInterval(i);
  }, [load]);
  if (!d) return null;
  const k = d.kiloview;
  const s = k.snapshot;
  const onWatch = async (key: string, on: boolean) => {
    const cur = new Set(k.watch ?? []);
    if (on) cur.add(key);
    else cur.delete(key);
    await put(`/api/kiloview/${k.id}/watch`, { watch: [...cur] });
    void load();
  };
  const Row = ({ label, v }: { label: string; v: ReactNode }) => (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/kiloview" className="text-muted hover:text-fg" aria-label={t("orch.atem.back")}>
              <ArrowLeft className="size-5" />
            </Link>
            {k.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-3">
            <Status on={k.online} />
            <Mono>{k.host}</Mono>
            <Badge tone="brand">{s?.product ?? "Kiloview"}</Badge>
            <span>{t(`orch.kiloview.kind_${k.kind}`)}</span>
            {k.location && <span>{k.location}</span>}
          </span>
        }
        actions={
          admin && (
            <>
              <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                {t("orch.kiloview.edit")}
              </Button>
              <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                {t("orch.atem.remove")}
              </Button>
            </>
          )
        }
      />
      {!s ? (
        <Alert tone="warn">{k.lastError === "login_failed" ? t("orch.kiloview.fail_login_failed") : t("orch.kiloview.neverSeen")}</Alert>
      ) : (
        <div className="space-y-6">
          {!k.online && <Alert tone="warn">{k.lastError === "login_failed" ? t("orch.kiloview.fail_login_failed") : t("orch.teranex.offlineSnapshot")}</Alert>}
          {k.online &&
            k.issues.map((i, n) => (
              <Alert key={n} tone={i.level === "down" ? "danger" : "warn"}>
                {issue(i)}
              </Alert>
            ))}
          {s.encoder && <EncoderView kv={k} admin={admin} onWatch={onWatch} />}
          {s.decoder && <DecoderView kv={k} admin={admin} onWatch={onWatch} />}
          <p className="flex items-start gap-2 text-xs text-muted">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            {t("orch.kiloview.readOnly")}
          </p>
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <div className="space-y-6">
              <Card>
                <CardHeader title={t("orch.atem.device")} />
                <CardBody className="grid gap-x-8 pt-1 md:grid-cols-2">
                  <dl className="divide-y divide-line">
                    <Row label={t("orch.atem.model")} v={s.product ?? "–"} />
                    <Row label={t("orch.kiloview.firmware")} v={<Mono>{s.firmware ?? "–"}</Mono>} />
                    <Row label={t("orch.kiloview.hardware")} v={<Mono>{s.hardware ?? "–"}</Mono>} />
                    <Row label={t("orch.kiloview.serial")} v={<Mono>{s.serial ?? "–"}</Mono>} />
                    <Row label={t("orch.nodes.lastSeen")} v={k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString() : "–"} />
                  </dl>
                  <dl className="divide-y divide-line">
                    {s.decoder && (
                      <>
                        <Row label="CPU" v={s.decoder.cpu != null ? `${Math.round(s.decoder.cpu)}%` : "–"} />
                        <Row label={t("orch.kiloview.memory")} v={s.decoder.mem != null ? `${Math.round(s.decoder.mem)}%` : "–"} />
                        <Row label={t("orch.kiloview.temperature")} v={s.decoder.temperature != null ? `${s.decoder.temperature} °C` : "–"} />
                      </>
                    )}
                    {s.encoder?.network && (
                      <>
                        <Row label={t("orch.kiloview.netOut")} v={mbit(s.encoder.network.txKbps)} />
                        <Row label={t("orch.kiloview.netIn")} v={mbit(s.encoder.network.rxKbps)} />
                        <Row label={t("orch.kiloview.link")} v={s.encoder.network.speedMbps ? `${s.encoder.network.speedMbps} Mbit/s` : "–"} />
                      </>
                    )}
                    <Row label={k.kind === "encoder" ? t("orch.kiloview.expectedIn") : t("orch.kiloview.expectedOut")} v={k.expectedFormat ? <Mono>{k.expectedFormat}</Mono> : <span className="text-muted">{t("orch.teranex.expectedNone")}</span>} />
                  </dl>
                  {k.notes && <p className="mt-3 text-sm whitespace-pre-wrap text-muted md:col-span-2">{k.notes}</p>}
                </CardBody>
              </Card>
              <RawData s={s} />
            </div>
            <Card>
              <CardHeader title={t("orch.nodes.events")} />
              <ul className="max-h-96 divide-y divide-line overflow-y-auto text-sm">
                {d.events.map((e, i) => (
                  <li key={i} className="px-5 py-2.5">
                    <p className={cx((e.type === "problem" || e.type === "offline") && "text-danger", e.type === "warning" && "text-warn", e.type === "resolved" && "text-ok")}>{e.message}</p>
                    <p className="text-xs text-muted">{new Date(e.at).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
      {editing && (
        <KiloviewDialog
          kv={k}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("orch.kiloview.removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await del(`/api/kiloview/${k.id}`);
                nav("/kiloview");
              }}
            >
              {t("orch.atem.remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("orch.kiloview.removeText", { name: k.name })}</p>
      </Dialog>
    </>
  );
}

/** One line per card: the input (encoder) or the watched outputs (decoder). */
function Summary({ k }: { k: Kiloview }) {
  const { t } = useTranslation();
  const s = k.snapshot;
  if (!k.online || !s) return <p className="text-sm text-muted">–</p>;
  if (s.encoder) {
    const e = s.encoder;
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {e.input.signal === false ? <Badge tone="danger">{t("orch.teranex.noSignalShort")}</Badge> : e.input.format && <Badge tone="ok">{e.input.format}</Badge>}
        {e.activeInput && <Badge>{e.activeInput}</Badge>}
        <span className="text-muted">{mbit(e.video?.bitrateKbps ?? null)}</span>
        {e.streams
          .filter((x) => x.enabled)
          .map((x) => (
            <Badge key={x.id} tone={x.running ? "brand" : "danger"}>
              {x.name}
            </Badge>
          ))}
      </div>
    );
  }
  const watch = new Set(k.watch ?? []);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {(s.decoder?.outputs ?? [])
        .filter((o) => watch.has(o.id) || o.playing)
        .map((o) => (
          <Badge key={o.id} tone={o.playing ? "ok" : "danger"}>
            {o.connector ?? o.id}: {o.playing ? (o.format ?? "OK") : t("orch.kiloview.noPictureShort")}
          </Badge>
        ))}
      {s.decoder?.temperature != null && <span className="text-muted">{s.decoder.temperature} °C</span>}
    </div>
  );
}

function List() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [list, setList] = useState<Kiloview[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => get<{ kiloviews: Kiloview[] }>("/api/kiloview").then((r) => setList(r.kiloviews)), []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 5000);
    return () => clearInterval(i);
  }, [load]);
  if (!list) return null;
  return (
    <>
      <PageHeader
        title={t("orch.kiloview.title")}
        description={t("orch.kiloview.intro")}
        actions={
          admin && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              {t("orch.kiloview.add")}
            </Button>
          )
        }
      />
      {list.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <ArrowLeftRight className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("orch.kiloview.empty")}</p>
            <p className="mt-1 text-sm text-muted">{t("orch.kiloview.emptyHint")}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((k) => {
            const down = k.online && k.issues.some((i) => i.level === "down");
            return (
              <button key={k.id} type="button" onClick={() => nav(`/kiloview/${k.id}`)} className="text-left">
                <Card className={cx("h-full transition hover:-translate-y-0.5 hover:shadow-lg", down && "ring-2 ring-danger/50")}>
                  <CardBody>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{k.name}</p>
                        <p className="truncate text-sm text-muted">
                          {k.snapshot?.product ?? "Kiloview"} · {t(`orch.kiloview.kind_${k.kind}`)}
                        </p>
                      </div>
                      <Status on={k.online} />
                    </div>
                    <p className="mb-2 text-sm">
                      <Mono>{k.host}</Mono>
                      {k.location && <span className="text-muted"> · {k.location}</span>}
                    </p>
                    <Summary k={k} />
                  </CardBody>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      {adding && (
        <KiloviewDialog
          onClose={() => setAdding(false)}
          onDone={(d) => {
            setAdding(false);
            nav(`/kiloview/${d.id}`);
          }}
        />
      )}
    </>
  );
}

export function KiloviewPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}
