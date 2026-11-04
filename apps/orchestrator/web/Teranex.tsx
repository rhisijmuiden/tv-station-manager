import { Alert, ApiError, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowLeft, ArrowRight, ChevronDown, Lock, Network, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { COMMON_FORMATS, normFormat, sourceKey, type TeranexSnapshot } from "../server/teranexlogic";

interface Teranex {
  id: string;
  name: string;
  host: string;
  location: string;
  notes: string;
  expectedInput: string;
  online: boolean;
  lastSeenAt: string | null;
  snapshot: TeranexSnapshot | null;
}

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`orch.teranex.err_${e.code}`, { defaultValue: t(`orch.atem.err_${e.code}`, { defaultValue: e.message }) }) : String(e));
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

/** Input state as a badge: the format (signal present) or NO SIGNAL in red. Also used on the diagram. */
export function SignalBadge({ signal, format }: { signal: boolean | null; format: string | null }) {
  const { t } = useTranslation();
  if (signal === false)
    return (
      <Badge tone="danger">
        <span className="size-1.5 animate-pulse rounded-full bg-danger" />
        {t("orch.teranex.noSignalShort")}
      </Badge>
    );
  return format ? <Badge tone="ok">{format}</Badge> : null;
}

const mismatch = (x: Teranex) => {
  const s = x.snapshot;
  return !!x.expectedInput && !!s?.input.videoMode && s.input.signalPresent !== false && normFormat(s.input.videoMode) !== normFormat(x.expectedInput);
};

function TeranexDialog({ teranex, onClose, onDone }: { teranex?: Teranex; onClose: () => void; onDone: (d: Teranex) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({ name: teranex?.name ?? "", host: teranex?.host ?? "", location: teranex?.location ?? "", notes: teranex?.notes ?? "", expectedInput: teranex?.expectedInput ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(teranex ? await put<Teranex>(`/api/teranex/${teranex.id}`, f) : await post<Teranex>("/api/teranex", f));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={teranex ? t("orch.teranex.edit") : t("orch.teranex.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={save} disabled={!f.name || !f.host}>
            {teranex ? t("common.save") : t("orch.teranex.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t("orch.atem.name")}>{(id) => <Input id={id} value={f.name} placeholder="Teranex AV" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t("orch.atem.host")} hint={t("orch.teranex.hostHint")}>
          {(id) => <Input id={id} className="font-mono" value={f.host} placeholder="10.40.5.219" onChange={(e) => setF({ ...f, host: e.target.value })} />}
        </Field>
        <Field label={`${t("orch.teranex.expected")} (${t("common.optional")})`} hint={t("orch.teranex.expectedHint")}>
          {(id) => (
            <>
              <Input id={id} className="font-mono" list={`${id}-formats`} value={f.expectedInput} placeholder="1080i50" maxLength={32} onChange={(e) => setF({ ...f, expectedInput: e.target.value })} />
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
      </div>
    </Dialog>
  );
}

/** A lit / unlit front-panel key, like the buttons on the Teranex itself. */
function Key({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span
      className={cx(
        "grid h-9 min-w-14 place-items-center rounded-md px-2 text-[11px] font-semibold tracking-wide uppercase transition",
        on ? "bg-[var(--tvsm-brand)] text-white shadow-[0_0_14px_color-mix(in_oklab,var(--tvsm-brand)_70%,transparent)]" : "bg-white/8 text-white/40",
      )}
    >
      {children}
    </span>
  );
}

/** The "front" of the converter: input keys, the display with input / output format, audio keys. Read only. */
function FrontPanel({ x }: { x: Teranex }) {
  const { t } = useTranslation();
  const s = x.snapshot!;
  const live = x.online;
  const v = live ? sourceKey(s.input.videoSource) : null;
  const a = live ? sourceKey(s.input.audioSource) : null;
  const noSig = live && s.input.signalPresent === false;
  const wrong = live && mismatch(x);
  return (
    <div className="rounded-xl bg-[color-mix(in_oklab,var(--tvsm-sidebar)_92%,black)] p-5 text-white">
      <div className="grid gap-5 lg:grid-cols-[auto_1fr_auto] lg:items-center">
        <div className="flex gap-6">
          <div>
            <p className="mb-2 text-[10px] tracking-widest text-white/45 uppercase">{t("orch.teranex.video")}</p>
            <div className="grid gap-1.5">
              <Key on={v === "sdi"}>SDI</Key>
              <Key on={v === "hdmi"}>HDMI</Key>
              <Key on={v === "optical"}>OPT</Key>
            </div>
          </div>
          <div>
            <p className="mb-2 text-[10px] tracking-widest text-white/45 uppercase">{t("orch.teranex.audio")}</p>
            <div className="grid gap-1.5">
              <Key on={a === "embedded"}>Embed</Key>
              <Key on={a === "aes"}>AES</Key>
              <Key on={a === "analog"}>Anlg</Key>
            </div>
          </div>
        </div>
        <div className={cx("rounded-lg border p-4", noSig ? "border-[var(--tvsm-danger)] bg-[color-mix(in_oklab,var(--tvsm-danger)_18%,transparent)]" : "border-white/10 bg-black/30")}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div>
              <p className="text-[10px] tracking-widest text-white/45 uppercase">{t("orch.teranex.input")}</p>
              <p className={cx("font-mono text-3xl font-semibold tabular-nums sm:text-4xl", noSig ? "text-[var(--tvsm-danger)]" : wrong ? "text-[var(--tvsm-warning)]" : "text-white")}>
                {!live ? "––" : noSig ? t("orch.teranex.noSignalShort") : (s.input.videoMode ?? "––")}
              </p>
              <p className="mt-1 text-xs text-white/55">{live ? [s.input.videoSource, s.input.audioSource].filter(Boolean).join(" · ") || "–" : "–"}</p>
            </div>
            <ArrowRight className="size-6 text-white/30" />
            <div>
              <p className="text-[10px] tracking-widest text-white/45 uppercase">{t("orch.teranex.output")}</p>
              <p className="font-mono text-3xl font-semibold text-white tabular-nums sm:text-4xl">{live ? (s.output.videoMode ?? "––") : "––"}</p>
              <p className="mt-1 text-xs text-white/55">{live && s.output.option ? s.output.option : "–"}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 text-xs lg:items-end">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-white/8 px-2.5 py-1.5 text-white/70">
            <Lock className="size-3.5" /> {t("orch.teranex.readOnlyShort")}
          </span>
          {live && s.input.signalPresent !== null && (
            <span className={cx("inline-flex items-center gap-1.5", noSig ? "text-[var(--tvsm-danger)]" : "text-[var(--tvsm-success)]")}>
              <span className={cx("size-2 rounded-full", noSig ? "animate-pulse bg-[var(--tvsm-danger)]" : "bg-[var(--tvsm-success)]")} />
              {noSig ? t("orch.teranex.noSignal") : t("orch.teranex.signalOk")}
            </span>
          )}
          {live && s.genlock.reference && (
            <span className="text-white/55">
              {t("orch.teranex.genlock")}: <span className="font-mono text-white/85">{s.genlock.reference}</span>
              {s.genlock.locked != null && ` · ${s.genlock.locked ? t("orch.teranex.locked") : t("orch.teranex.unlocked")}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AllSettings({ s }: { s: TeranexSnapshot }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const blocks = Object.entries(s.blocks);
  return (
    <Card>
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <CardHeader title={t("orch.teranex.allSettings")} description={t("orch.teranex.allSettingsIntro")} actions={<ChevronDown className={cx("size-5 text-muted transition", open && "rotate-180")} />} />
      </button>
      {open && (
        <CardBody className="grid gap-5 pt-0 md:grid-cols-2 2xl:grid-cols-3">
          {blocks.map(([h, f]) => (
            <div key={h}>
              <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{h}</p>
              <dl className="divide-y divide-line rounded-lg border border-line text-xs">
                {Object.entries(f).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                    <dt className="text-muted">{k}</dt>
                    <dd className="truncate text-right font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
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
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [d, setD] = useState<{ teranex: Teranex; events: { type: string; message: string; at: string }[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => get<typeof d>(`/api/teranex/${id}`).then(setD), [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 1000);
    return () => clearInterval(i);
  }, [load]);
  if (!d) return null;
  const x = d.teranex;
  const s = x.snapshot;
  const Row = ({ k, v }: { k: string; v: ReactNode }) => (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/teranex" className="text-muted hover:text-fg" aria-label={t("orch.atem.back")}>
              <ArrowLeft className="size-5" />
            </Link>
            {x.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-3">
            <Status on={x.online} />
            <Mono>{x.host}</Mono>
            {s && <Badge tone="brand">{s.model}</Badge>}
            {x.location && <span>{x.location}</span>}
          </span>
        }
        actions={
          admin && (
            <>
              <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                {t("orch.teranex.edit")}
              </Button>
              <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                {t("orch.atem.remove")}
              </Button>
            </>
          )
        }
      />
      {!s ? (
        <Alert tone="warn">{t("orch.teranex.neverSeen")}</Alert>
      ) : (
        <div className="space-y-6">
          {!x.online && <Alert tone="warn">{t("orch.teranex.offlineSnapshot")}</Alert>}
          {x.online && s.input.signalPresent === false && <Alert tone="danger">{t("orch.mon.issue.no_input_signal")}</Alert>}
          {x.online && mismatch(x) && <Alert tone="warn">{t("orch.teranex.expectedMismatch", { got: s.input.videoMode, want: x.expectedInput })}</Alert>}
          <Card>
            <CardHeader
              title={t("orch.teranex.signalPath")}
              description={t("orch.teranex.signalPathIntro")}
              icon={<Repeat className="size-4" />}
              actions={
                <Link to="/diagram" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
                  <Network className="size-4" /> {t("orch.nav.diagram")}
                </Link>
              }
            />
            <CardBody>
              <FrontPanel x={x} />
              <p className="mt-3 flex items-start gap-2 text-xs text-muted">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                {t("orch.teranex.readOnly")}
              </p>
            </CardBody>
          </Card>
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <div className="space-y-6">
              <Card>
                <CardHeader title={t("orch.atem.device")} />
                <CardBody className="grid gap-x-8 pt-1 md:grid-cols-2">
                  <dl className="divide-y divide-line">
                    <Row k={t("orch.atem.model")} v={s.model} />
                    <Row k={t("orch.teranex.software")} v={<Mono>{s.softwareVersion ?? "–"}</Mono>} />
                    <Row k={t("orch.atem.protocol")} v={<Mono>{s.protocolVersion ?? "–"}</Mono>} />
                    <Row k={t("orch.teranex.label")} v={s.label ?? "–"} />
                    <Row k={t("orch.nodes.lastSeen")} v={x.lastSeenAt ? new Date(x.lastSeenAt).toLocaleString() : "–"} />
                  </dl>
                  <dl className="divide-y divide-line">
                    <Row k={`${t("orch.teranex.input")} · ${t("orch.teranex.video")}`} v={<Mono>{s.input.videoSource ?? "–"}</Mono>} />
                    <Row k={`${t("orch.teranex.input")} · ${t("orch.teranex.audio")}`} v={<Mono>{s.input.audioSource ?? "–"}</Mono>} />
                    <Row k={`${t("orch.teranex.input")} · ${t("orch.teranex.format")}`} v={<Mono>{s.input.videoMode ?? "–"}</Mono>} />
                    <Row k={t("orch.teranex.expected")} v={x.expectedInput ? <Mono>{x.expectedInput}</Mono> : <span className="text-muted">{t("orch.teranex.expectedNone")}</span>} />
                    <Row k={`${t("orch.teranex.output")} · ${t("orch.teranex.format")}`} v={<Mono>{s.output.videoMode ?? "–"}</Mono>} />
                  </dl>
                  {x.notes && <p className="mt-3 text-sm whitespace-pre-wrap text-muted md:col-span-2">{x.notes}</p>}
                </CardBody>
              </Card>
              <AllSettings s={s} />
            </div>
            <Card>
              <CardHeader title={t("orch.nodes.events")} />
              <ul className="max-h-96 divide-y divide-line overflow-y-auto text-sm">
                {d.events.map((e, i) => (
                  <li key={i} className="px-5 py-2.5">
                    <p className={cx(e.type === "signal" && /^No /.test(e.message) && "text-danger", e.type === "offline" && "text-danger")}>{e.message}</p>
                    <p className="text-xs text-muted">{new Date(e.at).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
      {editing && (
        <TeranexDialog
          teranex={x}
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
        title={t("orch.teranex.removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await del(`/api/teranex/${x.id}`);
                nav("/teranex");
              }}
            >
              {t("orch.atem.remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("orch.teranex.removeText", { name: x.name })}</p>
      </Dialog>
    </>
  );
}

function List() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [list, setList] = useState<Teranex[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => get<{ teranexes: Teranex[] }>("/api/teranex").then((r) => setList(r.teranexes)), []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 3000);
    return () => clearInterval(i);
  }, [load]);
  if (!list) return null;
  return (
    <>
      <PageHeader
        title={t("orch.teranex.title")}
        description={t("orch.teranex.intro")}
        actions={
          admin && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              {t("orch.teranex.add")}
            </Button>
          )
        }
      />
      {list.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <Repeat className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("orch.teranex.empty")}</p>
            <p className="mt-1 text-sm text-muted">{t("orch.teranex.emptyHint")}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((x) => {
            const s = x.snapshot;
            const live = x.online && !!s;
            return (
              <button key={x.id} type="button" onClick={() => nav(`/teranex/${x.id}`)} className="text-left">
                <Card className={cx("h-full transition hover:-translate-y-0.5 hover:shadow-lg", live && s.input.signalPresent === false && "ring-2 ring-danger/50")}>
                  <CardBody>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{x.name}</p>
                        <p className="truncate text-sm text-muted">{s?.model ?? t("orch.atem.unknownModel")}</p>
                      </div>
                      <Status on={x.online} />
                    </div>
                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted">{t("orch.atem.host")}</dt>
                        <dd>
                          <Mono>{x.host}</Mono>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.teranex.input")}</dt>
                        <dd className={mismatch(x) ? "text-warn" : undefined}>
                          <Mono>{live ? [s.input.videoSource, s.input.videoMode].filter(Boolean).join(" · ") || "–" : "–"}</Mono>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.teranex.output")}</dt>
                        <dd>
                          <Mono>{live ? (s.output.videoMode ?? "–") : "–"}</Mono>
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex items-center gap-2 text-sm">
                      {live && <SignalBadge signal={s.input.signalPresent} format={s.input.videoMode} />}
                      {live && s.input.audioSource && <Badge>{s.input.audioSource}</Badge>}
                    </div>
                    {x.location && <p className="mt-2 text-xs text-muted">{x.location}</p>}
                  </CardBody>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      {adding && (
        <TeranexDialog
          onClose={() => setAdding(false)}
          onDone={(d) => {
            setAdding(false);
            nav(`/teranex/${d.id}`);
          }}
        />
      )}
    </>
  );
}

export function TeranexPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}
