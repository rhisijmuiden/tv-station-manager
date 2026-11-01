import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clapperboard, Copy, Globe, Image as ImageIcon, LayoutTemplate, Newspaper, Pause, Pencil, Play, Plus, RefreshCw, Rss, Save, Trash2, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { errorText, fmtDateTime, fmtDuration, useChannels, useGet } from "../lib";

// ---- types -------------------------------------------------------------------------

type Layout = "photo-left" | "photo-right" | "photo-top" | "photo-full" | "text";
const LAYOUTS: Layout[] = ["photo-left", "photo-right", "photo-top", "photo-full", "text"];
interface Settings {
  secondsPerPage: number;
  maxItems: number;
  maxAgeHours: number;
  maxTitleChars: number;
  maxTextChars: number;
  textSource: "summary" | "body";
  layout: Layout;
  textSize: "small" | "medium" | "large";
  transition: "fade" | "slide" | "none";
  show: { image: boolean; date: boolean; category: boolean; source: boolean; pageNumber: boolean; clock: boolean; progress: boolean };
  headerText: string;
  footerText: string;
  logoChannelId: number | null;
  emptyText: string;
  language: "nl" | "en";
  colors: { background: string; panel: string; accent: string; text: string };
  duration: { mode: "cycle" | "fixed"; fixedSeconds: number };
  showOverlay: boolean;
}
interface Beeldkrant {
  id: number;
  name: string;
  feedIds: number[];
  settings: Settings;
  pageCount: number;
  durationMs: number;
  usedIn: number;
  pageUrl: string;
}
interface WpCategory {
  id: number;
  slug: string;
  name: string;
  count?: number | null;
}
interface Feed {
  id: number;
  name: string;
  kind: "wordpress" | "rss";
  url: string;
  categories: WpCategory[];
  enabled: boolean;
  refreshMinutes: number;
  maxItems: number;
  lastFetchAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  via: "wp-json" | "rss" | null;
  itemCount: number;
}
interface PageData {
  id: number;
  title: string;
  text: string;
  image: string | null;
}

const defaults = (): Settings => ({
  secondsPerPage: 12,
  maxItems: 10,
  maxAgeHours: 72,
  maxTitleChars: 90,
  maxTextChars: 420,
  textSource: "summary",
  layout: "photo-left",
  textSize: "medium",
  transition: "fade",
  show: { image: true, date: true, category: true, source: false, pageNumber: true, clock: true, progress: true },
  headerText: "Nieuws",
  footerText: "",
  logoChannelId: null,
  emptyText: "Er is op dit moment geen nieuws.",
  language: "nl",
  // Colours of the house style (branding/ijmond360: aubergine, purple, pink); fixed, so dark mode in the UI does not change what goes on air.
  colors: { background: "#2A1430", panel: "#713C80", accent: "#E92E7F", text: "#FFFFFF" },
  duration: { mode: "cycle", fixedSeconds: 600 },
  showOverlay: false,
});

// ---- small pieces ----------------------------------------------------------------------

function Num({ label, hint, value, min, max, step = 1, suffix, onChange }: { label: ReactNode; hint?: ReactNode; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex items-center gap-3">
          <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 flex-1 cursor-pointer accent-brand" />
          <div className="relative w-24 shrink-0">
            <Input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} className="pr-8 text-right font-mono text-sm" />
            {suffix && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted">{suffix}</span>}
          </div>
        </div>
      )}
    </Field>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface-2/60 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cx("rounded-md px-3 py-1.5 text-[13px] font-medium transition", value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Miniature of a layout, for the layout picker. */
function LayoutThumb({ layout }: { layout: Layout }) {
  const lines = (
    <span className="flex flex-1 flex-col justify-center gap-1">
      <span className="block h-1.5 w-4/5 rounded-full bg-white/90" />
      <span className="block h-1 w-full rounded-full bg-white/45" />
      <span className="block h-1 w-3/4 rounded-full bg-white/45" />
    </span>
  );
  return (
    <span className="relative flex aspect-video w-full gap-1.5 overflow-hidden rounded-md p-1.5" style={{ background: "#2A1430" }}>
      {layout === "photo-left" && (
        <>
          <span className="w-[45%]">
            <span className="block h-full rounded-[3px]" style={{ background: "#E92E7F", opacity: 0.75 }} />
          </span>
          {lines}
        </>
      )}
      {layout === "photo-right" && (
        <>
          {lines}
          <span className="w-[45%]">
            <span className="block h-full rounded-[3px]" style={{ background: "#E92E7F", opacity: 0.75 }} />
          </span>
        </>
      )}
      {layout === "photo-top" && (
        <span className="flex flex-1 flex-col gap-1">
          <span className="block h-1/2 rounded-[3px]" style={{ background: "#E92E7F", opacity: 0.75 }} />
          {lines}
        </span>
      )}
      {layout === "photo-full" && (
        <>
          <span className="absolute inset-0" style={{ background: "linear-gradient(90deg, #2A1430 15%, transparent 75%), #E92E7FBB" }} />
          <span className="relative flex w-3/5">{lines}</span>
        </>
      )}
      {layout === "text" && <span className="flex flex-1 px-1">{lines}</span>}
    </span>
  );
}

function ColorField({ label, value, onChange }: { label: ReactNode; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2.5 rounded-md border border-line px-2.5 py-2 text-[13px]">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block font-mono text-[11px] text-muted">{value}</span>
      </span>
    </label>
  );
}

// ---- preview ------------------------------------------------------------------------------

function Preview({ settings, feedIds, onInfo }: { settings: Settings; feedIds: number[]; onInfo: (i: { pages: number; durationMs: number }) => void }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [pages, setPages] = useState<PageData[]>([]);
  const [pin, setPin] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const logoUrl = settings.logoChannelId != null ? `/graphics/${settings.logoChannelId}/logo` : null;

  useEffect(() => {
    const h = (e: MessageEvent) => e.origin === location.origin && e.data?.type === "beeldkrant-ready" && setReady(true);
    addEventListener("message", h);
    return () => removeEventListener("message", h);
  }, []);
  // Pages for the settings as they are now (debounced): the server cuts the texts exactly as on air.
  const key = JSON.stringify([settings, feedIds]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void post<{ pages: PageData[]; durationMs: number }>("/api/beeldkranten/preview", { settings, feedIds })
        .then((r) => {
          setPages(r.pages);
          onInfo({ pages: r.pages.length, durationMs: r.durationMs });
        })
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (pin != null && pin >= pages.length) setPin(pages.length ? pages.length - 1 : null);
  }, [pages.length, pin]);
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "beeldkrant", settings, pages, logoUrl, pin }, location.origin);
  }, [ready, settings, pages, logoUrl, pin]);

  const step = (d: number) => pages.length && setPin(((pin ?? 0) + d + pages.length) % pages.length);
  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-black shadow-sm">
        <iframe ref={frame} src="/beeldkrant/page.html?preview=1" title={t("mgmt.bk.preview")} className="absolute inset-0 h-full w-full border-0" onLoad={() => setReady(true)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="secondary" icon={<ChevronLeft className="size-3.5" />} onClick={() => step(-1)} disabled={!pages.length} title={t("mgmt.bk.prevPage")} />
        <Button size="sm" variant="secondary" icon={pin == null ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => setPin(pin == null ? 0 : null)} disabled={!pages.length}>
          {pin == null ? t("mgmt.bk.hold") : t("mgmt.bk.play")}
        </Button>
        <Button size="sm" variant="secondary" icon={<ChevronRight className="size-3.5" />} onClick={() => step(1)} disabled={!pages.length} title={t("mgmt.bk.nextPage")} />
        <span className="ml-1 text-muted">{pin != null ? t("mgmt.bk.pageOf", { n: pin + 1, total: pages.length }) : t("mgmt.bk.pages", { count: pages.length })}</span>
      </div>
    </div>
  );
}

// ---- editor ----------------------------------------------------------------------------------

function Editor({ id, feeds, onSaved }: { id: number | "new"; feeds: Feed[]; onSaved: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { channels } = useChannels();
  const [name, setName] = useState("");
  const [feedIds, setFeedIds] = useState<number[]>([]);
  const [s, setS] = useState<Settings>(defaults);
  const [info, setInfo] = useState<{ pages: number; durationMs: number }>({ pages: 0, durationMs: 0 });
  const [saved, setSaved] = useState<Beeldkrant | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    setMsg(null);
    setDirty(false);
    if (id === "new") {
      setName("");
      setFeedIds(feeds.length === 1 ? [feeds[0]!.id] : []);
      setS(defaults());
      setSaved(null);
      return;
    }
    get<Beeldkrant>(`/api/beeldkranten/${id}`)
      .then((b) => {
        setSaved(b);
        setName(b.name);
        setFeedIds(b.feedIds);
        setS(b.settings);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const set = (patch: Partial<Settings>) => {
    setS((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  };
  const show = (k: keyof Settings["show"], v: boolean) => set({ show: { ...s.show, [k]: v } });
  const color = (k: keyof Settings["colors"], v: string) => set({ colors: { ...s.colors, [k]: v } });
  const onInfo = useCallback((i: { pages: number; durationMs: number }) => setInfo(i), []);

  const save = async () => {
    setMsg(null);
    try {
      const body = { name, feedIds, settings: s };
      const r = id === "new" ? await post<Beeldkrant>("/api/beeldkranten", body) : await put<Beeldkrant>(`/api/beeldkranten/${id}`, body);
      setSaved(r);
      setDirty(false);
      setMsg({ tone: "ok", text: t("common.saved") });
      onSaved();
      if (id === "new") navigate(`/beeldkrant/${r.id}`);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const remove = async () => {
    if (id === "new" || !confirm(t("mgmt.bk.confirmDelete", { name }))) return;
    try {
      await del(`/api/beeldkranten/${id}`);
    } catch {
      if (!confirm(t("mgmt.bk.inUse"))) return;
      await del(`/api/beeldkranten/${id}?force=true`);
    }
    onSaved();
    navigate("/beeldkrant");
  };
  const makeBlock = async () => {
    if (id === "new") return;
    try {
      if (dirty) await save();
      const r = await post<{ id: number }>(`/api/beeldkranten/${id}/block`);
      navigate(`/blocks/${r.id}`);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const toggleFeed = (f: number) => {
    setFeedIds((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
    setDirty(true);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={<Newspaper className="size-4" />}
          title={id === "new" ? t("mgmt.bk.new") : name || t("mgmt.bk.title")}
          description={`${t("mgmt.bk.pages", { count: info.pages })} · ${s.duration.mode === "fixed" ? t("mgmt.bk.fixedLength", { d: fmtDuration(info.durationMs) }) : t("mgmt.bk.cycleLength", { d: fmtDuration(info.durationMs) })}`}
          actions={
            <>
              {id !== "new" && (
                <Button size="sm" variant="secondary" icon={<Clapperboard className="size-3.5" />} onClick={() => void makeBlock()} title={t("mgmt.bk.makeBlockHint")}>
                  {t("mgmt.bk.makeBlock")}
                </Button>
              )}
              {id !== "new" && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()} title={t("common.delete")} />}
              <Button size="sm" icon={<Save className="size-3.5" />} onClick={() => void save()} disabled={!name.trim()}>
                {t("common.save")}
              </Button>
            </>
          }
        />
        <CardBody className="space-y-4">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Preview settings={s} feedIds={feedIds} onInfo={onInfo} />
          {dirty && <p className="text-xs text-warn">{t("mgmt.blocks.unsaved")}</p>}
          {saved && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {t("mgmt.bk.usedIn", { count: saved.usedIn })}
              <span className="text-line">·</span>
              <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => void navigator.clipboard?.writeText(saved.pageUrl)} title={saved.pageUrl}>
                <Copy className="size-3" /> {t("mgmt.bk.copyUrl")}
              </button>
            </p>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-6 @5xl:grid-cols-2">
        <Card>
          <CardHeader icon={<Rss className="size-4" />} title={t("mgmt.bk.content")} description={t("mgmt.bk.contentHint")} />
          <CardBody className="space-y-4">
            <Field label={t("common.name")}>{(fid) => <Input id={fid} value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder={t("mgmt.bk.namePlaceholder")} />}</Field>
            <div>
              <p className="mb-1.5 text-[13px] font-medium">{t("mgmt.bk.feeds")}</p>
              <ul className="divide-y divide-line rounded-md border border-line">
                {feeds.map((f) => (
                  <li key={f.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2/50">
                      <input type="checkbox" checked={feedIds.includes(f.id)} onChange={() => toggleFeed(f.id)} className="size-4 accent-brand" />
                      {f.kind === "wordpress" ? <Globe className="size-3.5 text-brand" /> : <Rss className="size-3.5 text-warn" />}
                      <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                      <span className="text-xs text-muted">{t("mgmt.bk.itemCount", { count: f.itemCount })}</span>
                    </label>
                  </li>
                ))}
                {!feeds.length && (
                  <li className="px-3 py-5 text-center text-sm text-muted">
                    {t("mgmt.bk.noFeeds")}{" "}
                    <Link to="/beeldkrant/feeds" className="font-medium text-brand hover:underline">
                      {t("mgmt.bk.addFeed")}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
            <Num label={t("mgmt.bk.maxItems")} hint={t("mgmt.bk.maxItemsHint")} value={s.maxItems} min={1} max={50} onChange={(v) => set({ maxItems: v })} />
            <Num label={t("mgmt.bk.maxAge")} hint={t("mgmt.bk.maxAgeHint")} value={s.maxAgeHours} min={0} max={336} suffix="h" onChange={(v) => set({ maxAgeHours: v })} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<RefreshCw className="size-4" />} title={t("mgmt.bk.timing")} description={t("mgmt.bk.timingHint")} />
          <CardBody className="space-y-4">
            <Num label={t("mgmt.bk.secondsPerPage")} value={s.secondsPerPage} min={3} max={120} suffix="s" onChange={(v) => set({ secondsPerPage: v })} />
            <Field label={t("mgmt.bk.length")} hint={t("mgmt.bk.lengthHint")}>
              {() => (
                <Segmented
                  value={s.duration.mode}
                  onChange={(v) => set({ duration: { ...s.duration, mode: v } })}
                  options={[
                    { value: "cycle", label: t("mgmt.bk.lengthCycle") },
                    { value: "fixed", label: t("mgmt.bk.lengthFixed") },
                  ]}
                />
              )}
            </Field>
            {s.duration.mode === "fixed" && <Num label={t("mgmt.bk.fixedMinutes")} value={Math.round(s.duration.fixedSeconds / 60)} min={1} max={240} suffix="min" onChange={(v) => set({ duration: { ...s.duration, fixedSeconds: v * 60 } })} />}
            <Field label={t("mgmt.bk.transition")}>
              {() => (
                <Segmented
                  value={s.transition}
                  onChange={(v) => set({ transition: v })}
                  options={(["fade", "slide", "none"] as const).map((v) => ({ value: v, label: t(`mgmt.bk.transitions.${v}`) }))}
                />
              )}
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Type className="size-4" />} title={t("mgmt.bk.text")} description={t("mgmt.bk.textHint")} />
          <CardBody className="space-y-4">
            <Num label={t("mgmt.bk.maxTextChars")} hint={t("mgmt.bk.maxTextCharsHint")} value={s.maxTextChars} min={0} max={1500} step={10} suffix={t("mgmt.bk.chars")} onChange={(v) => set({ maxTextChars: v })} />
            <Num label={t("mgmt.bk.maxTitleChars")} value={s.maxTitleChars} min={20} max={200} suffix={t("mgmt.bk.chars")} onChange={(v) => set({ maxTitleChars: v })} />
            <Field label={t("mgmt.bk.textSource")}>
              {() => (
                <Segmented
                  value={s.textSource}
                  onChange={(v) => set({ textSource: v })}
                  options={[
                    { value: "summary", label: t("mgmt.bk.sourceSummary") },
                    { value: "body", label: t("mgmt.bk.sourceBody") },
                  ]}
                />
              )}
            </Field>
            <Field label={t("mgmt.bk.textSize")}>
              {() => (
                <Segmented value={s.textSize} onChange={(v) => set({ textSize: v })} options={(["small", "medium", "large"] as const).map((v) => ({ value: v, label: t(`mgmt.bk.sizes.${v}`) }))} />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mgmt.bk.headerText")}>{(fid) => <Input id={fid} value={s.headerText} onChange={(e) => set({ headerText: e.target.value })} />}</Field>
              <Field label={t("mgmt.bk.footerText")}>{(fid) => <Input id={fid} value={s.footerText} placeholder="ijmond360.nl" onChange={(e) => set({ footerText: e.target.value })} />}</Field>
              <Field label={t("mgmt.bk.emptyText")}>{(fid) => <Input id={fid} value={s.emptyText} onChange={(e) => set({ emptyText: e.target.value })} />}</Field>
              <Field label={t("mgmt.bk.language")} hint={t("mgmt.bk.languageHint")}>
                {(fid) => (
                  <Select id={fid} value={s.language} onChange={(e) => set({ language: e.target.value as "nl" | "en" })}>
                    <option value="nl">Nederlands</option>
                    <option value="en">English</option>
                  </Select>
                )}
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<LayoutTemplate className="size-4" />} title={t("mgmt.bk.layout")} description={t("mgmt.bk.layoutHint")} />
          <CardBody className="space-y-5">
            <div className="grid grid-cols-3 gap-2">
              {LAYOUTS.map((l) => (
                <button key={l} type="button" onClick={() => set({ layout: l })} className={cx("rounded-lg border p-1.5 text-left transition", s.layout === l ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-brand/50")}>
                  <LayoutThumb layout={l} />
                  <span className="mt-1.5 block px-0.5 text-[12px] leading-tight font-medium">{t(`mgmt.bk.layouts.${l}`)}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Switch checked={s.show.image} onChange={(v) => show("image", v)} label={t("mgmt.bk.showImage")} />
              <Switch checked={s.show.category} onChange={(v) => show("category", v)} label={t("mgmt.bk.showCategory")} />
              <Switch checked={s.show.date} onChange={(v) => show("date", v)} label={t("mgmt.bk.showDate")} />
              <Switch checked={s.show.source} onChange={(v) => show("source", v)} label={t("mgmt.bk.showSource")} />
              <Switch checked={s.show.clock} onChange={(v) => show("clock", v)} label={t("mgmt.bk.showClock")} />
              <Switch checked={s.show.pageNumber} onChange={(v) => show("pageNumber", v)} label={t("mgmt.bk.showPageNumber")} />
              <Switch checked={s.show.progress} onChange={(v) => show("progress", v)} label={t("mgmt.bk.showProgress")} />
              <Switch checked={s.showOverlay} onChange={(v) => set({ showOverlay: v })} label={t("mgmt.bk.showOverlay")} description={t("mgmt.bk.showOverlayHint")} />
            </div>
            <Field label={t("mgmt.bk.logo")} hint={t("mgmt.bk.logoHint")}>
              {(fid) => (
                <Select id={fid} value={s.logoChannelId ?? ""} onChange={(e) => set({ logoChannelId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t("mgmt.bk.noLogo")}</option>
                  {channels?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t("mgmt.bk.logoOf", { name: c.name })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <ColorField label={t("mgmt.bk.colors.background")} value={s.colors.background} onChange={(v) => color("background", v)} />
              <ColorField label={t("mgmt.bk.colors.panel")} value={s.colors.panel} onChange={(v) => color("panel", v)} />
              <ColorField label={t("mgmt.bk.colors.accent")} value={s.colors.accent} onChange={(v) => color("accent", v)} />
              <ColorField label={t("mgmt.bk.colors.text")} value={s.colors.text} onChange={(v) => color("text", v)} />
            </div>
            <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => set({ colors: defaults().colors })}>
              {t("mgmt.bk.brandColors")}
            </button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// ---- feeds -----------------------------------------------------------------------------------

interface FeedForm {
  name: string;
  kind: "wordpress" | "rss";
  url: string;
  categories: WpCategory[];
  enabled: boolean;
  refreshMinutes: number;
  maxItems: number;
}
const emptyFeed = (): FeedForm => ({ name: "", kind: "wordpress", url: "https://www.ijmond360.nl", categories: [], enabled: true, refreshMinutes: 10, maxItems: 20 });

function FeedDialog({ feed, onClose, onSaved }: { feed: Feed | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<FeedForm>(emptyFeed);
  const [cats, setCats] = useState<WpCategory[] | null>(null);
  const [test, setTest] = useState<{ via: string; items: { title: string; summary: string; imageUrl: string | null; publishedAt: string | null }[] } | null>(null);
  const [busy, setBusy] = useState<"cats" | "test" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!feed) return;
    setErr(null);
    setTest(null);
    setCats(null);
    setF(feed === "new" ? emptyFeed() : { name: feed.name, kind: feed.kind, url: feed.url, categories: feed.categories, enabled: feed.enabled, refreshMinutes: feed.refreshMinutes, maxItems: feed.maxItems });
  }, [feed]);
  const url = () => (/^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : `https://${f.url.trim()}`);
  const loadCats = async () => {
    setBusy("cats");
    setErr(null);
    try {
      const r = await post<{ site: string; categories: WpCategory[] }>("/api/rss/wordpress/categories", { url: url() });
      setCats(r.categories);
      setF((cur) => ({ ...cur, url: r.site }));
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy("test");
    setErr(null);
    try {
      setTest(await post("/api/rss/test", { kind: f.kind, url: url(), categories: f.categories, maxItems: 5 }));
    } catch (e) {
      setErr(errorText(t, e));
      setTest(null);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    setErr(null);
    try {
      const body = { ...f, url: url(), name: f.name.trim() || new URL(url()).hostname.replace(/^www\./, "") };
      if (feed === "new") await post("/api/rss/feeds", body);
      else if (feed) await put(`/api/rss/feeds/${feed.id}`, body);
      onSaved();
      onClose();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const toggleCat = (c: WpCategory) => setF((cur) => ({ ...cur, categories: cur.categories.some((x) => x.id === c.id) ? cur.categories.filter((x) => x.id !== c.id) : [...cur.categories, { id: c.id, slug: c.slug, name: c.name }] }));
  const allCats = cats ?? f.categories;
  return (
    <Dialog
      open={!!feed}
      onClose={onClose}
      wide
      title={feed === "new" ? t("mgmt.bk.addFeed") : t("mgmt.bk.editFeed")}
      footer={
        <>
          <Button variant="secondary" onClick={() => void runTest()} disabled={!f.url.trim() || busy != null} icon={<RefreshCw className={cx("size-3.5", busy === "test" && "animate-spin")} />}>
            {t("mgmt.bk.testFeed")}
          </Button>
          <Button onClick={() => void save()} disabled={!f.url.trim() || busy != null} icon={<Save className="size-3.5" />}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}
        <Segmented
          value={f.kind}
          onChange={(v) => setF({ ...f, kind: v })}
          options={[
            { value: "wordpress", label: t("mgmt.bk.kindWordpress") },
            { value: "rss", label: t("mgmt.bk.kindRss") },
          ]}
        />
        <p className="text-xs text-muted">{f.kind === "wordpress" ? t("mgmt.bk.kindWordpressHint") : t("mgmt.bk.kindRssHint")}</p>
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <Field label={f.kind === "wordpress" ? t("mgmt.bk.siteUrl") : t("mgmt.bk.feedUrl")}>
            {(id) => <Input id={id} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder={f.kind === "wordpress" ? "https://www.ijmond360.nl" : "https://feeds.nos.nl/nosnieuwsalgemeen"} />}
          </Field>
          <Field label={t("common.name")}>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="IJmond360" />}</Field>
        </div>
        {f.kind === "wordpress" && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <p className="mr-auto text-[13px] font-medium">{t("mgmt.bk.categories")}</p>
              <Button size="sm" variant="secondary" onClick={() => void loadCats()} disabled={busy != null} icon={<RefreshCw className={cx("size-3.5", busy === "cats" && "animate-spin")} />}>
                {t("mgmt.bk.loadCategories")}
              </Button>
            </div>
            <p className="mb-2 text-xs text-muted">{f.categories.length ? t("mgmt.bk.categoriesSome", { names: f.categories.map((c) => c.name).join(", ") }) : t("mgmt.bk.categoriesAll")}</p>
            {allCats.length > 0 && (
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {allCats.map((c) => {
                  const on = f.categories.some((x) => x.id === c.id);
                  return (
                    <button key={c.id} type="button" onClick={() => toggleCat(c)} className={cx("rounded-full border px-2.5 py-1 text-xs font-medium transition", on ? "border-brand bg-brand text-white" : "border-line hover:border-brand/50")}>
                      {c.name}
                      {c.count != null && <span className={cx("ml-1", on ? "text-white/70" : "text-muted")}>{c.count}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Num label={t("mgmt.bk.refresh")} value={f.refreshMinutes} min={1} max={240} suffix="min" onChange={(v) => setF({ ...f, refreshMinutes: v })} />
          <Num label={t("mgmt.bk.keepItems")} value={f.maxItems} min={1} max={100} onChange={(v) => setF({ ...f, maxItems: v })} />
        </div>
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={t("mgmt.bk.feedEnabled")} />
        {test && (
          <div className="rounded-md border border-line">
            <p className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
              <CheckCircle2 className="size-3.5 text-ok" />
              {t("mgmt.bk.testOk", { count: test.items.length })} · {test.via === "wp-json" ? t("mgmt.bk.viaRest") : t("mgmt.bk.viaRss")}
            </p>
            <ul className="divide-y divide-line">
              {test.items.map((i, n) => (
                <li key={n} className="flex gap-3 px-3 py-2">
                  {i.imageUrl ? <img src={i.imageUrl} alt="" className="h-12 w-20 shrink-0 rounded object-cover" /> : <span className="grid h-12 w-20 shrink-0 place-items-center rounded bg-surface-2 text-muted"><ImageIcon className="size-4" /></span>}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{i.title}</span>
                    <span className="line-clamp-2 text-xs text-muted">{i.summary}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function FeedsTab({ feeds, reload, canEdit }: { feeds: Feed[]; reload: () => void; canEdit: boolean }) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState<Feed | "new" | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = async (f: Feed) => {
    setBusy(f.id);
    setErr(null);
    try {
      await post(`/api/rss/feeds/${f.id}/refresh`);
    } catch (e) {
      setErr(`${f.name}: ${errorText(t, e)}`);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const remove = async (f: Feed) => {
    if (!confirm(t("mgmt.bk.confirmDeleteFeed", { name: f.name }))) return;
    await del(`/api/rss/feeds/${f.id}`);
    reload();
  };
  return (
    <Card>
      <CardHeader
        icon={<Rss className="size-4" />}
        title={t("mgmt.bk.feedsTitle")}
        description={t("mgmt.bk.feedsIntro")}
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit("new")}>
              {t("mgmt.bk.addFeed")}
            </Button>
          )
        }
      />
      {err && <Alert tone="danger" className="m-4">{err}</Alert>}
      <ul className="divide-y divide-line">
        {feeds.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className={cx("grid size-9 shrink-0 place-items-center rounded-lg", f.kind === "wordpress" ? "bg-brand/10 text-brand" : "bg-warn/15 text-warn")}>{f.kind === "wordpress" ? <Globe className="size-4" /> : <Rss className="size-4" />}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{f.name}</span>
                {!f.enabled && <Badge>{t("mgmt.bk.paused")}</Badge>}
                {f.via && <Badge tone="neutral">{f.via === "wp-json" ? "WordPress API" : "RSS"}</Badge>}
              </span>
              <span className="block truncate text-xs text-muted">
                {f.url}
                {f.categories.length > 0 && ` · ${f.categories.map((c) => c.name).join(", ")}`}
              </span>
              {f.lastError ? (
                <span className="mt-0.5 flex items-center gap-1 text-xs text-danger">
                  <AlertTriangle className="size-3" /> {f.lastError}
                </span>
              ) : (
                f.lastOkAt && <span className="block text-xs text-muted">{t("mgmt.bk.lastFetch", { at: fmtDateTime(f.lastOkAt), every: f.refreshMinutes })}</span>
              )}
            </span>
            <Badge tone={f.itemCount ? "ok" : "warn"}>{t("mgmt.bk.itemCount", { count: f.itemCount })}</Badge>
            {canEdit && (
              <span className="flex">
                <Button size="sm" variant="ghost" icon={<RefreshCw className={cx("size-3.5", busy === f.id && "animate-spin")} />} onClick={() => void refresh(f)} title={t("mgmt.bk.refreshNow")} />
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit(f)} title={t("common.edit")} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(f)} title={t("common.delete")} />
              </span>
            )}
          </li>
        ))}
        {!feeds.length && <li className="px-5 py-10 text-center text-sm text-muted">{t("mgmt.bk.noFeedsYet")}</li>}
      </ul>
      <FeedDialog feed={edit} onClose={() => setEdit(null)} onSaved={reload} />
    </Card>
  );
}

// ---- page ---------------------------------------------------------------------------------------

export function BeeldkrantPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const params = useParams();
  const canEdit = roleAtLeast(user?.role, "editor");
  const list = useGet<{ beeldkranten: Beeldkrant[] }>("/api/beeldkranten");
  const feeds = useGet<{ feeds: Feed[] }>("/api/rss/feeds", 30_000);
  const tab = params.id === "feeds" ? "feeds" : "pages";
  const sel = params.id === "new" ? "new" : params.id && params.id !== "feeds" ? Number(params.id) : null;
  const feedList = useMemo(() => feeds.data?.feeds ?? [], [feeds.data]);

  return (
    <>
      <PageHeader
        title={t("mgmt.bk.title")}
        description={t("mgmt.bk.intro")}
        actions={
          canEdit &&
          tab === "pages" && (
            <Link to="/beeldkrant/new">
              <Button icon={<Plus className="size-4" />}>{t("mgmt.bk.new")}</Button>
            </Link>
          )
        }
      />
      <div className="mb-5 flex gap-1 border-b border-line">
        {(
          [
            ["pages", "/beeldkrant", t("mgmt.bk.tabPages"), <Newspaper key="i" className="size-4" />],
            ["feeds", "/beeldkrant/feeds", t("mgmt.bk.tabFeeds"), <Rss key="i" className="size-4" />],
          ] as const
        ).map(([k, to, label, icon]) => (
          <Link key={k} to={to} className={cx("-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition", tab === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
            {icon}
            {label}
            {k === "feeds" && feedList.some((f) => f.lastError) && <AlertTriangle className="size-3.5 text-warn" />}
          </Link>
        ))}
      </div>
      {tab === "feeds" ? (
        <FeedsTab feeds={feedList} reload={() => void feeds.reload()} canEdit={canEdit} />
      ) : (
        <div className="@container" data-wide-page>
          <div className="grid gap-6 @4xl:grid-cols-[260px_1fr]">
            <Card className="self-start">
              <ul className="max-h-[40vh] divide-y divide-line overflow-y-auto @4xl:max-h-[75vh]">
                {list.data?.beeldkranten.map((b) => (
                  <li key={b.id}>
                    <Link to={`/beeldkrant/${b.id}`} className={cx("flex items-center gap-3 px-4 py-3 transition", sel === b.id ? "bg-brand/8" : "hover:bg-surface-2/60")}>
                      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: b.settings.colors.accent }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{b.name}</span>
                        <span className="block text-xs text-muted">
                          {t("mgmt.bk.pages", { count: b.pageCount })} · {b.settings.secondsPerPage}s · {fmtDuration(b.durationMs)}
                        </span>
                      </span>
                      {b.pageCount === 0 && <AlertTriangle className="size-4 text-warn" />}
                    </Link>
                  </li>
                ))}
                {list.data && !list.data.beeldkranten.length && <li className="px-4 py-8 text-center text-sm text-muted">{t("mgmt.bk.none")}</li>}
              </ul>
            </Card>
            {sel != null && canEdit ? (
              <Editor id={sel} feeds={feedList} onSaved={() => void list.reload()} />
            ) : (
              <Card>
                <CardBody className="py-16 text-center text-muted">{t("mgmt.bk.select")}</CardBody>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
