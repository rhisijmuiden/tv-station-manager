import { Alert, Button, Card, CardBody, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { CalendarDays, Clapperboard, Lock, Pencil, Plus, Radio, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { PendingChanges } from "../components/PendingChanges";
import { Link } from "react-router-dom";
import { ChannelTabs } from "../components/ChannelPicker";
import { errorText, fmtDuration, useCategories, useChannels, useChannelSelection, useGet, type BlockSummary, type LiveSource } from "../lib";

interface Slot {
  id: number;
  channelId: number;
  weekday: number;
  startMin: number;
  durationMin: number;
  clockMode: "channel" | "clock" | "none";
  clockId: number | null;
  blockId: number | null;
  categoryId: number | null;
  title: string | null;
  description: string | null;
  inEpg: boolean;
}
interface WeekData {
  channel: { id: number; name: string; clockId: number | null; weekEnabled: boolean };
  slots: Slot[];
}

const ROW = 46;
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** Monday of the current week (browser time), as a Date at midnight. */
const mondayOf = (d: Date) => {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
};
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const slotBody = (s: Slot) => ({ startMin: s.startMin, durationMin: s.durationMin, clockMode: s.clockMode, clockId: s.clockId, blockId: s.blockId, categoryId: s.categoryId, title: s.title, description: s.description, inEpg: s.inEpg });

interface Entry {
  id: number;
  startAt: string;
  endAt: string;
  programTitle: string;
  origin: string;
}

/**
 * "Plan live": a live event with a day, start and end time, laid over the week (a manual schedule entry with a block
 * that holds the live source; manual entries win over the week planning while they are on air).
 */
function LiveDialog({ open, onClose, channelId, onDone }: { open: boolean; onClose: () => void; channelId: number; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const live = useGet<{ sources: LiveSource[] }>(open ? "/api/live-sources" : null);
  const [f, setF] = useState({ source: 0, title: "", date: isoDate(new Date()), from: "19:00", to: "21:00" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setErr(null);
  }, [open]);
  const src = live.data?.sources.find((s) => s.id === f.source) ?? live.data?.sources[0];
  const start = new Date(`${f.date}T${f.from}:00`);
  let end = new Date(`${f.date}T${f.to}:00`);
  if (end <= start) end = new Date(end.getTime() + 86400_000);
  const ms = end.getTime() - start.getTime();
  const save = async () => {
    if (!src || !(ms > 0)) return;
    setBusy(true);
    setErr(null);
    try {
      const title = f.title.trim() || src.name;
      const b = await post<{ id: number }>("/api/blocks", { name: `Live: ${title}`.slice(0, 120), kind: "program", hourStart: false, hidden: true, items: [{ type: "live", liveSourceId: src.id, durationMs: ms, title }] });
      await post("/api/schedule", { channelId, startAt: start.toISOString(), blockId: b.id, title, inEpg: true });
      onDone(t("mgmt.plan.live.done", { name: title, date: start.toLocaleDateString(), from: f.from, to: f.to }));
      onClose();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("mgmt.plan.live.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button icon={<Radio className="size-4" />} disabled={!src || !(ms > 0) || busy} onClick={() => void save()}>
            {t("mgmt.plan.live.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t("mgmt.plan.live.intro")}</p>
        {err && <Alert tone="danger">{err}</Alert>}
        {live.data && !live.data.sources.length ? (
          <Alert tone="warn">{t("mgmt.plan.live.noSources")}</Alert>
        ) : (
          <>
            <Field label={t("mgmt.plan.live.source")}>
              {(id) => (
                <Select id={id} value={src?.id ?? ""} onChange={(e) => setF({ ...f, source: Number(e.target.value) })}>
                  {live.data?.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("mgmt.plan.live.name")}>{(id) => <Input id={id} value={f.title} placeholder={src?.name} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t("mgmt.plan.live.date")}>{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
              <Field label={t("mgmt.plan.live.from")}>{(id) => <Input id={id} type="time" step={300} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
              <Field label={t("mgmt.plan.live.to")}>{(id) => <Input id={id} type="time" step={300} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
            </div>
            {ms > 0 && <p className="text-xs text-muted">{t("mgmt.plan.live.length", { time: fmtDuration(ms) })}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

type Drag = { kind: "block"; blockId: number } | { kind: "slot"; slot: Slot };
let dragging: Drag | null = null;

/**
 * Week planning for editors: hour blocks dragged onto a week of hours. A block on several days at the same time is
 * one series; clicking it switches days on and off. Rundowns per date, clocks and categories stay on the advanced board.
 */
export function WeekPlanPage() {
  const { t, i18n } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { channels, reload: reloadChannels } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const week = useGet<WeekData>(channel ? `/api/week?channel=${channel.id}` : null);
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=program");
  const { categories } = useCategories();
  const [sel, setSel] = useState<number | null>(null);
  const [series, setSeries] = useState<number[]>([]);
  const [over, setOver] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const weekFrom = mondayOf(new Date());
  const weekTo = new Date(weekFrom.getFullYear(), weekFrom.getMonth(), weekFrom.getDate() + 7);
  const sched = useGet<{ entries: Entry[] }>(channel ? `/api/schedule?channel=${channel.id}&from=${encodeURIComponent(weekFrom.toISOString())}&to=${encodeURIComponent(weekTo.toISOString())}` : null);
  const extras = (sched.data?.entries ?? []).filter((e) => e.origin === "manual");

  const slots = week.data?.slots ?? [];
  const selected = slots.find((s) => s.id === sel) ?? null;
  const blockById = useMemo(() => new Map((blocks.data?.blocks ?? []).map((b) => [b.id, b])), [blocks.data]);
  const opener = channel?.graphics.hourStart?.enabled ? channel.graphics.hourStart.blockId : null;
  const monday = mondayOf(new Date());
  const today = (new Date().getDay() + 6) % 7;
  const dayName = (d: number) => new Date(2024, 0, 1 + d).toLocaleDateString(i18n.language, { weekday: "short" });
  const dateOf = (d: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);

  useEffect(() => {
    // Open at the morning, where most of the day's programmes are.
    if (scroller.current) scroller.current.scrollTop = 6 * ROW;
  }, [channel?.id]);
  useEffect(() => {
    if (!sel) return setSeries([]);
    void get<{ slots: { id: number; weekday: number }[] }>(`/api/week/slots/${sel}/series`)
      .then((d) => setSeries(d.slots.map((s) => s.weekday)))
      .catch(() => setSeries([]));
  }, [sel, week.data]);

  const label = (s: Slot) => s.title || (s.blockId ? blockById.get(s.blockId)?.name : null) || (s.categoryId ? categories?.find((c) => c.id === s.categoryId)?.name : null) || t("mgmt.plan.week.unnamed");
  const color = (s: Slot) => (s.blockId ? blockById.get(s.blockId)?.color : null) || (s.categoryId ? categories?.find((c) => c.id === s.categoryId)?.color : null) || "var(--tvsm-primary)";
  const simple = (s: Slot) => s.blockId != null && s.clockMode === "none";
  /** The longest a slot can get: until the next slot on the same day, or midnight. */
  const maxLength = (s: Slot) => Math.min(1440, ...slots.filter((o) => o.weekday === s.weekday && o.startMin > s.startMin).map((o) => o.startMin)) - s.startMin;

  // Pulling the bottom edge of a block makes it longer or shorter, in whole hours; the whole series follows.
  const [resize, setResize] = useState<{ slot: Slot; y: number; dur: number } | null>(null);
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  useEffect(() => {
    if (!resize) return;
    const move = (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const raw = r.slot.durationMin + ((e.clientY - r.y) / ROW) * 60;
      const dur = Math.max(60, Math.min(maxLength(r.slot), Math.round(raw / 60) * 60));
      if (dur !== r.dur) setResize({ ...r, dur });
    };
    const up = () => {
      const r = resizeRef.current;
      setResize(null);
      if (!r || r.dur === r.slot.durationMin) return;
      void run(async () => {
        const ser = await get<{ slots: { weekday: number }[] }>(`/api/week/slots/${r.slot.id}/series`);
        await put(`/api/week/slots/${r.slot.id}/series`, { ...slotBody(r.slot), durationMin: r.dur, weekdays: ser.slots.map((x) => x.weekday) });
      }, t("mgmt.plan.week.resized", { time: `${hh(r.slot.startMin)}–${hh((r.slot.startMin + r.dur) % 1440)}` }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // Only (re)attach when a resize starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!resize]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: "ok", text: ok });
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
    await week.reload();
  };

  const drop = (e: DragEvent, weekday: number, hour: number) => {
    e.preventDefault();
    setOver(null);
    const d = dragging;
    dragging = null;
    if (!d || !channel || !canEdit) return;
    const startMin = hour * 60;
    if (d.kind === "block") {
      const b = blockById.get(d.blockId);
      void run(
        () => post<{ ids: number[] }>("/api/week/slots", { channelId: channel.id, weekdays: [weekday], startMin, durationMin: 60, clockMode: "none", blockId: d.blockId, title: null }).then((r) => setSel(r.ids[0] ?? null)),
        t("mgmt.plan.week.placed", { name: b?.name ?? "", day: dayName(weekday), time: hh(startMin) }),
      );
    } else {
      if (d.slot.weekday === weekday && d.slot.startMin === startMin) return;
      void run(() => put(`/api/week/slots/${d.slot.id}`, { ...slotBody(d.slot), weekday, startMin }), t("mgmt.plan.week.moved", { day: dayName(weekday), time: hh(startMin) }));
    }
  };
  const setDays = (days: number[]) => {
    if (!selected) return;
    if (!days.length) return void run(() => del(`/api/week/slots/${selected.id}/series`)).then(() => setSel(null));
    void run(() => put(`/api/week/slots/${selected.id}/series`, { ...slotBody(selected), weekdays: days }));
  };
  const setLength = (durationMin: number) => selected && void run(() => put(`/api/week/slots/${selected.id}/series`, { ...slotBody(selected), durationMin, weekdays: series.length ? series : [selected.weekday] }));
  const toggleWeek = (on: boolean) => channel && void run(() => put(`/api/week/channels/${channel.id}`, { weekEnabled: on, clockId: channel.clockId }).then(() => reloadChannels()));

  return (
    <>
      <PageHeader
        title={t("mgmt.plan.week.title")}
        description={t("mgmt.plan.week.intro")}
        actions={
          <>
          {canEdit && channel && (
            <Button icon={<Radio className="size-4" />} onClick={() => setLiveOpen(true)}>
              {t("mgmt.plan.live.button")}
            </Button>
          )}
          <Link to="/week/advanced">
            <Button variant="secondary" icon={<CalendarDays className="size-4" />}>
              {t("mgmt.plan.week.advanced")}
            </Button>
          </Link>
          </>
        }
      />
      <PendingChanges />
      {channels && <ChannelTabs channels={channels} value={channel} onChange={setChannel} />}
      {channels && !channels.length && <Alert tone="warn">{t("mgmt.control.noChannelsIntro")}</Alert>}
      {week.data && (
        <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface px-4 py-3">
          <Switch checked={week.data.channel.weekEnabled} onChange={(v) => canEdit && toggleWeek(v)} label={t("mgmt.plan.week.active")} description={t(week.data.channel.weekEnabled ? "mgmt.plan.week.activeOn" : "mgmt.plan.week.activeOff")} />
          {opener ? <span className="ml-auto text-xs text-muted">{t("mgmt.plan.week.openerOn")}</span> : <Link to="/graphics" className="ml-auto text-xs font-medium text-brand hover:underline">{t("mgmt.plan.week.openerOff")}</Link>}
        </div>
      )}
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      {channel && <LiveDialog open={liveOpen} onClose={() => setLiveOpen(false)} channelId={channel.id} onDone={(text) => (setMsg({ tone: "ok", text }), void sched.reload())} />}
      <div data-wide-page className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="min-w-0 overflow-hidden">
          <div ref={scroller} className="max-h-[72vh] overflow-auto">
            <div className="grid min-w-[760px]" style={{ gridTemplateColumns: "52px repeat(7, minmax(96px, 1fr))" }}>
              <div className="sticky top-0 z-20 border-b border-line bg-surface" />
              {DAYS.map((d) => (
                <div key={d} className={cx("sticky top-0 z-20 border-b border-l border-line bg-surface px-2 py-2 text-center text-[13px] font-bold capitalize", d === today && "text-onair")}>
                  {dayName(d)}
                  <span className="block text-[11px] font-medium text-muted">{dateOf(d).toLocaleDateString(i18n.language, { day: "numeric", month: "short" })}</span>
                </div>
              ))}
              <div className="relative">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="border-t border-line px-1.5 pt-0.5 font-mono text-[11px] text-muted" style={{ height: ROW }}>
                    {hh(h * 60)}
                  </div>
                ))}
              </div>
              {DAYS.map((d) => (
                <div key={d} className="relative border-l border-line">
                  {Array.from({ length: 24 }, (_, h) => (
                    <div
                      key={h}
                      className={cx("border-t border-line transition-colors", over === `${d}-${h}` && "bg-brand/10 ring-2 ring-brand ring-inset")}
                      style={{ height: ROW }}
                      onDragOver={(e) => {
                        if (!dragging || !canEdit) return;
                        e.preventDefault();
                        setOver(`${d}-${h}`);
                      }}
                      onDragLeave={() => setOver((o) => (o === `${d}-${h}` ? null : o))}
                      onDrop={(e) => drop(e, d, h)}
                    />
                  ))}
                  {slots
                    .filter((s) => s.weekday === d)
                    .map((s) => {
                      const b = s.blockId ? blockById.get(s.blockId) : undefined;
                      const dur = resize?.slot.id === s.id ? resize.dur : s.durationMin;
                      return (
                        <button
                          key={s.id}
                          draggable={canEdit}
                          onDragStart={(e) => {
                            dragging = { kind: "slot", slot: s };
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", label(s));
                          }}
                          onDragEnd={() => ((dragging = null), setOver(null))}
                          onClick={() => setSel(s.id === sel ? null : s.id)}
                          className={cx("group absolute inset-x-1 z-10 overflow-hidden rounded-md px-1.5 py-1 text-left text-[12px] leading-tight font-semibold text-white shadow-sm transition", canEdit && "cursor-grab active:cursor-grabbing", s.id === sel && "ring-2 ring-onair ring-offset-2 ring-offset-surface")}
                          style={{ top: (s.startMin / 60) * ROW + 2, height: Math.max(18, (dur / 60) * ROW - 4), background: color(s) }}
                          title={`${label(s)} · ${hh(s.startMin)}–${hh((s.startMin + dur) % 1440)}`}
                        >
                          <span className="block truncate">{label(s)}</span>
                          <span className="block truncate text-[11px] font-medium opacity-85">
                            {resize?.slot.id === s.id ? `${hh(s.startMin)}–${hh((s.startMin + dur) % 1440)}` : hh(s.startMin)}
                            {resize?.slot.id === s.id ? "" : b ? ` · ${fmtDuration(b.durationMs)}` : !simple(s) ? ` · ${t("mgmt.plan.week.advancedSlot")}` : ""}
                          </span>
                          {canEdit && simple(s) && (
                            <span
                              role="separator"
                              aria-orientation="horizontal"
                              aria-label={t("mgmt.plan.week.resizeHint")}
                              title={t("mgmt.plan.week.resizeHint")}
                              draggable={false}
                              onDragStart={(e) => (e.preventDefault(), e.stopPropagation())}
                              onClick={(e) => e.stopPropagation()}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSel(s.id);
                                setResize({ slot: s, y: e.clientY, dur: s.durationMin });
                              }}
                              className="absolute inset-x-0 bottom-0 flex h-2.5 cursor-ns-resize items-center justify-center hover:bg-black/15"
                            >
                              <span className={cx("h-0.5 w-6 rounded-full bg-white/80 transition-opacity", s.id === sel || resize?.slot.id === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100")} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  {extras.map((e) => {
                    const s = new Date(e.startAt);
                    const en = new Date(e.endAt);
                    const day = Math.floor((new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime() - weekFrom.getTime()) / 86400_000 + 0.5);
                    if (day !== d) return null;
                    const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * ROW;
                    const h = Math.max(18, ((en.getTime() - s.getTime()) / 3600_000) * ROW - 4);
                    return (
                      <div key={`e${e.id}`} className="absolute right-1 left-3 z-20 overflow-hidden rounded-md border-2 border-onair bg-onair/90 px-1.5 py-1 text-[12px] leading-tight font-semibold text-white shadow-md" style={{ top: top + 2, height: h }} title={`${e.programTitle} · ${t("mgmt.plan.live.over")}`}>
                        <span className="flex items-center gap-1 truncate">
                          <Radio className="size-3 shrink-0" />
                          {e.programTitle}
                        </span>
                        <span className="block truncate text-[11px] font-medium opacity-90">
                          {hh(s.getHours() * 60 + s.getMinutes())}–{hh(en.getHours() * 60 + en.getMinutes())}
                        </span>
                        {canEdit && (
                          <button className="absolute top-0.5 right-0.5 rounded p-0.5 hover:bg-white/20" onClick={() => void run(() => del(`/api/schedule/${e.id}`)).then(() => sched.reload())} aria-label={t("common.delete")}>
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </Card>

        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          {selected && (
            <Card>
              <CardBody className="space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-1 size-3 shrink-0 rounded" style={{ background: color(selected) }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{label(selected)}</p>
                    <p className="text-xs text-muted">
                      {hh(selected.startMin)}–{hh((selected.startMin + selected.durationMin) % 1440)} · {t("mgmt.plan.week.everyWeek")}
                    </p>
                  </div>
                  <button className="rounded p-1 text-muted hover:bg-surface-2" onClick={() => setSel(null)} aria-label={t("common.close")}>
                    <X className="size-4" />
                  </button>
                </div>
                <div>
                  <p className="mb-1.5 text-xs text-muted">{t("mgmt.plan.week.days")}</p>
                  <div className="flex gap-1">
                    {DAYS.map((d) => {
                      const on = series.includes(d);
                      return (
                        <button
                          key={d}
                          disabled={!canEdit}
                          onClick={() => setDays(on ? series.filter((x) => x !== d) : [...series, d].sort())}
                          className={cx("h-8 min-w-0 flex-1 rounded-md border text-xs font-semibold capitalize transition", on ? "border-brand bg-brand text-white" : "border-line bg-surface hover:border-brand/50")}
                        >
                          {dayName(d).slice(0, 2)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {[
                      ["weekdays", [0, 1, 2, 3, 4]],
                      ["weekend", [5, 6]],
                      ["all", DAYS],
                    ].map(([k, days]) => (
                      <button key={k as string} disabled={!canEdit} onClick={() => setDays(days as number[])} className="rounded-full border border-line px-2.5 py-0.5 text-[11px] font-medium hover:border-brand/50">
                        {t(`mgmt.plan.week.preset.${k}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {simple(selected) && (
                  <label className="block text-xs text-muted">
                    {t("mgmt.plan.week.length")}
                    <Select className="mt-1" value={selected.durationMin} disabled={!canEdit} onChange={(e) => setLength(Number(e.target.value))}>
                      {Array.from({ length: Math.max(1, Math.floor(maxLength(selected) / 60)) }, (_, i) => (i + 1) * 60).concat(selected.durationMin % 60 ? [selected.durationMin] : []).map((m) => (
                        <option key={m} value={m}>
                          {t("mgmt.plan.week.hours", { count: m / 60 })}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {!simple(selected) && <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">{t("mgmt.plan.week.advancedHint")}</p>}
                <div className="flex flex-wrap gap-2">
                  {selected.blockId && (
                    <Link to={`/blocks/${selected.blockId}`}>
                      <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />}>
                        {t("mgmt.plan.week.openBlock")}
                      </Button>
                    </Link>
                  )}
                  <Link to={`/rundowns/${selected.id}/${isoDate(dateOf(selected.weekday))}`}>
                    <Button size="sm" variant="ghost" icon={<CalendarDays className="size-3.5" />}>
                      {t("mgmt.plan.week.onlyDate", { date: dateOf(selected.weekday).toLocaleDateString(i18n.language, { day: "numeric", month: "short" }) })}
                    </Button>
                  </Link>
                  {canEdit && (
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void run(() => del(`/api/week/slots/${selected.id}`)).then(() => setSel(null))}>
                      {t("mgmt.plan.week.removeDay")}
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold">{t("mgmt.plan.week.blocks")}</p>
                {canEdit && (
                  <Link to="/blocks/new">
                    <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />}>
                      {t("mgmt.plan.week.newBlock")}
                    </Button>
                  </Link>
                )}
              </div>
              <p className="text-xs text-muted">{t(canEdit ? "mgmt.plan.week.dragHint" : "mgmt.plan.week.readOnly")}</p>
              <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">
                {blocks.data?.blocks
                  .filter((b) => b.id !== opener)
                  .map((b) => (
                    <li
                      key={b.id}
                      draggable={canEdit}
                      onDragStart={(e) => {
                        dragging = { kind: "block", blockId: b.id };
                        e.dataTransfer.effectAllowed = "copy";
                        e.dataTransfer.setData("text/plain", b.name);
                      }}
                      onDragEnd={() => ((dragging = null), setOver(null))}
                      className={cx("flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2", canEdit && "cursor-grab hover:border-brand/50 active:cursor-grabbing")}
                    >
                      <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: b.color }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{b.name}</span>
                        <span className="block text-xs text-muted">
                          {fmtDuration(b.durationMs)}
                          {b.hourStart && opener ? ` · ${t("mgmt.plan.week.withStart")}` : ""}
                        </span>
                      </span>
                      {b.hourStart && opener ? <Lock className="size-3.5 text-muted" aria-label={t("mgmt.plan.week.withStart")} /> : <Clapperboard className="size-3.5 text-muted" />}
                    </li>
                  ))}
                {blocks.data && !blocks.data.blocks.length && <li className="py-6 text-center text-sm text-muted">{t("mgmt.plan.week.noBlocks")}</li>}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
