import { Alert, Button, Card, CardBody, Field, Input, PageHeader, Switch, Textarea, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowLeft, Copy, ImagePlus, Info, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, fmtDuration, parseDuration, useGet, type BlockSummary } from "../lib";

// ---- types -------------------------------------------------------------------------

const LAYOUTS = ["text", "imageRight", "imageLeft", "imageBackground", "imageOnly"] as const;
type Layout = (typeof LAYOUTS)[number];
interface Settings {
  title: string;
  subtitle: string;
  body: string;
  footer: string;
  layout: Layout;
  durationSec: number;
  showOverlay: boolean;
  showLogo: boolean;
}
interface InfoPage {
  id: number;
  name: string;
  settings: Settings;
  durationMs: number;
  imageUrl: string | null;
  usedIn: number;
  updatedAt: string;
  block: BlockSummary | null;
}
const DEFAULTS: Settings = { title: "", subtitle: "", body: "", footer: "", layout: "text", durationSec: 20, showOverlay: false, showLogo: true };

/** Small drawing of a layout, for the layout picker. */
function LayoutIcon({ layout }: { layout: Layout }) {
  const pic = <span className="rounded-[3px] bg-[var(--tvsm-info)]/70" />;
  const lines = (
    <span className="flex flex-col justify-center gap-1">
      <span className="h-1.5 w-3/4 rounded-full bg-current opacity-80" />
      <span className="h-1 w-full rounded-full bg-current opacity-40" />
      <span className="h-1 w-5/6 rounded-full bg-current opacity-40" />
      <span className="h-1 w-2/3 rounded-full bg-current opacity-40" />
    </span>
  );
  return (
    <span className="relative block aspect-video w-full overflow-hidden rounded-md bg-ink p-1.5 text-white" style={{ background: "#2A1430" }}>
      {layout === "text" && <span className="grid h-full px-1">{lines}</span>}
      {layout === "imageRight" && (
        <span className="grid h-full grid-cols-2 gap-1.5">
          {lines}
          {pic}
        </span>
      )}
      {layout === "imageLeft" && (
        <span className="grid h-full grid-cols-2 gap-1.5">
          {pic}
          {lines}
        </span>
      )}
      {layout === "imageBackground" && (
        <>
          <span className="absolute inset-0 bg-[var(--tvsm-info)]/60" />
          <span className="absolute inset-0 bg-gradient-to-r from-[#2A1430] to-transparent" />
          <span className="relative grid h-full w-3/5 px-1">{lines}</span>
        </>
      )}
      {layout === "imageOnly" && <span className="absolute inset-1.5 grid rounded-[3px] bg-[var(--tvsm-info)]/70" />}
    </span>
  );
}

/** A picture from the editor's computer, made no larger than a full HD screen needs. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("unsupported_image"));
      i.src = url;
    });
    // Big enough to fill the screen, never larger.
    const scale = Math.min(1, Math.max(1920 / img.naturalWidth, 1080 / img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    // PNG keeps transparency (a logo or a designed slide); photos become JPEG.
    const png = file.type === "image/png" ? c.toDataURL("image/png") : "";
    return png && png.length < 4_500_000 ? png : c.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The 1920x1080 page scaled into a 16:9 box. */
function PagePreview({ src, srcDoc, title }: { src?: string; srcDoc?: string; title: string }) {
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-line">
      {(src || srcDoc) && <iframe title={title} src={src} srcDoc={srcDoc} loading="lazy" className="pointer-events-none size-full border-0" tabIndex={-1} />}
    </div>
  );
}

// ---- editor -------------------------------------------------------------------------

function Editor({ page, onClose, onSaved }: { page: InfoPage | "new"; onClose: () => void; onSaved: (p: InfoPage) => void }) {
  const { t } = useTranslation();
  const [id, setId] = useState<number | null>(page === "new" ? null : page.id);
  const [name, setName] = useState(page === "new" ? "" : page.name);
  const [s, setS] = useState<Settings>(page === "new" ? DEFAULTS : { ...DEFAULTS, ...page.settings });
  const [imageUrl, setImageUrl] = useState<string | null>(page === "new" ? null : page.imageUrl);
  const [duration, setDuration] = useState(fmtDuration(s.durationSec * 1000));
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Settings>) => (setS((cur) => ({ ...cur, ...patch })), setDirty(true), setMsg(null));

  // Live preview of the unsaved page, a moment after the last keystroke.
  useEffect(() => {
    const h = setTimeout(() => {
      void post<{ html: string }>("/api/infopages/preview", { id, settings: s })
        .then((r) => setHtml(r.html))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(h);
  }, [s, id, imageUrl]);

  const body = () => ({ name: name.trim() || s.title.trim() || t("mgmt.info.untitled"), settings: s });
  const save = async (quiet = false) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = id == null ? await post<InfoPage>("/api/infopages", body()) : await put<InfoPage>(`/api/infopages/${id}`, body());
      setId(r.id);
      setName(r.name);
      setDirty(false);
      if (!quiet) setMsg({ tone: "ok", text: t("mgmt.info.saved") });
      onSaved(r);
      return r;
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File) => {
    setMsg(null);
    try {
      const dataUrl = await shrinkImage(file);
      // A new page is saved first: the picture belongs to a page.
      const target = id ?? (await save(true))?.id;
      if (target == null) return;
      const r = await post<InfoPage>(`/api/infopages/${target}/image`, { dataUrl });
      setImageUrl(r.imageUrl);
      if (s.layout === "text") set({ layout: "imageRight" });
      onSaved(r);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const removeImage = async () => {
    if (id == null) return;
    const r = await del<InfoPage>(`/api/infopages/${id}/image`);
    setImageUrl(null);
    onSaved(r);
  };

  const needsImage = s.layout !== "text";
  return (
    <>
      <PageHeader
        title={id == null ? t("mgmt.info.new") : name || t("mgmt.info.untitled")}
        description={t("mgmt.info.editorIntro")}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="size-4" />} onClick={() => (!dirty || confirm(t("mgmt.info.discard"))) && onClose()}>
              {t("mgmt.info.back")}
            </Button>
            <Button icon={<Save className="size-4" />} onClick={() => void save()} disabled={busy}>
              {t("common.save")}
            </Button>
          </>
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
          <PagePreview srcDoc={html} title={t("mgmt.info.preview")} />
          <p className="text-xs text-muted">{t("mgmt.info.previewHint")}</p>
        </div>
        <Card>
          <CardBody className="space-y-5">
            <Field label={t("mgmt.info.name")} hint={t("mgmt.info.nameHint")}>
              {(fid) => <Input id={fid} value={name} maxLength={120} placeholder={s.title || t("mgmt.info.namePlaceholder")} onChange={(e) => (setName(e.target.value), setDirty(true))} />}
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium">{t("mgmt.info.layout")}</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="radiogroup" aria-label={t("mgmt.info.layout")}>
                {LAYOUTS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={s.layout === l}
                    onClick={() => set({ layout: l })}
                    className={cx("rounded-lg border p-1.5 text-left text-[11px] font-medium transition", s.layout === l ? "border-brand bg-brand/5 ring-2 ring-brand/30" : "border-line hover:border-brand/50")}
                  >
                    <LayoutIcon layout={l} />
                    <span className="mt-1 block truncate">{t(`mgmt.info.layouts.${l}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            {needsImage && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 p-3">
                <span className="relative grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-surface text-muted ring-1 ring-line">
                  {imageUrl ? <img src={imageUrl} alt="" className="absolute inset-0 size-full object-cover" /> : <ImagePlus className="size-5" />}
                </span>
                <span className="min-w-0 flex-1 text-xs text-muted">{imageUrl ? t("mgmt.info.imageHint") : t("mgmt.info.imageMissing")}</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void upload(f);
                  }}
                />
                <Button size="sm" variant="secondary" icon={<ImagePlus className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                  {imageUrl ? t("mgmt.info.imageReplace") : t("mgmt.info.imageChoose")}
                </Button>
                {imageUrl && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void removeImage()}>
                    {t("mgmt.info.imageRemove")}
                  </Button>
                )}
              </div>
            )}
            {s.layout !== "imageOnly" && (
              <>
                <Field label={t("mgmt.info.title")}>{(fid) => <Input id={fid} value={s.title} maxLength={120} placeholder={t("mgmt.info.titlePlaceholder")} onChange={(e) => set({ title: e.target.value })} />}</Field>
                <Field label={t("mgmt.info.subtitle")}>{(fid) => <Input id={fid} value={s.subtitle} maxLength={160} placeholder={t("mgmt.info.subtitlePlaceholder")} onChange={(e) => set({ subtitle: e.target.value })} />}</Field>
                <Field label={t("mgmt.info.body")} hint={t("mgmt.info.bodyHint")}>
                  {(fid) => <Textarea id={fid} rows={8} value={s.body} maxLength={3000} placeholder={t("mgmt.info.bodyPlaceholder")} onChange={(e) => set({ body: e.target.value })} />}
                </Field>
                <Field label={t("mgmt.info.footer")} hint={t("mgmt.info.footerHint")}>
                  {(fid) => <Input id={fid} value={s.footer} maxLength={160} placeholder={t("mgmt.info.footerPlaceholder")} onChange={(e) => set({ footer: e.target.value })} />}
                </Field>
              </>
            )}
            <Field label={t("mgmt.info.duration")} hint={t("mgmt.info.durationHint")}>
              {(fid) => (
                <Input
                  id={fid}
                  className="w-32! font-mono"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  onBlur={() => {
                    const ms = parseDuration(duration);
                    const sec = ms == null ? s.durationSec : Math.min(3600, Math.max(3, Math.round(ms / 1000)));
                    setDuration(fmtDuration(sec * 1000));
                    if (sec !== s.durationSec) set({ durationSec: sec });
                  }}
                />
              )}
            </Field>
            <div className="space-y-3 border-t border-line pt-4">
              {s.layout !== "imageOnly" && <Switch checked={s.showLogo} onChange={(v) => set({ showLogo: v })} label={t("mgmt.info.showLogo")} description={t("mgmt.info.showLogoHint")} />}
              <Switch checked={s.showOverlay} onChange={(v) => set({ showOverlay: v })} label={t("mgmt.info.showOverlay")} description={t("mgmt.info.showOverlayHint")} />
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

// ---- list ---------------------------------------------------------------------------

export function InfoPagesPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const list = useGet<{ pages: InfoPage[] }>("/api/infopages");
  const [editing, setEditing] = useState<InfoPage | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pages = list.data?.pages ?? [];

  if (editing) return <Editor page={editing} onClose={() => (setEditing(null), void list.reload())} onSaved={() => void list.reload()} />;

  const remove = async (p: InfoPage) => {
    if (!confirm(t("mgmt.info.confirmDelete", { name: p.name }))) return;
    setError(null);
    try {
      await del(`/api/infopages/${p.id}`);
    } catch (e) {
      if (!confirm(t("mgmt.info.confirmDeleteUsed", { name: p.name, count: p.usedIn }))) return;
      try {
        await del(`/api/infopages/${p.id}?force=true`);
      } catch (e2) {
        setError(errorText(t, e2 ?? e));
      }
    }
    await list.reload();
  };
  const duplicate = async (p: InfoPage) => {
    try {
      await post(`/api/infopages/${p.id}/duplicate`, { name: t("mgmt.info.copyName", { name: p.name }).slice(0, 120) });
      await list.reload();
    } catch (e) {
      setError(errorText(t, e));
    }
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.info.pageTitle")}
        description={t("mgmt.info.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              {t("mgmt.info.add")}
            </Button>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {list.data && !pages.length ? (
        <Card>
          <CardBody className="py-14 text-center">
            <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-brand/10 text-brand">
              <Info className="size-7" />
            </span>
            <div className="text-base font-semibold">{t("mgmt.info.emptyTitle")}</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t("mgmt.info.emptyText")}</p>
            {canEdit && (
              <Button className="mt-5" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                {t("mgmt.info.add")}
              </Button>
            )}
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{t("mgmt.info.howToPlan")}</p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {pages.map((p) => (
              <Card key={p.id} className="flex flex-col overflow-hidden">
                <button type="button" className="block text-left" onClick={() => canEdit && setEditing(p)} aria-label={t("mgmt.info.edit")}>
                  <PagePreview src={`/infopage/page.html?id=${p.id}&preview=1&v=${encodeURIComponent(p.updatedAt)}`} title={p.name} />
                </button>
                <div className="flex flex-1 flex-col gap-1 p-4">
                  <span className="truncate font-semibold">{p.name}</span>
                  <div className="text-xs text-muted">
                    {t(`mgmt.info.layouts.${p.settings.layout}`)} · {fmtDuration(p.durationMs)}
                    {p.usedIn > 0 ? ` · ${t("mgmt.info.usedIn", { count: p.usedIn })}` : ""}
                  </div>
                  {canEdit && (
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                      <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(p)}>
                        {t("mgmt.info.edit")}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void duplicate(p)} aria-label={t("mgmt.info.duplicate")} title={t("mgmt.info.duplicate")} />
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(p)} aria-label={t("common.delete")} title={t("common.delete")} />
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
