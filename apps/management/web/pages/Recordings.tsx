import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, formatBytes, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { CalendarPlus, ChevronDown, Circle, CircleStop, Clapperboard, FolderInput, HardDrive, Library, Pause, Pencil, Play, Plus, Repeat, Scissors, Settings2, SkipBack, SkipForward, Trash2, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { addDays, errorText, fmtDateTime, fmtDuration, fmtTime, isoDay, useGet, type Channel } from "../lib";

type Status = "recording" | "processing" | "ready" | "publishing" | "published" | "failed";
interface RepeatEntry {
  id: number;
  channelId: number;
  channelName: string;
  startAt: string;
  past: boolean;
}
interface Recording {
  id: number;
  liveSourceId: number | null;
  sourceName: string;
  title: string;
  status: Status;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  channelId: number | null;
  size: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  trimInMs: number;
  trimOutMs: number | null;
  lengthMs: number | null;
  categoryId: number | null;
  mediaId: number | null;
  mediaPath: string | null;
  publishedAt: string | null;
  outdated: boolean;
  hasFile: boolean;
  pendingRepeats: number;
  repeats: RepeatEntry[];
  error: string | null;
}
interface Active {
  recordingId: number;
  liveSourceId: number;
  since: string;
  bytes: number;
  pieces: number;
  recording: boolean;
  programEnd: string | null;
  error: string | null;
}
interface Settings {
  mediaSourceId: number | null;
  folder: string;
  graceSeconds: number;
  postRollSeconds: number;
  minSeconds: number;
  keepDays: number;
  minFreeGb: number;
}
interface RepeatRule {
  dayOffset: number;
  time: string;
  channelId: number | null;
}
interface SourceCfg {
  id: number;
  name: string;
  active: boolean;
  blocked: string | null;
  recording: { enabled: boolean; categoryId: number | null; toLibrary: boolean; repeats: RepeatRule[] };
}
interface Category {
  id: number;
  name: string;
  color: string;
}
interface ListResponse {
  recordings: Recording[];
  active: Active[];
  disk: { free: number; total: number } | null;
  settings: Settings;
  library: { id: number; name: string } | null;
}

const fmtClock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = sec.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
/** "1:02:03.4", "12:03", "75" (seconds) -> ms */
const parseClock = (v: string): number | null => {
  const parts = v.trim().split(":");
  if (!parts.length || parts.length > 3) return null;
  let ms = 0;
  for (const p of parts) {
    const n = Number(p.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    ms = ms * 60 + n;
  }
  return Math.round(ms * 1000);
};

const dayLabel = (t: (k: string, o?: Record<string, unknown>) => string, d: number) => (d === 0 ? t("mgmt.rec.source.sameDay") : d === 1 ? t("mgmt.rec.source.nextDay") : t("mgmt.rec.source.dayN", { n: d }));

function StatusBadge({ r }: { r: Recording }) {
  const { t } = useTranslation();
  const tone = ({ recording: "danger", processing: "neutral", ready: "warn", publishing: "brand", published: "ok", failed: "danger" } as const)[r.status];
  return (
    <Badge tone={tone}>
      {r.status === "recording" && <span className="size-1.5 animate-pulse rounded-full bg-danger" />}
      {t(`mgmt.rec.status.${r.status}`)}
    </Badge>
  );
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono tabular-nums">{fmtDuration(now - Date.parse(since))}</span>;
}

function Thumb({ r, className }: { r: Recording; className?: string }) {
  const [broken, setBroken] = useState(false);
  const t = Math.round((r.trimInMs + (r.lengthMs ?? 0) * 0.15) / 100) * 100;
  return (
    <div className={cx("grid aspect-video shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 text-muted", className)}>
      {r.hasFile && r.durationMs && !broken ? <img src={`/api/recordings/${r.id}/thumb?t=${t}`} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} /> : <Video className="size-5" />}
    </div>
  );
}

// ---- trim editor -------------------------------------------------------------------------

const STRIP = 12;

function TrimDialog({ r, categories, onClose, onSaved }: { r: Recording; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const dur = r.durationMs ?? 0;
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [inMs, setIn] = useState(r.trimInMs);
  const [outMs, setOut] = useState(r.trimOutMs ?? dur);
  const [pos, setPos] = useState(r.trimInMs);
  const [playing, setPlaying] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [categoryId, setCategoryId] = useState<string>(r.categoryId == null ? "" : String(r.categoryId));
  const [inText, setInText] = useState(fmtClock(r.trimInMs));
  const [outText, setOutText] = useState(fmtClock(r.trimOutMs ?? dur));
  const [drag, setDrag] = useState<"in" | "out" | "pos" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopAt = useRef<number | null>(null);

  useEffect(() => setInText(fmtClock(inMs)), [inMs]);
  useEffect(() => setOutText(fmtClock(outMs)), [outMs]);
  useEffect(() => {
    const v = video.current;
    if (v) v.currentTime = r.trimInMs / 1000;
  }, [r.trimInMs]);

  const seek = useCallback((ms: number) => {
    const v = video.current;
    const c = Math.max(0, Math.min(dur, ms));
    if (v) v.currentTime = c / 1000;
    setPos(c);
  }, [dur]);
  const play = (from: number, until: number | null) => {
    const v = video.current;
    if (!v) return;
    seek(from);
    stopAt.current = until;
    void v.play();
  };
  const msAt = (e: { clientX: number }) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * dur);
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const ms = msAt(e);
    const near = (x: number) => Math.abs(x - ms) < dur * 0.02;
    const which = near(inMs) ? "in" : near(outMs) ? "out" : "pos";
    setDrag(which);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (which === "pos") seek(ms);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const ms = msAt(e);
    if (drag === "in") {
      setIn(Math.min(ms, outMs - 1000));
      seek(Math.min(ms, outMs - 1000));
    } else if (drag === "out") {
      setOut(Math.max(ms, inMs + 1000));
      seek(Math.max(ms, inMs + 1000));
    } else seek(ms);
  };
  const pct = (ms: number) => `${dur ? (ms / dur) * 100 : 0}%`;
  const strip = useMemo(() => Array.from({ length: STRIP }, (_, i) => Math.round(((i + 0.5) * dur) / STRIP / 100) * 100), [dur]);
  const length = outMs - inMs;
  const changed = inMs !== r.trimInMs || outMs !== (r.trimOutMs ?? dur);

  const save = async (publish: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      await put(`/api/recordings/${r.id}`, { title: title.trim(), categoryId: categoryId ? Number(categoryId) : null, trimInMs: inMs, trimOutMs: outMs >= dur ? null : outMs, publish });
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t("mgmt.rec.trim.title", { name: r.title })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {r.mediaId ? (
            <Button loading={busy} disabled={!title.trim()} icon={<Library className="size-4" />} onClick={() => void save(false)}>
              {changed ? t("mgmt.rec.trim.saveUpdate") : t("common.save")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" loading={busy} disabled={!title.trim()} onClick={() => void save(false)}>
                {t("common.save")}
              </Button>
              <Button loading={busy} disabled={!title.trim()} icon={<FolderInput className="size-4" />} onClick={() => void save(true)}>
                {t("mgmt.rec.trim.saveLibrary")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="overflow-hidden rounded-lg bg-black">
          <video
            ref={video}
            src={`/api/recordings/${r.id}/video`}
            className="aspect-video w-full"
            preload="metadata"
            onTimeUpdate={(e) => {
              const ms = e.currentTarget.currentTime * 1000;
              setPos(ms);
              if (stopAt.current != null && ms >= stopAt.current) {
                e.currentTarget.pause();
                stopAt.current = null;
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
          />
        </div>

        {/* Filmstrip with the part that is kept; drag the yellow handles. */}
        <div className="select-none">
          <div ref={track} className="relative h-16 cursor-pointer touch-none overflow-hidden rounded-md bg-surface-2" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDrag(null)} role="slider" aria-label={t("mgmt.rec.trim.strip")} aria-valuemin={0} aria-valuemax={dur} aria-valuenow={pos}>
            <div className="absolute inset-0 flex">
              {strip.map((ms) => (
                <img key={ms} src={`/api/recordings/${r.id}/thumb?t=${ms}`} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover" />
              ))}
            </div>
            <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: pct(inMs) }} />
            <div className="absolute inset-y-0 right-0 bg-black/65" style={{ left: pct(outMs) }} />
            <div className="absolute inset-y-0 border-y-2 border-warn" style={{ left: pct(inMs), right: `calc(100% - ${pct(outMs)})` }} />
            {(["in", "out"] as const).map((k) => (
              <div key={k} className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-sm bg-warn shadow" style={{ left: pct(k === "in" ? inMs : outMs) }}>
                <span className="absolute top-1/2 left-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-black/40" />
              </div>
            ))}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: pct(pos) }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[11px] text-muted tabular-nums">
            <span>0:00</span>
            <span className="text-fg">{fmtClock(pos)}</span>
            <span>{fmtClock(dur)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="secondary" aria-label={t("mgmt.rec.trim.back")} icon={<SkipBack className="size-3.5" />} onClick={() => seek(pos - 1000)}>
            1s
          </Button>
          <Button size="sm" variant="secondary" aria-label={t("mgmt.rec.trim.frameBack")} onClick={() => seek(pos - 40)}>
            −1
          </Button>
          <Button size="sm" icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => (playing ? video.current?.pause() : void video.current?.play())}>
            {playing ? t("mgmt.rec.trim.pause") : t("mgmt.rec.trim.play")}
          </Button>
          <Button size="sm" variant="secondary" aria-label={t("mgmt.rec.trim.frameForward")} onClick={() => seek(pos + 40)}>
            +1
          </Button>
          <Button size="sm" variant="secondary" aria-label={t("mgmt.rec.trim.forward")} icon={<SkipForward className="size-3.5" />} onClick={() => seek(pos + 1000)}>
            1s
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line p-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t("mgmt.rec.trim.start")}</p>
            <div className="flex gap-2">
              <Input aria-label={t("mgmt.rec.trim.start")} value={inText} className="font-mono" onChange={(e) => setInText(e.target.value)} onBlur={() => {
                  const v = parseClock(inText);
                  if (v != null && v < outMs - 1000) setIn(v);
                  else setInText(fmtClock(inMs));
                }} />
              <Button variant="secondary" onClick={() => setIn(Math.min(Math.round(pos), outMs - 1000))}>
                {t("mgmt.rec.trim.setHere")}
              </Button>
            </div>
            <button className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand" onClick={() => play(inMs, inMs + 5000)}>
              <Play className="size-3" /> {t("mgmt.rec.trim.watchStart")}
            </button>
          </div>
          <div className="rounded-lg border border-line p-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{t("mgmt.rec.trim.end")}</p>
            <div className="flex gap-2">
              <Input aria-label={t("mgmt.rec.trim.end")} value={outText} className="font-mono" onChange={(e) => setOutText(e.target.value)} onBlur={() => {
                  const v = parseClock(outText);
                  if (v != null && v > inMs + 1000 && v <= dur) setOut(v);
                  else setOutText(fmtClock(outMs));
                }} />
              <Button variant="secondary" onClick={() => setOut(Math.max(Math.round(pos), inMs + 1000))}>
                {t("mgmt.rec.trim.setHere")}
              </Button>
            </div>
            <button className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand" onClick={() => play(Math.max(inMs, outMs - 5000), outMs)}>
              <Play className="size-3" /> {t("mgmt.rec.trim.watchEnd")}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-4 py-3 text-sm">
          <span>
            {t("mgmt.rec.trim.result")} <strong className="font-mono tabular-nums">{fmtDuration(length)}</strong>
            <span className="text-muted"> · {t("mgmt.rec.trim.removed", { start: fmtDuration(inMs), end: fmtDuration(dur - outMs) })}</span>
          </span>
          {changed && (
            <button className="text-xs font-medium text-muted hover:text-fg" onClick={() => (setIn(0), setOut(dur))}>
              {t("mgmt.rec.trim.reset")}
            </button>
          )}
        </div>
        <p className="text-xs text-muted">{t("mgmt.rec.trim.keyframeNote")}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("mgmt.rec.trim.name")} hint={t("mgmt.rec.trim.nameHint")}>
            {(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label={t("mgmt.rec.category")} hint={t("mgmt.rec.categoryHint")}>
            {(id) => (
              <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t("mgmt.rec.noCategory")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

// ---- repeats -------------------------------------------------------------------------------

interface Slot {
  date: string;
  time: string;
}
const slotIso = (s: Slot) => new Date(`${s.date}T${s.time}:00`).toISOString();

function RepeatDialog({ r, channels, onClose, onSaved, onChanged }: { r: Recording; channels: Channel[]; onClose: () => void; onSaved: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const started = new Date(r.startedAt);
  const sameTime = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
  const [channelId, setChannelId] = useState(String(r.channelId ?? channels[0]?.id ?? ""));
  const [slots, setSlots] = useState<Slot[]>([{ date: isoDay(addDays(new Date(), 1)), time: "10:00" }]);
  const [conflicts, setConflicts] = useState<{ at: string; title: string; startAt: string; origin: string }[]>([]);
  const [lengthMs, setLength] = useState<number | null>(r.lengthMs);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = slots.filter((s) => s.date && s.time && Date.parse(slotIso(s)) > Date.now());

  const key = JSON.stringify([channelId, valid]);
  useEffect(() => {
    if (!channelId || !valid.length) return setConflicts([]);
    const timer = setTimeout(() => {
      post<{ conflicts: typeof conflicts; lengthMs: number }>(`/api/recordings/${r.id}/repeats`, { channelId: Number(channelId), startAts: valid.map(slotIso), dryRun: true })
        .then((d) => {
          setConflicts(d.conflicts);
          setLength(d.lengthMs);
        })
        .catch(() => setConflicts([]));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const quick = [
    { label: t("mgmt.rec.repeat.tonight"), slot: { date: isoDay(new Date()), time: "22:00" } },
    { label: t("mgmt.rec.repeat.tomorrowMorning"), slot: { date: isoDay(addDays(new Date(), 1)), time: "10:00" } },
    { label: t("mgmt.rec.repeat.tomorrowSame", { time: sameTime }), slot: { date: isoDay(addDays(started, 1)), time: sameTime } },
    { label: t("mgmt.rec.repeat.nextWeek", { time: sameTime }), slot: { date: isoDay(addDays(started, 7)), time: sameTime } },
  ].filter((q) => Date.parse(slotIso(q.slot)) > Date.now());

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      await post(`/api/recordings/${r.id}/repeats`, { channelId: Number(channelId), startAts: valid.map(slotIso) });
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    try {
      await del(`/api/recordings/${r.id}/repeats/${id}`);
      onChanged();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mgmt.rec.repeat.title", { name: r.title })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} disabled={!valid.length || !channelId} icon={<CalendarPlus className="size-4" />} onClick={() => void save()}>
            {t("mgmt.rec.repeat.plan", { count: valid.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}
        {!r.mediaId && <Alert tone="brand">{t("mgmt.rec.repeat.firstLibrary")}</Alert>}
        <Field label={t("mgmt.rec.repeat.channel")}>
          {(id) => (
            <Select id={id} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium">{t("mgmt.rec.repeat.when")}</p>
          <div className="space-y-2">
            {slots.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input type="date" aria-label={t("mgmt.rec.repeat.date")} value={s.date} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
                <Input type="time" aria-label={t("mgmt.rec.repeat.time")} value={s.time} className="w-32" onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
                <Button variant="ghost" size="sm" aria-label={t("common.delete")} icon={<X className="size-4" />} disabled={slots.length < 2} onClick={() => setSlots(slots.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {quick.map((q) => (
              <button key={q.label} className="rounded-full border border-line px-3 py-1 text-xs font-medium hover:border-brand hover:text-brand" onClick={() => setSlots([...slots.filter((x) => x.date && Date.parse(slotIso(x)) > Date.now() && slotIso(x) !== slotIso(q.slot)), q.slot])}>
                + {q.label}
              </button>
            ))}
            <button className="rounded-full border border-dashed border-line px-3 py-1 text-xs font-medium text-muted hover:text-fg" onClick={() => setSlots([...slots, { date: isoDay(addDays(new Date(), 1)), time: sameTime }])}>
              <Plus className="mr-1 inline size-3" />
              {t("mgmt.rec.repeat.another")}
            </button>
          </div>
          {lengthMs != null && <p className="mt-3 text-xs text-muted">{t("mgmt.rec.repeat.length", { length: fmtDuration(lengthMs) })}</p>}
        </div>
        {conflicts.map((c, i) => (
          <Alert key={i} tone={c.origin === "week" ? "neutral" : "warn"}>
            {t(c.origin === "week" ? "mgmt.rec.repeat.replacesWeek" : "mgmt.rec.repeat.overlaps", { at: fmtDateTime(c.at), title: c.title || "–", time: fmtTime(c.startAt) })}
          </Alert>
        ))}
        {r.repeats.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">{t("mgmt.rec.repeat.planned")}</p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {r.repeats.map((x) => (
                <li key={x.id} className={cx("flex items-center gap-3 px-3 py-2 text-sm", x.past && "text-muted")}>
                  <Repeat className="size-4 text-brand" />
                  <span className="flex-1">
                    {fmtDateTime(x.startAt)} · {x.channelName}
                  </span>
                  {!x.past && <Button size="sm" variant="ghost" aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} onClick={() => void remove(x.id)} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- settings ------------------------------------------------------------------------------

function SettingsDialog({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const libs = useGet<{ sources: { id: number; name: string; type: string; enabled: boolean }[] }>("/api/media/sources");
  const [s, setS] = useState(settings);
  const [err, setErr] = useState<string | null>(null);
  const num = (k: keyof Settings, v: string) => setS({ ...s, [k]: Number(v) || 0 });
  const save = async () => {
    try {
      await put("/api/recordings/settings", s);
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mgmt.rec.settings.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("mgmt.rec.settings.library")} hint={t("mgmt.rec.settings.libraryHint")}>
            {(id) => (
              <Select id={id} value={s.mediaSourceId ?? ""} onChange={(e) => setS({ ...s, mediaSourceId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t("mgmt.rec.settings.firstLibrary")}</option>
                {libs.data?.sources.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("mgmt.rec.settings.folder")} hint={t("mgmt.rec.settings.folderHint")}>
            {(id) => <Input id={id} value={s.folder} onChange={(e) => setS({ ...s, folder: e.target.value })} />}
          </Field>
          <Field label={t("mgmt.rec.settings.grace")} hint={t("mgmt.rec.settings.graceHint")}>
            {(id) => <Input id={id} type="number" min={5} max={1800} value={s.graceSeconds} onChange={(e) => num("graceSeconds", e.target.value)} />}
          </Field>
          <Field label={t("mgmt.rec.settings.postRoll")} hint={t("mgmt.rec.settings.postRollHint")}>
            {(id) => <Input id={id} type="number" min={0} max={3600} value={s.postRollSeconds} onChange={(e) => num("postRollSeconds", e.target.value)} />}
          </Field>
          <Field label={t("mgmt.rec.settings.min")} hint={t("mgmt.rec.settings.minHint")}>
            {(id) => <Input id={id} type="number" min={0} max={3600} value={s.minSeconds} onChange={(e) => num("minSeconds", e.target.value)} />}
          </Field>
          <Field label={t("mgmt.rec.settings.keep")} hint={t("mgmt.rec.settings.keepHint")}>
            {(id) => <Input id={id} type="number" min={0} max={365} value={s.keepDays} onChange={(e) => num("keepDays", e.target.value)} />}
          </Field>
          <Field label={t("mgmt.rec.settings.minFree")} hint={t("mgmt.rec.settings.minFreeHint")}>
            {(id) => <Input id={id} type="number" min={0} value={s.minFreeGb} onChange={(e) => num("minFreeGb", e.target.value)} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function SourceDialog({ src, categories, channels, onClose, onSaved }: { src: SourceCfg; categories: Category[]; channels: Channel[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [c, setC] = useState(src.recording);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await put(`/api/recordings/sources/${src.id}`, c);
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const setRule = (i: number, r: Partial<RepeatRule>) => setC({ ...c, repeats: c.repeats.map((x, j) => (j === i ? { ...x, ...r } : x)) });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t("mgmt.rec.source.title", { name: src.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-5">
        {err && <Alert tone="danger">{err}</Alert>}
        <Switch checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} label={t("mgmt.rec.source.enabled")} description={t("mgmt.rec.source.enabledHint")} />
        {c.enabled && (
          <>
            <Field label={t("mgmt.rec.category")} hint={t("mgmt.rec.source.categoryHint")}>
              {(id) => (
                <Select id={id} value={c.categoryId ?? ""} onChange={(e) => setC({ ...c, categoryId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t("mgmt.rec.noCategory")}</option>
                  {categories.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Switch checked={c.toLibrary} onChange={(v) => setC({ ...c, toLibrary: v })} label={t("mgmt.rec.source.toLibrary")} description={t("mgmt.rec.source.toLibraryHint")} />
            <div>
              <p className="text-sm font-medium">{t("mgmt.rec.source.repeats")}</p>
              <p className="mb-3 text-xs text-muted">{t("mgmt.rec.source.repeatsHint")}</p>
              <div className="space-y-2">
                {c.repeats.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_7.5rem] items-center gap-2 rounded-lg border border-line p-2 sm:grid-cols-[11rem_8.5rem_1fr_auto]">
                    <Select aria-label={t("mgmt.rec.source.day")} value={r.dayOffset} onChange={(e) => setRule(i, { dayOffset: Number(e.target.value) })}>
                      {Array.from({ length: 8 }, (_, d) => (
                        <option key={d} value={d}>
                          {dayLabel(t, d)}
                        </option>
                      ))}
                    </Select>
                    <Input type="time" aria-label={t("mgmt.rec.repeat.time")} value={r.time} onChange={(e) => setRule(i, { time: e.target.value })} />
                    <Select aria-label={t("mgmt.rec.repeat.channel")} value={r.channelId ?? ""} onChange={(e) => setRule(i, { channelId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">{t("mgmt.rec.source.sameChannel")}</option>
                      {channels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.name}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" variant="ghost" aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} onClick={() => setC({ ...c, repeats: c.repeats.filter((_, j) => j !== i) })} />
                  </div>
                ))}
              </div>
              {c.repeats.length < 6 && (
                <Button className="mt-2" size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setC({ ...c, repeats: [...c.repeats, { dayOffset: 1, time: "10:00", channelId: null }] })}>
                  {t("mgmt.rec.source.addRepeat")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---- page ------------------------------------------------------------------------------------

export function RecordingsPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const canOperate = roleAtLeast(user?.role, "operator");
  const list = useGet<ListResponse>("/api/recordings", 3000);
  const sources = useGet<{ sources: SourceCfg[] }>("/api/recordings/sources", 5000);
  const cats = useGet<{ categories: Category[] }>("/api/categories");
  const chans = useGet<{ channels: Channel[] }>("/api/channels");
  const categories = cats.data?.categories ?? [];
  const channels = chans.data?.channels ?? [];
  const [trim, setTrim] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [source, setSource] = useState<number | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const recs = list.data?.recordings ?? [];
  const byId = (id: number | null) => recs.find((r) => r.id === id);
  const catOf = (id: number | null) => categories.find((c) => c.id === id);
  const active = list.data?.active ?? [];
  const done = recs.filter((r) => r.status !== "recording");
  const disk = list.data?.disk;

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(id);
    try {
      await fn();
      await list.reload();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const reload = () => {
    void list.reload();
    void sources.reload();
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.rec.title")}
        description={t("mgmt.rec.intro")}
        actions={
          canEdit && (
            <Button variant="secondary" icon={<Settings2 className="size-4" />} onClick={() => setSettings(true)}>
              {t("mgmt.rec.settings.button")}
            </Button>
          )
        }
      />
      <div className="space-y-6">
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs font-medium text-muted">{t("mgmt.rec.kpi.recording")}</p>
            <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">
              {active.length > 0 && <span className="size-2.5 animate-pulse rounded-full bg-danger" />}
              {active.length}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium text-muted">{t("mgmt.rec.kpi.toCheck")}</p>
            <p className="mt-1 text-2xl font-semibold">{recs.filter((r) => r.status === "ready").length}</p>
          </Card>
          <Card className="p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <HardDrive className="size-3.5" /> {t("mgmt.rec.kpi.disk")}
            </p>
            {disk ? (
              <>
                <p className="mt-1 text-2xl font-semibold">{formatBytes(disk.free)}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className={cx("h-full rounded-full", disk.free < (list.data?.settings.minFreeGb ?? 5) * 2e9 ? "bg-danger" : "bg-brand")} style={{ width: `${Math.min(100, ((disk.total - disk.free) / disk.total) * 100)}%` }} />
                </div>
              </>
            ) : (
              <p className="mt-1 text-2xl font-semibold">–</p>
            )}
          </Card>
        </div>
        {list.data && !list.data.library && (
          <Alert tone="warn">
            {t("mgmt.rec.noLibrary")}{" "}
            <Link className="font-medium underline" to="/media">
              {t("mgmt.nav.media")}
            </Link>
          </Alert>
        )}

        {active.length > 0 && (
          <Card>
            <CardHeader icon={<Circle className="size-4 fill-danger text-danger" />} title={t("mgmt.rec.now")} description={t("mgmt.rec.nowIntro")} />
            <ul className="divide-y divide-line">
              {active.map((a) => {
                const r = byId(a.recordingId);
                return (
                  <li key={a.recordingId} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="grid size-11 place-items-center rounded-lg bg-danger/12 text-danger">
                      <span className="text-[11px] font-bold tracking-wider">REC</span>
                    </div>
                    <div className="min-w-48 flex-1">
                      <p className="font-medium">{r?.title ?? "…"}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {[r?.sourceName, t("mgmt.rec.since", { time: fmtTime(a.since) }), formatBytes(a.bytes), a.pieces > 1 ? t("mgmt.rec.reconnects", { count: a.pieces - 1 }) : null, a.programEnd ? t("mgmt.rec.stopsAfter", { time: fmtTime(a.programEnd) }) : t("mgmt.rec.stopsWhenStreamEnds")]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {a.error && <p className="mt-1 text-xs text-danger">{a.error}</p>}
                    </div>
                    <span className="text-lg font-semibold text-danger">
                      <Elapsed since={a.since} />
                    </span>
                    {canOperate && (
                      <Button variant="secondary" size="sm" loading={busy === a.recordingId} icon={<CircleStop className="size-3.5" />} onClick={() => confirm(t("mgmt.rec.stopConfirm")) && void act(a.recordingId, () => post(`/api/recordings/${a.recordingId}/stop`))}>
                        {t("mgmt.rec.stop")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader icon={<Clapperboard className="size-4" />} title={t("mgmt.rec.list")} description={t("mgmt.rec.listIntro")} />
          <ul className="divide-y divide-line">
            {done.map((r) => {
              const cat = catOf(r.categoryId);
              const upcoming = r.repeats.filter((x) => !x.past);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <Thumb r={r} className="w-32" />
                  <div className="min-w-56 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{r.title}</p>
                      <StatusBadge r={r} />
                      {r.outdated && <Badge tone="warn">{t("mgmt.rec.outdated")}</Badge>}
                      {cat && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">
                          <span className="size-2 rounded-full" style={{ background: cat.color }} />
                          {cat.name}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {[fmtDateTime(r.startedAt), r.sourceName, r.lengthMs != null ? fmtDuration(r.lengthMs) : null, r.lengthMs != null && r.durationMs !== r.lengthMs ? t("mgmt.rec.trimmedFrom", { length: fmtDuration(r.durationMs) }) : null, r.width ? `${r.width}×${r.height}` : null, r.size ? formatBytes(r.size) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {r.mediaPath && (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                        <Library className="size-3" /> {r.mediaPath}
                      </p>
                    )}
                    {upcoming.length > 0 && (
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <Repeat className="size-3 text-brand" />
                        {upcoming.map((x) => (
                          <span key={x.id} className="rounded bg-brand/10 px-1.5 py-0.5 font-medium text-brand">
                            {fmtDateTime(x.startAt)}
                          </span>
                        ))}
                      </p>
                    )}
                    {r.pendingRepeats > 0 && <p className="mt-1 text-xs text-muted">{t("mgmt.rec.pendingRepeats", { count: r.pendingRepeats })}</p>}
                    {!r.hasFile && r.status === "published" && <p className="mt-1 text-xs text-muted">{t("mgmt.rec.localRemoved")}</p>}
                    {r.error && <p className="mt-1 text-xs text-danger">{t("mgmt.rec.errorLine", { message: t(`mgmt.errors.${r.error}`, { defaultValue: r.error }) })}</p>}
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      {r.hasFile && (r.status === "ready" || r.status === "published") && (
                        <Button size="sm" variant={r.status === "ready" ? "primary" : "secondary"} icon={<Scissors className="size-3.5" />} onClick={() => setTrim(r.id)}>
                          {t("mgmt.rec.trimBtn")}
                        </Button>
                      )}
                      {r.hasFile && r.status === "ready" && (
                        <Button size="sm" variant="secondary" loading={busy === r.id} icon={<FolderInput className="size-3.5" />} onClick={() => void act(r.id, () => post(`/api/recordings/${r.id}/publish`))}>
                          {t("mgmt.rec.toLibrary")}
                        </Button>
                      )}
                      {r.outdated && r.hasFile && r.status === "published" && (
                        <Button size="sm" variant="secondary" loading={busy === r.id} icon={<Library className="size-3.5" />} onClick={() => void act(r.id, () => post(`/api/recordings/${r.id}/publish`))}>
                          {t("mgmt.rec.update")}
                        </Button>
                      )}
                      {(r.status === "published" || (r.status === "ready" && r.hasFile)) && (
                        <Button size="sm" variant="secondary" icon={<CalendarPlus className="size-3.5" />} onClick={() => setRepeat(r.id)}>
                          {t("mgmt.rec.repeatBtn")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("common.delete")}
                        disabled={r.status === "processing" || r.status === "publishing"}
                        icon={<Trash2 className="size-3.5" />}
                        onClick={() => confirm(t(r.mediaId ? "mgmt.rec.deleteConfirmLibrary" : "mgmt.rec.deleteConfirm", { name: r.title })) && void act(r.id, () => del(`/api/recordings/${r.id}`))}
                      />
                    </div>
                  )}
                </li>
              );
            })}
            {list.data && !done.length && (
              <li className="px-5 py-10 text-center">
                <Video className="mx-auto mb-2 size-6 text-muted" />
                <p className="text-sm text-muted">{t("mgmt.rec.none")}</p>
              </li>
            )}
          </ul>
        </Card>

        <Card>
          <button className="flex w-full items-center gap-3 px-5 py-4 text-left" onClick={() => setShowSources(!showSources)} aria-expanded={showSources}>
            <span className="grid size-8 place-items-center rounded-md bg-brand/10 text-brand">
              <Settings2 className="size-4" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold">{t("mgmt.rec.sources")}</span>
              <span className="block text-sm text-muted">{t("mgmt.rec.sourcesIntro")}</span>
            </span>
            <ChevronDown className={cx("size-4 text-muted transition", showSources && "rotate-180")} />
          </button>
          {showSources && (
            <div className="border-t border-line">
              <ul className="divide-y divide-line">
                {(sources.data?.sources ?? []).map((s) => {
                  const cat = catOf(s.recording.categoryId);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <div className="min-w-48 flex-1">
                        <p className="flex items-center gap-2 font-medium">
                          {s.name}
                          {s.active && <Badge tone="danger">REC</Badge>}
                          {s.blocked && <Badge tone="warn">{t(`mgmt.rec.blocked.${s.blocked}`)}</Badge>}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {s.recording.enabled
                            ? [t("mgmt.rec.source.on"), cat?.name, s.recording.toLibrary ? t("mgmt.rec.source.autoLibrary") : t("mgmt.rec.source.manualLibrary"), s.recording.repeats.length ? t("mgmt.rec.source.autoRepeats", { list: s.recording.repeats.map((x) => `${dayLabel(t, x.dayOffset)} ${x.time}`).join(", ") }) : null]
                                .filter(Boolean)
                                .join(" · ")
                            : t("mgmt.rec.source.off")}
                        </p>
                      </div>
                      {canEdit && <Button size="sm" variant="ghost" aria-label={t("common.edit")} icon={<Pencil className="size-3.5" />} onClick={() => setSource(s.id)} />}
                    </li>
                  );
                })}
                {sources.data && !sources.data.sources.length && (
                  <li className="px-5 py-6 text-center text-sm text-muted">
                    {t("mgmt.rec.noSources")}{" "}
                    <Link className="font-medium text-brand" to="/remote">
                      {t("mgmt.nav.remote")}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          )}
        </Card>
      </div>

      {trim != null && byId(trim) && (
        <TrimDialog
          r={byId(trim)!}
          categories={categories}
          onClose={() => setTrim(null)}
          onSaved={() => {
            setTrim(null);
            reload();
          }}
        />
      )}
      {repeat != null && byId(repeat) && (
        <RepeatDialog
          r={byId(repeat)!}
          channels={channels}
          onClose={() => setRepeat(null)}
          onChanged={reload}
          onSaved={() => {
            setRepeat(null);
            reload();
          }}
        />
      )}
      {settings && list.data && (
        <SettingsDialog
          settings={list.data.settings}
          onClose={() => setSettings(false)}
          onSaved={() => {
            setSettings(false);
            reload();
          }}
        />
      )}
      {source != null && sources.data?.sources.find((s) => s.id === source) && (
        <SourceDialog
          src={sources.data.sources.find((s) => s.id === source)!}
          categories={categories}
          channels={channels}
          onClose={() => setSource(null)}
          onSaved={() => {
            setSource(null);
            reload();
          }}
        />
      )}
    </>
  );
}
