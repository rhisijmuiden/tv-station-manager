import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, Select, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Clapperboard, Film, Plus, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { distribute } from "../../server/hourclock";
import { ChannelTabs } from "../components/ChannelPicker";
import { MediaPicker } from "../components/MediaPicker";
import { addDays, errorText, fmtDate, fmtDuration, fmtTime, isoDay, startOfWeek, useCategories, useChannelSelection, useChannels, useGet, type BlockSummary } from "../lib";

interface OccSummary {
  key: string;
  slotId: number;
  date: string;
  startAt: string;
  endAt: string;
  title: string | null;
  categoryId: number | null;
  blockId: number | null;
  clockId: number | null;
  state: "block" | "manual" | "auto" | "empty";
  ready: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  capacityMs: number;
  filledMs: number;
  overflowMs: number;
  overflowCount: number;
  tooLong: number;
  warnings: number;
  itemCount: number;
}
interface Part {
  type: "fixed" | "window";
  startAt: string;
  endAt: string;
  start: number;
  end: number;
  title: string;
  blockId: number | null;
  usedMs?: number;
  tooLong?: boolean;
  items: { index: number; title: string; startAt: string; durationMs: number; warning?: string }[];
}
interface Detail {
  occurrence: OccSummary;
  parts: Part[];
  overflow: { title: string; durationMs: number }[];
  items: RawItem[];
}
interface RawItem {
  type: "media" | "block" | "live";
  mediaId: number | null;
  childBlockId: number | null;
  liveSourceId: number | null;
  durationMs: number | null;
  title: string | null;
  mediaName?: string | null;
  mediaTitle?: string | null;
  mediaPath?: string | null;
  mediaMissing?: boolean;
  childName?: string | null;
  liveName?: string | null;
  effectiveDurationMs: number | null;
}
interface Item {
  type: "media" | "block" | "live";
  mediaId?: number | null;
  childBlockId?: number | null;
  liveSourceId?: number | null;
  durationMs?: number | null;
  title?: string | null;
  label: string;
  sub?: string | null;
  effectiveDurationMs: number | null;
  warning?: string | null;
}
const toItem = (i: RawItem): Item => ({
  type: i.type,
  mediaId: i.mediaId,
  childBlockId: i.childBlockId,
  liveSourceId: i.liveSourceId,
  durationMs: i.durationMs,
  title: i.title,
  label: i.type === "media" ? i.mediaTitle || i.mediaName || "" : i.type === "block" ? i.childName || "" : i.liveName || "",
  sub: i.type === "media" ? i.mediaPath : null,
  effectiveDurationMs: i.effectiveDurationMs,
  warning: i.type === "media" ? (i.mediaMissing ? "missing" : i.effectiveDurationMs == null ? "no_duration" : null) : null,
});

const stateTone = { block: "neutral", manual: "brand", auto: "ok", empty: "warn" } as const;

function FillBar({ used, capacity, overflow }: { used: number; capacity: number; overflow?: number }) {
  const pct = capacity ? Math.min(100, (used / capacity) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cx("h-full rounded-full transition-all", overflow ? "bg-danger" : pct >= 97 ? "bg-ok" : pct > 70 ? "bg-brand" : "bg-warn")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function RundownsPage() {
  const params = useParams();
  if (params.slot && params.date) return <OccurrenceEditor slotId={Number(params.slot)} date={params.date} />;
  return <RundownList />;
}

function RundownList() {
  const { t } = useTranslation();
  const { channels } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const { categories } = useCategories();
  const [monday, setMonday] = useState(() => startOfWeek(new Date()));
  const list = useGet<{ occurrences: OccSummary[] }>(channel ? `/api/week/occurrences?channel=${channel.id}&from=${isoDay(monday)}&days=7` : null, 30000);
  const catById = new Map((categories ?? []).map((c) => [c.id, c]));
  const occs = list.data?.occurrences ?? [];
  const byDay = Array.from({ length: 7 }, (_, i) => isoDay(addDays(monday, i))).map((d) => ({ date: d, items: occs.filter((o) => o.date === d) }));
  const todo = occs.filter((o) => Date.parse(o.endAt) > Date.now() && (o.state === "empty" || (o.state !== "block" && !o.ready) || o.overflowCount > 0 || o.tooLong > 0));

  return (
    <>
      <PageHeader title={t("mgmt.rundowns.title")} description={t("mgmt.rundowns.intro")} />
      {channels && <ChannelTabs channels={channels} value={channel} onChange={setChannel} />}
      {channel && !channel.weekEnabled && (
        <Alert tone="warn" className="mb-4">
          {t("mgmt.rundowns.weekOff")}{" "}
          <Link to="/week" className="font-semibold underline">
            {t("mgmt.nav.week")}
          </Link>
        </Alert>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setMonday(addDays(monday, -7))} aria-label="previous week" />
          <span className="font-semibold">{t("mgmt.rundowns.weekOf", { date: fmtDate(monday) })}</span>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => setMonday(addDays(monday, 7))} aria-label="next week" />
          <Button size="sm" variant="secondary" onClick={() => setMonday(startOfWeek(new Date()))}>
            {t("mgmt.rundowns.thisWeek")}
          </Button>
          <span className="flex-1" />
          {list.data && (todo.length ? <Badge tone="warn">{t("mgmt.rundowns.todo", { n: todo.length })}</Badge> : occs.length > 0 && <Badge tone="ok">{t("mgmt.rundowns.allDone")}</Badge>)}
        </div>
        {byDay.map(({ date, items }) =>
          items.length ? (
            <div key={date}>
              <p className="border-b border-line bg-surface-2/50 px-5 py-2 text-xs font-semibold tracking-wide text-muted uppercase">{fmtDate(new Date(`${date}T12:00:00`))}</p>
              <ul className="divide-y divide-line">
                {items.map((o) => {
                  const cat = o.categoryId ? catById.get(o.categoryId) : undefined;
                  const past = Date.parse(o.endAt) < Date.now();
                  return (
                    <li key={o.key}>
                      <Link to={`/rundowns/${o.slotId}/${o.date}`} className={cx("flex flex-wrap items-center gap-4 px-5 py-3 transition hover:bg-surface-2/60", past && "opacity-60")}>
                        <span className="w-24 shrink-0 font-mono text-sm">
                          {fmtTime(o.startAt)}–{fmtTime(o.endAt)}
                        </span>
                        <span className="h-9 w-1 shrink-0 rounded-full" style={{ background: cat?.color ?? "#64748B" }} />
                        <span className="min-w-40 flex-1">
                          <span className="block truncate font-medium">{o.title || t("mgmt.week.editorial")}</span>
                          <span className="block truncate text-xs text-muted">
                            {cat?.name ?? (o.state === "block" ? t("mgmt.week.content_block") : t("mgmt.week.editorial"))}
                            {o.updatedBy && ` · ${t("mgmt.rundowns.by", { name: o.updatedBy })}`}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={stateTone[o.state]}>{t(`mgmt.rundowns.state_${o.state}`)}</Badge>
                          {o.ready && (
                            <Badge tone="ok">
                              <CheckCircle2 className="size-3" /> {t("mgmt.rundowns.ready")}
                            </Badge>
                          )}
                          {(o.overflowCount > 0 || o.tooLong > 0) && (
                            <Badge tone="danger">
                              <AlertTriangle className="size-3" /> {o.overflowCount > 0 ? t("mgmt.rundowns.overflow", { d: fmtDuration(o.overflowMs) }) : t("mgmt.rundowns.tooLong")}
                            </Badge>
                          )}
                          {o.warnings > 0 && <Badge tone="warn">{t("mgmt.schedule.warnings", { n: o.warnings })}</Badge>}
                        </span>
                        <span className="w-36 shrink-0">
                          <FillBar used={o.filledMs} capacity={o.capacityMs} overflow={o.overflowCount} />
                          <span className="mt-1 block text-right font-mono text-[11px] text-muted">
                            {fmtDuration(o.filledMs)} / {fmtDuration(o.capacityMs)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
        {list.data && !occs.length && (
          <CardBody className="py-14 text-center text-muted">
            <Clapperboard className="mx-auto mb-3 size-8" />
            {t("mgmt.rundowns.none")}{" "}
            <Link to="/week" className="font-medium text-brand hover:underline">
              {t("mgmt.nav.week")}
            </Link>
          </CardBody>
        )}
      </Card>
    </>
  );
}

function OccurrenceEditor({ slotId, date }: { slotId: number; date: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { categories } = useCategories();
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const load = async () => {
    const d = await get<Detail>(`/api/week/occurrences/${slotId}/${date}`);
    setDetail(d);
    setItems(d.occurrence.state === "block" ? null : d.items.map(toItem));
    setDirty(false);
  };
  useEffect(() => {
    setMsg(null);
    void load().catch((e) => setMsg({ tone: "danger", text: errorText(t, e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId, date]);

  const occ = detail?.occurrence;
  const cat = occ?.categoryId ? categories?.find((c) => c.id === occ.categoryId) : undefined;
  const windows = useMemo(() => (detail?.parts ?? []).filter((p) => p.type === "window"), [detail]);
  // Live preview of how the rundown fits the windows (the server does the same when it publishes).
  const preview = useMemo(() => (items ? distribute(items.map((i) => i.effectiveDurationMs ?? 0), windows.map((w) => ({ start: w.start, end: w.end }))) : null), [items, windows]);
  const total = (items ?? []).reduce((s, i) => s + (i.effectiveDurationMs ?? 0), 0);
  const capacity = windows.reduce((s, w) => s + (w.end - w.start), 0);

  const change = (next: Item[]) => {
    setItems(next);
    setDirty(true);
  };
  const move = (i: number, d: number) => {
    if (!items) return;
    const n = [...items];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x!);
    change(n);
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ tone: "ok", text: ok });
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const save = (ready: boolean) =>
    run(() => put(`/api/week/occurrences/${slotId}/${date}`, { ready, items: (items ?? []).map(({ type, mediaId, childBlockId, liveSourceId, durationMs, title }) => ({ type, mediaId, childBlockId, liveSourceId, durationMs, title })) }), ready ? t("mgmt.rundowns.savedReady") : t("common.saved"));
  const ownFromBlock = async () => {
    if (!occ?.blockId) return change([]);
    const b = await get<{ items: RawItem[] }>(`/api/blocks/${occ.blockId}`);
    change(b.items.map(toItem));
  };

  if (!detail || !occ)
    return (
      <>
        <PageHeader title={t("mgmt.rundowns.title")} />
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </>
    );

  // Which window (and start time) each rundown item lands in, from the live preview.
  const placedAt = new Map<number, { window: number; start: number }>();
  preview?.placements.forEach((p) => {
    let cursor = windows[p.window]!.start;
    for (let k = p.skip; k < p.skip + p.take; k++) {
      placedAt.set(k, { window: p.window, start: cursor });
      cursor += items?.[k]?.effectiveDurationMs ?? 0;
    }
  });
  const usedCount = preview ? preview.placements.reduce((s, p) => s + p.take, 0) : 0;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <button onClick={() => navigate("/rundowns")} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label={t("mgmt.rundowns.back")}>
              <ArrowLeft className="size-5" />
            </button>
            {occ.title || t("mgmt.week.editorial")}
          </span>
        }
        description={`${fmtDate(new Date(`${date}T12:00:00`))} · ${fmtTime(occ.startAt)}–${fmtTime(occ.endAt)}${cat ? ` · ${cat.name}` : ""}`}
        actions={
          canEdit && (
            <>
              {occ.categoryId && (
                <Button variant="secondary" icon={<Sparkles className="size-4" />} onClick={() => void run(() => post(`/api/week/occurrences/${slotId}/${date}/suggest`), t("mgmt.rundowns.suggested"))}>
                  {t("mgmt.rundowns.suggest")}
                </Button>
              )}
              {occ.state === "manual" && (
                <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => confirm(t("mgmt.rundowns.confirmReset")) && void run(() => del(`/api/week/occurrences/${slotId}/${date}`), t("mgmt.rundowns.reset"))}>
                  {t("mgmt.rundowns.resetButton")}
                </Button>
              )}
            </>
          )
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card className="self-start">
          <CardHeader
            icon={<Clapperboard className="size-4" />}
            title={t("mgmt.blocks.rundown")}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={stateTone[occ.state]}>{t(`mgmt.rundowns.state_${occ.state}`)}</Badge>
                {occ.ready && <Badge tone="ok">{t("mgmt.rundowns.ready")}</Badge>}
                <span>
                  {fmtDuration(total)} / {fmtDuration(capacity)}
                </span>
              </span>
            }
            actions={
              canEdit &&
              items && (
                <>
                  <Button size="sm" variant="secondary" icon={<Save className="size-3.5" />} onClick={() => void save(false)}>
                    {t("common.save")}
                  </Button>
                  <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={() => void save(true)}>
                    {t("mgmt.rundowns.saveReady")}
                  </Button>
                </>
              )
            }
          />
          <CardBody className="space-y-4">
            {!items ? (
              <div className="rounded-md border border-dashed border-line px-4 py-8 text-center">
                <p className="text-sm">{t("mgmt.rundowns.fixedBlock", { name: blocks.data?.blocks.find((b) => b.id === occ.blockId)?.name ?? "" })}</p>
                {canEdit && (
                  <div className="mt-3 flex justify-center gap-2">
                    <Link to={`/blocks/${occ.blockId}`}>
                      <Button size="sm" variant="secondary">
                        {t("mgmt.rundowns.editBlock")}
                      </Button>
                    </Link>
                    <Button size="sm" onClick={() => void ownFromBlock()}>
                      {t("mgmt.rundowns.ownForDate")}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <FillBar used={Math.min(total, capacity)} capacity={capacity} overflow={preview?.overflowCount} />
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setPicker(true)}>
                      {t("mgmt.blocks.addMedia")}
                    </Button>
                    <Select
                      className="h-8 w-auto! text-[13px]"
                      value=""
                      onChange={(e) => {
                        const b = blocks.data?.blocks.find((x) => x.id === Number(e.target.value));
                        if (b) change([...items, { type: "block", childBlockId: b.id, label: b.name, effectiveDurationMs: b.durationMs }]);
                      }}
                    >
                      <option value="">{t("mgmt.blocks.addBlock")}</option>
                      {blocks.data?.blocks.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.kind === "commercial" ? "📺 " : ""}
                          {b.name} ({fmtDuration(b.durationMs)})
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                <ol className="divide-y divide-line rounded-md border border-line">
                  {items.map((it, i) => {
                    const at = placedAt.get(i);
                    const out = i >= usedCount;
                    return (
                      <li key={i} className={cx("flex items-center gap-3 px-3 py-2 text-sm", out && "bg-danger/5")}>
                        <span className={cx("w-12 font-mono text-xs", out ? "text-danger" : "text-muted")}>{at ? fmtTime(at.start) : "—"}</span>
                        <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", it.type === "block" ? "bg-warn/15 text-warn" : "bg-brand/10 text-brand")}>{it.type === "block" ? <Film className="size-3.5" /> : <Clapperboard className="size-3.5" />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{it.title || it.label}</span>
                          {it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}
                        </span>
                        {it.warning && <AlertTriangle className="size-4 shrink-0 text-warn" aria-label={t(`mgmt.warnings.${it.warning}`)} />}
                        {out && <Badge tone="danger">{t("mgmt.rundowns.doesNotFit")}</Badge>}
                        <span className="w-16 text-right font-mono text-xs text-muted">{fmtDuration(it.effectiveDurationMs)}</span>
                        {canEdit && (
                          <span className="flex shrink-0">
                            <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="up">
                              <ArrowUp className="size-3.5" />
                            </button>
                            <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="down">
                              <ArrowDown className="size-3.5" />
                            </button>
                            <button className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger" onClick={() => change(items.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
                              <X className="size-3.5" />
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {!items.length && <li className="px-3 py-8 text-center text-sm text-muted">{t("mgmt.rundowns.emptyRundown")}</li>}
                </ol>
                <p className="text-xs text-muted">{t("mgmt.rundowns.help")}</p>
                {dirty && <p className="text-xs text-warn">{t("mgmt.blocks.unsaved")}</p>}
              </>
            )}
          </CardBody>
        </Card>

        <Card className="self-start">
          <CardHeader title={t("mgmt.rundowns.timeline")} description={t("mgmt.rundowns.timelineHint")} />
          <ol className="relative px-5 py-4">
            {detail.parts.map((p, pi) => {
              if (p.type === "fixed")
                return (
                  <li key={pi} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="w-12 font-mono text-xs text-muted">{fmtTime(p.startAt)}</span>
                    <span className="size-2.5 shrink-0 rounded-full bg-muted/60" />
                    <span className="flex-1 truncate text-muted">{p.title}</span>
                    <span className="font-mono text-[11px] text-muted">{fmtDuration(p.end - p.start)}</span>
                  </li>
                );
              const wi = windows.indexOf(p);
              const pl = preview?.placements[wi];
              const placed = items && pl ? items.slice(pl.skip, pl.skip + pl.take) : p.items.map((x) => ({ label: x.title, effectiveDurationMs: x.durationMs }) as Item);
              const used = pl ? pl.usedMs : (p.usedMs ?? 0);
              let cursor = p.start;
              return (
                <li key={pi} className="my-2 rounded-lg border border-brand/30 bg-brand/[0.04] p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold">
                      {fmtTime(p.startAt)}–{fmtTime(p.endAt)}
                    </span>
                    <span className="text-muted">{t("mgmt.clocks.program")}</span>
                    <span className="flex-1" />
                    <span className={cx("font-mono", used > p.end - p.start + 2000 ? "text-danger" : "text-muted")}>
                      {fmtDuration(used)} / {fmtDuration(p.end - p.start)}
                    </span>
                  </div>
                  <FillBar used={Math.min(used, p.end - p.start)} capacity={p.end - p.start} overflow={pl?.tooLong ? 1 : 0} />
                  <ul className="mt-2 space-y-1">
                    {placed.map((it, k) => {
                      const s = cursor;
                      cursor += it.effectiveDurationMs ?? 0;
                      return (
                        <li key={k} className="flex items-center gap-2 text-[13px]">
                          <span className="w-12 font-mono text-[11px] text-muted">{fmtTime(s)}</span>
                          <span className="flex-1 truncate">{it.title || it.label}</span>
                          <span className="font-mono text-[11px] text-muted">{fmtDuration(it.effectiveDurationMs)}</span>
                        </li>
                      );
                    })}
                    {!placed.length && <li className="text-[13px] text-muted italic">{t("mgmt.rundowns.windowEmpty")}</li>}
                    {pl && !pl.tooLong && placed.length > 0 && p.end - p.start - used > 60_000 && <li className="text-[11px] text-warn">{t("mgmt.rundowns.gap", { d: fmtDuration(p.end - p.start - used) })}</li>}
                    {pl?.tooLong && <li className="text-[11px] text-danger">{t("mgmt.rundowns.cut")}</li>}
                  </ul>
                </li>
              );
            })}
          </ol>
          {preview && preview.overflowCount > 0 && (
            <div className="border-t border-line px-5 py-3 text-xs text-danger">{t("mgmt.rundowns.overflowHint", { n: preview.overflowCount, d: fmtDuration(preview.overflowMs) })}</div>
          )}
        </Card>
      </div>
      <MediaPicker
        open={picker}
        onClose={() => setPicker(false)}
        categoryId={occ.categoryId}
        onPick={(ms) => change([...(items ?? []), ...ms.map((m) => ({ type: "media" as const, mediaId: m.id, label: m.title || m.name, sub: m.path, effectiveDurationMs: m.durationMs, warning: m.durationMs == null ? "no_duration" : null }))])}
      />
    </>
  );
}
