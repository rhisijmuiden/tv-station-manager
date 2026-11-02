import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, brandColor, Input, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, ArrowDown, ArrowUp, Clapperboard, Copy, Film, GripVertical, Newspaper, Pencil, Plus, Radio, Save, Sparkles, Trash2, Webcam as WebcamIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { indicatorClass, payloadItems, useDropList, type DragPayload } from "../components/dnd";
import { WithMediaBin } from "../components/MediaBin";
import { AudioSelect, useAudioSources } from "../components/AudioSelect";
import { MediaPicker } from "../components/MediaPicker";
import { AutoClipsDialog, autoLabel, useAutoPreviews, type AutoInfo, type AutoRule } from "../components/AutoClips";
import { categoryTone, errorText, fmtDuration, parseDuration, useCategories, useGet, type BlockSummary, type LiveSource } from "../lib";

interface Item {
  type: "media" | "block" | "live" | "beeldkrant" | "webcam" | "auto";
  /** "Newest clips": the rule and what it plays now. */
  autoRule?: AutoRule | null;
  autoSourceName?: string | null;
  autoClips?: AutoInfo["autoClips"];
  mediaId?: number | null;
  childBlockId?: number | null;
  liveSourceId?: number | null;
  beeldkrantId?: number | null;
  webcamId?: number | null;
  durationMs?: number | null;
  title?: string | null;
  /** Audio under the item: null = like the block, "none", or an audio source id. */
  audio?: string | null;
  // display
  label: string;
  sub?: string;
  category?: string;
  effectiveDurationMs: number | null;
  warning?: string | null;
}
interface Detail {
  block: BlockSummary & { audio?: string | null };
  items: (Item & { autoSourceName?: string | null; mediaName?: string; mediaTitle?: string; mediaPath?: string; mediaCategory?: string; mediaMissing?: boolean; mediaDurationMs?: number | null; childName?: string; liveName?: string; beeldkrantName?: string; webcamName?: string })[];
}
const COLORS = [...new Set([brandColor("primary"), brandColor("accent", "#FF3D57"), "#1DB97A", "#F5A524", "#8B5CF6", "#06B6D4", "#EC4899", "#64748B"])];

type LibraryPayload = Exclude<DragPayload, { kind: "row" }>;

/** The clips a "newest clips" item plays now, as one line. */
const autoSub = (clips: AutoInfo["autoClips"] | undefined) => (clips?.length ? clips.map((c) => c.name).join(" · ") : undefined);

function Editor({ id, kind, onSaved, onInsertRef }: { id: number | "new"; kind: "program" | "commercial"; onSaved: (id: number) => void; onInsertRef?: { current: ((p: LibraryPayload) => void) | null } }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const base = kind === "program" ? "/blocks" : "/ads";
  const [meta, setMeta] = useState({ name: "", color: kind === "program" ? brandColor("primary") : brandColor("warning", "#F5A524"), genre: "", description: "", categoryId: null as number | null, audio: null as string | null });
  const { categories } = useCategories();
  const [items, setItems] = useState<Item[]>([]);
  const [picker, setPicker] = useState(false);
  /** "Newest clips" dialog: a new item, or the index of the item being changed. */
  const [autoEdit, setAutoEdit] = useState<"new" | number | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const ads = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=commercial");
  const programs = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=program");
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources");
  const beeldkranten = useGet<{ beeldkranten: { id: number; name: string; durationMs: number }[] }>("/api/beeldkranten");
  const { sources: audioSources } = useAudioSources();
  const hasAudio = !!audioSources?.length;
  const webcams = useGet<{ webcams: { id: number; name: string; durationMs: number }[] }>("/api/webcams");

  useEffect(() => {
    setMsg(null);
    setDirty(false);
    if (id === "new") {
      setMeta({ name: "", color: kind === "program" ? brandColor("primary") : brandColor("warning", "#F5A524"), genre: "", description: "", categoryId: null, audio: null });
      setItems([]);
      return;
    }
    void get<Detail>(`/api/blocks/${id}`).then((d) => {
      setMeta({ name: d.block.name, color: d.block.color, genre: d.block.genre, description: d.block.description, categoryId: d.block.categoryId ?? null, audio: d.block.audio ?? null });
      setItems(
        d.items.map((i) => ({
          type: i.type,
          mediaId: i.mediaId,
          childBlockId: i.childBlockId,
          liveSourceId: i.liveSourceId,
          beeldkrantId: i.beeldkrantId,
          webcamId: i.webcamId,
          durationMs: i.durationMs,
          title: i.title,
          audio: i.audio ?? null,
          autoRule: i.autoRule,
          autoSourceName: i.autoSourceName,
          autoClips: i.autoClips,
          label: i.type === "auto" && i.autoRule ? autoLabel(t, { autoRule: i.autoRule, autoSourceName: i.autoSourceName ?? null }) : i.type === "media" ? i.mediaTitle || i.mediaName || "" : i.type === "block" ? i.childName || "" : i.type === "beeldkrant" ? i.beeldkrantName || "" : i.type === "webcam" ? i.webcamName || "" : i.liveName || "",
          sub: i.type === "media" ? i.mediaPath : i.type === "auto" ? autoSub(i.autoClips) : undefined,
          category: i.mediaCategory,
          effectiveDurationMs: i.effectiveDurationMs,
          warning: i.type === "media" ? (i.mediaMissing ? "missing" : i.effectiveDurationMs == null ? "no_duration" : null) : null,
        })),
      );
    });
  }, [id, kind]);

  // Dynamic parts previewed together (no bumper twice, as on air); updates their "now" line and length.
  const previews = useAutoPreviews(items.map((i) => (i.type === "auto" ? i.autoRule : null)));
  useEffect(() => {
    if (!previews) return;
    setItems((cur) =>
      cur.length !== previews.length
        ? cur
        : cur.map((it, i) => {
            const pv = previews[i];
            return it.type === "auto" && pv ? { ...it, autoClips: pv.autoClips, autoSourceName: pv.autoSourceName, sub: autoSub(pv.autoClips), effectiveDurationMs: pv.effectiveDurationMs } : it;
          }),
    );
  }, [previews]);
  const change = (next: Item[]) => {
    setItems(next);
    setDirty(true);
  };
  const move = (i: number, d: number) => {
    const n = [...items];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x!);
    change(n);
  };
  const total = items.reduce((s, i) => s + (i.effectiveDurationMs ?? 0), 0);
  /** Library drops. A block cannot contain itself; ad breaks only take other ad breaks. */
  const insert = (at: number | null, p: LibraryPayload) => {
    if (p.kind === "block" && (p.block.id === id || (kind === "commercial" && p.block.kind !== "commercial"))) return setMsg({ tone: "danger", text: t("mgmt.bin.blockNotAllowed") });
    const add: Item[] = payloadItems(p).map((d) =>
      d.type === "media"
        ? { type: "media", mediaId: d.mediaId, label: d.media.title || d.media.name, sub: d.media.path, category: d.media.category, effectiveDurationMs: d.media.durationMs, warning: d.media.durationMs == null ? "no_duration" : null }
        : { type: "block", childBlockId: d.childBlockId, label: d.block.name, effectiveDurationMs: d.block.durationMs, category: d.block.kind === "commercial" ? "commercial" : undefined },
    );
    setItems((cur) => {
      const pos = at ?? cur.length;
      return [...cur.slice(0, pos), ...add, ...cur.slice(pos)];
    });
    setDirty(true);
  };
  const dnd = useDropList({ list: "block", length: items.length, onInsert: (i, p) => insert(i, p), onMove: (from, to) => move(from, to - from) });
  useEffect(() => {
    if (onInsertRef) onInsertRef.current = (p) => insert(null, p);
  });

  const save = async () => {
    setMsg(null);
    const body = { ...meta, kind, items: items.map(({ type, mediaId, childBlockId, liveSourceId, beeldkrantId, webcamId, autoRule, durationMs, title, audio }) => ({ type, mediaId, childBlockId, liveSourceId, beeldkrantId, webcamId, autoRule: type === "auto" ? autoRule : undefined, durationMs, title, audio: audio ?? null })) };
    try {
      const r = id === "new" ? await post<{ id: number }>("/api/blocks", body) : await put<{ id: number }>(`/api/blocks/${id}`, body);
      setDirty(false);
      setMsg({ tone: "ok", text: t("common.saved") });
      onSaved(r.id);
      if (id === "new") navigate(`${base}/${r.id}`);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const remove = async () => {
    if (id === "new" || !confirm(t("mgmt.blocks.confirmDelete", { name: meta.name }))) return;
    try {
      await del(`/api/blocks/${id}`);
    } catch {
      if (!confirm(t("mgmt.blocks.inUse"))) return;
      await del(`/api/blocks/${id}?force=true`);
    }
    onSaved(0);
    navigate(base);
  };
  const duplicate = async () => {
    if (id === "new") return;
    const r = await post<{ id: number }>(`/api/blocks/${id}/duplicate`);
    onSaved(r.id);
    navigate(`${base}/${r.id}`);
  };

  let offset = 0;
  const nestable = (kind === "program" ? [...(ads.data?.blocks ?? []), ...(programs.data?.blocks ?? [])] : (ads.data?.blocks ?? [])).filter((b) => b.id !== id);

  return (
    <Card>
      <CardHeader
        icon={kind === "program" ? <Clapperboard className="size-4" /> : <Film className="size-4" />}
        title={id === "new" ? t(kind === "program" ? "mgmt.blocks.new" : "mgmt.ads.new") : meta.name}
        description={`${t("mgmt.blocks.total")}: ${fmtDuration(total)} · ${t("mgmt.blocks.itemCount", { n: items.length })}`}
        actions={
          <>
            {id !== "new" && <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void duplicate()} title={t("mgmt.blocks.duplicate")} />}
            {id !== "new" && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()} title={t("common.delete")} />}
            <Button size="sm" icon={<Save className="size-3.5" />} onClick={() => void save()} disabled={!meta.name}>
              {t("common.save")}
            </Button>
          </>
        }
      />
      <CardBody className="space-y-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label={t("common.name")}>{(fid) => <Input id={fid} value={meta.name} onChange={(e) => (setMeta({ ...meta, name: e.target.value }), setDirty(true))} placeholder={t(kind === "program" ? "mgmt.blocks.namePlaceholder" : "mgmt.ads.namePlaceholder")} />}</Field>
          <Field label={t("mgmt.categoriesPage.one")}>
            {(fid) => (
              <Select id={fid} value={meta.categoryId ?? ""} onChange={(e) => (setMeta({ ...meta, categoryId: Number(e.target.value) || null }), setDirty(true))}>
                <option value="">{t("mgmt.week.noCategory")}</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {hasAudio && (
          <Field label={t("mgmt.audio.blockLabel")} hint={t("mgmt.audio.blockHint")}>
            {(fid) => <AudioSelect id={fid} scope="block" sources={audioSources} value={meta.audio} onChange={(audio) => (setMeta({ ...meta, audio }), setDirty(true))} />}
          </Field>
        )}
        <Field label={t("mgmt.blocks.description")} hint={t("mgmt.blocks.descriptionHint")}>
          {(fid) => <Textarea id={fid} className="min-h-16 font-sans text-sm" value={meta.description} onChange={(e) => (setMeta({ ...meta, description: e.target.value }), setDirty(true))} />}
        </Field>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{t("mgmt.blocks.color")}</span>
          {COLORS.map((c) => (
            <button key={c} onClick={() => (setMeta({ ...meta, color: c }), setDirty(true))} className={cx("size-6 rounded-full ring-offset-2 ring-offset-surface", meta.color === c && "ring-2 ring-fg")} style={{ background: c }} aria-label={c} />
          ))}
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm font-semibold">{t("mgmt.blocks.rundown")}</p>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setPicker(true)}>
              {t("mgmt.blocks.addMedia")}
            </Button>
            {kind === "program" && (
              <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} onClick={() => setAutoEdit("new")} title={t("mgmt.auto.buttonHint")}>
                {t("mgmt.auto.button")}
              </Button>
            )}
            {/* Everything else in one list, so the toolbar stays calm. */}
            <Select
              className="h-8 w-auto! text-[13px]"
              value=""
              aria-label={t("mgmt.blocks.addMore")}
              onChange={(e) => {
                const [what, raw] = e.target.value.split(":");
                const n = Number(raw);
                if (what === "block") {
                  const b = nestable.find((x) => x.id === n);
                  if (b) change([...items, { type: "block", childBlockId: b.id, label: b.name, effectiveDurationMs: b.durationMs, category: b.kind === "commercial" ? "commercial" : undefined }]);
                } else if (what === "live") {
                  const l = live.data?.sources.find((x) => x.id === n);
                  if (l) change([...items, { type: "live", liveSourceId: l.id, label: l.name, durationMs: 30 * 60_000, effectiveDurationMs: 30 * 60_000 }]);
                } else if (what === "beeldkrant") {
                  const b = beeldkranten.data?.beeldkranten.find((x) => x.id === n);
                  if (b) change([...items, { type: "beeldkrant", beeldkrantId: b.id, label: b.name, durationMs: null, effectiveDurationMs: b.durationMs }]);
                } else if (what === "webcam") {
                  const w = webcams.data?.webcams.find((x) => x.id === n);
                  if (w) change([...items, { type: "webcam", webcamId: w.id, label: w.name, durationMs: null, effectiveDurationMs: w.durationMs }]);
                }
              }}
            >
              <option value="">{t("mgmt.blocks.addMore")}</option>
              {!!nestable.length && (
                <optgroup label={t(kind === "program" ? "mgmt.blocks.groups.blocks" : "mgmt.blocks.groups.ads")}>
                  {nestable.map((b) => (
                    <option key={b.id} value={`block:${b.id}`}>
                      {b.kind === "commercial" ? "📺 " : ""}
                      {b.name} ({fmtDuration(b.durationMs)})
                    </option>
                  ))}
                </optgroup>
              )}
              {kind === "program" && !!live.data?.sources.length && (
                <optgroup label={t("mgmt.blocks.groups.live")}>
                  {live.data.sources.map((l) => (
                    <option key={l.id} value={`live:${l.id}`}>
                      {l.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {kind === "program" && !!beeldkranten.data?.beeldkranten.length && (
                <optgroup label={t("mgmt.blocks.groups.beeldkrant")}>
                  {beeldkranten.data.beeldkranten.map((b) => (
                    <option key={b.id} value={`beeldkrant:${b.id}`}>
                      {b.name} ({fmtDuration(b.durationMs)})
                    </option>
                  ))}
                </optgroup>
              )}
              {kind === "program" && !!webcams.data?.webcams.length && (
                <optgroup label={t("mgmt.blocks.groups.webcam")}>
                  {webcams.data.webcams.map((w) => (
                    <option key={w.id} value={`webcam:${w.id}`}>
                      {w.name} ({fmtDuration(w.durationMs)})
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </div>
          <ol {...dnd.listProps} className={cx("divide-y divide-line rounded-md border transition", dnd.indicator != null ? "border-brand/60" : "border-line")}>
            {items.map((it, i) => {
              const start = offset;
              offset += it.effectiveDurationMs ?? 0;
              return (
                <li key={i} {...dnd.rowProps(i, it.title || it.label)} className={cx("flex cursor-grab items-center gap-3 px-3 py-2 text-sm active:cursor-grabbing", indicatorClass(dnd.indicator, i, items.length))}>
                  <GripVertical className="-mr-1 size-3.5 shrink-0 text-muted/50" />
                  <span className="w-14 font-mono text-xs text-muted">+{fmtDuration(start)}</span>
                  <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", it.type === "auto" ? "bg-brand text-white" : it.type === "live" ? "bg-onair/12 text-onair" : it.type === "block" ? "bg-warn/15 text-warn" : it.type === "beeldkrant" ? "bg-ok/12 text-ok" : it.type === "webcam" ? "bg-[#0EA5A4]/12 text-[#0EA5A4]" : "bg-brand/10 text-brand")}>
                    {it.type === "auto" ? <Sparkles className="size-3.5" /> : it.type === "live" ? <Radio className="size-3.5" /> : it.type === "block" ? <Film className="size-3.5" /> : it.type === "beeldkrant" ? <Newspaper className="size-3.5" /> : it.type === "webcam" ? <WebcamIcon className="size-3.5" /> : <Clapperboard className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.title || it.label}</span>
                    {it.sub && <span className="block truncate text-xs text-muted">{it.type === "auto" ? `${t("mgmt.auto.now")}: ${it.sub}` : it.sub}</span>}
                    {it.type === "auto" && !it.autoClips?.length && <span className="block text-xs text-warn">{t("mgmt.auto.noneYet")}</span>}
                  </span>
                  {it.warning && <AlertTriangle className="size-4 shrink-0 text-warn" aria-label={t(`mgmt.warnings.${it.warning}`)} />}
                  {it.category && <Badge tone={categoryTone(it.category)}>{t(`mgmt.categories.${it.category}`)}</Badge>}
                  {it.type === "beeldkrant" && <Badge tone="ok">{t("mgmt.blocks.types.beeldkrant")}</Badge>}
                  {it.type === "webcam" && <Badge tone="brand">{t("mgmt.blocks.types.webcam")}</Badge>}
                  {it.type === "auto" && (
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setAutoEdit(i)}>
                      {t("mgmt.auto.change")}
                    </Button>
                  )}
                  {hasAudio && it.type !== "live" && <AudioSelect compact scope="item" sources={audioSources} value={it.audio} onChange={(audio) => change(items.map((x, j) => (j === i ? { ...x, audio } : x)))} />}
                  {it.type === "beeldkrant" || it.type === "webcam" ? (
                    <Input
                      className="h-8 w-24! text-right font-mono text-xs"
                      defaultValue={it.durationMs != null ? fmtDuration(it.durationMs) : ""}
                      placeholder={fmtDuration(it.effectiveDurationMs)}
                      title={t(it.type === "webcam" ? "mgmt.blocks.webcamDuration" : "mgmt.blocks.beeldkrantDuration")}
                      onBlur={(e) => {
                        const ms = e.target.value.trim() ? parseDuration(e.target.value) : null;
                        if (ms === it.durationMs) return;
                        const auto = (it.type === "webcam" ? webcams.data?.webcams.find((w) => w.id === it.webcamId)?.durationMs : beeldkranten.data?.beeldkranten.find((b) => b.id === it.beeldkrantId)?.durationMs) ?? it.effectiveDurationMs;
                        change(items.map((x, j) => (j === i ? { ...x, durationMs: ms, effectiveDurationMs: ms ?? auto } : x)));
                      }}
                    />
                  ) : it.type === "live" ? (
                    <Input
                      className="h-8 w-24! text-right font-mono text-xs"
                      defaultValue={fmtDuration(it.durationMs)}
                      title={t("mgmt.blocks.liveDuration")}
                      onBlur={(e) => {
                        const ms = parseDuration(e.target.value);
                        if (ms != null) change(items.map((x, j) => (j === i ? { ...x, durationMs: ms, effectiveDurationMs: ms } : x)));
                      }}
                    />
                  ) : (
                    <span className="w-16 text-right font-mono text-xs text-muted">{fmtDuration(it.effectiveDurationMs)}</span>
                  )}
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
                </li>
              );
            })}
            {!items.length && <li className={cx("px-3 py-8 text-center text-sm", dnd.indicator != null ? "bg-brand/5 text-brand" : "text-muted")}>{t(kind === "program" ? "mgmt.blocks.emptyRundown" : "mgmt.ads.emptyRundown")}</li>}
          </ol>
          {dirty && <p className="mt-2 text-xs text-warn">{t("mgmt.blocks.unsaved")}</p>}
        </div>
      </CardBody>
      <AutoClipsDialog
        open={autoEdit != null}
        rule={typeof autoEdit === "number" ? (items[autoEdit]?.autoRule ?? null) : null}
        onClose={() => setAutoEdit(null)}
        onSave={(info) => {
          const item: Item = { type: "auto", autoRule: info.autoRule, autoSourceName: info.autoSourceName, autoClips: info.autoClips, label: autoLabel(t, info), sub: autoSub(info.autoClips), effectiveDurationMs: info.effectiveDurationMs };
          change(typeof autoEdit === "number" ? items.map((x, j) => (j === autoEdit ? { ...item, audio: x.audio } : x)) : [...items, item]);
          setAutoEdit(null);
        }}
      />
      <MediaPicker
        open={picker}
        onClose={() => setPicker(false)}
        category={kind === "commercial" ? "commercial" : undefined}
        onPick={(ms) => change([...items, ...ms.map((m) => ({ type: "media" as const, mediaId: m.id, label: m.title || m.name, sub: m.path, category: m.category, effectiveDurationMs: m.durationMs, warning: m.durationMs == null ? "no_duration" : null }))])}
      />
    </Card>
  );
}

export function BlocksPage({ kind }: { kind: "program" | "commercial" }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const params = useParams();
  const base = kind === "program" ? "/blocks" : "/ads";
  const list = useGet<{ blocks: BlockSummary[] }>(`/api/blocks?kind=${kind}`);
  const canEdit = roleAtLeast(user?.role, "editor");
  const sel = params.id === "new" ? "new" : params.id ? Number(params.id) : null;
  const k = kind === "program" ? "blocks" : "ads";
  const insertRef = useRef<((p: LibraryPayload) => void) | null>(null);
  const editing = sel != null && canEdit;
  return (
    <>
      <PageHeader
        title={t(`mgmt.${k}.title`)}
        description={t(`mgmt.${k}.intro`)}
        actions={
          canEdit && (
            <Link to={`${base}/new`}>
              <Button icon={<Plus className="size-4" />}>{t(`mgmt.${k}.new`)}</Button>
            </Link>
          )
        }
      />
      <WithMediaBin onAdd={editing ? (p) => insertRef.current?.(p) : undefined} hint={editing ? t("mgmt.bin.hintBlock") : t("mgmt.bin.hintBlockSelect")}>
      <div className="grid gap-6 @4xl:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="self-start">
          <ul className="max-h-[40vh] divide-y divide-line overflow-y-auto @4xl:max-h-[70vh]">
            {list.data?.blocks.map((b) => (
              <li key={b.id}>
                <Link to={`${base}/${b.id}`} className={cx("flex items-center gap-3 px-4 py-3 transition", sel === b.id ? "bg-brand/8" : "hover:bg-surface-2/60")}>
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: b.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{b.name}</span>
                    <span className="block text-xs text-muted">
                      {fmtDuration(b.durationMs)} · {t("mgmt.blocks.itemCount", { n: b.itemCount })}
                    </span>
                  </span>
                  {(b.warnings > 0 || b.cycle) && <AlertTriangle className="size-4 text-warn" />}
                </Link>
              </li>
            ))}
            {list.data && !list.data.blocks.length && <li className="px-4 py-8 text-center text-sm text-muted">{t(`mgmt.${k}.none`)}</li>}
          </ul>
        </Card>
        {sel != null && canEdit ? (
          <Editor id={sel} kind={kind} onSaved={() => void list.reload()} onInsertRef={insertRef} />
        ) : (
          <Card>
            <CardBody className="py-16 text-center text-muted">{t(`mgmt.${k}.select`)}</CardBody>
          </Card>
        )}
      </div>
      </WithMediaBin>
    </>
  );
}
