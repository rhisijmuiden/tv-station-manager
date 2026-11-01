import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Switch, Textarea, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { CalendarRange, Clock3, Copy, Plus, Send, Tags, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChannelTabs } from "../components/ChannelPicker";
import { ClockRing } from "../components/ClockRing";
import { errorText, fmtDateTime, fmtDuration, fmtMinutes, parseMinutes, useCategories, useChannelSelection, useChannels, useGet, weekdayName, type BlockSummary, type HourClock } from "../lib";

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
  const publish = async () => {
    if (!data) return;
    const r = await post<{ planned: number }>("/api/week/publish", { channelId: data.channel.id });
    setNotice(t("mgmt.week.published", { n: r.planned }));
    void week.reload();
  };

  const newSlot = (weekday: number, hour = 18) => setForm({ weekdays: [weekday], start: fmtMinutes(hour * 60), duration: "01:00", content: "category", categoryId: categories?.[0]?.id ?? "", blockId: "", clockMode: "channel", clockId: "", title: "", description: "", inEpg: true });
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
                  <div
                    key={d}
                    className={cx("relative border-l border-line", d === todayWd && "bg-brand/[0.03]", canEdit && "cursor-copy")}
                    onClick={(e) => {
                      if (!canEdit || e.target !== e.currentTarget) return;
                      const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                      newSlot(d, Math.min(23, Math.max(0, Math.floor(y / HOUR_PX))));
                    }}
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
                        <button
                          key={`${s.id}${cont ? "c" : ""}`}
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
                        </button>
                      );
                    })}
                  </div>
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
