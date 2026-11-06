/**
 * Beeldkrant tab "Regional": four ready-made sources (traffic, events, council meetings, P2000) for the IJmond.
 * Switch one on, adjust a few settings, make a beeldkrant with a block in one click. P2000 alerts wait for an editor.
 */
import { Alert, Badge, Button, Card, CardBody, Dialog, Field, Input, Select, Switch, cx, post, put } from "@tvsm/ui";
import { AlertTriangle, CalendarDays, Car, Check, CheckCircle2, Clock, Eye, Landmark, Newspaper, Plus, RefreshCw, Settings2, Siren, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { errorText, fmtDateTime, fmtTime, useGet } from "../lib";

type Source = "traffic" | "events" | "council" | "p2000";
type Config = Record<string, unknown>;
interface FeedInfo {
  id: number;
  name: string;
  enabled: boolean;
  refreshMinutes: number;
  lastOkAt: string | null;
  lastFetchAt: string | null;
  lastError: string | null;
  itemCount: number;
  config: Config;
}
interface SourceInfo {
  source: Source;
  feed: FeedInfo | null;
  defaults: Config;
  pending: number;
}
interface Item {
  id: number;
  title: string;
  summary: string;
  category: string | null;
  publishedAt: string | null;
  state: "on_air" | "delayed" | "pending" | "rejected";
  showFrom: string | null;
  note: string | null;
}
interface ManualEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  endDate: string;
  place: string;
  text: string;
}
interface Municipality {
  name: string;
  system: "ibabs" | "notubiz" | "ical";
  url: string;
  organisationId: number | null;
  enabled: boolean;
}

const ICONS: Record<Source, ReactNode> = {
  traffic: <Car className="size-5" />,
  events: <CalendarDays className="size-5" />,
  council: <Landmark className="size-5" />,
  p2000: <Siren className="size-5" />,
};
const TINT: Record<Source, string> = { traffic: "bg-warn/15 text-warn", events: "bg-brand/10 text-brand", council: "bg-sky-500/12 text-sky-600 dark:text-sky-400", p2000: "bg-danger/12 text-danger" };

function Chips({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [add, setAdd] = useState("");
  const push = () => {
    const v = add.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setAdd("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full border border-brand bg-brand px-2.5 py-1 text-xs font-medium text-white">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-white/70 hover:text-white" aria-label="×">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={add}
        onChange={(e) => setAdd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            push();
          }
        }}
        onBlur={push}
        placeholder={placeholder}
        className="h-7 w-28 rounded-full border border-dashed border-line bg-transparent px-2.5 text-xs focus:border-brand focus:outline-none"
      />
    </div>
  );
}

function NumberField({ label, hint, value, min, max, step = 1, suffix, onChange }: { label: ReactNode; hint?: ReactNode; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex items-center gap-2">
          <Input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} className="w-28" />
          {suffix && <span className="text-sm text-muted">{suffix}</span>}
        </div>
      )}
    </Field>
  );
}

// ---- settings per source ------------------------------------------------------------------------

function TrafficSettings({ c, set }: { c: Config; set: (p: Config) => void }) {
  const { t } = useTranslation();
  const b = (k: string) => !!c[k];
  return (
    <div className="space-y-5">
      <Field label={t("mgmt.reg.traffic.roads")} hint={t("mgmt.reg.traffic.roadsHint")}>
        {() => <Chips values={(c.roads as string[]) ?? []} onChange={(v) => set({ roads: v.map((x) => x.toUpperCase()) })} placeholder={t("mgmt.reg.add")} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Switch checked={b("jams")} onChange={(v) => set({ jams: v })} label={t("mgmt.reg.traffic.jams")} />
        <Switch checked={b("incidents")} onChange={(v) => set({ incidents: v })} label={t("mgmt.reg.traffic.incidents")} description={t("mgmt.reg.traffic.incidentsHint")} />
        <Switch checked={b("closures")} onChange={(v) => set({ closures: v })} label={t("mgmt.reg.traffic.closures")} description={t("mgmt.reg.traffic.closuresHint")} />
        <Switch checked={b("roadworks")} onChange={(v) => set({ roadworks: v })} label={t("mgmt.reg.traffic.roadworks")} description={t("mgmt.reg.traffic.roadworksHint")} />
        <Switch checked={b("eventClosures")} onChange={(v) => set({ eventClosures: v })} label={t("mgmt.reg.traffic.eventClosures")} />
        <Switch checked={b("minorWorks")} onChange={(v) => set({ minorWorks: v })} label={t("mgmt.reg.traffic.minorWorks")} description={t("mgmt.reg.traffic.minorWorksHint")} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label={t("mgmt.reg.traffic.daysAhead")} value={Number(c.roadworksDaysAhead ?? 7)} min={0} max={60} suffix={t("mgmt.reg.days")} onChange={(v) => set({ roadworksDaysAhead: v })} />
        <NumberField label={t("mgmt.reg.traffic.minJam")} value={Number(c.minJamKm ?? 1)} min={0} max={50} step={0.5} suffix="km" onChange={(v) => set({ minJamKm: v })} />
        <NumberField label={t("mgmt.reg.traffic.maxWorkDays")} hint={t("mgmt.reg.traffic.maxWorkDaysHint")} value={Number(c.maxWorkDays ?? 90)} min={0} max={3650} suffix={t("mgmt.reg.days")} onChange={(v) => set({ maxWorkDays: v })} />
      </div>
    </div>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);
function EventsSettings({ c, set }: { c: Config; set: (p: Config) => void }) {
  const { t } = useTranslation();
  const list = (c.manual as ManualEvent[]) ?? [];
  const upd = (i: number, p: Partial<ManualEvent>) => set({ manual: list.map((e, n) => (n === i ? { ...e, ...p } : e)) });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-5">
      <Field label={t("mgmt.reg.events.feedUrl")} hint={t("mgmt.reg.events.feedUrlHint")}>
        {(id) => <Input id={id} value={String(c.feedUrl ?? "")} onChange={(e) => set({ feedUrl: e.target.value.trim() })} placeholder="https://…/agenda.ics" />}
      </Field>
      <NumberField label={t("mgmt.reg.events.daysAhead")} value={Number(c.daysAhead ?? 14)} min={1} max={120} suffix={t("mgmt.reg.days")} onChange={(v) => set({ daysAhead: v })} />
      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="mr-auto text-[13px] font-medium">{t("mgmt.reg.events.manual")}</p>
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => set({ manual: [...list, { id: newId(), title: "", date: today, time: "", endDate: "", place: "", text: "" }] })}>
            {t("mgmt.reg.events.addEvent")}
          </Button>
        </div>
        {!list.length && <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-muted">{t("mgmt.reg.events.noManual")}</p>}
        <ul className="space-y-3">
          {list.map((e, i) => (
            <li key={e.id} className="rounded-md border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Input value={e.title} onChange={(x) => upd(i, { title: x.target.value })} placeholder={t("mgmt.reg.events.eventTitle")} aria-label={t("mgmt.reg.events.eventTitle")} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => set({ manual: list.filter((_, n) => n !== i) })} title={t("common.delete")} />
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                <label className="text-xs text-muted">
                  {t("mgmt.reg.events.date")}
                  <Input type="date" value={e.date} onChange={(x) => upd(i, { date: x.target.value })} />
                </label>
                <label className="text-xs text-muted">
                  {t("mgmt.reg.events.time")}
                  <Input type="time" value={e.time} onChange={(x) => upd(i, { time: x.target.value })} />
                </label>
                <label className="text-xs text-muted">
                  {t("mgmt.reg.events.endDate")}
                  <Input type="date" value={e.endDate} onChange={(x) => upd(i, { endDate: x.target.value })} />
                </label>
                <label className="text-xs text-muted">
                  {t("mgmt.reg.events.place")}
                  <Input value={e.place} onChange={(x) => upd(i, { place: x.target.value })} placeholder="Witte Theater, IJmuiden" />
                </label>
              </div>
              <Input className="mt-2" value={e.text} onChange={(x) => upd(i, { text: x.target.value })} placeholder={t("mgmt.reg.events.text")} aria-label={t("mgmt.reg.events.text")} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CouncilSettings({ c, set }: { c: Config; set: (p: Config) => void }) {
  const { t } = useTranslation();
  const list = (c.municipalities as Municipality[]) ?? [];
  const upd = (i: number, p: Partial<Municipality>) => set({ municipalities: list.map((m, n) => (n === i ? { ...m, ...p } : m)) });
  return (
    <div className="space-y-5">
      <ul className="space-y-3">
        {list.map((m, i) => (
          <li key={i} className="rounded-md border border-line p-3">
            <div className="grid items-end gap-3 sm:grid-cols-[1fr_150px_auto]">
              <Field label={t("mgmt.reg.council.name")}>{(id) => <Input id={id} value={m.name} onChange={(e) => upd(i, { name: e.target.value })} />}</Field>
              <Field label={t("mgmt.reg.council.system")}>
                {(id) => (
                  <Select id={id} value={m.system} onChange={(e) => upd(i, { system: e.target.value as Municipality["system"] })}>
                    <option value="notubiz">Notubiz</option>
                    <option value="ibabs">iBabs</option>
                    <option value="ical">{t("mgmt.reg.council.ical")}</option>
                  </Select>
                )}
              </Field>
              <div className="flex items-center gap-2 pb-2">
                <Switch checked={m.enabled} onChange={(v) => upd(i, { enabled: v })} label={t("mgmt.reg.council.on")} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => set({ municipalities: list.filter((_, n) => n !== i) })} title={t("common.delete")} />
              </div>
            </div>
            <Field className="mt-2" label={m.system === "ical" ? t("mgmt.reg.council.icalUrl") : t("mgmt.reg.council.portal")} hint={t(`mgmt.reg.council.hint_${m.system}`)}>
              {(id) => <Input id={id} value={m.url} onChange={(e) => upd(i, { url: e.target.value.trim() })} placeholder="https://" />}
            </Field>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => set({ municipalities: [...list, { name: "", system: "ical", url: "", organisationId: null, enabled: true }] })}>
        {t("mgmt.reg.council.add")}
      </Button>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label={t("mgmt.reg.council.daysAhead")} value={Number(c.daysAhead ?? 14)} min={1} max={60} suffix={t("mgmt.reg.days")} onChange={(v) => set({ daysAhead: v })} />
        <div className="pt-6">
          <Switch checked={!!c.showCancelled} onChange={(v) => set({ showCancelled: v })} label={t("mgmt.reg.council.showCancelled")} />
        </div>
      </div>
    </div>
  );
}

function P2000Settings({ c, set }: { c: Config; set: (p: Config) => void }) {
  const { t } = useTranslation();
  const services = (c.services as Record<string, boolean>) ?? {};
  return (
    <div className="space-y-5">
      <Alert tone="warn">{t("mgmt.reg.p2000.privacy")}</Alert>
      <Field label={t("mgmt.reg.p2000.places")} hint={t("mgmt.reg.p2000.placesHint")}>
        {() => <Chips values={(c.places as string[]) ?? []} onChange={(v) => set({ places: v })} placeholder={t("mgmt.reg.add")} />}
      </Field>
      <div>
        <p className="mb-2 text-[13px] font-medium">{t("mgmt.reg.p2000.services")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["fire", "rescue", "ambulance", "police", "helicopter"] as const).map((k) => (
            <Switch key={k} checked={!!services[k]} onChange={(v) => set({ services: { ...services, [k]: v } })} label={t(`mgmt.reg.p2000.svc_${k}`)} description={k === "ambulance" ? t("mgmt.reg.p2000.ambulanceHint") : undefined} />
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Switch checked={!!c.requireApproval} onChange={(v) => set({ requireApproval: v })} label={t("mgmt.reg.p2000.approval")} description={t("mgmt.reg.p2000.approvalHint")} />
        <Switch checked={!!c.skipAutomaticAlarms} onChange={(v) => set({ skipAutomaticAlarms: v })} label={t("mgmt.reg.p2000.skipAutomatic")} />
        <Switch checked={!!c.urgentOnly} onChange={(v) => set({ urgentOnly: v })} label={t("mgmt.reg.p2000.urgentOnly")} />
        <Switch checked={!!c.showStreet} onChange={(v) => set({ showStreet: v })} label={t("mgmt.reg.p2000.showStreet")} description={t("mgmt.reg.p2000.showStreetHint")} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label={t("mgmt.reg.p2000.delay")} hint={t("mgmt.reg.p2000.delayHint")} value={Number(c.delayMinutes ?? 20)} min={0} max={1440} suffix="min" onChange={(v) => set({ delayMinutes: v })} />
        <NumberField label={t("mgmt.reg.p2000.maxAge")} value={Number(c.maxAgeHours ?? 6)} min={1} max={72} suffix={t("mgmt.reg.hours")} onChange={(v) => set({ maxAgeHours: v })} />
      </div>
    </div>
  );
}

function SettingsDialog({ info, onClose, onSaved }: { info: SourceInfo | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [c, setC] = useState<Config>({});
  const [refresh, setRefresh] = useState(10);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ items: { title: string; summary: string; category: string | null; pending: boolean }[]; warning: string | null } | null>(null);
  useEffect(() => {
    if (!info) return;
    setC({ ...info.defaults, ...(info.feed?.config ?? {}) });
    setRefresh(info.feed?.refreshMinutes ?? 10);
    setErr(null);
    setPreview(null);
  }, [info]);
  if (!info) return null;
  const set = (p: Config) => setC((cur) => ({ ...cur, ...p }));
  const s = info.source;
  const run = async (what: "test" | "save") => {
    setBusy(what);
    setErr(null);
    try {
      if (what === "test") setPreview(await post(`/api/regional/${s}/test`, { config: c }));
      else {
        if (info.feed) await put(`/api/regional/${s}`, { config: c, refreshMinutes: refresh });
        else await post(`/api/regional/${s}`, { config: c, refreshMinutes: refresh });
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={t(`mgmt.reg.${s}.title`)}
      footer={
        <>
          <Button variant="secondary" onClick={() => void run("test")} disabled={busy != null} icon={<Eye className={cx("size-3.5", busy === "test" && "animate-pulse")} />}>
            {t("mgmt.reg.preview")}
          </Button>
          <Button onClick={() => void run("save")} disabled={busy != null} icon={<Check className="size-3.5" />}>
            {info.feed ? t("common.save") : t("mgmt.reg.switchOn")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {err && <Alert tone="danger">{err}</Alert>}
        <p className="text-sm text-muted">{t(`mgmt.reg.${s}.about`)}</p>
        {s === "traffic" && <TrafficSettings c={c} set={set} />}
        {s === "events" && <EventsSettings c={c} set={set} />}
        {s === "council" && <CouncilSettings c={c} set={set} />}
        {s === "p2000" && <P2000Settings c={c} set={set} />}
        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <NumberField label={t("mgmt.reg.refresh")} value={refresh} min={1} max={1440} suffix="min" onChange={setRefresh} />
          <Field label={t("mgmt.reg.language")} hint={t("mgmt.reg.languageHint")}>
            {(id) => (
              <Select id={id} value={String(c.language ?? "nl")} onChange={(e) => set({ language: e.target.value })}>
                <option value="nl">Nederlands</option>
                <option value="en">English</option>
              </Select>
            )}
          </Field>
        </div>
        {preview && (
          <div className="rounded-md border border-line">
            <p className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
              <CheckCircle2 className="size-3.5 text-ok" />
              {t("mgmt.reg.previewCount", { count: preview.items.length })}
              {preview.warning && <span className="text-warn">· {preview.warning}</span>}
            </p>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto">
              {preview.items.map((i, n) => (
                <li key={n} className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    {i.category && <Badge tone="brand">{i.category}</Badge>}
                    <span className="truncate text-sm font-medium">{i.title}</span>
                    {i.pending && <Badge tone="warn">{t("mgmt.reg.state_pending")}</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{i.summary}</span>
                </li>
              ))}
              {!preview.items.length && <li className="px-3 py-6 text-center text-xs text-muted">{t("mgmt.reg.nothingNow")}</li>}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- items + approval ---------------------------------------------------------------------------

function ItemsList({ source, canEdit, onChanged }: { source: Source; canEdit: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const items = useGet<{ items: Item[] }>(`/api/regional/${source}/items`, 20_000);
  const act = async (i: Item, what: "approve" | "reject") => {
    await post(`/api/regional/items/${i.id}/${what}`);
    void items.reload();
    onChanged();
  };
  const list = items.data?.items ?? [];
  const tone = { on_air: "ok", delayed: "brand", pending: "warn", rejected: "neutral" } as const;
  return (
    <ul className="max-h-96 divide-y divide-line overflow-y-auto border-t border-line">
      {list.map((i) => (
        <li key={i.id} className={cx("flex flex-wrap items-start gap-3 px-5 py-3", i.state === "rejected" && "opacity-60")}>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={tone[i.state]}>
                {t(`mgmt.reg.state_${i.state}`)}
                {i.state === "delayed" && i.showFrom && ` ${fmtTime(i.showFrom)}`}
              </Badge>
              <span className="text-sm font-medium">{i.title}</span>
            </span>
            <span className="mt-0.5 block text-xs text-muted">{i.summary}</span>
            {i.note && (
              <span className="mt-1 block text-xs text-muted/80">
                <span className="font-medium">{t("mgmt.reg.original")}:</span> {i.note}
              </span>
            )}
          </span>
          {canEdit && source === "p2000" && (
            <span className="flex gap-1">
              {i.state !== "on_air" && i.state !== "delayed" && (
                <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => void act(i, "approve")}>
                  {t("mgmt.reg.approve")}
                </Button>
              )}
              {i.state !== "rejected" && (
                <Button size="sm" variant="secondary" icon={<X className="size-3.5" />} onClick={() => void act(i, "reject")}>
                  {t("mgmt.reg.reject")}
                </Button>
              )}
            </span>
          )}
        </li>
      ))}
      {items.data && !list.length && <li className="px-5 py-6 text-center text-sm text-muted">{t("mgmt.reg.nothingNow")}</li>}
    </ul>
  );
}

// ---- the tab ------------------------------------------------------------------------------------

export function RegionalTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const data = useGet<{ sources: SourceInfo[] }>("/api/regional", 30_000);
  const [edit, setEdit] = useState<SourceInfo | null>(null);
  const [open, setOpen] = useState<Source | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
      void data.reload();
    }
  };
  return (
    <div className="space-y-5">
      <Alert tone="brand">{t("mgmt.reg.intro")}</Alert>
      {err && <Alert tone="danger">{err}</Alert>}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {(data.data?.sources ?? []).map((s) => {
          const f = s.feed;
          return (
            <Card key={s.source} className="flex flex-col">
              <CardBody className="flex flex-1 flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span className={cx("grid size-10 shrink-0 place-items-center rounded-lg", TINT[s.source])}>{ICONS[s.source]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-semibold">{t(`mgmt.reg.${s.source}.title`)}</span>
                      {!f ? <Badge>{t("mgmt.reg.off")}</Badge> : f.lastError ? <Badge tone="warn">{t("mgmt.reg.problem")}</Badge> : <Badge tone="ok">{t("mgmt.reg.on")}</Badge>}
                      {s.pending > 0 && (
                        <Badge tone="warn">
                          <Clock className="size-3" />
                          {t("mgmt.reg.pendingCount", { count: s.pending })}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{t(`mgmt.reg.${s.source}.short`)}</span>
                  </span>
                </div>
                {f && (
                  <div className="text-xs text-muted">
                    {t("mgmt.reg.status", { count: f.itemCount, every: f.refreshMinutes })}
                    {f.lastOkAt && ` · ${t("mgmt.reg.lastFetch", { at: fmtDateTime(f.lastOkAt) })}`}
                    {f.lastError && (
                      <span className="mt-1 flex items-start gap-1 text-warn">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {f.lastError}
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  {canEdit && (
                    <Button size="sm" variant={f ? "secondary" : "primary"} icon={f ? <Settings2 className="size-3.5" /> : <Plus className="size-3.5" />} onClick={() => setEdit(s)}>
                      {f ? t("mgmt.reg.settings") : t("mgmt.reg.switchOn")}
                    </Button>
                  )}
                  {f && (
                    <>
                      <Button size="sm" variant="secondary" icon={<Eye className="size-3.5" />} onClick={() => setOpen(open === s.source ? null : s.source)}>
                        {s.source === "p2000" ? t("mgmt.reg.checkAlerts") : t("mgmt.reg.showItems")}
                      </Button>
                      {canEdit && (
                        <>
                          <Button size="sm" variant="ghost" icon={<RefreshCw className={cx("size-3.5", busy === `r${s.source}` && "animate-spin")} />} onClick={() => void run(`r${s.source}`, async () => void (await post(`/api/rss/feeds/${f.id}/refresh`)))} title={t("mgmt.reg.refreshNow")} />
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Newspaper className="size-3.5" />}
                            loading={busy === `b${s.source}`}
                            onClick={() =>
                              void run(`b${s.source}`, async () => {
                                const r = await post<{ beeldkrantId: number }>(`/api/regional/${s.source}/beeldkrant`);
                                navigate(`/beeldkrant/${r.beeldkrantId}`);
                              })
                            }
                          >
                            {t("mgmt.reg.makeBeeldkrant")}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </CardBody>
              {f && open === s.source && <ItemsList source={s.source} canEdit={canEdit} onChanged={() => void data.reload()} />}
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted">{t("mgmt.reg.tickerHint")}</p>
      <SettingsDialog info={edit} onClose={() => setEdit(null)} onSaved={() => void data.reload()} />
    </div>
  );
}
