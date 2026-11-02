import { Alert, Badge, Button, Card, CardBody, Dialog, Field, Input, PageHeader, Select, Switch, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, Camera, CheckCircle2, Clapperboard, Globe, Image as ImageIcon, Pencil, Plus, RefreshCw, Search, Trash2, Video, Volume2, VolumeX, Webcam as WebcamIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { errorText, fmtDateTime, fmtDuration, useGet, type BlockSummary } from "../lib";

// ---- types -------------------------------------------------------------------------

export type WebcamKind = "hls" | "rtsp" | "rtmp" | "srt" | "video" | "mjpeg" | "image" | "page";
const KINDS: WebcamKind[] = ["hls", "rtsp", "rtmp", "srt", "video", "mjpeg", "image", "page"];
const VIDEO: WebcamKind[] = ["hls", "rtsp", "rtmp", "srt", "video"];
type Position = "bottom-left" | "bottom-right" | "top-left" | "top-right";
interface Settings {
  durationSec: number;
  audio: boolean;
  caption: { enabled: boolean; text: string; live: boolean; position: Position };
  showOverlay: boolean;
  fit: "cover" | "contain";
  refreshSec: number;
  via: "relay" | "direct";
}
interface StreamInfo {
  videoCodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  audioCodec?: string | null;
}
export interface Webcam {
  id: number;
  name: string;
  kind: WebcamKind;
  url: string;
  hasCredentials: boolean;
  pageUrl: string | null;
  settings: Settings;
  durationMs: number;
  status: "unknown" | "online" | "offline";
  info: StreamInfo;
  lastCheckAt: string | null;
  lastError: string | null;
  thumbnailUrl: string | null;
  usedIn: number;
  block: BlockSummary | null;
}
interface Candidate {
  url: string;
  kind: WebcamKind;
  found: string;
}
interface Inspect {
  url: string;
  kind: WebcamKind;
  pageUrl: string | null;
  title: string | null;
  candidates: Candidate[];
  youtube: boolean;
}
interface TestResult {
  ok: boolean;
  info: StreamInfo | null;
  error: string | null;
  thumbnail: string | null;
}

const defaults = (): Settings => ({ durationSec: 60, audio: false, caption: { enabled: true, text: "", live: true, position: "bottom-left" }, showOverlay: true, fit: "cover", refreshSec: 5, via: "relay" });

export const kindIcon = (k: WebcamKind, cls = "size-3.5") => (k === "image" ? <ImageIcon className={cls} /> : k === "page" ? <Globe className={cls} /> : k === "mjpeg" ? <Camera className={cls} /> : <Video className={cls} />);
const infoText = (i: StreamInfo | null | undefined) => (i?.width ? [`${i.width}×${i.height}`, i.videoCodec?.toUpperCase(), i.fps ? `${i.fps} fps` : null].filter(Boolean).join(" · ") : null);
const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    const s = `${x.host}${x.pathname}`;
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return u;
  }
};

// ---- add / edit dialog -------------------------------------------------------------------

function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)} className={cx("rounded-full border px-3 py-1 text-[13px] font-medium transition", value === o.value ? "border-brand bg-brand text-white" : "border-line hover:border-brand/50")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function WebcamDialog({ cam, onClose, onSaved }: { cam: Webcam | "new"; onClose: () => void; onSaved: (w: Webcam) => void }) {
  const { t } = useTranslation();
  const editing = cam !== "new";
  const [link, setLink] = useState(editing ? (cam.pageUrl ?? cam.url) : "");
  const [found, setFound] = useState<Inspect | null>(null);
  const [kind, setKind] = useState<WebcamKind>(editing ? cam.kind : "hls");
  const [url, setUrl] = useState(editing ? cam.url : "");
  const [pageUrl, setPageUrl] = useState<string | null>(editing ? cam.pageUrl : null);
  const [name, setName] = useState(editing ? cam.name : "");
  const [s, setS] = useState<Settings>(editing ? cam.settings : defaults());
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"inspect" | "test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const ready = editing || !!found;

  const runTest = async (k: WebcamKind, u: string) => {
    setBusy("test");
    setTest(null);
    try {
      setTest(await post<TestResult>("/api/webcams/test", { kind: k, url: u, id: editing ? cam.id : undefined }));
    } catch (e) {
      setTest({ ok: false, info: null, error: errorText(t, e), thumbnail: null });
    } finally {
      setBusy(null);
    }
  };
  const inspect = async () => {
    setBusy("inspect");
    setError(null);
    setTest(null);
    try {
      const r = await post<Inspect>("/api/webcams/inspect", { url: link });
      setFound(r);
      setKind(r.kind);
      setUrl(r.url);
      setPageUrl(r.pageUrl);
      if (!name) setName(r.title?.slice(0, 120) ?? "");
      setBusy(null);
      if (!r.youtube) void runTest(r.kind, r.url);
    } catch (e) {
      setError(errorText(t, e));
      setBusy(null);
    }
  };
  const pick = (c: Candidate) => {
    setKind(c.kind);
    setUrl(c.url);
    void runTest(c.kind, c.url);
  };
  useEffect(() => {
    if (editing) void runTest(cam.kind, cam.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const body = { name: name.trim(), kind, url, pageUrl, settings: s };
      onSaved(editing ? await put<Webcam>(`/api/webcams/${cam.id}`, body) : await post<Webcam>("/api/webcams", body));
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(null);
    }
  };
  const isVideo = VIDEO.includes(kind);

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={editing ? t("mgmt.cams.edit") : t("mgmt.cams.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} loading={busy === "save"} disabled={!ready || !name.trim() || !url}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Step 1: paste a link. */}
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-6 place-items-center rounded-full bg-brand text-xs text-white">1</span>
            {t("mgmt.cams.step1")}
          </div>
          <div className="flex gap-2">
            <Input className="flex-1" placeholder={t("mgmt.cams.linkPlaceholder")} value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === "Enter" && link.trim() && void inspect()} autoFocus={!editing} />
            <Button icon={<Search className="size-4" />} onClick={() => void inspect()} loading={busy === "inspect"} disabled={!link.trim()} variant={ready ? "secondary" : "primary"}>
              {t("mgmt.cams.lookUp")}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted">{t("mgmt.cams.linkHint")}</p>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {found?.youtube && <Alert tone="warn">{t("mgmt.cams.youtube")}</Alert>}
        {found && !found.youtube && found.pageUrl && found.kind === "page" && <Alert tone="warn">{t("mgmt.cams.noStream")}</Alert>}
        {found && found.candidates.length > 1 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">{t("mgmt.cams.foundMany", { count: found.candidates.length })}</div>
            <div className="space-y-1">
              {found.candidates.slice(0, 8).map((c) => (
                <button key={c.url} type="button" onClick={() => pick(c)} className={cx("flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition", c.url === url ? "border-brand bg-brand/8" : "border-line hover:border-brand/50")}>
                  {kindIcon(c.kind)}
                  <Badge tone="brand">{t(`mgmt.cams.kinds.${c.kind}`)}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{shortUrl(c.url)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {ready && (
          <>
            {/* Preview */}
            <div className="grid gap-4 sm:grid-cols-[260px_1fr]">
              <div className="relative grid aspect-video place-items-center overflow-hidden rounded-lg border border-line bg-surface-2">
                {test?.thumbnail ? <img src={test.thumbnail} alt="" className="absolute inset-0 size-full object-cover" /> : busy === "test" ? <RefreshCw className="size-5 animate-spin text-muted" /> : kindIcon(kind, "size-8 text-muted")}
                {s.caption.enabled && test?.thumbnail && (
                  <span className={cx("absolute flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white", s.caption.position.startsWith("top") ? "top-2" : "bottom-2", s.caption.position.endsWith("left") ? "left-2" : "right-2")}>
                    {s.caption.live && <span className="rounded-sm bg-[#E92E7F] px-1 text-[9px] uppercase">Live</span>}
                    {s.caption.text || name}
                  </span>
                )}
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">
                    {kindIcon(kind)}
                    {t(`mgmt.cams.kinds.${kind}`)}
                  </Badge>
                  {busy === "test" && <span className="text-xs text-muted">{t("mgmt.cams.testing")}</span>}
                  {test?.ok && (
                    <Badge tone="ok">
                      <CheckCircle2 className="size-3" />
                      {t("mgmt.cams.works")}
                    </Badge>
                  )}
                  {test && !test.ok && (
                    <Badge tone="danger">
                      <AlertTriangle className="size-3" />
                      {t("mgmt.cams.noPicture")}
                    </Badge>
                  )}
                </div>
                {infoText(test?.info) && <div className="text-xs text-muted">{infoText(test?.info)}</div>}
                {test?.info && <div className="text-xs text-muted">{test.info.audioCodec ? t("mgmt.cams.hasSound", { codec: test.info.audioCodec.toUpperCase() }) : t("mgmt.cams.noSound")}</div>}
                {test && !test.ok && test.error && <div className="font-mono text-[11.5px] break-all text-danger">{test.error}</div>}
                {kind === "page" && <p className="text-xs text-muted">{t("mgmt.cams.pageHint")}</p>}
                <div className="truncate font-mono text-[11.5px] text-muted" title={url}>
                  {shortUrl(url)}
                </div>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void runTest(kind, url)} disabled={busy != null}>
                  {t("mgmt.cams.testAgain")}
                </Button>
              </div>
            </div>

            {/* Step 2: how it goes on air. */}
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <span className="grid size-6 place-items-center rounded-full bg-brand text-xs text-white">2</span>
                {t("mgmt.cams.step2")}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mgmt.cams.name")}>{(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t("mgmt.cams.namePlaceholder")} />}</Field>
                <Field label={t("mgmt.cams.length")} hint={t("mgmt.cams.lengthHint")}>
                  {() => (
                    <Chips
                      value={s.durationSec}
                      onChange={(v) => setS({ ...s, durationSec: v })}
                      options={[30, 60, 120, 300, 600, ...([30, 60, 120, 300, 600].includes(s.durationSec) ? [] : [s.durationSec])].map((v) => ({ value: v, label: fmtDuration(v * 1000) }))}
                    />
                  )}
                </Field>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <Switch checked={s.caption.enabled} onChange={(v) => setS({ ...s, caption: { ...s.caption, enabled: v } })} label={t("mgmt.cams.caption")} description={t("mgmt.cams.captionHint")} />
                  {s.caption.enabled && (
                    <div className="space-y-2 pl-12">
                      <Input value={s.caption.text} maxLength={120} placeholder={name || t("mgmt.cams.captionPlaceholder")} onChange={(e) => setS({ ...s, caption: { ...s.caption, text: e.target.value } })} />
                      <Switch checked={s.caption.live} onChange={(v) => setS({ ...s, caption: { ...s.caption, live: v } })} label={t("mgmt.cams.liveBadge")} />
                      <Select value={s.caption.position} onChange={(e) => setS({ ...s, caption: { ...s.caption, position: e.target.value as Position } })} aria-label={t("mgmt.cams.position")}>
                        {(["bottom-left", "bottom-right", "top-left", "top-right"] as const).map((p) => (
                          <option key={p} value={p}>
                            {t(`mgmt.graphics.positions.${p}`)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  {isVideo && <Switch checked={s.audio} onChange={(v) => setS({ ...s, audio: v })} label={t("mgmt.cams.sound")} description={t("mgmt.cams.soundHint")} />}
                  <Switch checked={s.showOverlay} onChange={(v) => setS({ ...s, showOverlay: v })} label={t("mgmt.cams.overlay")} description={t("mgmt.cams.overlayHint")} />
                  {kind === "image" && (
                    <Field label={t("mgmt.cams.refresh")}>
                      {(id) => <Input id={id} type="number" min={1} max={600} value={s.refreshSec} onChange={(e) => setS({ ...s, refreshSec: Math.max(1, Math.min(600, Number(e.target.value) || 5)) })} />}
                    </Field>
                  )}
                </div>
              </div>
              <button type="button" className="mt-4 text-xs font-medium text-brand hover:underline" onClick={() => setAdvanced(!advanced)}>
                {advanced ? t("mgmt.cams.lessOptions") : t("mgmt.cams.moreOptions")}
              </button>
              {advanced && (
                <div className="mt-3 grid gap-4 rounded-lg border border-line bg-surface-2/40 p-4 sm:grid-cols-2">
                  <Field label={t("mgmt.cams.kind")}>
                    {(id) => (
                      <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as WebcamKind)}>
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`mgmt.cams.kinds.${k}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("mgmt.cams.streamUrl")} hint={editing && cam.hasCredentials ? t("mgmt.cams.credentialsKept") : undefined}>
                    {(id) => <Input id={id} className="font-mono text-[12.5px]" value={url} onChange={(e) => setUrl(e.target.value)} />}
                  </Field>
                  {isVideo && (
                    <Field label={t("mgmt.cams.via")} hint={t(`mgmt.cams.viaHint_${s.via}`)}>
                      {(id) => (
                        <Select id={id} value={s.via} onChange={(e) => setS({ ...s, via: e.target.value as Settings["via"] })}>
                          <option value="relay">{t("mgmt.cams.via_relay")}</option>
                          <option value="direct">{t("mgmt.cams.via_direct")}</option>
                        </Select>
                      )}
                    </Field>
                  )}
                  {(kind === "image" || kind === "mjpeg") && (
                    <Field label={t("mgmt.cams.fit")}>
                      {(id) => (
                        <Select id={id} value={s.fit} onChange={(e) => setS({ ...s, fit: e.target.value as Settings["fit"] })}>
                          <option value="cover">{t("mgmt.cams.fit_cover")}</option>
                          <option value="contain">{t("mgmt.cams.fit_contain")}</option>
                        </Select>
                      )}
                    </Field>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---- page --------------------------------------------------------------------------------

export function WebcamsPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const navigate = useNavigate();
  const canEdit = roleAtLeast(user?.role, "editor");
  const list = useGet<{ webcams: Webcam[] }>("/api/webcams", 30_000);
  const [dialog, setDialog] = useState<Webcam | "new" | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cams = list.data?.webcams ?? [];

  const check = async (w: Webcam) => {
    setChecking(w.id);
    try {
      await post(`/api/webcams/${w.id}/check`);
      await list.reload();
    } finally {
      setChecking(null);
    }
  };
  const remove = async (w: Webcam) => {
    if (!confirm(t("mgmt.cams.confirmDelete", { name: w.name }))) return;
    setError(null);
    try {
      await del(`/api/webcams/${w.id}`);
    } catch (e) {
      if (!confirm(t("mgmt.cams.confirmDeleteUsed", { name: w.name }))) return;
      try {
        await del(`/api/webcams/${w.id}?force=true`);
      } catch (e2) {
        setError(errorText(t, e2 ?? e));
      }
    }
    await list.reload();
  };
  const openBlock = async (w: Webcam) => {
    const r = w.block ? { id: w.block.id } : await post<{ id: number }>(`/api/webcams/${w.id}/block`);
    navigate(`/blocks/${r.id}`);
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.cams.title")}
        description={t("mgmt.cams.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setDialog("new")}>
              {t("mgmt.cams.add")}
            </Button>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {list.data && !cams.length ? (
        <Card>
          <CardBody className="py-14 text-center">
            <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-brand/10 text-brand">
              <WebcamIcon className="size-7" />
            </span>
            <div className="text-base font-semibold">{t("mgmt.cams.emptyTitle")}</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t("mgmt.cams.emptyText")}</p>
            {canEdit && (
              <Button className="mt-5" icon={<Plus className="size-4" />} onClick={() => setDialog("new")}>
                {t("mgmt.cams.add")}
              </Button>
            )}
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{t("mgmt.cams.howToPlan")}</p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {cams.map((w) => (
              <Card key={w.id} className="flex flex-col overflow-hidden">
                <div className="relative aspect-video bg-surface-2">
                  {w.thumbnailUrl ? <img src={w.thumbnailUrl} alt="" className="absolute inset-0 size-full object-cover" /> : <span className="absolute inset-0 grid place-items-center text-muted">{kindIcon(w.kind, "size-8")}</span>}
                  <span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white">
                    <span className={cx("size-2 rounded-full", w.status === "online" ? "bg-emerald-400" : w.status === "offline" ? "bg-red-500" : "bg-zinc-400")} />
                    {t(`mgmt.cams.status_${w.status}`)}
                  </span>
                  <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
                    {kindIcon(w.kind, "size-3")}
                    {t(`mgmt.cams.kinds.${w.kind}`)}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-4">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-semibold">{w.name}</span>
                    {VIDEO.includes(w.kind) && (w.settings.audio ? <Volume2 className="size-3.5 text-muted" /> : <VolumeX className="size-3.5 text-muted" />)}
                  </div>
                  <div className="text-xs text-muted">
                    {fmtDuration(w.durationMs)}
                    {infoText(w.info) ? ` · ${infoText(w.info)}` : ""}
                    {w.usedIn > 1 ? ` · ${t("mgmt.cams.usedIn", { count: w.usedIn - 1 })}` : ""}
                  </div>
                  {w.status === "offline" && w.lastError && (
                    <div className="truncate text-xs text-danger" title={w.lastError}>
                      {w.lastError}
                    </div>
                  )}
                  {w.lastCheckAt && <div className="text-[11px] text-muted">{t("mgmt.cams.checkedAt", { at: fmtDateTime(w.lastCheckAt) })}</div>}
                  {canEdit && (
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                      <Button size="sm" variant="secondary" icon={<Clapperboard className="size-3.5" />} onClick={() => void openBlock(w)} title={t("mgmt.cams.blockHint")}>
                        {t("mgmt.cams.block")}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDialog(w)} aria-label={t("mgmt.cams.edit")} title={t("mgmt.cams.edit")} />
                      <Button size="sm" variant="ghost" icon={<RefreshCw className={cx("size-3.5", checking === w.id && "animate-spin")} />} onClick={() => void check(w)} disabled={checking === w.id} aria-label={t("mgmt.cams.check")} title={t("mgmt.cams.check")} />
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(w)} aria-label={t("common.delete")} title={t("common.delete")} />
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      {dialog && (
        <WebcamDialog
          cam={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void list.reload();
            // The first check (thumbnail) runs in the background.
            setTimeout(() => void list.reload(), 4000);
          }}
        />
      )}
    </>
  );
}
