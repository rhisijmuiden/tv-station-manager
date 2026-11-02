import { Alert, ApiError, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowLeft, Circle, HardDrive, Network, Pencil, Play, Plus, Square, Trash2, Video } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatDuration, LOW_RECORD_TIME_S, recordTimeLeft, type HyperdeckSnapshot } from "../server/hyperdecklogic";

interface Deck {
  id: string;
  name: string;
  host: string;
  location: string;
  notes: string;
  online: boolean;
  lastSeenAt: string | null;
  snapshot: HyperdeckSnapshot | null;
}

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`orch.hyperdeck.err_${e.code}`, { defaultValue: t(`orch.atem.err_${e.code}`, { defaultValue: e.message }) }) : String(e));
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

/** Transport state as a badge: REC (red), PLAY (green), stopped etc. */
export function TransportBadge({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation();
  if (!status) return null;
  const tone = status === "record" ? "danger" : status === "play" || status === "forward" ? "ok" : "neutral";
  return (
    <Badge tone={tone}>
      {status === "record" && <span className="size-1.5 animate-pulse rounded-full bg-danger" />}
      {t(`orch.hyperdeck.status_${status}`, { defaultValue: status })}
    </Badge>
  );
}

function DeckDialog({ deck, onClose, onDone }: { deck?: Deck; onClose: () => void; onDone: (d: Deck) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({ name: deck?.name ?? "", host: deck?.host ?? "", location: deck?.location ?? "", notes: deck?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(deck ? await put<Deck>(`/api/hyperdecks/${deck.id}`, f) : await post<Deck>("/api/hyperdecks", f));
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
      title={deck ? t("orch.hyperdeck.edit") : t("orch.hyperdeck.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={save} disabled={!f.name || !f.host}>
            {deck ? t("common.save") : t("orch.hyperdeck.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t("orch.atem.name")}>{(id) => <Input id={id} value={f.name} placeholder="HyperDeck Regie" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t("orch.atem.host")} hint={t("orch.hyperdeck.hostHint")}>
          {(id) => <Input id={id} className="font-mono" value={f.host} placeholder="10.40.5.219" onChange={(e) => setF({ ...f, host: e.target.value })} />}
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

/** The deck's "front": big timecode, transport state and the three buttons. */
function Transport({ deck, onChanged }: { deck: Deck; onChanged: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const { user } = useSession();
  const operator = roleAtLeast(user?.role, "operator");
  const s = deck.snapshot!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recDialog, setRecDialog] = useState(false);
  const [clip, setClip] = useState("");
  const live = deck.online;
  const st = live ? s.transport.status : null;
  const send = async (action: "record" | "play" | "stop", clipName?: string) => {
    setBusy(action);
    setError(null);
    try {
      await post(`/api/hyperdecks/${deck.id}/transport`, { action, clipName });
      onChanged();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(null);
    }
  };
  const left = recordTimeLeft(s);
  return (
    <>
      <div className="rounded-xl bg-[color-mix(in_oklab,var(--tvsm-sidebar)_92%,black)] p-5 text-white">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs tracking-wider text-white/50 uppercase">{s.model}</p>
            <p className={cx("font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl", st === "record" ? "text-[var(--tvsm-danger)]" : "text-white")}>{live ? s.transport.displayTimecode || s.transport.timecode : "--:--:--:--"}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-white/60">
              <TransportBadge status={st} />
              <span>
                {t("orch.hyperdeck.input")}: <span className="font-mono text-white/85">{s.videoInput ?? "–"}</span>
                {s.transport.inputVideoFormat && <span className="font-mono text-white/85"> · {s.transport.inputVideoFormat}</span>}
              </span>
              {left != null && (
                <span className={left < LOW_RECORD_TIME_S ? "text-[var(--tvsm-warning)]" : undefined}>
                  {t("orch.hyperdeck.timeLeft")}: <span className="font-mono text-white/85">{formatDuration(left)}</span>
                </span>
              )}
            </div>
          </div>
          {operator && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!live || !!busy || st === "record"}
                onClick={() => setRecDialog(true)}
                className={cx("grid size-14 place-items-center rounded-full border-2 transition disabled:opacity-40", st === "record" ? "border-[var(--tvsm-danger)] bg-[var(--tvsm-danger)]" : "border-white/25 hover:border-[var(--tvsm-danger)]")}
                title={t("orch.hyperdeck.record")}
                aria-label={t("orch.hyperdeck.record")}
              >
                <Circle className={cx("size-6", st === "record" ? "fill-white text-white" : "fill-[var(--tvsm-danger)] text-[var(--tvsm-danger)]")} />
              </button>
              <button
                type="button"
                disabled={!live || !!busy || st === "record"}
                onClick={() => void send("play")}
                className={cx("grid size-14 place-items-center rounded-full border-2 transition disabled:opacity-40", st === "play" ? "border-[var(--tvsm-success)] bg-[var(--tvsm-success)]" : "border-white/25 hover:border-[var(--tvsm-success)]")}
                title={t("orch.hyperdeck.play")}
                aria-label={t("orch.hyperdeck.play")}
              >
                <Play className="size-6 fill-white text-white" />
              </button>
              <button
                type="button"
                disabled={!live || !!busy}
                onClick={() => void send("stop")}
                className="grid size-14 place-items-center rounded-full border-2 border-white/25 transition hover:border-white disabled:opacity-40"
                title={t("orch.hyperdeck.stop")}
                aria-label={t("orch.hyperdeck.stop")}
              >
                <Square className="size-5 fill-white text-white" />
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      {live && s.remoteEnabled === false && (
        <Alert tone="warn" className="mt-3">
          {t("orch.hyperdeck.remoteOff")}
        </Alert>
      )}
      <Dialog
        open={recDialog}
        onClose={() => setRecDialog(false)}
        title={t("orch.hyperdeck.recordTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRecDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy === "record"}
              icon={<Circle className="size-4 fill-white" />}
              onClick={async () => {
                await send("record", clip.trim() || undefined);
                setRecDialog(false);
                setClip("");
              }}
            >
              {t("orch.hyperdeck.startRecording")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={`${t("orch.hyperdeck.clipName")} (${t("common.optional")})`} hint={t("orch.hyperdeck.clipNameHint")}>
            {(id) => <Input id={id} value={clip} maxLength={60} placeholder={t("orch.hyperdeck.clipNamePlaceholder")} onChange={(e) => setClip(e.target.value)} />}
          </Field>
          {left != null && left < LOW_RECORD_TIME_S && <Alert tone="warn">{t("orch.hyperdeck.lowSpace", { time: formatDuration(left) })}</Alert>}
        </div>
      </Dialog>
    </>
  );
}

function Detail({ id }: { id: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [d, setD] = useState<{ deck: Deck; events: { type: string; message: string; at: string }[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => get<typeof d>(`/api/hyperdecks/${id}`).then(setD), [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 1000);
    return () => clearInterval(i);
  }, [load]);
  if (!d) return null;
  const deck = d.deck;
  const s = deck.snapshot;
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
            <Link to="/hyperdeck" className="text-muted hover:text-fg" aria-label={t("orch.atem.back")}>
              <ArrowLeft className="size-5" />
            </Link>
            {deck.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-3">
            <Status on={deck.online} />
            <Mono>{deck.host}</Mono>
            {s && <Badge tone="brand">{s.model}</Badge>}
            {deck.location && <span>{deck.location}</span>}
          </span>
        }
        actions={
          admin && (
            <>
              <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                {t("orch.hyperdeck.edit")}
              </Button>
              <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                {t("orch.atem.remove")}
              </Button>
            </>
          )
        }
      />
      {!s ? (
        <Alert tone="warn">{t("orch.hyperdeck.neverSeen")}</Alert>
      ) : (
        <div className="space-y-6">
          {!deck.online && <Alert tone="warn">{t("orch.atem.offlineSnapshot")}</Alert>}
          <Card>
            <CardHeader
              title={t("orch.hyperdeck.transport")}
              description={t("orch.hyperdeck.transportIntro")}
              icon={<Video className="size-4" />}
              actions={
                <Link to="/diagram" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
                  <Network className="size-4" /> {t("orch.nav.diagram")}
                </Link>
              }
            />
            <CardBody>
              <Transport deck={deck} onChanged={() => void load()} />
            </CardBody>
          </Card>
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader title={t("orch.hyperdeck.slots")} description={t("orch.hyperdeck.slotsIntro")} icon={<HardDrive className="size-4" />} />
              <ul className="divide-y divide-line">
                {s.slots.map((sl) => {
                  const active = sl.id === s.transport.slotId;
                  const low = sl.status === "mounted" && sl.recordingTime < LOW_RECORD_TIME_S;
                  return (
                    <li key={sl.id} className="flex items-center gap-4 px-5 py-3.5">
                      <span className={cx("grid size-9 place-items-center rounded-lg", sl.status === "mounted" ? "bg-brand/10 text-brand" : "bg-surface-2 text-muted")}>
                        <HardDrive className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          {t("orch.hyperdeck.slot", { n: sl.id })}
                          {active && <Badge tone="brand">{t("orch.hyperdeck.active")}</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted">{sl.status === "mounted" ? sl.volumeName || t("orch.hyperdeck.noName") : t(`orch.hyperdeck.slot_${sl.status}`)}</p>
                      </div>
                      {sl.status === "mounted" && (
                        <div className="text-right">
                          <p className={cx("font-mono text-sm", low && "text-warn")}>{formatDuration(sl.recordingTime)}</p>
                          <p className="text-xs text-muted">{t("orch.hyperdeck.recordTime")}</p>
                        </div>
                      )}
                    </li>
                  );
                })}
                {s.slots.length === 0 && <li className="px-5 py-4 text-sm text-muted">{t("orch.hyperdeck.noSlots")}</li>}
              </ul>
            </Card>
            <div className="space-y-6">
              <Card>
                <CardHeader title={t("orch.atem.device")} />
                <CardBody className="pt-1">
                  <dl className="divide-y divide-line">
                    <Row k={t("orch.atem.model")} v={s.model} />
                    <Row k={t("orch.atem.protocol")} v={<Mono>{s.protocolVersion ?? "–"}</Mono>} />
                    <Row k={t("orch.atem.videoMode")} v={<Mono>{s.transport.videoFormat ?? "–"}</Mono>} />
                    <Row k={t("orch.hyperdeck.input")} v={<Mono>{s.videoInput ?? "–"}</Mono>} />
                    <Row k={t("orch.hyperdeck.codec")} v={<Mono>{s.fileFormat ?? "–"}</Mono>} />
                    <Row k={t("orch.hyperdeck.remote")} v={s.remoteEnabled == null ? "–" : s.remoteEnabled ? t("orch.hyperdeck.on") : t("orch.hyperdeck.off")} />
                    <Row k={t("orch.nodes.lastSeen")} v={deck.lastSeenAt ? new Date(deck.lastSeenAt).toLocaleString() : "–"} />
                  </dl>
                  {deck.notes && <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{deck.notes}</p>}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t("orch.nodes.events")} />
                <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
                  {d.events.map((e, i) => (
                    <li key={i} className="px-5 py-2.5">
                      <p>{e.message}</p>
                      <p className="text-xs text-muted">{new Date(e.at).toLocaleString()}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <DeckDialog
          deck={deck}
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
        title={t("orch.hyperdeck.removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await del(`/api/hyperdecks/${deck.id}`);
                nav("/hyperdeck");
              }}
            >
              {t("orch.atem.remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("orch.hyperdeck.removeText", { name: deck.name })}</p>
      </Dialog>
    </>
  );
}

function List() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [list, setList] = useState<Deck[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => get<{ decks: Deck[] }>("/api/hyperdecks").then((r) => setList(r.decks)), []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 3000);
    return () => clearInterval(i);
  }, [load]);
  if (!list) return null;
  return (
    <>
      <PageHeader
        title={t("orch.hyperdeck.title")}
        description={t("orch.hyperdeck.intro")}
        actions={
          admin && (
            <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              {t("orch.hyperdeck.add")}
            </Button>
          )
        }
      />
      {list.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <Video className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("orch.hyperdeck.empty")}</p>
            <p className="mt-1 text-sm text-muted">{t("orch.hyperdeck.emptyHint")}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((dk) => {
            const s = dk.snapshot;
            const left = recordTimeLeft(s);
            return (
              <button key={dk.id} type="button" onClick={() => nav(`/hyperdeck/${dk.id}`)} className="text-left">
                <Card className="h-full transition hover:-translate-y-0.5 hover:shadow-lg">
                  <CardBody>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{dk.name}</p>
                        <p className="truncate text-sm text-muted">{s?.model ?? t("orch.atem.unknownModel")}</p>
                      </div>
                      <Status on={dk.online} />
                    </div>
                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted">{t("orch.atem.host")}</dt>
                        <dd>
                          <Mono>{dk.host}</Mono>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.hyperdeck.input")}</dt>
                        <dd>
                          <Mono>{s?.videoInput ?? "–"}</Mono>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.hyperdeck.timeLeft")}</dt>
                        <dd className={left != null && left < LOW_RECORD_TIME_S ? "text-warn" : undefined}>
                          <Mono>{left != null ? formatDuration(left) : "–"}</Mono>
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex items-center gap-2 text-sm">
                      <TransportBadge status={dk.online ? s?.transport.status : null} />
                      {dk.online && s && <Mono>{s.transport.displayTimecode}</Mono>}
                    </div>
                    {dk.location && <p className="mt-2 text-xs text-muted">{dk.location}</p>}
                  </CardBody>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      {adding && (
        <DeckDialog
          onClose={() => setAdding(false)}
          onDone={(d) => {
            setAdding(false);
            nav(`/hyperdeck/${d.id}`);
          }}
        />
      )}
    </>
  );
}

export function HyperdeckPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}
