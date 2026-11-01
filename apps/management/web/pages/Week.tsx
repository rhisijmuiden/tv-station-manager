import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Switch, Textarea, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { CalendarRange, Clock3, Copy, MousePointerClick, Plus, Send, Tags, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { payloadDuration, useDragging, useDrop, type DragPayload } from "../components/dnd";
import { WithMediaBin } from "../components/MediaBin";
import { ChannelTabs } from "../components/ChannelPicker";
import { ClockRing } from "../components/ClockRing";
import { errorText, fmtDate, fmtDateTime, fmtDuration, fmtMinutes, fmtTime, isoDay, parseMinutes, useCategories, useChannelSelection, useChannels, useGet, weekdayName, type BlockSummary, type HourClock } from "../lib";

export interface Slot {
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
  timezone: string;
  horizonDays: number;
  generated: { entries: number; until: string | null };
  lastPublish: { at: string; created: number } | null;
}
interface SlotForm {
  id?: number;
  weekdays: number[];
  start: string;
  duration: string;
  content: "category" | "block";
  categoryId: number | "";
  blockId: number | "";
  clockMode: Slot["clockMode"];
  clockId: number | "";
  title: string;
  description: string;
  inEpg: boolean;
}

type LibraryPayload = Exclude<DragPayload, { kind: "row" }>;
const HOUR_PX = 44;
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const DURATIONS = [30, 60, 90, 120, 180, 240, 360];

export function WeekPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { channels, reload: reloadChannels } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const week = useGet<WeekData>(channel ? `/api/week?channel=${channel.id}` : null);
  const clocks = useGet<{ clocks: HourClock[] }>("/api/clocks");
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=program");
  const { categories } = useCategories();
  const [form, setForm] = useState<SlotForm | null>(null);
  const [copy, setCopy] = useState<{ from: number; to: number[]; replace: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ text: string; to: string } | null>(null);
  const [dropOn, setDropOn] = useState<{ slot: Slot; payload: LibraryPayload } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 6 * HOUR_PX;
  }, [week.data?.channel.id]);

  const catById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
  const blockById = useMemo(() => new Map((blocks.data?.blocks ?? []).map((b) => [b.id, b])), [blocks.data]);
  const clockById = useMemo(() => new Map((clocks.data?.clocks ?? []).map((c) => [c.id, c])), [clocks.data]);
  const data = week.data;
  const slots = data?.slots ?? [];
  const defaultClock = data?.channel.clockId != null ? clockById.get(data.channel.clockId) : undefined;

  const slotColor = (s: Slot) => (s.blockId ? blockById.get(s.blockId)?.color : s.categoryId ? catById.get(s.categoryId)?.color : undefined) ?? "#64748B";
  const slotTitle = (s: Slot) => s.title || (s.blockId ? blockById.get(s.blockId)?.name : s.categoryId ? catById.get(s.categoryId)?.name : null) || t("mgmt.week.editorial");
  const clockOf = (s: Slot) => (s.clockMode === "none" ? null : s.clockMode === "clock" ? clockById.get(s.clockId ?? 0) : defaultClock);

  const setChannelWeek = async (patch: { weekEnabled?: boolean; clockId?: number | null }) => {
    if (!data) return;
    const r = await put<{ created: number; removed: number; planned: number }>(`/api/week/channels/${data.channel.id}`, { weekEnabled: patch.weekEnabled ?? data.channel.weekEnabled, clockId: patch.clockId !== undefined ? patch.clockId : data.channel.clockId });
    setNotice(patch.weekEnabled === false ? t("mgmt.week.disabledNotice", { n: r.removed }) : t("mgmt.week.published", { n: r.planned }));
    void week.reload();
    void reloadChannels();
  };
  const dragging = useDragging();
  const libraryDrag = dragging && dragging.kind !== "row" ? dragging : null;
  const publish = async () => {
    if (!data) return;
    const r = await post<{ planned: number }>("/api/week/publish", { channelId: data.channel.id });
    setNotice(t("mgmt.week.published", { n: r.planned }));
    void week.reload();
  };

  const newSlot = (weekday: number, startMin = 18 * 60, extra: Partial<SlotForm> = {}) =>
    setForm({ weekdays: [weekday], start: fmtMinutes(startMin), duration: "01:00", content: "category", categoryId: categories?.[0]?.id ?? "", blockId: "", clockMode: "channel", clockId: "", title: "", description: "", inEpg: true, ...extra });
  /** Dropped on an empty spot: a new slot there with the block (clips become a block first). */
  const newSlotFromDrop = async (weekday: number, startMin: number, p: LibraryPayload) => {
    setErr(null);
    try {
      let block = p.kind === "block" ? p.block : null;
      if (p.kind === "media") {
        const r = await post<{ id: number }>("/api/blocks/from-media", { mediaIds: p.media.map((m) => m.id), kind: "program" });
        await blocks.reload();
        block = { id: r.id, durationMs: payloadDuration(p) } as BlockSummary;
      }
      if (!block) return;
      const min = Math.max(5, Math.ceil((block.durationMs || 0) / 300_000) * 5);
      newSlot(weekday, startMin, { content: "block", blockId: block.id, duration: fmtMinutes(Math.min(1440, min)).replace(/^00:00$/, "24:00") });
    } catch (e) {
      setNotice(null);
      setErr(errorText(t, e));
    }
  };
  const editSlot = (s: Slot) =>
    setForm({
      id: s.id,
      weekdays: [s.weekday],
      start: fmtMinutes(s.startMin),
      duration: fmtMinutes(s.durationMin === 1440 ? 1440 : s.durationMin).replace(/^00:00$/, "24:00"),
      content: s.blockId ? "block" : "category",
      categoryId: s.categoryId ?? "",
      blockId: s.blockId ?? "",
      clockMode: s.clockMode,
      clockId: s.clockId ?? "",
      title: s.title ?? "",
      description: s.description ?? "",
      inEpg: s.inEpg,
    });
  const durationMin = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
  };
  const save = async () => {
    if (!form || !data) return;
    setErr(null);
    const startMin = parseMinutes(form.start);
    const dur = durationMin(form.duration);
    if (startMin == null || !dur) return setErr(t("mgmt.errors.validation_failed"));
    const body = {
      startMin,
      durationMin: dur,
      clockMode: form.clockMode,
      clockId: form.clockMode === "clock" ? form.clockId || null : null,
      blockId: form.content === "block" ? form.blockId || null : null,
      categoryId: form.content === "category" ? form.categoryId || null : null,
      title: form.title || null,
      description: form.description || null,
      inEpg: form.inEpg,
    };
    try {
      if (form.id) await put(`/api/week/slots/${form.id}`, { ...body, weekday: form.weekdays[0] });
      else await post("/api/week/slots", { ...body, channelId: data.channel.id, weekdays: form.weekdays });
      setForm(null);
      void week.reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async () => {
    if (!form?.id || !confirm(t("mgmt.week.confirmDelete"))) return;
    await del(`/api/week/slots/${form.id}`);
    setForm(null);
    void week.reload();
  };
  const doCopy = async () => {
    if (!copy || !data) return;
    setErr(null);
    try {
      const r = await post<{ copied: number }>("/api/week/copy-day", { channelId: data.channel.id, ...copy });
      setNotice(t("mgmt.week.copied", { n: r.copied }));
      setCopy(null);
      void week.reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };

  if (channels && !channels.length)
    return (
      <>
        <PageHeader title={t("mgmt.week.title")} />
        <Alert tone="warn">
          {t("mgmt.control.noChannelsIntro")}{" "}
          <Link to="/channels" className="font-semibold underline">
            {t("mgmt.nav.channels")}
          </Link>
        </Alert>
      </>
    );

  const now = new Date();
  const todayWd = (now.getDay() + 6) % 7;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const formClock = form ? (form.clockMode === "none" ? null : form.clockMode === "clock" ? clockById.get(Number(form.clockId)) : defaultClock) : null;

  return (
    <>
      <PageHeader
        title={t("mgmt.week.title")}
        description={t("mgmt.week.intro")}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => (setErr(null), setCopy({ from: 0, to: [1, 2, 3, 4], replace: false }))} disabled={!slots.length}>
                {t("mgmt.week.copyDay")}
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => newSlot(todayWd)}>
                {t("mgmt.week.addSlot")}
              </Button>
            </>
          )
        }
      />
      {channels && <ChannelTabs channels={channels} value={channel} onChange={setChannel} />}
      {notice && (
        <Alert tone="ok" className="mb-4">
          {notice}
        </Alert>
      )}
      {dropped && (
        <Alert tone="ok" className="mb-4">
          {dropped.text}{" "}
          <Link to={dropped.to} className="font-semibold underline">
            {t("mgmt.bin.openRundown")}
          </Link>
        </Alert>
      )}
      {err && !form && !copy && (
        <Alert tone="danger" className="mb-4">
          {err}
        </Alert>
      )}
      <WithMediaBin blocks hint={canEdit ? t("mgmt.bin.hintWeek") : undefined}>
      {data && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
            <div className="min-w-64 flex-1">
              {canEdit ? (
                <Switch checked={data.channel.weekEnabled} onChange={(v) => void setChannelWeek({ weekEnabled: v })} label={t("mgmt.week.active")} description={t("mgmt.week.activeHint", { days: data.horizonDays })} />
              ) : (
                <Badge tone={data.channel.weekEnabled ? "ok" : "neutral"}>{data.channel.weekEnabled ? t("mgmt.week.activeOn") : t("mgmt.week.activeOff")}</Badge>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Clock3 className="size-4 text-muted" />
              <span className="font-medium">{t("mgmt.week.defaultClock")}</span>
              <Select className="h-8 w-auto! text-[13px]" disabled={!canEdit} value={data.channel.clockId ?? ""} onChange={(e) => void setChannelWeek({ clockId: Number(e.target.value) || null })}>
                <option value="">{t("mgmt.week.noClock")}</option>
                {clocks.data?.clocks.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            <div className="text-xs text-muted">
              {data.generated.entries > 0 ? t("mgmt.week.generated", { n: data.generated.entries, until: data.generated.until ? fmtDateTime(data.generated.until) : "–" }) : t("mgmt.week.nothingGenerated")}
              <br />
              {t("mgmt.week.timezone", { tz: data.timezone })}
            </div>
            {canEdit && data.channel.weekEnabled && (
              <Button size="sm" variant="secondary" icon={<Send className="size-3.5" />} onClick={() => void publish()}>
                {t("mgmt.week.publish")}
              </Button>
            )}
          </div>
          {!clocks.data?.clocks.length && (
            <div className="border-t border-line px-5 py-3 text-sm text-muted">
              {t("mgmt.week.noClocks")}{" "}
              <Link to="/clocks/new" className="font-medium text-brand hover:underline">
                {t("mgmt.clocks.new")}
              </Link>
            </div>
          )}
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <div className="min-w-[880px]">
            <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-line bg-surface-2/50 text-sm">
              <div />
              {DAYS.map((d) => (
                <div key={d} className={cx("flex items-center justify-between px-3 py-2.5 font-semibold capitalize", d === todayWd && "text-brand")}>
                  {weekdayName(d)}
                  {canEdit && (
                    <button className="rounded p-1 text-muted hover:bg-surface hover:text-fg" onClick={() => newSlot(d)} aria-label={t("mgmt.week.addSlot")}>
                      <Plus className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div ref={scroller} className="max-h-[68vh] overflow-y-auto">
              <div className="relative grid grid-cols-[56px_repeat(7,1fr)]" style={{ height: 24 * HOUR_PX }}>
                <div className="relative">
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className="absolute right-2 -translate-y-1/2 font-mono text-[10px] text-muted" style={{ top: h * HOUR_PX }}>
                      {h ? `${String(h).padStart(2, "0")}:00` : ""}
                    </span>
                  ))}
                </div>
                {DAYS.map((d) => (
                  <DayColumn
                    key={d}
                    canEdit={canEdit}
                    className={cx("relative border-l border-line", d === todayWd && "bg-brand/[0.03]", canEdit && "cursor-copy")}
                    onClick={(e) => {
                      if (!canEdit || e.target !== e.currentTarget) return;
                      const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                      newSlot(d, Math.min(23, Math.max(0, Math.floor(y / HOUR_PX))) * 60);
                    }}
                    onDropAt={(min, p) => void newSlotFromDrop(d, min, p)}
                    preview={libraryDrag}
                  >
                    {Array.from({ length: 23 }, (_, h) => (
                      <div key={h} className="pointer-events-none absolute right-0 left-0 border-t border-line/60" style={{ top: (h + 1) * HOUR_PX }} />
                    ))}
                    {d === todayWd && <div className="pointer-events-none absolute right-0 left-0 z-10 h-0.5 bg-onair" style={{ top: (nowMin / 60) * HOUR_PX }} />}
                    {/* Slots of this day, plus the part of yesterday's slot that runs past midnight. */}
                    {[...slots.filter((s) => s.weekday === d).map((s) => ({ s, from: s.startMin, cont: false })), ...slots.filter((s) => s.weekday === (d + 6) % 7 && s.startMin + s.durationMin > 1440).map((s) => ({ s, from: s.startMin - 1440, cont: true }))].map(({ s, from, cont }) => {
                      const top = Math.max(0, from);
                      const bottom = Math.min(1440, from + s.durationMin);
                      const color = slotColor(s);
                      const cl = clockOf(s);
                      const h = ((bottom - top) / 60) * HOUR_PX;
                      return (
                        <SlotButton
                          key={`${s.id}${cont ? "c" : ""}`}
                          canDrop={canEdit}
                          onDropPayload={(p) => (setErr(null), setDropOn({ slot: s, payload: p }))}
                          onClick={() => canEdit && editSlot(s)}
                          className="absolute right-1 left-1 overflow-hidden rounded-md border-l-[3px] px-2 py-1 text-left text-xs shadow-sm transition hover:brightness-110 hover:shadow-md"
                          style={{ top: (top / 60) * HOUR_PX + 1, height: h - 2, borderColor: color, background: `color-mix(in srgb, ${color} 16%, var(--color-surface))` }}
                          title={`${fmtMinutes(s.startMin)}–${fmtMinutes(s.startMin + s.durationMin)} ${slotTitle(s)}`}
                        >
                          <span className="block truncate font-semibold">{slotTitle(s)}</span>
                          {h > 30 && (
                            <span className="flex items-center gap-1 truncate text-[11px] text-muted">
                              {fmtMinutes(s.startMin)}–{fmtMinutes(s.startMin + s.durationMin)}
                              {cl && <Clock3 className="size-3 shrink-0" aria-label={cl.name} />}
                            </span>
                          )}
                          {h > 52 && (
                            <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted">
                              {s.blockId ? blockById.get(s.blockId)?.name : s.categoryId ? (
                                <>
                                  <Tags className="size-3 shrink-0" /> {catById.get(s.categoryId)?.name}
                                </>
                              ) : (
                                t("mgmt.week.editorial")
                              )}
                            </span>
                          )}
                        </SlotButton>
                      );
                    })}
                  </DayColumn>
                ))}
              </div>
            </div>
          </div>
        </div>
        {data && !slots.length && (
          <div className="border-t border-line px-5 py-6 text-center text-sm text-muted">
            <CalendarRange className="mx-auto mb-2 size-7" />
            {t("mgmt.week.empty")}
          </div>
        )}
      </Card>
      <p className="mt-3 text-sm text-muted">
        {t("mgmt.week.footer")}{" "}
        <Link to="/rundowns" className="font-medium text-brand hover:underline">
          {t("mgmt.nav.rundowns")} →
        </Link>
      </p>
      </WithMediaBin>
      {dropOn && data && (
        <DropDialog
          slot={dropOn.slot}
          payload={dropOn.payload}
          title={slotTitle(dropOn.slot)}
          channelId={data.channel.id}
          onClose={() => setDropOn(null)}
          onDone={(text, to) => {
            setDropOn(null);
            setNotice(null);
            setDropped({ text, to });
          }}
        />
      )}

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        wide
        title={form?.id ? t("mgmt.week.editSlot") : t("mgmt.week.addSlot")}
        footer={
          <>
            {form?.id && (
              <Button variant="ghost" className="mr-auto text-danger!" icon={<Trash2 className="size-4" />} onClick={() => void remove()}>
                {t("common.delete")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!form?.weekdays.length || (form?.content === "block" && !form.blockId)} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="grid gap-6 md:grid-cols-[1fr_200px]">
            <div className="space-y-4">
              {err && <Alert tone="danger">{err}</Alert>}
              <div>
                <p className="mb-2 text-[13px] font-medium">{form.id ? t("mgmt.week.day") : t("mgmt.week.days")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => {
                    const on = form.weekdays.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setForm({ ...form, weekdays: form.id ? [d] : on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d].sort() })}
                        className={cx("rounded-full border px-3 py-1 text-[13px] font-medium capitalize transition", on ? "border-brand bg-brand text-white" : "border-line hover:border-brand/50")}
                      >
                        {weekdayName(d, "short")}
                      </button>
                    );
                  })}
                  {!form.id && (
                    <>
                      <button type="button" className="px-2 text-xs text-brand hover:underline" onClick={() => setForm({ ...form, weekdays: [0, 1, 2, 3, 4] })}>
                        {t("mgmt.week.weekdaysShortcut")}
                      </button>
                      <button type="button" className="px-2 text-xs text-brand hover:underline" onClick={() => setForm({ ...form, weekdays: [...DAYS] })}>
                        {t("mgmt.week.everyDay")}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mgmt.schedule.startTime")}>{(id) => <Input id={id} type="time" step={300} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />}</Field>
                <Field label={t("mgmt.week.duration")} hint={t("mgmt.week.durationHint")}>
                  {(id) => (
                    <div className="flex gap-2">
                      <Select className="w-auto!" value={DURATIONS.includes(durationMin(form.duration) ?? -1) ? String(durationMin(form.duration)) : "custom"} onChange={(e) => e.target.value !== "custom" && setForm({ ...form, duration: fmtMinutes(Number(e.target.value)).replace(/^00:00$/, "24:00") })}>
                        {DURATIONS.map((m) => (
                          <option key={m} value={m}>
                            {fmtMinutes(m).replace(/^00:00$/, "24:00")}
                          </option>
                        ))}
                        <option value="custom">{t("mgmt.week.custom")}</option>
                      </Select>
                      <Input id={id} className="font-mono" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="hh:mm" />
                    </div>
                  )}
                </Field>
              </div>
              <div>
                <p className="mb-2 text-[13px] font-medium">{t("mgmt.week.content")}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(["category", "block"] as const).map((c) => (
                    <button key={c} type="button" onClick={() => setForm({ ...form, content: c })} className={cx("rounded-lg border p-3 text-left transition", form.content === c ? "border-brand bg-brand/5 ring-1 ring-brand" : "border-line hover:border-brand/50")}>
                      <span className="block text-sm font-semibold">{t(`mgmt.week.content_${c}`)}</span>
                      <span className="block text-xs text-muted">{t(`mgmt.week.content_${c}Hint`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              {form.content === "category" ? (
                <Field label={t("mgmt.categoriesPage.one")} hint={t("mgmt.week.categoryHint")}>
                  {(id) => (
                    <Select id={id} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) || "" })}>
                      <option value="">{t("mgmt.week.noCategory")}</option>
                      {categories?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({t("mgmt.categoriesPage.media", { n: c.mediaCount, d: fmtDuration(c.mediaMs) })})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <Field label={t("mgmt.schedule.block")}>
                  {(id) => (
                    <Select id={id} value={form.blockId} onChange={(e) => setForm({ ...form, blockId: Number(e.target.value) || "" })}>
                      <option value="">{t("mgmt.schedule.chooseBlock")}</option>
                      {blocks.data?.blocks.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({fmtDuration(b.durationMs)})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={t("mgmt.week.clock")}>
                {(id) => (
                  <Select
                    id={id}
                    value={form.clockMode === "clock" ? String(form.clockId) : form.clockMode}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm({ ...form, clockMode: v === "channel" || v === "none" ? v : "clock", clockId: v === "channel" || v === "none" ? "" : Number(v) });
                    }}
                  >
                    <option value="channel">{t("mgmt.week.clockChannel", { name: defaultClock?.name ?? t("mgmt.week.noClock") })}</option>
                    {clocks.data?.clocks.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value="none">{t("mgmt.week.clockNone")}</option>
                  </Select>
                )}
              </Field>
              <Field label={t("mgmt.schedule.epgTitle")} hint={t("mgmt.week.titleHint")}>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
              <Field label={t("mgmt.blocks.description")}>{(id) => <Textarea id={id} className="min-h-14 font-sans text-sm" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
              <Switch checked={form.inEpg} onChange={(v) => setForm({ ...form, inEpg: v })} label={t("mgmt.schedule.inEpg")} />
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              {formClock ? (
                <>
                  <ClockRing layout={formClock.layout} size={180} colors={(i) => (formClock.items[i]?.kind === "program" ? "var(--color-brand)" : (formClock.items[i]?.blockColor ?? undefined))} />
                  <p className="text-sm font-medium">{formClock.name}</p>
                  <p className="text-xs text-muted">{t("mgmt.week.clockPreview")}</p>
                </>
              ) : (
                <p className="mt-8 text-xs text-muted">{t("mgmt.week.noClockPreview")}</p>
              )}
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!copy}
        onClose={() => setCopy(null)}
        title={t("mgmt.week.copyDay")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCopy(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!copy?.to.length} onClick={() => void doCopy()}>
              {t("mgmt.schedule.copy")}
            </Button>
          </>
        }
      >
        {copy && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("mgmt.week.copyFrom")}>
              {(id) => (
                <Select id={id} value={copy.from} onChange={(e) => setCopy({ ...copy, from: Number(e.target.value), to: copy.to.filter((x) => x !== Number(e.target.value)) })}>
                  {DAYS.map((d) => (
                    <option key={d} value={d}>
                      {weekdayName(d)} ({slots.filter((s) => s.weekday === d).length})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.week.copyTo")}</p>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.filter((d) => d !== copy.from).map((d) => {
                  const on = copy.to.includes(d);
                  return (
                    <button key={d} type="button" onClick={() => setCopy({ ...copy, to: on ? copy.to.filter((x) => x !== d) : [...copy.to, d] })} className={cx("rounded-full border px-3 py-1 text-[13px] font-medium capitalize", on ? "border-brand bg-brand text-white" : "border-line")}>
                      {weekdayName(d, "short")}
                    </button>
                  );
                })}
              </div>
            </div>
            <Switch checked={copy.replace} onChange={(v) => setCopy({ ...copy, replace: v })} label={t("mgmt.schedule.replace")} description={t("mgmt.week.replaceHint")} />
          </div>
        )}
      </Dialog>
    </>
  );
}

/** A day in the week grid. Dropping on an empty spot starts a new slot there (snapped to 15 minutes). */
function DayColumn({ canEdit, className, onClick, onDropAt, preview, children }: { canEdit: boolean; className: string; onClick: (e: React.MouseEvent<HTMLDivElement>) => void; onDropAt: (startMin: number, p: LibraryPayload) => void; preview: LibraryPayload | null; children: ReactNode }) {
  const { t } = useTranslation();
  const [at, setAt] = useState<number | null>(null);
  const minuteAt = (e: React.DragEvent<HTMLDivElement>) => Math.min(1440 - 15, Math.max(0, Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR_PX / 0.25) * 15));
  const onSlot = (e: React.DragEvent) => !!(e.target as HTMLElement).closest("[data-slot]");
  const { props } = useDrop(
    (p, e) => {
      if (p.kind === "row" || onSlot(e)) return;
      onDropAt(minuteAt(e as React.DragEvent<HTMLDivElement>), p);
    },
    (p) => canEdit && p.kind !== "row",
  );
  const durMin = preview ? Math.max(15, Math.ceil(payloadDuration(preview) / 300_000) * 5) : 60;
  return (
    <div
      className={className}
      onClick={onClick}
      {...props}
      onDragOver={(e) => {
        if (onSlot(e)) return setAt(null);
        props.onDragOver(e);
        if (e.defaultPrevented) {
          const m = minuteAt(e);
          if (m !== at) setAt(m);
        }
      }}
      onDragLeave={(e) => {
        props.onDragLeave(e);
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAt(null);
      }}
      onDrop={(e) => {
        setAt(null);
        props.onDrop(e);
      }}
    >
      {children}
      {at != null && preview && (
        <div className="pointer-events-none absolute right-1 left-1 z-20 rounded-md border-2 border-dashed border-brand bg-brand/10 px-2 py-1 text-[11px] font-semibold text-brand" style={{ top: (at / 60) * HOUR_PX, height: Math.max(20, (durMin / 60) * HOUR_PX) }}>
          {fmtMinutes(at)} · {t("mgmt.bin.newSlot")}
        </div>
      )}
    </div>
  );
}

/** A slot in the week grid that takes clips and blocks: they go into the rundown of a date (chosen in a dialog). */
function SlotButton({ canDrop, onDropPayload, children, ...rest }: { canDrop: boolean; onDropPayload: (p: LibraryPayload) => void; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { over, props } = useDrop((p) => p.kind !== "row" && onDropPayload(p), (p) => canDrop && p.kind !== "row");
  return (
    <button data-slot {...rest} {...props} className={cx(rest.className, over && "z-20 ring-2 ring-brand ring-offset-1 brightness-110")}>
      {children}
      {over && (
        <span className="absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white">
          <MousePointerClick className="size-3" />
          <DropLabel />
        </span>
      )}
    </button>
  );
}
const DropLabel = () => {
  const { t } = useTranslation();
  return <>{t("mgmt.bin.dropOnSlot")}</>;
};

interface OccRow {
  slotId: number;
  date: string;
  startAt: string;
  endAt: string;
  state: "block" | "manual" | "auto" | "empty";
  ready: boolean;
  capacityMs: number;
  filledMs: number;
}
/** Which date of a recurring slot gets the dropped clips. */
function DropDialog({ slot, payload, title, channelId, onClose, onDone }: { slot: Slot; payload: LibraryPayload; title: string; channelId: number; onClose: () => void; onDone: (text: string, to: string) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = isoDay(new Date());
  const list = useGet<{ occurrences: OccRow[] }>(`/api/week/occurrences?channel=${channelId}&from=${today}&days=29`);
  const next = (list.data?.occurrences ?? []).filter((o) => o.slotId === slot.id && Date.parse(o.endAt) > Date.now()).slice(0, 4);
  const add = payloadDuration(payload);
  const n = payload.kind === "media" ? payload.media.length : 1;
  const label = payload.kind === "media" ? (n > 1 ? t("mgmt.bin.clips", { n }) : payload.media[0]!.title || payload.media[0]!.name) : payload.block.name;
  const go = async (o: OccRow) => {
    setBusy(o.date);
    setErr(null);
    try {
      const items = payload.kind === "media" ? payload.media.map((m) => ({ type: "media" as const, mediaId: m.id })) : [{ type: "block" as const, childBlockId: payload.block.id }];
      await post(`/api/week/occurrences/${slot.id}/${o.date}/append`, { items });
      onDone(t("mgmt.bin.added", { what: label, date: fmtDate(new Date(`${o.date}T12:00:00`)) }), `/rundowns/${slot.id}/${o.date}`);
    } catch (e) {
      setErr(errorText(t, e));
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mgmt.bin.whichDate", { what: label })}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t("mgmt.bin.whichDateHint", { title, d: fmtDuration(add) })}</p>
        {err && <Alert tone="danger">{err}</Alert>}
        <ul className="divide-y divide-line rounded-md border border-line">
          {next.map((o) => {
            const free = o.capacityMs - o.filledMs;
            const fits = o.state === "block" ? null : add <= free + 2000;
            return (
              <li key={o.date} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium capitalize">{fmtDate(new Date(`${o.date}T12:00:00`))}</span>
                  <span className="block text-xs text-muted">
                    {fmtTime(o.startAt)}–{fmtTime(o.endAt)} · {t(`mgmt.rundowns.state_${o.state}`)} · {fmtDuration(o.filledMs)} / {fmtDuration(o.capacityMs)}
                  </span>
                  {o.state === "block" && <span className="block text-xs text-warn">{t("mgmt.bin.becomesOwn")}</span>}
                  {fits === false && <span className="block text-xs text-warn">{t("mgmt.bin.noRoom", { d: fmtDuration(Math.max(0, free)) })}</span>}
                </span>
                <Button size="sm" disabled={!!busy} onClick={() => void go(o)}>
                  {busy === o.date ? "…" : t("common.add")}
                </Button>
              </li>
            );
          })}
          {list.data && !next.length && <li className="px-3 py-6 text-center text-sm text-muted">{t("mgmt.bin.noDates")}</li>}
        </ul>
      </div>
    </Dialog>
  );
}
