import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Switch, Textarea, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AudioLines, Camera, Disc3, FileUp, FolderSearch, Link2, Mic, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, fmtDuration, fmtDateTime, fmtTime, useChannels, useGet } from "../lib";
import { CopyField } from "./RemoteSources";

interface MicCfg {
  key: string;
  name: string;
  input: number;
  priority: number;
}
interface Station {
  id: number;
  name: string;
  enabled: boolean;
  channelId: number | null;
  studioId: number | null;
  casparChannel: number;
  clipInput: number | null;
  wideInput: number | null;
  loopInput: number | null;
  fallback: "loop" | "wide";
  transition: "cut" | "mix";
  openDelayMs: number;
  closeDelayMs: number;
  minShotMs: number;
  fuzzyThreshold: number;
  clipSourceId: number | null;
  clipFolder: string;
  rdsPort: number | null;
  mics: MicCfg[];
  urls: { nowPlaying: string; mic: string };
}
interface Live {
  enabled: boolean;
  nowPlaying: { artist: string; title: string; type: string; songId: string | null; durationMs: number | null; startedAt: string; stale: boolean } | null;
  match: { clipId: number; artist: string; title: string; how: string; score: number } | null;
  clip: { title: string; running: boolean; endsAt: string | null } | null;
  mics: { key: string; name: string; input: number; open: boolean; live: boolean }[];
  shot: { input: number | null; reason: string; mic?: string; held?: boolean } | null;
  onAir: { input: number; since: number } | null;
  manualInput: number | null;
  paused: boolean;
  lastError: string | null;
  log: { at: string; kind: string; text: string }[];
  clips: number;
}
interface Clip {
  id: number;
  artist: string;
  title: string;
  songId: string | null;
  offsetMs: number;
  enabled: boolean;
  plays: number;
  lastPlayedAt: string | null;
  path: string;
  durationMs: number | null;
  missing: boolean;
}
interface Song {
  id: number;
  artist: string;
  title: string;
  songId: string | null;
  plays: number;
  lastAt: string | null;
}

const EMPTY: Omit<Station, "id" | "urls"> = {
  name: "",
  enabled: false,
  channelId: null,
  studioId: null,
  casparChannel: 1,
  clipInput: null,
  wideInput: null,
  loopInput: null,
  fallback: "loop",
  transition: "cut",
  openDelayMs: 250,
  closeDelayMs: 1500,
  minShotMs: 3000,
  fuzzyThreshold: 0.82,
  clipSourceId: null,
  clipFolder: "",
  rdsPort: null,
  mics: [{ key: "dj", name: "DJ", input: 4, priority: 10 }],
};

const num = (v: string) => (v.trim() === "" ? null : Number(v));

export function VisualRadioPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const isAdmin = roleAtLeast(user?.role, "admin");
  const stations = useGet<{ stations: Station[] }>("/api/visualradio/stations");
  const [sel, setSel] = useState<number | null>(null);
  const [tab, setTab] = useState<"live" | "clips" | "settings">("live");
  const [creating, setCreating] = useState(false);
  const list = stations.data?.stations ?? [];
  const station = list.find((s) => s.id === sel) ?? list[0] ?? null;

  return (
    <>
      <PageHeader
        title={t("mgmt.vr.title")}
        description={t("mgmt.vr.intro")}
        actions={
          <div className="flex items-center gap-2">
            {list.length > 1 && (
              <Select value={station?.id ?? ""} onChange={(e) => setSel(Number(e.target.value))} aria-label={t("mgmt.vr.station")}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
            {isAdmin && (
              <Button icon={<Plus className="size-4" />} onClick={() => (setCreating(true), setTab("settings"))}>
                {t("mgmt.vr.newStation")}
              </Button>
            )}
          </div>
        }
      />
      {stations.data && !list.length && !creating && (
        <Card>
          <div className="px-5 py-12 text-center">
            <Disc3 className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("mgmt.vr.none")}</p>
            <p className="mx-auto max-w-xl text-sm text-muted">{t("mgmt.vr.noneIntro")}</p>
          </div>
        </Card>
      )}
      {(station || creating) && (
        <>
          {!creating && (
            <div className="mb-4 inline-flex rounded-lg border border-line bg-surface p-1">
              {(["live", "clips", "settings"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setTab(k)} className={cx("rounded-md px-3 py-1.5 text-sm font-medium transition", tab === k ? "bg-brand text-white shadow-sm" : "text-muted hover:text-fg")}>
                  {t(`mgmt.vr.tabs.${k}`)}
                </button>
              ))}
            </div>
          )}
          {creating ? (
            <SettingsTab
              key="new"
              station={null}
              onSaved={(id) => {
                setCreating(false);
                setSel(id);
                setTab("live");
                void stations.reload();
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            station && (
              <>
                {tab === "live" && <LiveTab station={station} />}
                {tab === "clips" && <ClipsTab station={station} />}
                {tab === "settings" && <SettingsTab key={station.id} station={station} onSaved={() => void stations.reload()} onDeleted={() => (setSel(null), setTab("live"), void stations.reload())} />}
              </>
            )
          )}
        </>
      )}
    </>
  );
}

// ---- Live ----------------------------------------------------------------------------

function LiveTab({ station }: { station: Station }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const canOperate = roleAtLeast(user?.role, "operator");
  const live = useGet<Live>(`/api/visualradio/stations/${station.id}/live`, 1000);
  const [test, setTest] = useState({ artist: "", title: "" });
  const l = live.data;
  const action = async (path: string, body: unknown) => {
    await post(`/api/visualradio/stations/${station.id}/${path}`, body);
    void live.reload();
  };
  const inputs = [
    station.clipInput != null && { input: station.clipInput, label: t("mgmt.vr.clipInput") },
    station.wideInput != null && { input: station.wideInput, label: t("mgmt.vr.wideInput") },
    station.loopInput != null && { input: station.loopInput, label: t("mgmt.vr.loopInput") },
    ...station.mics.map((m) => ({ input: m.input, label: m.name })),
  ].filter(Boolean) as { input: number; label: string }[];
  const inputName = (n: number | null | undefined) => (n == null ? "–" : (inputs.find((i) => i.input === n)?.label ?? `${t("mgmt.vr.input")} ${n}`));

  return (
    <div className="space-y-4">
      {!station.enabled && <Alert tone="warn">{t("mgmt.vr.disabled")}</Alert>}
      {l?.lastError && <Alert tone="danger">{l.lastError === "no_atem" ? t("mgmt.errors.no_atem") : l.lastError}</Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader icon={<AudioLines className="size-4" />} title={t("mgmt.vr.nowPlaying")} />
          <CardBody>
            {l?.nowPlaying ? (
              <div className={cx(l.nowPlaying.stale && "opacity-50")}>
                <p className="text-2xl font-semibold leading-tight">{l.nowPlaying.title || "–"}</p>
                <p className="text-lg text-muted">{l.nowPlaying.artist}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={l.nowPlaying.type === "music" ? "brand" : "neutral"}>{t(`mgmt.vr.types.${l.nowPlaying.type}`)}</Badge>
                  {l.nowPlaying.stale && <Badge tone="warn">{t("mgmt.vr.stale")}</Badge>}
                  <span className="text-muted">
                    {t("mgmt.vr.since", { time: fmtTime(l.nowPlaying.startedAt, true) })}
                    {l.nowPlaying.durationMs ? ` · ${fmtDuration(l.nowPlaying.durationMs)}` : ""}
                  </span>
                </div>
                <div className="mt-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
                  {l.match ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Play className="size-4 text-ok" />
                      <span className="font-medium">
                        {l.match.artist} - {l.match.title}
                      </span>
                      <Badge tone={l.match.how === "fuzzy" ? "warn" : "ok"}>
                        {t(`mgmt.vr.how.${l.match.how}`)}
                        {l.match.how === "fuzzy" ? ` ${Math.round(l.match.score * 100)}%` : ""}
                      </Badge>
                      {l.clip && !l.clip.running && <Badge>{t("mgmt.vr.clipEnded")}</Badge>}
                    </span>
                  ) : (
                    <span className="text-muted">{l.nowPlaying.type === "music" ? t("mgmt.vr.noClip") : t("mgmt.vr.noClipNeeded")}</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">{t("mgmt.vr.waiting")}</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Camera className="size-4" />} title={t("mgmt.vr.onAir")} />
          <CardBody>
            <p className={cx("text-3xl font-semibold", !l?.onAir && "text-muted")}>{inputName(l?.onAir?.input ?? l?.shot?.input)}</p>
            <p className="text-sm text-muted">
              {[
                (l?.onAir?.input ?? l?.shot?.input) != null && `${t("mgmt.vr.input")} ${l?.onAir?.input ?? l?.shot?.input}`,
                l?.shot && `${t(`mgmt.vr.reasons.${l.shot.reason}`)}${l.shot.held ? ` (${t("mgmt.vr.held")})` : ""}`,
                l && !l.onAir && l.shot?.input != null && t("mgmt.vr.notSwitched"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="mt-4 space-y-2">
              {l?.mics.map((m) => (
                <div key={m.key} className="flex items-center gap-2 text-sm">
                  <span className={cx("size-2.5 rounded-full", m.live ? "bg-danger shadow-[0_0_8px] shadow-danger" : m.open ? "bg-warn" : "bg-line")} />
                  <Mic className="size-3.5 text-muted" />
                  <span className="flex-1">{m.name}</span>
                  <span className="text-xs text-muted">{m.live ? t("mgmt.vr.micLive") : m.open ? t("mgmt.vr.micOpen") : t("mgmt.vr.micClosed")}</span>
                  {canOperate && (
                    <Button size="sm" variant="ghost" onClick={() => void action("simulate", { mic: m.key, open: !m.open })}>
                      {m.open ? t("mgmt.vr.close") : t("mgmt.vr.open")}
                    </Button>
                  )}
                </div>
              ))}
              {!l?.mics.length && <p className="text-sm text-muted">{t("mgmt.vr.noMics")}</p>}
            </div>
          </CardBody>
        </Card>
      </div>

      {canOperate && (
        <Card>
          <CardHeader title={t("mgmt.vr.control")} description={t("mgmt.vr.controlIntro")} />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant={l?.manualInput == null ? "primary" : "secondary"} icon={<Wand2 className="size-4" />} onClick={() => void action("manual", { input: null })}>
                {t("mgmt.vr.auto")}
              </Button>
              {inputs.map((i) => (
                <Button key={`${i.input}-${i.label}`} variant={l?.manualInput === i.input ? "primary" : "secondary"} onClick={() => void action("manual", { input: i.input })}>
                  {i.label}
                </Button>
              ))}
              <Button variant={l?.paused ? "primary" : "secondary"} icon={<Pause className="size-4" />} onClick={() => void action("manual", { paused: !l?.paused })}>
                {l?.paused ? t("mgmt.vr.resume") : t("mgmt.vr.pause")}
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
              <Field label={t("mgmt.vr.artist")} className="min-w-40 flex-1">
                {(id) => <Input id={id} value={test.artist} onChange={(e) => setTest({ ...test, artist: e.target.value })} />}
              </Field>
              <Field label={t("mgmt.vr.songTitle")} className="min-w-40 flex-1">
                {(id) => <Input id={id} value={test.title} onChange={(e) => setTest({ ...test, title: e.target.value })} />}
              </Field>
              <Button variant="secondary" disabled={!test.title} onClick={() => void action("simulate", { ...test, type: "music" })}>
                {t("mgmt.vr.testSong")}
              </Button>
              <Button variant="secondary" onClick={() => void action("simulate", { title: "Jingle", type: "jingle" })}>
                {t("mgmt.vr.testJingle")}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title={t("mgmt.vr.log")} />
        <div className="max-h-80 divide-y divide-line overflow-auto">
          {l?.log.map((e, i) => (
            <div key={i} className="flex gap-3 px-5 py-2 text-sm">
              <span className="w-20 shrink-0 text-muted tabular-nums">{fmtTime(e.at, true)}</span>
              <Badge tone={e.kind === "error" ? "danger" : e.kind === "shot" ? "brand" : e.kind === "mic" ? "warn" : "neutral"}>{t(`mgmt.vr.logKinds.${e.kind}`)}</Badge>
              <span className="min-w-0 flex-1 truncate">{e.text}</span>
            </div>
          ))}
          {!l?.log.length && <p className="px-5 py-4 text-sm text-muted">{t("mgmt.vr.logEmpty")}</p>}
        </div>
      </Card>
    </div>
  );
}

// ---- Clips ---------------------------------------------------------------------------

function ClipsTab({ station }: { station: Station }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(h);
  }, [q]);
  const clips = useGet<{ total: number; clips: Clip[] }>(`/api/visualradio/stations/${station.id}/clips?q=${encodeURIComponent(query)}`);
  const missing = useGet<{ total: number; songs: Song[] }>(`/api/visualradio/stations/${station.id}/missing`);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [edit, setEdit] = useState<Clip | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [link, setLink] = useState<Song | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      void clips.reload();
      void missing.reload();
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const scan = () =>
    run(async () => {
      const r = await post<{ files: number; added: number; updated: number; unnamed: number }>(`/api/visualradio/stations/${station.id}/clips/scan`, {});
      return t("mgmt.vr.scanned", r);
    });
  const importCsv = () =>
    run(async () => {
      const r = await post<{ rows: number; imported: number; notFound: string[] }>(`/api/visualradio/stations/${station.id}/clips/import`, { csv });
      setCsv(null);
      return t("mgmt.vr.imported", { ...r, notFound: r.notFound.length });
    });

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card>
        <CardHeader
          icon={<Disc3 className="size-4" />}
          title={t("mgmt.vr.library", { n: clips.data?.total ?? 0 })}
          description={t("mgmt.vr.libraryIntro")}
          actions={
            canEdit && (
              <div className="flex gap-2">
                <Button variant="secondary" icon={<FolderSearch className="size-4" />} disabled={!station.clipSourceId} onClick={() => void scan()} title={station.clipSourceId ? undefined : t("mgmt.errors.no_clip_source")}>
                  {t("mgmt.vr.scan")}
                </Button>
                <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setCsv("")}>
                  {t("mgmt.vr.import")}
                </Button>
              </div>
            )
          }
        />
        <div className="border-b border-line px-5 py-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("mgmt.vr.search")} className="pl-9" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">{t("mgmt.vr.artist")}</th>
                <th className="px-3 py-2 font-medium">{t("mgmt.vr.songTitle")}</th>
                <th className="px-3 py-2 font-medium">{t("mgmt.vr.songId")}</th>
                <th className="px-3 py-2 font-medium">{t("mgmt.vr.offset")}</th>
                <th className="px-3 py-2 font-medium">{t("mgmt.vr.plays")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {clips.data?.clips.map((c) => (
                <tr key={c.id} className={cx(!c.enabled && "opacity-50")}>
                  <td className="px-5 py-2 font-medium">{c.artist}</td>
                  <td className="px-3 py-2">
                    {c.title}
                    <span className="block truncate text-xs text-muted">{c.path}</span>
                  </td>
                  <td className="px-3 py-2">{c.songId ? <Mono>{c.songId}</Mono> : "–"}</td>
                  <td className="px-3 py-2 tabular-nums">{c.offsetMs ? fmtDuration(c.offsetMs) : "–"}</td>
                  <td className="px-3 py-2 tabular-nums">{c.plays}</td>
                  <td className="px-3 py-2 text-right">{canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit(c)} title={t("common.edit")} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {clips.data && !clips.data.clips.length && <p className="px-5 py-6 text-center text-sm text-muted">{t("mgmt.vr.noClips")}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Link2 className="size-4" />} title={t("mgmt.vr.missing", { n: missing.data?.total ?? 0 })} description={t("mgmt.vr.missingIntro")} actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void missing.reload()} />} />
        <div className="divide-y divide-line">
          {missing.data?.songs.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-5 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{s.artist}</span> - {s.title}
              </span>
              <span className="text-xs text-muted">
                {t("mgmt.vr.playedTimes", { n: s.plays })}
                {s.lastAt ? ` · ${fmtDateTime(s.lastAt)}` : ""}
              </span>
              {canEdit && (
                <>
                  <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} onClick={() => setLink(s)}>
                    {t("mgmt.vr.link")}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} title={t("common.delete")} onClick={() => void del(`/api/visualradio/songs/${s.id}`).then(() => missing.reload())} />
                </>
              )}
            </div>
          ))}
          {missing.data && !missing.data.songs.length && <p className="px-5 py-6 text-center text-sm text-muted">{t("mgmt.vr.noMissing")}</p>}
        </div>
      </Card>

      <ClipDialog clip={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), void clips.reload(), void missing.reload())} />
      <Dialog
        open={csv != null}
        onClose={() => setCsv(null)}
        title={t("mgmt.vr.import")}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setCsv(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!csv?.trim()} onClick={() => void importCsv()}>
              {t("mgmt.vr.import")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("mgmt.vr.importIntro")}</p>
          <Mono>artist;title;path;songId;offsetMs</Mono>
          <input type="file" accept=".csv,.txt,text/csv" className="block text-sm" onChange={(e) => void e.target.files?.[0]?.text().then(setCsv)} />
          <Textarea rows={8} value={csv ?? ""} onChange={(e) => setCsv(e.target.value)} className="font-mono text-[12.5px]" />
        </div>
      </Dialog>
      <LinkDialog station={station} song={link} onClose={() => setLink(null)} onLinked={() => (setLink(null), void missing.reload())} />
    </div>
  );
}

function ClipDialog({ clip, onClose, onSaved }: { clip: Clip | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<Clip | null>(clip);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => (setF(clip), setErr(null)), [clip]);
  const save = async () => {
    if (!f) return;
    try {
      await put(`/api/visualradio/clips/${f.id}`, { artist: f.artist, title: f.title, songId: f.songId || null, offsetMs: f.offsetMs, enabled: f.enabled });
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  return (
    <Dialog
      open={!!clip}
      onClose={onClose}
      title={t("mgmt.vr.editClip")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </>
      }
    >
      {f && (
        <div className="space-y-4">
          {err && <Alert tone="danger">{err}</Alert>}
          <p className="truncate text-xs text-muted">{f.path}</p>
          <Field label={t("mgmt.vr.artist")}>{(id) => <Input id={id} value={f.artist} onChange={(e) => setF({ ...f, artist: e.target.value })} />}</Field>
          <Field label={t("mgmt.vr.songTitle")}>{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("mgmt.vr.songId")} hint={t("mgmt.vr.songIdHint")}>
              {(id) => <Input id={id} value={f.songId ?? ""} onChange={(e) => setF({ ...f, songId: e.target.value })} />}
            </Field>
            <Field label={t("mgmt.vr.offsetSeconds")} hint={t("mgmt.vr.offsetHint")}>
              {(id) => <Input id={id} type="number" min={0} step={0.1} value={f.offsetMs / 1000} onChange={(e) => setF({ ...f, offsetMs: Math.max(0, Math.round(Number(e.target.value) * 1000) || 0) })} />}
            </Field>
          </div>
          <Switch checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} label={t("mgmt.vr.clipEnabled")} />
        </div>
      )}
    </Dialog>
  );
}

function LinkDialog({ station, song, onClose, onLinked }: { station: Station; song: Song | null; onClose: () => void; onLinked: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  useEffect(() => setQ(song ? song.title : ""), [song]);
  const res = useGet<{ clips: Clip[] }>(song ? `/api/visualradio/stations/${station.id}/clips?limit=30&q=${encodeURIComponent(q)}` : null);
  return (
    <Dialog open={!!song} onClose={onClose} title={t("mgmt.vr.linkTitle", { song: song ? `${song.artist} - ${song.title}` : "" })}>
      <div className="space-y-3">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("mgmt.vr.search")} />
        <div className="max-h-80 divide-y divide-line overflow-auto rounded-lg border border-line">
          {res.data?.clips.map((c) => (
            <button
              key={c.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
              onClick={() => song && void post(`/api/visualradio/songs/${song.id}/link`, { clipId: c.id }).then(onLinked)}
            >
              <span className="font-medium">{c.artist}</span> - {c.title}
            </button>
          ))}
          {res.data && !res.data.clips.length && <p className="px-3 py-4 text-sm text-muted">{t("mgmt.vr.noClips")}</p>}
        </div>
      </div>
    </Dialog>
  );
}

// ---- Settings --------------------------------------------------------------------------

function SettingsTab({ station, onSaved, onCancel, onDeleted }: { station: Station | null; onSaved: (id: number) => void; onCancel?: () => void; onDeleted?: () => void }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const isAdmin = roleAtLeast(user?.role, "admin");
  const { channels } = useChannels();
  const studios = useGet<{ studios: { id: number; name: string; status: { channels?: number[] | null } }[] }>("/api/studios");
  const sources = useGet<{ sources: { id: number; name: string }[] }>("/api/media/sources");
  const [f, setF] = useState<Omit<Station, "id" | "urls">>(() => (station ? { ...station } : { ...EMPTY }));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (p: Partial<typeof f>) => (setF({ ...f, ...p }), setSaved(false));
  const setMic = (i: number, p: Partial<MicCfg>) => set({ mics: f.mics.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  const save = async () => {
    setErr(null);
    try {
      const body = { ...f };
      const r = station ? await put<{ id: number }>(`/api/visualradio/stations/${station.id}`, body) : await post<{ id: number }>("/api/visualradio/stations", body);
      setSaved(true);
      onSaved(r.id);
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async () => {
    if (!station || !confirm(t("mgmt.vr.confirmDelete", { name: station.name }))) return;
    await del(`/api/visualradio/stations/${station.id}`);
    onDeleted?.();
  };
  const newToken = async () => {
    if (!station || !confirm(t("mgmt.vr.confirmToken"))) return;
    await post(`/api/visualradio/stations/${station.id}/token`, {});
    onSaved(station.id);
  };
  const ro = !isAdmin;
  const inputField = (label: string, key: "clipInput" | "wideInput" | "loopInput", hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" min={0} disabled={ro} value={f[key] ?? ""} onChange={(e) => set({ [key]: num(e.target.value) })} />}
    </Field>
  );

  return (
    <div className="space-y-4">
      {err && <Alert tone="danger">{err}</Alert>}
      {saved && <Alert tone="ok">{t("mgmt.vr.saved")}</Alert>}
      <Card>
        <CardHeader title={t("mgmt.vr.general")} />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label={t("common.name")}>{(id) => <Input id={id} disabled={ro} value={f.name} placeholder="IJmond360 Radio" onChange={(e) => set({ name: e.target.value })} />}</Field>
          <div className="flex items-end pb-2">
            <Switch checked={f.enabled} onChange={(enabled) => !ro && set({ enabled })} label={t("mgmt.vr.enabled")} description={t("mgmt.vr.enabledHint")} />
          </div>
          <Field label={t("mgmt.vr.channel")} hint={t("mgmt.vr.channelHint")}>
            {(id) => (
              <Select id={id} disabled={ro} value={f.channelId ?? ""} onChange={(e) => set({ channelId: num(e.target.value) })}>
                <option value="">–</option>
                {channels?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("mgmt.vr.transition")}>
            {(id) => (
              <Select id={id} disabled={ro} value={f.transition} onChange={(e) => set({ transition: e.target.value as "cut" | "mix" })}>
                <option value="cut">{t("mgmt.vr.cut")}</option>
                <option value="mix">{t("mgmt.vr.mix")}</option>
              </Select>
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("mgmt.vr.node")} description={t("mgmt.vr.nodeIntro")} />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <Field label={t("mgmt.vr.studio")}>
            {(id) => (
              <Select id={id} disabled={ro} value={f.studioId ?? ""} onChange={(e) => set({ studioId: num(e.target.value) })}>
                <option value="">–</option>
                {studios.data?.studios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("mgmt.vr.casparChannel")}>{(id) => <Input id={id} type="number" min={1} disabled={ro} value={f.casparChannel} onChange={(e) => set({ casparChannel: Number(e.target.value) || 1 })} />}</Field>
          {inputField(t("mgmt.vr.clipInput"), "clipInput", t("mgmt.vr.clipInputHint"))}
          {inputField(t("mgmt.vr.wideInput"), "wideInput", t("mgmt.vr.wideInputHint"))}
          {inputField(t("mgmt.vr.loopInput"), "loopInput", t("mgmt.vr.loopInputHint"))}
          <Field label={t("mgmt.vr.fallback")}>
            {(id) => (
              <Select id={id} disabled={ro} value={f.fallback} onChange={(e) => set({ fallback: e.target.value as "loop" | "wide" })}>
                <option value="loop">{t("mgmt.vr.loopInput")}</option>
                <option value="wide">{t("mgmt.vr.wideInput")}</option>
              </Select>
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<Mic className="size-4" />}
          title={t("mgmt.vr.mics")}
          description={t("mgmt.vr.micsIntro")}
          actions={
            !ro && (
              <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => set({ mics: [...f.mics, { key: `mic${f.mics.length + 1}`, name: `Mic ${f.mics.length + 1}`, input: 5, priority: 0 }] })}>
                {t("mgmt.vr.addMic")}
              </Button>
            )
          }
        />
        <CardBody className="space-y-3">
          {f.mics.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_8rem_6rem_auto] items-end gap-2">
              <Field label={i === 0 ? t("common.name") : ""}>{(id) => <Input id={id} disabled={ro} value={m.name} onChange={(e) => setMic(i, { name: e.target.value })} />}</Field>
              <Field label={i === 0 ? t("mgmt.vr.micKey") : ""}>{(id) => <Input id={id} disabled={ro} className="font-mono" value={m.key} onChange={(e) => setMic(i, { key: e.target.value.replace(/[^\w.-]/g, "") })} />}</Field>
              <Field label={i === 0 ? t("mgmt.vr.camera") : ""}>{(id) => <Input id={id} type="number" min={0} disabled={ro} value={m.input} onChange={(e) => setMic(i, { input: Number(e.target.value) || 0 })} />}</Field>
              <Field label={i === 0 ? t("mgmt.vr.priority") : ""}>{(id) => <Input id={id} type="number" min={0} max={100} disabled={ro} value={m.priority} onChange={(e) => setMic(i, { priority: Number(e.target.value) || 0 })} />}</Field>
              {!ro && <Button variant="ghost" icon={<Trash2 className="size-4" />} title={t("common.delete")} onClick={() => set({ mics: f.mics.filter((_, j) => j !== i) })} />}
            </div>
          ))}
          <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-3">
            <Field label={t("mgmt.vr.openDelay")} hint={t("mgmt.vr.openDelayHint")}>
              {(id) => <Input id={id} type="number" min={0} step={50} disabled={ro} value={f.openDelayMs} onChange={(e) => set({ openDelayMs: Number(e.target.value) || 0 })} />}
            </Field>
            <Field label={t("mgmt.vr.closeDelay")} hint={t("mgmt.vr.closeDelayHint")}>
              {(id) => <Input id={id} type="number" min={0} step={100} disabled={ro} value={f.closeDelayMs} onChange={(e) => set({ closeDelayMs: Number(e.target.value) || 0 })} />}
            </Field>
            <Field label={t("mgmt.vr.minShot")} hint={t("mgmt.vr.minShotHint")}>
              {(id) => <Input id={id} type="number" min={0} step={500} disabled={ro} value={f.minShotMs} onChange={(e) => set({ minShotMs: Number(e.target.value) || 0 })} />}
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader icon={<Disc3 className="size-4" />} title={t("mgmt.vr.clipSource")} description={t("mgmt.vr.clipSourceIntro")} />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <Field label={t("mgmt.vr.mediaSource")}>
            {(id) => (
              <Select id={id} disabled={ro} value={f.clipSourceId ?? ""} onChange={(e) => set({ clipSourceId: num(e.target.value) })}>
                <option value="">–</option>
                {sources.data?.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("mgmt.vr.clipFolder")} hint={t("mgmt.vr.clipFolderHint")}>
            {(id) => <Input id={id} disabled={ro} value={f.clipFolder} placeholder="Videoclips" onChange={(e) => set({ clipFolder: e.target.value })} />}
          </Field>
          <Field label={t("mgmt.vr.fuzzy")} hint={t("mgmt.vr.fuzzyHint")}>
            {(id) => <Input id={id} type="number" min={0.5} max={1} step={0.01} disabled={ro} value={f.fuzzyThreshold} onChange={(e) => set({ fuzzyThreshold: Number(e.target.value) || 0.82 })} />}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader icon={<AudioLines className="size-4" />} title={t("mgmt.vr.connect")} description={t("mgmt.vr.connectIntro")} />
        <CardBody className="space-y-4">
          <Field label={t("mgmt.vr.rdsPort")} hint={t("mgmt.vr.rdsPortHint")}>
            {(id) => <Input id={id} type="number" min={1024} max={65535} disabled={ro} className="max-w-40" value={f.rdsPort ?? ""} placeholder="5010" onChange={(e) => set({ rdsPort: num(e.target.value) })} />}
          </Field>
          {station ? (
            <>
              <CopyField label={t("mgmt.vr.urlNowPlaying")} value={station.urls.nowPlaying} secret hint={t("mgmt.vr.urlNowPlayingHint")} />
              <CopyField label={t("mgmt.vr.urlMic")} value={station.urls.mic} secret hint={t("mgmt.vr.urlMicHint")} />
              {isAdmin && (
                <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} onClick={() => void newToken()}>
                  {t("mgmt.vr.newToken")}
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">{t("mgmt.vr.urlsAfterSave")}</p>
          )}
        </CardBody>
      </Card>

      {isAdmin && (
        <div className="flex justify-between gap-2">
          <div>
            {station && (
              <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => void remove()}>
                {t("common.delete")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {onCancel && (
              <Button variant="secondary" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
            )}
            <Button disabled={!f.name.trim()} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
