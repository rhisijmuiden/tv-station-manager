import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Switch, cx, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarRange, Check, CheckCircle2, Clapperboard, Clock3, Film, GripVertical, MousePointerClick, PartyPopper, Plus, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { distribute, occurrenceParts, overlaps } from "../../server/hourclock";
import { ClockRing } from "../components/ClockRing";
import { ChannelTabs } from "../components/ChannelPicker";
import { indicatorClass, payloadItems, useDrop, useDropList, type DragPayload } from "../components/dnd";
import { WithMediaBin } from "../components/MediaBin";
import { errorText, fmtDuration, fmtMinutes, useCategories, useChannelSelection, useChannels, useGet, weekdayName, type BlockSummary, type HourClock } from "../lib";
import { ColorPicker } from "./Categories";
import { DayPicker, type Slot } from "./Week";

type LibraryPayload = Exclude<DragPayload, { kind: "row" }>;
interface Item {
  type: "media" | "block";
  mediaId?: number;
  childBlockId?: number;
  label: string;
  sub?: string;
  durationMs: number;
}
interface WeekData {
  channel: { id: number; name: string; clockId: number | null; weekEnabled: boolean };
  slots: Slot[];
}

const MIN = 60_000;
const LENGTHS = [30, 60, 90, 120];
const STEPS = ["basics", "fill", "plan", "check"] as const;
type Step = (typeof STEPS)[number];
/** Start times every quarter of an hour. */
const TIMES = Array.from({ length: 96 }, (_, i) => i * 15);

/**
 * Step-by-step wizard for editors: make an hour block (name, subject, length), fill it by dragging clips into the
 * hour, choose the days and time it runs, check and save. Saving makes a TV block and the week slots for it.
 */
export function NewHourPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { channels } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const { categories } = useCategories();
  const clocks = useGet<{ clocks: HourClock[] }>("/api/clocks");
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks");
  const week = useGet<WeekData>(channel ? `/api/week?channel=${channel.id}` : null);

  const [step, setStep] = useState<Step>("basics");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [color, setColor] = useState("#3B6CFF");
  const [colorTouched, setColorTouched] = useState(false);
  const [lengthMin, setLengthMin] = useState(60);
  const [clockChoice, setClockChoice] = useState<"channel" | "none" | number>("channel");
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState(true);
  const [weekdays, setWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [startMin, setStartMin] = useState(18 * 60);
  const [turnOn, setTurnOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ blockId: number; planned: number } | null>(null);

  const clockById = useMemo(() => new Map((clocks.data?.clocks ?? []).map((c) => [c.id, c])), [clocks.data]);
  const channelClock = week.data?.channel.clockId != null ? clockById.get(week.data.channel.clockId) : undefined;
  const clock = clockChoice === "none" ? undefined : clockChoice === "channel" ? channelClock : clockById.get(clockChoice);

  // The shape of the hour: fixed parts of the clock and the room for programmes, from the chosen start time.
  const parts = useMemo(() => occurrenceParts(0, lengthMin * MIN, clock?.layout ?? null, startMin % 60), [clock, lengthMin, startMin]);
  const timeline = useMemo(
    () =>
      [...parts.fixed.map((f) => ({ type: "fixed" as const, start: f.start, end: f.end, title: f.title, blockId: f.blockId })), ...parts.windows.map((w) => ({ type: "window" as const, start: w.start, end: w.end }))].sort((a, b) => a.start - b.start),
    [parts],
  );
  const capacity = parts.windows.reduce((s, w) => s + (w.end - w.start), 0);
  const total = items.reduce((s, i) => s + i.durationMs, 0);
  const preview = useMemo(() => distribute(items.map((i) => i.durationMs), parts.windows), [items, parts]);
  const usedCount = preview.placements.reduce((s, p) => s + p.take, 0);
  const free = capacity - total;
  const at = (ms: number) => fmtMinutes(Math.round(startMin + ms / MIN) % 1440);

  const clashes = useMemo(() => {
    if (!plan) return [];
    const slots = week.data?.slots ?? [];
    return weekdays.flatMap((wd) => slots.filter((o) => overlaps({ weekday: o.weekday, startMin: o.startMin, durationMin: o.durationMin }, { weekday: wd, startMin, durationMin: lengthMin })).map((o) => ({ day: wd, slot: o })));
  }, [plan, weekdays, startMin, lengthMin, week.data]);

  const add = (p: LibraryPayload, pos?: number) => {
    const add: Item[] = payloadItems(p).map((d) =>
      d.type === "media" ? { type: "media", mediaId: d.mediaId, label: d.media.title || d.media.name, sub: d.media.folder, durationMs: d.media.durationMs ?? 0 } : { type: "block", childBlockId: d.childBlockId, label: d.block.name, durationMs: d.block.durationMs },
    );
    setItems((cur) => {
      const i = pos ?? cur.length;
      return [...cur.slice(0, i), ...add, ...cur.slice(i)];
    });
    // A first clip with a subject gives the hour its name and subject, when those are still empty.
    if (p.kind === "media" && p.media[0]) {
      const m = p.media[0];
      if (!categoryId && m.categoryId) pickCategory(m.categoryId);
    }
  };
  const move = (from: number, to: number) =>
    setItems((cur) => {
      const n = [...cur];
      const [x] = n.splice(from, 1);
      n.splice(to, 0, x!);
      return n;
    });
  const dnd = useDropList({ list: "new-hour", length: items.length, onInsert: (i, p) => add(p, i), onMove: move });
  const pickCategory = (id: number | "") => {
    setCategoryId(id);
    const c = categories?.find((x) => x.id === id);
    if (c && !colorTouched) setColor(c.color);
  };

  const canNext: Record<Step, boolean> = {
    basics: !!name.trim() && !!channel,
    fill: items.length > 0,
    plan: !plan || (weekdays.length > 0 && !clashes.length),
    check: true,
  };
  const idx = STEPS.indexOf(step);
  const go = (d: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, idx + d))]!);

  const save = async () => {
    if (!channel) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ id: number }>("/api/blocks", {
        name: name.trim(),
        kind: "program",
        color,
        categoryId: categoryId || null,
        items: items.map((i) => (i.type === "media" ? { type: "media", mediaId: i.mediaId } : { type: "block", childBlockId: i.childBlockId })),
      });
      let planned = 0;
      if (plan && weekdays.length) {
        const s = await post<{ ids: number[] }>("/api/week/slots", {
          channelId: channel.id,
          weekdays,
          startMin,
          durationMin: lengthMin,
          blockId: r.id,
          clockMode: clockChoice === "channel" ? "channel" : clockChoice === "none" ? "none" : "clock",
          clockId: typeof clockChoice === "number" ? clockChoice : null,
          inEpg: true,
        });
        planned = s.ids.length;
        if (turnOn && week.data && !week.data.channel.weekEnabled) await put(`/api/week/channels/${channel.id}`, { weekEnabled: true, clockId: week.data.channel.clockId });
      }
      setDone({ blockId: r.id, planned });
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const restart = () => {
    setDone(null);
    setStep("basics");
    setName("");
    setItems([]);
    setErr(null);
    void week.reload();
  };

  if (!canEdit)
    return (
      <>
        <PageHeader title={t("mgmt.newHour.title")} />
        <Alert tone="warn">{t("mgmt.newHour.editorsOnly")}</Alert>
      </>
    );

  if (done)
    return (
      <>
        <PageHeader title={t("mgmt.newHour.title")} />
        <Card className="mx-auto max-w-xl">
          <CardBody className="space-y-4 py-10 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full bg-ok/12 text-ok">
              <PartyPopper className="size-7" />
            </span>
            <h2 className="text-xl font-semibold">{t("mgmt.newHour.doneTitle", { name })}</h2>
            <p className="text-sm text-muted">{done.planned ? t("mgmt.newHour.donePlanned", { days: weekdays.map((d) => weekdayName(d)).join(", "), time: fmtMinutes(startMin) }) : t("mgmt.newHour.doneNotPlanned")}</p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Link to="/week">
                <Button icon={<CalendarRange className="size-4" />}>{t("mgmt.newHour.toWeek")}</Button>
              </Link>
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={restart}>
                {t("mgmt.newHour.another")}
              </Button>
              <Link to={`/blocks/${done.blockId}`}>
                <Button variant="ghost">{t("mgmt.newHour.openBlock")}</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </>
    );

  const stepper = (
    <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STEPS.map((s, i) => {
        const state = i < idx ? "done" : i === idx ? "now" : "todo";
        const reachable = i <= idx || STEPS.slice(0, i).every((x) => canNext[x]);
        return (
          <li key={s}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => setStep(s)}
              className={cx(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                state === "now" ? "border-brand bg-brand/8 ring-1 ring-brand" : state === "done" ? "border-ok/40 bg-ok/5 hover:border-ok" : "border-line bg-surface hover:border-brand/40",
              )}
            >
              <span className={cx("grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold", state === "now" ? "bg-brand text-white" : state === "done" ? "bg-ok text-white" : "bg-surface-2 text-muted")}>{state === "done" ? <Check className="size-4" /> : i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{t(`mgmt.newHour.step_${s}`)}</span>
                <span className="block truncate text-xs text-muted">{t(`mgmt.newHour.step_${s}Hint`)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  const nav = (
    <div className="mt-6 flex items-center gap-2">
      {idx > 0 && (
        <Button variant="secondary" icon={<ArrowLeft className="size-4" />} onClick={() => go(-1)}>
          {t("mgmt.newHour.back")}
        </Button>
      )}
      <span className="flex-1" />
      {step === "check" ? (
        <Button icon={<CheckCircle2 className="size-4" />} disabled={busy} onClick={() => void save()}>
          {busy ? "…" : plan ? t("mgmt.newHour.saveAndPlan") : t("mgmt.newHour.save")}
        </Button>
      ) : (
        <Button disabled={!canNext[step]} onClick={() => go(1)}>
          {t("mgmt.newHour.next")} <ArrowRight className="ml-1 inline size-4" />
        </Button>
      )}
    </div>
  );

  const ring = (size: number) =>
    clock ? (
      <ClockRing layout={clock.layout} size={size} colors={(i) => (clock.items[i]?.kind === "program" ? "var(--color-brand)" : (clock.items[i]?.blockColor ?? undefined))} />
    ) : (
      <div className="grid place-items-center rounded-full border-[14px] border-brand/20 text-center text-xs text-muted" style={{ width: size, height: size }}>
        {t("mgmt.newHour.allProgramme")}
      </div>
    );

  const body: Record<Step, ReactNode> = {
    basics: (
      <Card>
        <CardHeader icon={<Clapperboard className="size-4" />} title={t("mgmt.newHour.step_basics")} description={t("mgmt.newHour.basicsIntro")} />
        <CardBody className="space-y-5">
          {channels && channels.length > 1 && (
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.newHour.channel")}</p>
              <ChannelTabs channels={channels} value={channel} onChange={setChannel} />
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("mgmt.newHour.name")} hint={t("mgmt.newHour.nameHint")}>
              {(id) => <Input id={id} autoFocus value={name} placeholder={t("mgmt.newHour.namePlaceholder")} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label={t("mgmt.newHour.subject")} hint={t("mgmt.newHour.subjectHint")}>
              {(id) => (
                <Select id={id} value={categoryId} onChange={(e) => pickCategory(Number(e.target.value) || "")}>
                  <option value="">{t("mgmt.newHour.noSubject")}</option>
                  {categories?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-medium">{t("mgmt.newHour.length")}</p>
            <div className="flex flex-wrap gap-2">
              {LENGTHS.map((m) => (
                <button key={m} type="button" onClick={() => setLengthMin(m)} className={cx("rounded-lg border px-4 py-2 text-sm font-medium transition", lengthMin === m ? "border-brand bg-brand text-white" : "border-line hover:border-brand/50")}>
                  {t(`mgmt.newHour.len_${m}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid items-start gap-5 md:grid-cols-[1fr_auto]">
            <div>
              <p className="mb-1 text-[13px] font-medium">{t("mgmt.newHour.fixedParts")}</p>
              <p className="mb-3 text-xs text-muted">
                {t("mgmt.newHour.fixedPartsHint")}{" "}
                <Link to="/clocks/new" className="font-medium text-brand hover:underline">
                  {t("mgmt.newHour.ownClock")}
                </Link>
              </p>
              <div className="grid gap-2">
                {[
                  { v: "channel" as const, title: channelClock ? t("mgmt.newHour.clockChannel", { name: channelClock.name }) : t("mgmt.newHour.clockChannelNone"), sub: channelClock ? t("mgmt.newHour.clockRoom", { d: fmtDuration(channelClock.layout.programMs) }) : t("mgmt.newHour.allProgrammeHint") },
                  ...(clocks.data?.clocks ?? []).filter((c) => c.id !== channelClock?.id).map((c) => ({ v: c.id, title: c.name, sub: t("mgmt.newHour.clockRoom", { d: fmtDuration(c.layout.programMs) }) })),
                  { v: "none" as const, title: t("mgmt.newHour.clockNone"), sub: t("mgmt.newHour.allProgrammeHint") },
                ].map((o) => (
                  <button key={String(o.v)} type="button" onClick={() => setClockChoice(o.v)} className={cx("rounded-lg border px-3 py-2.5 text-left transition", clockChoice === o.v ? "border-brand bg-brand/5 ring-1 ring-brand" : "border-line hover:border-brand/50")}>
                    <span className="block text-sm font-semibold">{o.title}</span>
                    <span className="block text-xs text-muted">{o.sub}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
              {ring(170)}
              <p className="max-w-44 text-xs text-muted">{t("mgmt.newHour.roomTotal", { d: fmtDuration(capacity), len: t(`mgmt.newHour.len_${lengthMin}`) })}</p>
            </div>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-medium">{t("mgmt.blocks.color")}</p>
            <ColorPicker value={color} onChange={(c) => (setColor(c), setColorTouched(true))} />
          </div>
        </CardBody>
      </Card>
    ),
    fill: (
      <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="self-start">
          <CardHeader
            icon={<MousePointerClick className="size-4" />}
            title={t("mgmt.newHour.fillTitle", { name })}
            description={t("mgmt.newHour.fillIntro")}
            actions={<FreeBadge free={free} />}
          />
          <CardBody className="space-y-3">
            <FillMeter used={total} capacity={capacity} />
            <ol {...dnd.listProps} className={cx("min-h-40 divide-y divide-line rounded-lg border-2 border-dashed transition", dnd.indicator != null ? "border-brand bg-brand/5" : "border-line")}>
              {items.map((it, i) => {
                const out = i >= usedCount;
                return (
                  <li key={i} {...dnd.rowProps(i, it.label)} className={cx("flex cursor-grab items-center gap-3 bg-surface px-3 py-2 text-sm active:cursor-grabbing", out && "bg-danger/5", indicatorClass(dnd.indicator, i, items.length))}>
                    <GripVertical className="-mr-1 size-3.5 shrink-0 text-muted/50" />
                    <span className={cx("w-12 font-mono text-xs", out ? "text-danger" : "text-muted")}>{out ? "—" : at(startOf(preview, parts.windows, items, i))}</span>
                    <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", it.type === "block" ? "bg-warn/15 text-warn" : "bg-brand/10 text-brand")}>{it.type === "block" ? <Film className="size-3.5" /> : <Clapperboard className="size-3.5" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{it.label}</span>
                      {it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}
                    </span>
                    {!it.durationMs && <AlertTriangle className="size-4 shrink-0 text-warn" aria-label={t("mgmt.warnings.no_duration")} />}
                    {out && <Badge tone="danger">{t("mgmt.rundowns.doesNotFit")}</Badge>}
                    <span className="w-16 text-right font-mono text-xs text-muted">{fmtDuration(it.durationMs)}</span>
                    <span className="flex shrink-0">
                      <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t("mgmt.newHour.up")}>
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={t("mgmt.newHour.down")}>
                        <ArrowDown className="size-3.5" />
                      </button>
                      <button className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
                        <X className="size-3.5" />
                      </button>
                    </span>
                  </li>
                );
              })}
              {!items.length && (
                <li className={cx("px-4 py-14 text-center text-sm", dnd.indicator != null ? "text-brand" : "text-muted")}>
                  <MousePointerClick className="mx-auto mb-2 size-7" />
                  <span className="block font-medium">{t("mgmt.newHour.dropFirst")}</span>
                  <span className="mt-1 block text-xs">{t("mgmt.newHour.dropFirstHint")}</span>
                </li>
              )}
            </ol>
            {preview.overflowCount > 0 && <Alert tone="danger">{t("mgmt.newHour.tooMuch", { n: preview.overflowCount, d: fmtDuration(preview.overflowMs) })}</Alert>}
          </CardBody>
        </Card>
        <Card className="self-start">
          <CardHeader icon={<Clock3 className="size-4" />} title={t("mgmt.newHour.hourTitle")} description={t("mgmt.newHour.hourIntro", { time: fmtMinutes(startMin) })} />
          <ol className="px-4 py-3">
            {timeline.map((p, pi) => {
              if (p.type === "fixed")
                return (
                  <li key={pi} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="w-11 font-mono text-xs text-muted">{at(p.start)}</span>
                    <span className="size-2.5 shrink-0 rounded-full bg-muted/60" />
                    <span className="flex-1 truncate text-muted">{p.title || blocks.data?.blocks.find((b) => b.id === p.blockId)?.name || t("mgmt.newHour.fixedPart")}</span>
                    <span className="font-mono text-[11px] text-muted">{fmtDuration(p.end - p.start)}</span>
                  </li>
                );
              const wi = parts.windows.findIndex((w) => w.start === p.start);
              const pl = preview.placements[wi];
              let cursor = p.start;
              return (
                <WindowDrop key={pi} onDrop={(x) => add(x, pl ? pl.skip + pl.take : undefined)}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold">
                      {at(p.start)}–{at(p.end)}
                    </span>
                    <span className="flex-1 text-muted">{t("mgmt.newHour.room")}</span>
                    <span className="font-mono text-muted">
                      {fmtDuration(pl?.usedMs ?? 0)} / {fmtDuration(p.end - p.start)}
                    </span>
                  </div>
                  <FillMeter used={pl?.usedMs ?? 0} capacity={p.end - p.start} thin />
                  <ul className="mt-1.5 space-y-0.5">
                    {pl &&
                      items.slice(pl.skip, pl.skip + pl.take).map((it, k) => {
                        const s = cursor;
                        cursor += it.durationMs;
                        return (
                          <li key={k} className="flex items-center gap-2 text-[12.5px]">
                            <span className="w-11 font-mono text-[11px] text-muted">{at(s)}</span>
                            <span className="flex-1 truncate">{it.label}</span>
                          </li>
                        );
                      })}
                    {(!pl || !pl.take) && <li className="text-[12.5px] text-muted italic">{t("mgmt.newHour.dropHere")}</li>}
                  </ul>
                </WindowDrop>
              );
            })}
          </ol>
        </Card>
      </div>
    ),
    plan: (
      <Card>
        <CardHeader icon={<CalendarRange className="size-4" />} title={t("mgmt.newHour.step_plan")} description={t("mgmt.newHour.planIntro")} />
        <CardBody className="space-y-5">
          <Switch checked={plan} onChange={setPlan} label={t("mgmt.newHour.planNow")} description={t("mgmt.newHour.planNowHint")} />
          {plan && (
            <>
              <DayPicker value={weekdays} onChange={setWeekdays} label={t("mgmt.newHour.whichDays")} />
              <Field label={t("mgmt.newHour.startTime")} hint={t("mgmt.newHour.startTimeHint", { end: fmtMinutes(startMin + lengthMin) })}>
                {(id) => (
                  <Select id={id} className="max-w-40" value={startMin} onChange={(e) => setStartMin(Number(e.target.value))}>
                    {TIMES.map((m) => (
                      <option key={m} value={m}>
                        {fmtMinutes(m)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <WeekStrip slots={week.data?.slots ?? []} weekdays={weekdays} startMin={startMin} lengthMin={lengthMin} color={color} name={name} />
              {clashes.length > 0 && (
                <Alert tone="danger">
                  {t("mgmt.newHour.clash")}{" "}
                  {clashes.map((c) => `${weekdayName(c.day)} ${fmtMinutes(c.slot.startMin)}–${fmtMinutes(c.slot.startMin + c.slot.durationMin)}`).join(", ")}
                </Alert>
              )}
            </>
          )}
        </CardBody>
      </Card>
    ),
    check: (
      <Card>
        <CardHeader icon={<CheckCircle2 className="size-4" />} title={t("mgmt.newHour.step_check")} description={t("mgmt.newHour.checkIntro")} />
        <CardBody className="space-y-4">
          {err && <Alert tone="danger">{err}</Alert>}
          <div className="flex flex-col gap-6 sm:flex-row">
            <div className="flex flex-col items-center gap-2">{ring(140)}</div>
            <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <Row label={t("mgmt.newHour.name")} value={<span className="flex items-center gap-2"><span className="size-3 rounded-full" style={{ background: color }} />{name}</span>} edit={() => setStep("basics")} />
              <Row label={t("mgmt.newHour.subject")} value={categories?.find((c) => c.id === categoryId)?.name ?? t("mgmt.newHour.noSubject")} edit={() => setStep("basics")} />
              <Row label={t("mgmt.newHour.length")} value={`${t(`mgmt.newHour.len_${lengthMin}`)} · ${clock ? clock.name : t("mgmt.newHour.clockNone")}`} edit={() => setStep("basics")} />
              <Row
                label={t("mgmt.newHour.content")}
                value={
                  <span>
                    {t("mgmt.newHour.contentSummary", { n: items.length, d: fmtDuration(total), room: fmtDuration(capacity) })} <FreeBadge free={free} />
                  </span>
                }
                edit={() => setStep("fill")}
              />
              <Row
                label={t("mgmt.newHour.when")}
                value={plan ? t("mgmt.newHour.whenSummary", { days: weekdays.map((d) => weekdayName(d, "short")).join(", "), from: fmtMinutes(startMin), to: fmtMinutes(startMin + lengthMin) }) : t("mgmt.newHour.notPlanned")}
                edit={() => setStep("plan")}
              />
            </dl>
          </div>
          {preview.overflowCount > 0 && <Alert tone="warn">{t("mgmt.newHour.tooMuch", { n: preview.overflowCount, d: fmtDuration(preview.overflowMs) })}</Alert>}
          {free > 5 * MIN && <Alert tone="warn">{t("mgmt.newHour.tooLittle", { d: fmtDuration(free) })}</Alert>}
          {plan && week.data && !week.data.channel.weekEnabled && <Switch checked={turnOn} onChange={setTurnOn} label={t("mgmt.newHour.turnOn", { channel: week.data.channel.name })} description={t("mgmt.newHour.turnOnHint")} />}
        </CardBody>
      </Card>
    ),
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.newHour.title")}
        description={t("mgmt.newHour.intro")}
        actions={
          <Button variant="ghost" onClick={() => navigate("/week")}>
            {t("common.cancel")}
          </Button>
        }
      />
      {channels && !channels.length ? (
        <Alert tone="warn">{t("mgmt.control.noChannelsIntro")}</Alert>
      ) : step === "fill" ? (
        <WithMediaBin onAdd={(p) => add(p)} categoryId={categoryId || null} hint={t("mgmt.newHour.binHint")}>
          {stepper}
          {body.fill}
          {nav}
        </WithMediaBin>
      ) : (
        <div className="mx-auto max-w-4xl">
          {stepper}
          {body[step]}
          {nav}
        </div>
      )}
    </>
  );
}

/** Start (ms from the start of the hour block) of item `i` in the preview. */
function startOf(preview: ReturnType<typeof distribute>, windows: { start: number }[], items: Item[], i: number) {
  const p = preview.placements.find((x) => i >= x.skip && i < x.skip + x.take);
  if (!p) return 0;
  return windows[p.window]!.start + items.slice(p.skip, i).reduce((s, x) => s + x.durationMs, 0);
}

function FreeBadge({ free }: { free: number }) {
  const { t } = useTranslation();
  if (Math.abs(free) <= 2000) return <Badge tone="ok">{t("mgmt.newHour.full")}</Badge>;
  return free > 0 ? <Badge tone="warn">{t("mgmt.newHour.free", { d: fmtDuration(free) })}</Badge> : <Badge tone="danger">{t("mgmt.newHour.over", { d: fmtDuration(-free) })}</Badge>;
}

function FillMeter({ used, capacity, thin }: { used: number; capacity: number; thin?: boolean }) {
  const pct = capacity ? Math.min(100, (used / capacity) * 100) : 0;
  const over = used > capacity + 2000;
  return (
    <div className={cx("w-full overflow-hidden rounded-full bg-surface-2", thin ? "h-1.5" : "h-2.5")}>
      <div className={cx("h-full rounded-full transition-all", over ? "bg-danger" : pct >= 97 ? "bg-ok" : "bg-brand")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function WindowDrop({ onDrop, children }: { onDrop: (p: LibraryPayload) => void; children: ReactNode }) {
  const { over, props } = useDrop((p) => p.kind !== "row" && onDrop(p));
  return (
    <li {...props} className={cx("my-2 rounded-lg border p-2.5 transition", over ? "border-brand bg-brand/10 ring-2 ring-brand/30" : "border-brand/30 bg-brand/[0.04]")}>
      {children}
    </li>
  );
}

function Row({ label, value, edit }: { label: string; value: ReactNode; edit: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-start justify-between gap-3">
        <span className="font-medium">{value}</span>
        <button type="button" onClick={edit} className="shrink-0 text-xs font-medium text-brand hover:underline">
          {t("common.edit")}
        </button>
      </dd>
    </>
  );
}

/** The chosen days and time against what already runs on the channel, around the new block. */
function WeekStrip({ slots, weekdays, startMin, lengthMin, color, name }: { slots: Slot[]; weekdays: number[]; startMin: number; lengthMin: number; color: string; name: string }) {
  const { t } = useTranslation();
  const from = Math.max(0, Math.floor(startMin / 60) - 2) * 60;
  const to = Math.min(1440, from + 6 * 60);
  const px = 0.6; // per minute
  const y = (m: number) => (Math.max(from, Math.min(to, m)) - from) * px;
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium">{t("mgmt.newHour.preview")}</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <div className="grid min-w-[560px] grid-cols-[44px_repeat(7,1fr)]">
          <div />
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <div key={d} className={cx("border-l border-line px-2 py-1.5 text-center text-xs font-semibold capitalize", weekdays.includes(d) && "text-brand")}>
              {weekdayName(d, "short")}
            </div>
          ))}
          <div className="relative border-t border-line" style={{ height: (to - from) * px }}>
            {Array.from({ length: (to - from) / 60 }, (_, i) => (
              <span key={i} className="absolute right-1.5 font-mono text-[10px] text-muted" style={{ top: i * 60 * px }}>
                {fmtMinutes(from + i * 60)}
              </span>
            ))}
          </div>
          {[0, 1, 2, 3, 4, 5, 6].map((d) => (
            <div key={d} className="relative border-t border-l border-line" style={{ height: (to - from) * px }}>
              {slots
                .filter((s) => s.weekday === d && s.startMin < to && s.startMin + s.durationMin > from)
                .map((s) => (
                  <div key={s.id} className="absolute inset-x-0.5 overflow-hidden rounded bg-surface-2 px-1 text-[10px] text-muted" style={{ top: y(s.startMin), height: Math.max(8, y(s.startMin + s.durationMin) - y(s.startMin)) }}>
                    {s.title || fmtMinutes(s.startMin)}
                  </div>
                ))}
              {weekdays.includes(d) && (
                <div className="absolute inset-x-0.5 overflow-hidden rounded border-l-[3px] px-1 text-[10px] font-semibold" style={{ top: y(startMin), height: Math.max(8, y(startMin + lengthMin) - y(startMin)), borderColor: color, background: `color-mix(in srgb, ${color} 22%, var(--color-surface))` }}>
                  {name}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
