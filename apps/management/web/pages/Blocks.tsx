import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, brandColor, Input, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, ArrowDown, ArrowUp, Clapperboard, Copy, Film, Plus, Radio, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MediaPicker } from "../components/MediaPicker";
import { categoryTone, errorText, fmtDuration, parseDuration, useGet, type BlockSummary, type LiveSource } from "../lib";

interface Item {
  type: "media" | "block" | "live";
  mediaId?: number | null;
  childBlockId?: number | null;
  liveSourceId?: number | null;
  durationMs?: number | null;
  title?: string | null;
  // display
  label: string;
  sub?: string;
  category?: string;
  effectiveDurationMs: number | null;
  warning?: string | null;
}
interface Detail {
  block: BlockSummary;
  items: (Item & { mediaName?: string; mediaTitle?: string; mediaPath?: string; mediaCategory?: string; mediaMissing?: boolean; mediaDurationMs?: number | null; childName?: string; liveName?: string })[];
}
const COLORS = [...new Set([brandColor("primary"), brandColor("accent", "#FF3D57"), "#1DB97A", "#F5A524", "#8B5CF6", "#06B6D4", "#EC4899", "#64748B"])];

function Editor({ id, kind, onSaved }: { id: number | "new"; kind: "program" | "commercial"; onSaved: (id: number) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const base = kind === "program" ? "/blocks" : "/ads";
  const [meta, setMeta] = useState({ name: "", color: kind === "program" ? brandColor("primary") : brandColor("warning", "#F5A524"), genre: "", description: "" });
  const [items, setItems] = useState<Item[]>([]);
  const [picker, setPicker] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const ads = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=commercial");
  const programs = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=program");
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources");

  useEffect(() => {
    setMsg(null);
    setDirty(false);
    if (id === "new") {
      setMeta({ name: "", color: kind === "program" ? brandColor("primary") : brandColor("warning", "#F5A524"), genre: "", description: "" });
      setItems([]);
      return;
    }
    void get<Detail>(`/api/blocks/${id}`).then((d) => {
      setMeta({ name: d.block.name, color: d.block.color, genre: d.block.genre, description: d.block.description });
      setItems(
        d.items.map((i) => ({
          type: i.type,
          mediaId: i.mediaId,
          childBlockId: i.childBlockId,
          liveSourceId: i.liveSourceId,
          durationMs: i.durationMs,
          title: i.title,
          label: i.type === "media" ? i.mediaTitle || i.mediaName || "" : i.type === "block" ? i.childName || "" : i.liveName || "",
          sub: i.type === "media" ? i.mediaPath : undefined,
          category: i.mediaCategory,
          effectiveDurationMs: i.effectiveDurationMs,
          warning: i.type === "media" ? (i.mediaMissing ? "missing" : i.effectiveDurationMs == null ? "no_duration" : null) : null,
        })),
      );
    });
  }, [id, kind]);

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

  const save = async () => {
    setMsg(null);
    const body = { ...meta, kind, items: items.map(({ type, mediaId, childBlockId, liveSourceId, durationMs, title }) => ({ type, mediaId, childBlockId, liveSourceId, durationMs, title })) };
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
          <Field label={t("mgmt.blocks.genre")}>{(fid) => <Input id={fid} value={meta.genre} onChange={(e) => (setMeta({ ...meta, genre: e.target.value }), setDirty(true))} placeholder={t("mgmt.blocks.genrePlaceholder")} />}</Field>
        </div>
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
            <Select
              className="h-8 w-auto! text-[13px]"
              value=""
              onChange={(e) => {
                const b = nestable.find((x) => x.id === Number(e.target.value));
                if (b) change([...items, { type: "block", childBlockId: b.id, label: b.name, effectiveDurationMs: b.durationMs, category: b.kind === "commercial" ? "commercial" : undefined }]);
              }}
            >
              <option value="">{kind === "program" ? t("mgmt.blocks.addBlock") : t("mgmt.ads.addBlock")}</option>
              {nestable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.kind === "commercial" ? "📺 " : ""}
                  {b.name} ({fmtDuration(b.durationMs)})
                </option>
              ))}
            </Select>
            {kind === "program" && (
              <Select
                className="h-8 w-auto! text-[13px]"
                value=""
                onChange={(e) => {
                  const l = live.data?.sources.find((x) => x.id === Number(e.target.value));
                  if (l) change([...items, { type: "live", liveSourceId: l.id, label: l.name, durationMs: 30 * 60_000, effectiveDurationMs: 30 * 60_000 }]);
                }}
              >
                <option value="">{t("mgmt.blocks.addLive")}</option>
                {live.data?.sources.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <ol className="divide-y divide-line rounded-md border border-line">
            {items.map((it, i) => {
              const start = offset;
              offset += it.effectiveDurationMs ?? 0;
              return (
                <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-14 font-mono text-xs text-muted">+{fmtDuration(start)}</span>
                  <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", it.type === "live" ? "bg-onair/12 text-onair" : it.type === "block" ? "bg-warn/15 text-warn" : "bg-brand/10 text-brand")}>
                    {it.type === "live" ? <Radio className="size-3.5" /> : it.type === "block" ? <Film className="size-3.5" /> : <Clapperboard className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.title || it.label}</span>
                    {it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}
                  </span>
                  {it.warning && <AlertTriangle className="size-4 shrink-0 text-warn" aria-label={t(`mgmt.warnings.${it.warning}`)} />}
                  {it.category && <Badge tone={categoryTone(it.category)}>{t(`mgmt.categories.${it.category}`)}</Badge>}
                  {it.type === "live" ? (
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
            {!items.length && <li className="px-3 py-8 text-center text-sm text-muted">{t(kind === "program" ? "mgmt.blocks.emptyRundown" : "mgmt.ads.emptyRundown")}</li>}
          </ol>
          {dirty && <p className="mt-2 text-xs text-warn">{t("mgmt.blocks.unsaved")}</p>}
        </div>
      </CardBody>
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
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="self-start">
          <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
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
          <Editor id={sel} kind={kind} onSaved={() => void list.reload()} />
        ) : (
          <Card>
            <CardBody className="py-16 text-center text-muted">{t(`mgmt.${k}.select`)}</CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
