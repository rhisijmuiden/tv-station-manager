import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, formatBytes, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, FolderOpen, HardDrive, Pencil, Plus, RefreshCw, Search, Tags, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CATEGORIES, categoryTone, errorText, fmtDateTime, fmtDuration, parseDuration, useCategories, useGet, type ContentCategory, type MediaItem } from "../lib";

interface Source {
  id: number;
  name: string;
  type: "smb" | "local";
  enabled: boolean;
  config: Record<string, string>;
  scanStatus: string;
  lastScanAt: string | null;
  lastError: string | null;
  files: number;
  pending: number;
  missing: number;
}
const emptySmb = { host: "", share: "", path: "", username: "", password: "", domain: "", protocol: "SMB3" };

function SourceDialog({ source, onClose, onSaved }: { source: Partial<Source>; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [s, setS] = useState<Partial<Source>>(source);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cfg = (s.config ?? {}) as Record<string, string>;
  const set = (k: string, v: string) => setS({ ...s, config: { ...cfg, [k]: v } });
  const body = () => ({ id: s.id, name: s.name ?? "", type: s.type ?? "smb", enabled: s.enabled ?? true, config: s.type === "local" ? { path: cfg.path ?? "" } : { ...emptySmb, ...cfg } });
  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ files: number; sample: string[] }>("/api/media/sources/test", body());
      setMsg({ tone: "ok", text: t("mgmt.media.testOk", { n: r.files }) + (r.sample.length ? ` (${r.sample.slice(0, 3).join(", ")}…)` : "") });
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    try {
      if (s.id) await put(`/api/media/sources/${s.id}`, body());
      else await post("/api/media/sources", body());
      onSaved();
      onClose();
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={s.id ? t("mgmt.media.editSource") : t("mgmt.media.addSource")}
      footer={
        <>
          <Button variant="secondary" loading={busy} onClick={() => void test()}>
            {t("mgmt.media.testConnection")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.name")}>{(id) => <Input id={id} value={s.name ?? ""} placeholder="UNAS Pro" onChange={(e) => setS({ ...s, name: e.target.value })} />}</Field>
          <Field label={t("mgmt.media.type")}>
            {(id) => (
              <Select id={id} value={s.type ?? "smb"} onChange={(e) => setS({ ...s, type: e.target.value as "smb" | "local", config: {} })}>
                <option value="smb">{t("mgmt.media.typeSmb")}</option>
                <option value="local">{t("mgmt.media.typeLocal")}</option>
              </Select>
            )}
          </Field>
        </div>
        {(s.type ?? "smb") === "smb" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mgmt.media.host")} hint={t("mgmt.media.hostHint")}>{(id) => <Input id={id} value={cfg.host ?? ""} placeholder="10.40.6.10" onChange={(e) => set("host", e.target.value)} />}</Field>
              <Field label={t("mgmt.media.share")}>{(id) => <Input id={id} value={cfg.share ?? ""} placeholder="TV" onChange={(e) => set("share", e.target.value)} />}</Field>
            </div>
            <Field label={t("mgmt.media.subfolder")} hint={t("mgmt.media.subfolderHint")}>{(id) => <Input id={id} value={cfg.path ?? ""} placeholder="Playout" onChange={(e) => set("path", e.target.value)} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("auth.username")}>{(id) => <Input id={id} value={cfg.username ?? ""} autoComplete="off" onChange={(e) => set("username", e.target.value)} />}</Field>
              <Field label={t("auth.password")}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={cfg.password ?? ""} onChange={(e) => set("password", e.target.value)} />}</Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mgmt.media.domain")}>{(id) => <Input id={id} value={cfg.domain ?? ""} placeholder={t("common.optional")} onChange={(e) => set("domain", e.target.value)} />}</Field>
              <Field label={t("mgmt.media.protocol")}>
                {(id) => (
                  <Select id={id} value={cfg.protocol ?? "SMB3"} onChange={(e) => set("protocol", e.target.value)}>
                    <option value="SMB3">SMB 3</option>
                    <option value="SMB2">SMB 2</option>
                  </Select>
                )}
              </Field>
            </div>
          </>
        ) : (
          <Field label={t("mgmt.media.localPath")} hint={t("mgmt.media.localHint")}>{(id) => <Input id={id} value={cfg.path ?? ""} placeholder="/mnt/media" onChange={(e) => set("path", e.target.value)} />}</Field>
        )}
        <Switch checked={s.enabled ?? true} onChange={(v) => setS({ ...s, enabled: v })} label={t("common.enabled")} description={t("mgmt.media.enabledHint")} />
      </div>
    </Dialog>
  );
}

function MediaDialog({ item, categories, onClose, onSaved }: { item: MediaItem; categories: ContentCategory[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [m, setM] = useState({ title: item.title ?? "", category: item.category as string, duration: item.durationMs != null ? fmtDuration(item.durationMs) : "", categoryId: item.categoryId ?? null });
  const save = async () => {
    await put(`/api/media/${item.id}`, { title: m.title || null, category: m.category, durationMs: m.duration ? parseDuration(m.duration) : item.durationMs, categoryId: m.categoryId });
    onSaved();
    onClose();
  };
  const reprobe = async () => {
    await post(`/api/media/${item.id}/probe`);
    onSaved();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={item.name}
      footer={
        <>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => void reprobe()}>
            {t("mgmt.media.reprobe")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </>
      }
    >
      {(
        <div className="space-y-4">
          <p className="font-mono text-xs break-all text-muted">{item.path}</p>
          {item.probeError && <Alert tone="warn">{t("mgmt.media.probeFailed")}: {item.probeError}</Alert>}
          <Field label={t("mgmt.media.title")} hint={t("mgmt.media.titleHint")}>{(id) => <Input id={id} value={m.title} placeholder={item.name} onChange={(e) => setM({ ...m, title: e.target.value })} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mgmt.media.category")}>
              {(id) => (
                <Select id={id} value={m.category} onChange={(e) => setM({ ...m, category: e.target.value })}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`mgmt.categories.${c}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("mgmt.media.duration")} hint={t("mgmt.media.durationHint")}>{(id) => <Input id={id} value={m.duration} placeholder="0:30:00" onChange={(e) => setM({ ...m, duration: e.target.value })} />}</Field>
          </div>
          <Field label={t("mgmt.categoriesPage.one")} hint={t("mgmt.media.categoryHint")}>
            {(id) => (
              <Select id={id} value={m.categoryId ?? ""} onChange={(e) => setM({ ...m, categoryId: Number(e.target.value) || null })}>
                <option value="">{t("mgmt.week.noCategory")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">{t("mgmt.media.resolution")}</dt>
              <dd>{item.width ? `${item.width}×${item.height}` : "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">FPS</dt>
              <dd>{item.fps ?? "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("mgmt.media.size")}</dt>
              <dd>{formatBytes(item.size)}</dd>
            </div>
          </dl>
        </div>
      )}
    </Dialog>
  );
}

export function MediaPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const sources = useGet<{ sources: Source[] }>("/api/media/sources", 4000);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [folder, setFolder] = useState("");
  const [search] = useSearchParams();
  const [theme, setTheme] = useState(search.get("categoryId") ?? "");
  const [page, setPage] = useState(0);
  const { categories } = useCategories();
  const catById = new Map((categories ?? []).map((c) => [c.id, c]));
  const [assign, setAssign] = useState<number | "" | null>(null);
  const params = new URLSearchParams({ limit: "100", offset: String(page * 100), ...(q ? { q } : {}), ...(cat ? { category: cat } : {}), ...(folder ? { folder } : {}), ...(theme ? { categoryId: theme } : {}) });
  const media = useGet<{ items: MediaItem[]; total: number; folders: string[] }>(`/api/media?${params}`);
  const [editSource, setEditSource] = useState<Partial<Source> | null>(null);
  const [editItem, setEditItem] = useState<MediaItem | null>(null);

  const scan = async (id: number) => {
    await post(`/api/media/sources/${id}/scan`);
    void sources.reload();
  };
  const remove = async (s: Source) => {
    if (!confirm(t("mgmt.media.confirmDeleteSource", { name: s.name }))) return;
    await del(`/api/media/sources/${s.id}`);
    void sources.reload();
    void media.reload();
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.media.title_page")}
        description={t("mgmt.media.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditSource({ type: "smb", enabled: true, config: { ...emptySmb } })}>
              {t("mgmt.media.addSource")}
            </Button>
          )
        }
      />
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {sources.data?.sources.map((s) => (
          <Card key={s.id}>
            <CardBody className="flex items-start gap-4">
              <div className="grid size-10 place-items-center rounded-lg bg-brand/10 text-brand">
                <HardDrive className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{s.name}</span>
                  {s.scanStatus === "scanning" ? <Badge tone="brand">{t("mgmt.media.scanning")}</Badge> : s.scanStatus === "error" ? <Badge tone="danger">{t("mgmt.media.error")}</Badge> : !s.enabled ? <Badge>{t("common.disabled")}</Badge> : <Badge tone="ok">{t("mgmt.media.connected")}</Badge>}
                </div>
                <p className="truncate font-mono text-xs text-muted">{s.type === "smb" ? `\\\\${s.config.host}\\${s.config.share}${s.config.path ? `\\${s.config.path}` : ""}` : s.config.path}</p>
                <p className="mt-1 text-xs text-muted">
                  {t("mgmt.media.fileCount", { n: s.files })}
                  {s.pending > 0 && ` · ${t("mgmt.media.probing", { n: s.pending })}`}
                  {s.missing > 0 && ` · ${t("mgmt.media.missingCount", { n: s.missing })}`}
                  {s.lastScanAt && ` · ${t("mgmt.media.lastScan")} ${fmtDateTime(s.lastScanAt)}`}
                </p>
                {s.lastError && <p className="mt-1 text-xs text-danger">{s.lastError}</p>}
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" icon={<RefreshCw className={cx("size-3.5", s.scanStatus === "scanning" && "animate-spin")} />} onClick={() => void scan(s.id)} title={t("mgmt.media.scan")} />
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditSource(s)} title={t("common.edit")} />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(s)} title={t("common.delete")} />
                </div>
              )}
            </CardBody>
          </Card>
        ))}
        {sources.data && !sources.data.sources.length && (
          <Card className="md:col-span-2">
            <CardBody className="py-10 text-center">
              <FolderOpen className="mx-auto mb-3 size-8 text-muted" />
              <p className="font-medium">{t("mgmt.media.noSources")}</p>
              <p className="text-sm text-muted">{t("mgmt.media.noSourcesIntro")}</p>
            </CardBody>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader
          title={t("mgmt.media.library")}
          description={media.data ? t("mgmt.media.fileCount", { n: media.data.total }) : undefined}
          actions={
            canEdit &&
            folder && (
              <Button size="sm" variant="secondary" icon={<Tags className="size-3.5" />} onClick={() => setAssign("")}>
                {t("mgmt.media.assignFolder")}
              </Button>
            )
          }
        />
        <div className="grid gap-2 border-b border-line p-4 sm:grid-cols-[1fr_150px_170px_220px]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted" />
            <Input className="pl-9" placeholder={t("mgmt.media.search")} value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />
          </div>
          <Select value={cat} onChange={(e) => (setCat(e.target.value), setPage(0))}>
            <option value="">{t("mgmt.media.allCategories")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`mgmt.categories.${c}`)}
              </option>
            ))}
          </Select>
          <Select value={theme} onChange={(e) => (setTheme(e.target.value), setPage(0))} aria-label={t("mgmt.categoriesPage.one")}>
            <option value="">{t("mgmt.categoriesPage.all")}</option>
            <option value="none">{t("mgmt.categoriesPage.withoutCategory")}</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select value={folder} onChange={(e) => (setFolder(e.target.value), setPage(0))}>
            <option value="">{t("mgmt.media.allFolders")}</option>
            {media.data?.folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">{t("common.name")}</th>
                <th className="px-3 py-2.5 font-medium">{t("mgmt.media.folder")}</th>
                <th className="px-3 py-2.5 font-medium">{t("mgmt.media.category")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("mgmt.media.duration")}</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {media.data?.items.map((m) => (
                <tr key={m.id} className="hover:bg-surface-2/50">
                  <td className="max-w-80 px-5 py-2.5">
                    <p className="flex items-center gap-2 truncate font-medium">
                      <span className="truncate">{m.title || m.name}</span>
                      {m.subtitlePath && (
                        <span title={m.subtitlePath}>
                          <Badge tone="brand">{t("mgmt.media.subtitles")}</Badge>
                        </span>
                      )}
                    </p>
                    {m.width && (
                      <p className="text-xs text-muted">
                        {m.width}×{m.height} · {m.fps} fps · {m.codec}
                      </p>
                    )}
                  </td>
                  <td className="max-w-56 truncate px-3 py-2.5 text-muted">{m.folder || "/"}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={categoryTone(m.category)}>{t(`mgmt.categories.${m.category}`)}</Badge>
                      {m.categoryId && catById.get(m.categoryId) && (
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: catById.get(m.categoryId)!.color }}>
                          {catById.get(m.categoryId)!.name}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    {m.probeStatus === "pending" ? (
                      <span className="text-muted">{t("mgmt.media.measuring")}</span>
                    ) : m.durationMs == null ? (
                      <span className="inline-flex items-center gap-1 text-warn">
                        <AlertTriangle className="size-3.5" /> {t("mgmt.media.unknown")}
                      </span>
                    ) : (
                      fmtDuration(m.durationMs)
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right">{canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditItem(m)} />}</td>
                </tr>
              ))}
              {media.data && !media.data.items.length && (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-muted">
                    {t("mgmt.media.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {media.data && media.data.total > 100 && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 text-sm">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
              ←
            </Button>
            <span className="text-muted">
              {page + 1} / {Math.ceil(media.data.total / 100)}
            </span>
            <Button size="sm" variant="secondary" disabled={(page + 1) * 100 >= media.data.total} onClick={() => setPage(page + 1)}>
              →
            </Button>
          </div>
        )}
      </Card>

      {editSource && <SourceDialog source={editSource} onClose={() => setEditSource(null)} onSaved={() => void sources.reload()} />}
      {editItem && <MediaDialog item={editItem} categories={categories ?? []} onClose={() => setEditItem(null)} onSaved={() => void media.reload()} />}
      <Dialog
        open={assign !== null}
        onClose={() => setAssign(null)}
        title={t("mgmt.media.assignFolder")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssign(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={async () => {
                await post("/api/media/assign-category", { folder, categoryId: assign || null });
                setAssign(null);
                void media.reload();
              }}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("mgmt.media.assignFolderIntro", { folder })}</p>
          <Select value={assign ?? ""} onChange={(e) => setAssign(Number(e.target.value) || "")}>
            <option value="">{t("mgmt.week.noCategory")}</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </Dialog>
    </>
  );
}
