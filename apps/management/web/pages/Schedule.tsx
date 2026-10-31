import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, Textarea, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, CalendarPlus, ChevronLeft, ChevronRight, Copy, ListPlus, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChannelTabs } from "../components/ChannelPicker";
import { addDays, errorText, fmtDate, fmtDuration, fmtTime, isoDay, startOfDay, useChannelSelection, useChannels, useGet, type BlockSummary } from "../lib";

interface Entry {
  id: number;
  startAt: string;
  endAt: string;
  contentEndAt: string;
  blockId: number;
  block: { id: number; name: string; kind: string; color: string; genre: string } | null;
  title: string | null;
  programTitle: string;
  description: string | null;
  inEpg: boolean;
  overrunMs: number;
  gapAfterMs: number;
  warnings: number;
}
interface EntryForm {
  id?: number;
  date: string;
  time: string;
  blockId: number | "";
  title: string;
  description: string;
  inEpg: boolean;
}
const hhmmss = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
const toIso = (date: string, time: string) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  return new Date(y!, mo! - 1, d!, h ?? 0, mi ?? 0, s ?? 0).toISOString();
};

function DayBar({ entries, day }: { entries: Entry[]; day: Date }) {
  const from = day.getTime();
  const span = addDays(day, 1).getTime() - from;
  return (
    <div className="relative h-10 overflow-hidden rounded-md border border-line bg-surface-2">
      {entries.map((e) => {
        const s = Math.max(0, Date.parse(e.startAt) - from);
        const en = Math.min(span, Date.parse(e.endAt) - from);
        return <div key={e.id} title={`${fmtTime(e.startAt)} ${e.programTitle}`} className="absolute top-0 bottom-0 border-r border-surface" style={{ left: `${(s / span) * 100}%`, width: `${((en - s) / span) * 100}%`, background: e.block?.color ?? "var(--tvsm-primary)", opacity: 0.85 }} />;
      })}
      {Array.from({ length: 23 }, (_, i) => (
        <div key={i} className="absolute top-0 h-2 border-l border-fg/20" style={{ left: `${((i + 1) / 24) * 100}%` }} />
      ))}
      {Date.now() >= from && Date.now() < from + span && <div className="absolute top-0 bottom-0 w-0.5 bg-onair" style={{ left: `${((Date.now() - from) / span) * 100}%` }} />}
    </div>
  );
}

export function SchedulePage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { channels } = useChannels();
  const [channel, setChannel] = useChannelSelection(channels);
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const from = day.toISOString();
  const to = addDays(day, 1).toISOString();
  const sched = useGet<{ entries: Entry[] }>(channel ? `/api/schedule?channel=${channel.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null, 15000);
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks");
  const [form, setForm] = useState<EntryForm | null>(null);
  const [copy, setCopy] = useState<{ days: number; replace: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const programBlocks = useMemo(() => [...(blocks.data?.blocks ?? [])].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "program" ? -1 : 1)), [blocks.data]);

  const entries = sched.data?.entries ?? [];
  const lastEnd = entries.length ? new Date(entries[entries.length - 1]!.contentEndAt) : null;

  const newEntry = () => {
    const at = lastEnd && lastEnd >= day && lastEnd < addDays(day, 1) ? lastEnd : new Date(Math.max(day.getTime(), Math.ceil(Date.now() / 300_000) * 300_000));
    setForm({ date: isoDay(at), time: hhmmss(at), blockId: "", title: "", description: "", inEpg: true });
  };
  const save = async () => {
    if (!form || !channel || !form.blockId) return;
    setErr(null);
    const body = { channelId: channel.id, startAt: toIso(form.date, form.time), blockId: form.blockId, title: form.title || null, description: form.description || null, inEpg: form.inEpg };
    try {
      if (form.id) await put(`/api/schedule/${form.id}`, body);
      else await post("/api/schedule", body);
      setForm(null);
      void sched.reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const append = async (blockId: number) => {
    if (!channel) return;
    const startAt = lastEnd && lastEnd >= day ? lastEnd.toISOString() : new Date(Math.max(day.getTime(), Date.now() + 60_000)).toISOString();
    await post("/api/schedule/append", { channelId: channel.id, blockIds: [blockId], startAt });
    void sched.reload();
  };
  const remove = async (e: Entry) => {
    if (!confirm(t("mgmt.schedule.confirmDelete", { name: e.programTitle }))) return;
    await del(`/api/schedule/${e.id}`);
    void sched.reload();
  };
  const doCopy = async () => {
    if (!copy || !channel) return;
    const targets = Array.from({ length: copy.days }, (_, i) => addDays(day, i + 1).toISOString());
    await post("/api/schedule/copy-day", { channelId: channel.id, from, to, targets, replace: copy.replace });
    setCopy(null);
  };

  if (channels && !channels.length)
    return (
      <>
        <PageHeader title={t("mgmt.schedule.title")} />
        <Alert tone="warn">
          {t("mgmt.control.noChannelsIntro")}{" "}
          <Link to="/channels" className="font-semibold underline">
            {t("mgmt.nav.channels")}
          </Link>
        </Alert>
      </>
    );

  return (
    <>
      <PageHeader
        title={t("mgmt.schedule.title")}
        description={t("mgmt.schedule.intro")}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => setCopy({ days: 1, replace: false })} disabled={!entries.length}>
                {t("mgmt.schedule.copyDay")}
              </Button>
              <Button icon={<CalendarPlus className="size-4" />} onClick={newEntry}>
                {t("mgmt.schedule.add")}
              </Button>
            </>
          )
        }
      />
      {channels && <ChannelTabs channels={channels} value={channel} onChange={setChannel} />}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setDay(addDays(day, -1))} aria-label="previous day" />
          <Input type="date" className="h-8 w-40!" value={isoDay(day)} onChange={(e) => e.target.value && setDay(startOfDay(new Date(`${e.target.value}T00:00:00`)))} />
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => setDay(addDays(day, 1))} aria-label="next day" />
          <span className="font-semibold first-letter:uppercase">{fmtDate(day)}</span>
          <Button size="sm" variant="secondary" onClick={() => setDay(startOfDay(new Date()))}>
            {t("mgmt.schedule.today")}
          </Button>
          <span className="flex-1" />
          {canEdit && (
            <Select className="h-8 w-auto! text-[13px]" value="" onChange={(e) => e.target.value && void append(Number(e.target.value))}>
              <option value="">{t("mgmt.schedule.appendBlock")}</option>
              {programBlocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.kind === "commercial" ? "📺 " : ""}
                  {b.name} ({fmtDuration(b.durationMs)})
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="px-5 py-4">
          <DayBar entries={entries} day={day} />
          <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
            {["00", "06", "12", "18", "24"].map((h) => (
              <span key={h}>{h}:00</span>
            ))}
          </div>
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {entries.map((e) => {
            const live = Date.parse(e.startAt) <= Date.now() && Date.now() < Date.parse(e.endAt);
            return (
              <li key={e.id} className={cx("flex items-center gap-4 px-5 py-3", live && "bg-onair/5")}>
                <div className="w-20 shrink-0">
                  <p className="font-mono text-sm font-semibold">{fmtTime(e.startAt, true)}</p>
                  <p className="font-mono text-[11px] text-muted">{fmtTime(e.endAt, true)}</p>
                </div>
                <span className="h-10 w-1 shrink-0 rounded-full" style={{ background: e.block?.color }} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {live && <Badge tone="danger">● {t("mgmt.control.onAir")}</Badge>}
                    {e.programTitle}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {e.block?.name}
                    {e.block?.genre ? ` · ${e.block.genre}` : ""}
                    {!e.inEpg && ` · ${t("mgmt.schedule.notInEpg")}`}
                  </p>
                </div>
                {e.warnings > 0 && (
                  <Badge tone="warn">
                    <AlertTriangle className="size-3" /> {t("mgmt.schedule.warnings", { n: e.warnings })}
                  </Badge>
                )}
                {e.overrunMs > 0 && <Badge tone="danger">{t("mgmt.schedule.overrun", { d: fmtDuration(e.overrunMs) })}</Badge>}
                {e.gapAfterMs > 0 && <Badge tone="warn">{t("mgmt.schedule.gap", { d: fmtDuration(e.gapAfterMs) })}</Badge>}
                <span className="w-16 text-right font-mono text-xs text-muted">{fmtDuration(Date.parse(e.endAt) - Date.parse(e.startAt))}</span>
                {canEdit && (
                  <span className="flex shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pencil className="size-3.5" />}
                      onClick={() => {
                        const d = new Date(e.startAt);
                        setForm({ id: e.id, date: isoDay(d), time: hhmmss(d), blockId: e.blockId, title: e.title ?? "", description: e.description ?? "", inEpg: e.inEpg });
                      }}
                    />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(e)} />
                  </span>
                )}
              </li>
            );
          })}
          {sched.data && !entries.length && (
            <li className="px-5 py-12 text-center">
              <ListPlus className="mx-auto mb-2 size-8 text-muted" />
              <p className="text-sm text-muted">{t("mgmt.schedule.empty")}</p>
            </li>
          )}
        </ul>
      </Card>

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t("mgmt.schedule.edit") : t("mgmt.schedule.add")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!form?.blockId} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mgmt.schedule.date")}>{(id) => <Input id={id} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}</Field>
              <Field label={t("mgmt.schedule.startTime")}>{(id) => <Input id={id} type="time" step={1} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />}</Field>
            </div>
            <Field label={t("mgmt.schedule.block")}>
              {(id) => (
                <Select id={id} value={form.blockId} onChange={(e) => setForm({ ...form, blockId: Number(e.target.value) || "" })}>
                  <option value="">{t("mgmt.schedule.chooseBlock")}</option>
                  {programBlocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.kind === "commercial" ? "📺 " : ""}
                      {b.name} ({fmtDuration(b.durationMs)})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("mgmt.schedule.epgTitle")} hint={t("mgmt.schedule.epgTitleHint")}>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
            <Field label={t("mgmt.blocks.description")}>{(id) => <Textarea id={id} className="min-h-16 font-sans text-sm" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Switch checked={form.inEpg} onChange={(v) => setForm({ ...form, inEpg: v })} label={t("mgmt.schedule.inEpg")} />
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!copy}
        onClose={() => setCopy(null)}
        title={t("mgmt.schedule.copyDay")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCopy(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void doCopy()}>{t("mgmt.schedule.copy")}</Button>
          </>
        }
      >
        {copy && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t("mgmt.schedule.copyIntro", { day: fmtDate(day) })}</p>
            <Field label={t("mgmt.schedule.copyDays")}>{(id) => <Input id={id} type="number" min={1} max={62} value={copy.days} onChange={(e) => setCopy({ ...copy, days: Math.max(1, Math.min(62, Number(e.target.value) || 1)) })} />}</Field>
            <Switch checked={copy.replace} onChange={(v) => setCopy({ ...copy, replace: v })} label={t("mgmt.schedule.replace")} description={t("mgmt.schedule.replaceHint")} />
          </div>
        )}
      </Dialog>
    </>
  );
}
