import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, Select, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { Check, ChevronDown, Copy, Eye, EyeOff, KeyRound, MonitorPlay, Pencil, Plus, Radio, RefreshCw, Satellite, Send, Square, Trash2, Tv } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { errorText, fmtTime, useGet, type LiveSource } from "../lib";

interface Studio {
  id: number;
  name: string;
  host: string;
  publicHost: string | null;
  role: "playout" | "live" | "both";
  enabled: boolean;
  status: { connected: boolean; channels?: number[] | null };
  ingest: { reachable: boolean; error: string | null };
}
interface Form {
  id?: number;
  name: string;
  studioId: string;
  casparChannel: string;
  atemInput: string;
  url: string;
  pull: boolean;
}

/** Works on plain http too (navigator.clipboard needs a secure context). */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall back */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export function CopyField({ label, value, secret, hint }: { label: string; value: string; secret?: boolean; hint?: ReactNode }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex gap-2">
          <Input id={id} readOnly value={shown ? value : "•".repeat(Math.min(value.length, 32))} className="font-mono text-[12.5px]" onFocus={(e) => shown && e.target.select()} />
          {secret && <Button variant="secondary" aria-label={t(shown ? "mgmt.remote.hide" : "mgmt.remote.show")} icon={shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => setShown(!shown)} />}
          <Button
            variant="secondary"
            aria-label={t("mgmt.remote.copy")}
            icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
            onClick={() =>
              void copyText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          />
        </div>
      )}
    </Field>
  );
}

export function StatusBadge({ s }: { s: LiveSource }) {
  const { t } = useTranslation();
  const st = s.status?.state ?? "unknown";
  if (st === "live")
    return (
      <Badge tone="ok">
        <span className="size-1.5 animate-pulse rounded-full bg-ok" /> {t("mgmt.remote.state.live")}
      </Badge>
    );
  if (st === "waiting") return <Badge tone="warn">{t("mgmt.remote.state.waiting")}</Badge>;
  if (st === "pull") return <Badge tone="brand">{t("mgmt.remote.state.pull")}</Badge>;
  return <Badge tone="neutral">{t("mgmt.remote.state.unknown")}</Badge>;
}

const STEPS = [
  { icon: Plus, key: "add" },
  { icon: Send, key: "send" },
  { icon: Radio, key: "check" },
  { icon: MonitorPlay, key: "decklink" },
  { icon: Tv, key: "air" },
] as const;

function HowItWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <Card>
      <button className="flex w-full items-center gap-3 px-5 py-4 text-left" onClick={onToggle} aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-md bg-brand/10 text-brand">
          <Satellite className="size-4" />
        </span>
        <span className="flex-1">
          <span className="block font-semibold">{t("mgmt.remote.how.title")}</span>
          <span className="block text-sm text-muted">{t("mgmt.remote.how.intro")}</span>
        </span>
        <ChevronDown className={cx("size-4 text-muted transition", open && "rotate-180")} />
      </button>
      {open && (
        <CardBody className="border-t border-line">
          <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
            {["contributor", "ingest", "casparcg", "decklink", "atem", "air"].map((k, i, a) => (
              <span key={k} className="flex items-center gap-2">
                <span className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-fg">{t(`mgmt.remote.how.chain.${k}`)}</span>
                {i < a.length - 1 && <span aria-hidden>→</span>}
              </span>
            ))}
          </div>
          <ol className="grid gap-4 md:grid-cols-5">
            {STEPS.map(({ icon: Icon, key }, i) => (
              <li key={key} className="rounded-lg border border-line p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{i + 1}</span>
                  <Icon className="size-4 text-brand" />
                </div>
                <p className="text-sm font-semibold">{t(`mgmt.remote.how.${key}.title`)}</p>
                <p className="mt-1 text-sm text-muted">{t(`mgmt.remote.how.${key}.text`)}</p>
              </li>
            ))}
          </ol>
          <Alert tone="neutral" className="mt-4">
            {t("mgmt.remote.how.network")}
          </Alert>
        </CardBody>
      )}
    </Card>
  );
}

const APPS = ["obs", "vmix", "larix", "ffmpeg"] as const;

function ConnectDialog({ s, studio, onClose, onNewKey, canEdit }: { s: LiveSource; studio: Studio | undefined; onClose: () => void; onNewKey: () => void; canEdit: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<(typeof APPS)[number]>("obs");
  const p = s.push;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t("mgmt.remote.connect.title", { name: s.name })}
      footer={
        <>
          {canEdit && p && (
            <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={onNewKey}>
              {t("mgmt.remote.connect.newKey")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.close")}</Button>
        </>
      }
    >
      {!p ? (
        <Alert tone="brand">{t("mgmt.remote.connect.pullInfo", { url: s.url })}</Alert>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">{t("mgmt.remote.connect.intro")}</p>
          {studio && !studio.ingest.reachable && <Alert tone="warn">{t("mgmt.remote.ingestUnreachable", { name: studio.name, error: studio.ingest.error ?? "–" })}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <CopyField label={t("mgmt.remote.connect.server")} value={p.rtmpServer} />
            <CopyField label={t("mgmt.remote.connect.key")} value={p.streamKey} secret />
          </div>
          <CopyField label={t("mgmt.remote.connect.fullUrl")} value={p.rtmpUrl} secret hint={t("mgmt.remote.connect.fullUrlHint")} />
          <CopyField label={t("mgmt.remote.connect.srt")} value={p.srtUrl} secret hint={t("mgmt.remote.connect.srtHint")} />

          <div>
            <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1">
              {APPS.map((a) => (
                <button key={a} onClick={() => setTab(a)} className={cx("flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition", tab === a ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
                  {t(`mgmt.remote.apps.${a}.name`)}
                </button>
              ))}
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              {(t(`mgmt.remote.apps.${tab}.steps`, { returnObjects: true, server: p.rtmpServer, key: p.streamKey, srt: p.srtUrl }) as string[]).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
            {tab === "ffmpeg" && (
              <pre className="mt-3 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-[12px]">{`ffmpeg -re -i input.mp4 -c:v libx264 -preset veryfast -b:v 6000k -maxrate 6000k -bufsize 12000k \\
  -g 50 -keyint_min 50 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 \\
  -f flv "${p.rtmpUrl}"`}</pre>
            )}
          </div>

          <div className="rounded-lg border border-line p-4">
            <p className="mb-2 text-sm font-semibold">{t("mgmt.remote.encoder.title")}</p>
            <ul className="grid gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
              {(t("mgmt.remote.encoder.items", { returnObjects: true }) as string[]).map((x, i) => (
                <li key={i}>• {x}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function RemoteSourcesPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const canOperate = roleAtLeast(user?.role, "operator");
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources", 3000);
  const studios = useGet<{ studios: Studio[] }>("/api/studios", 5000);
  const info = useGet<{ authUrl: string }>("/api/remote-sources/info");
  const sources = (live.data?.sources ?? []).filter((s) => s.kind === "rtmp");
  const [how, setHow] = useState<boolean | null>(null);
  const [edit, setEdit] = useState<Form | null>(null);
  const [connect, setConnect] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const studioOf = (id: number | null) => studios.data?.studios.find((s) => s.id === id);
  const howOpen = how ?? (live.data ? sources.length === 0 : false);

  const save = async () => {
    if (!edit) return;
    setErr(null);
    const body = { name: edit.name, kind: "rtmp", atemInput: Number(edit.atemInput) || 0, studioId: Number(edit.studioId) || null, casparChannel: Number(edit.casparChannel) || null, url: edit.pull ? edit.url : null };
    try {
      if (edit.id) await put(`/api/live-sources/${edit.id}`, body);
      else {
        const r = await post<{ id: number }>("/api/live-sources", body);
        setConnect(r.id);
      }
      setEdit(null);
      await live.reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const act = async (id: number, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(id);
    try {
      await fn();
      await live.reload();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const remove = (s: LiveSource) => confirm(t("mgmt.devices.confirmDelete", { name: s.name })) && void act(s.id, () => del(`/api/live-sources/${s.id}`));
  const newKey = (s: LiveSource) => confirm(t("mgmt.remote.connect.newKeyConfirm")) && void act(s.id, () => post(`/api/live-sources/${s.id}/new-key`));
  const set = (k: keyof Form, v: string | boolean) => edit && setEdit({ ...edit, [k]: v });
  const current = connect != null ? live.data?.sources.find((s) => s.id === connect) : undefined;
  const noIngest = (studios.data?.studios ?? []).filter((s) => s.enabled && !s.ingest.reachable && sources.some((x) => x.studioId === s.id && x.mode === "push"));

  return (
    <>
      <PageHeader
        title={t("mgmt.remote.title")}
        description={t("mgmt.remote.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => {
                // New remote sources go to the live node by default.
                const list = studios.data?.studios ?? [];
                const st = list.find((x) => x.enabled && x.role === "live") ?? list.find((x) => x.enabled && x.role === "both") ?? list[0];
                setEdit({ name: "", studioId: String(st?.id ?? ""), casparChannel: String(st?.status.channels?.[0] ?? 1), atemInput: "", url: "", pull: false });
              }}>
              {t("mgmt.remote.add")}
            </Button>
          )
        }
      />
      <div className="space-y-6">
        <HowItWorks open={howOpen} onToggle={() => setHow(!howOpen)} />
        {err && <Alert tone="danger">{err}</Alert>}
        {noIngest.map((s) => (
          <Alert key={s.id} tone="warn">
            {t("mgmt.remote.ingestUnreachable", { name: s.name, error: s.ingest.error ?? "–" })} {t("mgmt.remote.ingestFix", { url: info.data?.authUrl ?? "" })}
          </Alert>
        ))}
        <Card>
          <CardHeader icon={<Satellite className="size-4" />} title={t("mgmt.remote.list")} description={t("mgmt.remote.listIntro")} />
          <ul className="divide-y divide-line">
            {sources.map((s) => {
              const st = studioOf(s.studioId);
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                  <div className="min-w-48 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{s.name}</p>
                      <StatusBadge s={s} />
                      {s.onOutput && <Badge tone="brand">{t("mgmt.remote.onOutput")}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {t("mgmt.remote.route", { studio: st?.name ?? "–", output: s.casparChannel, input: s.atemInput })}
                      {s.status?.state === "live" && (
                        <>
                          {" · "}
                          {[s.status.tracks.join(" + "), s.status.kbps != null ? `${(s.status.kbps / 1000).toFixed(1)} Mbit/s` : null, s.status.onlineSince ? t("mgmt.remote.since", { time: fmtTime(s.status.onlineSince) }) : null].filter(Boolean).join(" · ")}
                        </>
                      )}
                    </p>
                    {s.outputError && <p className="mt-1 text-xs text-danger">{t("mgmt.remote.outputError", { message: s.outputError })}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" icon={<KeyRound className="size-3.5" />} onClick={() => setConnect(s.id)}>
                      {t("mgmt.remote.connectBtn")}
                    </Button>
                    {canOperate &&
                      (s.onOutput ? (
                        <Button size="sm" variant="secondary" loading={busy === s.id} icon={<Square className="size-3.5" />} onClick={() => void act(s.id, () => post(`/api/live-sources/${s.id}/output`, { on: false }))}>
                          {t("mgmt.remote.offOutput")}
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" loading={busy === s.id} icon={<MonitorPlay className="size-3.5" />} onClick={() => void act(s.id, () => post(`/api/live-sources/${s.id}/output`, { on: true }))}>
                          {t("mgmt.remote.toOutput")}
                        </Button>
                      ))}
                    <Link to="/control" className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-brand hover:bg-surface-2">
                      <Tv className="size-3.5" /> {t("mgmt.remote.toAir")}
                    </Link>
                    {canEdit && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("common.edit")}
                          icon={<Pencil className="size-3.5" />}
                          onClick={() => setEdit({ id: s.id, name: s.name, studioId: String(s.studioId ?? ""), casparChannel: String(s.casparChannel ?? ""), atemInput: String(s.atemInput), url: s.url ?? "", pull: s.mode === "pull" })}
                        />
                        <Button size="sm" variant="ghost" aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} onClick={() => remove(s)} />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
            {live.data && !sources.length && <li className="px-5 py-8 text-center text-sm text-muted">{t("mgmt.remote.none")}</li>}
          </ul>
        </Card>
      </div>

      {current && <ConnectDialog s={current} studio={studioOf(current.studioId)} canEdit={canEdit} onClose={() => setConnect(null)} onNewKey={() => newKey(current)} />}

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={t(edit?.id ? "mgmt.remote.edit" : "mgmt.remote.add")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={!edit?.name || !edit.studioId || !edit.casparChannel || (edit.pull && !edit.url)}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("common.name")} hint={t("mgmt.remote.form.nameHint")}>
              {(id) => <Input id={id} value={edit.name} placeholder={t("mgmt.remote.form.namePlaceholder")} onChange={(e) => set("name", e.target.value)} />}
            </Field>
            <Field label={t("mgmt.channels.studio")} hint={t("mgmt.remote.form.studioHint")}>
              {(id) => (
                <Select id={id} value={edit.studioId} onChange={(e) => set("studioId", e.target.value)}>
                  <option value="">–</option>
                  {studios.data?.studios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({t(`mgmt.devices.role_${s.role}`)})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {studios.data && !studios.data.studios.length && (
              <Alert tone="warn">
                {t("mgmt.remote.form.noStudio")}{" "}
                <Link className="font-medium underline" to="/devices">
                  {t("mgmt.nav.devices")}
                </Link>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mgmt.remote.form.output")} hint={t("mgmt.remote.form.outputHint")}>
                {(id) => {
                  const chans = studioOf(Number(edit.studioId) || null)?.status.channels;
                  return chans?.length ? (
                    <Select id={id} value={edit.casparChannel} onChange={(e) => set("casparChannel", e.target.value)}>
                      {!chans.includes(Number(edit.casparChannel)) && <option value={edit.casparChannel}>{t("mgmt.remote.form.missingOutput", { n: edit.casparChannel })}</option>}
                      {chans.map((c) => (
                        <option key={c} value={c}>
                          {t("mgmt.remote.form.outputN", { n: c })}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input id={id} type="number" min={1} max={16} value={edit.casparChannel} onChange={(e) => set("casparChannel", e.target.value)} />
                  );
                }}
              </Field>
              <Field label={t("mgmt.devices.atemInput")} hint={t("mgmt.remote.form.atemHint")}>
                {(id) => <Input id={id} type="number" min={0} value={edit.atemInput} onChange={(e) => set("atemInput", e.target.value)} />}
              </Field>
            </div>
            <details className="rounded-md border border-line" open={edit.pull}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("mgmt.remote.form.advanced")}</summary>
              <div className="space-y-3 border-t border-line p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={edit.pull} onChange={(e) => set("pull", e.target.checked)} />
                  <span>
                    <span className="font-medium">{t("mgmt.remote.form.pull")}</span>
                    <span className="block text-muted">{t("mgmt.remote.form.pullHint")}</span>
                  </span>
                </label>
                {edit.pull && (
                  <Field label={t("mgmt.devices.streamUrl")}>
                    {(id) => <Input id={id} value={edit.url} placeholder="srt://encoder.example.org:9000" onChange={(e) => set("url", e.target.value)} />}
                  </Field>
                )}
              </div>
            </details>
            {!edit.id && !edit.pull && <p className="flex items-center gap-2 text-xs text-muted"><RefreshCw className="size-3.5" /> {t("mgmt.remote.form.keyNote")}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}
