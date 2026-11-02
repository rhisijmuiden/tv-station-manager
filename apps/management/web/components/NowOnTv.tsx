import { Badge, Button, Card, Input, cx, put, roleAtLeast, useSession } from "@tvsm/ui";
import { Clapperboard, Film, Megaphone, MonitorPlay, Newspaper, Pause, Radio, Settings2, Webcam, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { errorText, fmtDuration, fmtTime } from "../lib";

export interface NowEv {
  key: string;
  type: "media" | "live" | "beeldkrant" | "webcam" | "filler";
  title: string;
  programTitle: string;
  startAt: string;
  endAt: string;
  blockKind: "program" | "commercial" | null;
  warning: string | null;
}
export interface NowChannel {
  channel: { id: number; name: string; color: string };
  automation: boolean;
  override: { name: string; since: string } | null;
  standby: { name: string; since: string } | null;
  current: NowEv | null;
  upcoming: NowEv[];
  program: { title: string; startAt: string; endAt: string; index: number; items: NowEv[]; next: { title: string; startAt: string } | null } | null;
  lastError: string | null;
}
export interface Preview {
  channelId: number;
  url: string | null;
  kind: "video" | "page" | null;
  suggestion: string | null;
}

/** Ticks every second, corrected for the server clock so progress matches the playout. */
export function useNow(serverTime: string | undefined) {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (serverTime) setOffset(Date.parse(serverTime) - Date.now());
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now + offset;
}

const ms = (iso: string) => Date.parse(iso);

function typeIcon(e: NowEv) {
  if (e.blockKind === "commercial") return Megaphone;
  return { media: Film, live: Radio, beeldkrant: Newspaper, webcam: Webcam, filler: Pause }[e.type] ?? Clapperboard;
}

function Bar({ value, className, fill = "bg-brand" }: { value: number; className?: string; fill?: string }) {
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2", className)}>
      <div className={cx("h-full rounded-full transition-[width] duration-1000 ease-linear", fill)} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

/** Dashboard card per channel: the hour block on air, how far the current item is, what comes next, and a preview. */
export function NowOnTv({ c, now, preview, onPreviewSaved }: { c: NowChannel; now: number; preview: Preview | undefined; onPreviewSaved: () => void }) {
  const { t } = useTranslation();
  const [showPreview, setShowPreview] = useState(false);
  const cur = c.current;
  const label = (e: NowEv) => (e.type === "filler" ? t("mgmt.control.filler") : e.title || e.programTitle);

  const p = c.program;
  const nextItems = p ? p.items.slice(p.index + 1) : c.upcoming;
  const shown = nextItems.slice(0, 5);
  const more = nextItems.length - shown.length;
  const after = p?.next ?? null;

  let curBox: ReactNode = <p className="text-sm text-muted">{t("mgmt.control.nothing")}</p>;
  if (c.override) {
    curBox = <LiveLine text={t("mgmt.control.liveOverride", { name: c.override.name })} since={c.override.since} />;
  } else if (cur) {
    const start = ms(cur.startAt);
    const end = ms(cur.endAt);
    const Icon = typeIcon(cur);
    curBox = (
      <div>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-onair/12 text-onair">
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-wide text-onair uppercase">{t("mgmt.now.playing")}</p>
            <p className="truncate font-semibold" title={label(cur)}>
              {label(cur)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-lg leading-tight font-semibold tabular-nums">−{fmtDuration(Math.max(0, end - now))}</p>
            <p className="text-[11px] text-muted">{t("mgmt.now.remaining")}</p>
          </div>
        </div>
        <Bar value={(now - start) / Math.max(1, end - start)} className="mt-3" />
        <div className="mt-1 flex justify-between font-mono text-[11px] text-muted tabular-nums">
          <span>
            {fmtDuration(Math.max(0, now - start))} / {fmtDuration(end - start)}
          </span>
          <span>
            {fmtTime(cur.startAt)}–{fmtTime(cur.endAt)}
          </span>
        </div>
        {c.standby && <p className="mt-2 text-xs text-warn">{t("mgmt.now.standby", { name: c.standby.name })}</p>}
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="h-6 w-1.5 rounded-full" style={{ background: c.channel.color }} />
        <Link to="/control" className="min-w-0 flex-1 truncate font-semibold hover:text-brand">
          {c.channel.name}
        </Link>
        {c.automation ? <Badge tone="danger">● {t("mgmt.control.onAir")}</Badge> : <Badge>{t("mgmt.control.manual")}</Badge>}
        <Button size="sm" variant={showPreview ? "primary" : "secondary"} icon={<MonitorPlay className="size-4" />} onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>
          {t("mgmt.now.watch")}
        </Button>
      </div>

      {showPreview && <PreviewPane channelId={c.channel.id} preview={preview} onClose={() => setShowPreview(false)} onSaved={onPreviewSaved} />}

      {p && (
        <div className="border-b border-line px-5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("mgmt.now.block")}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={p.title}>
              {p.title}
            </span>
            <span className="font-mono text-xs text-muted tabular-nums">
              {fmtTime(p.startAt)}–{fmtTime(p.endAt)}
            </span>
          </div>
          <Bar value={(now - ms(p.startAt)) / Math.max(1, ms(p.endAt) - ms(p.startAt))} className="mt-2 h-1" fill="bg-muted/50" />
          <p className="mt-1 text-[11px] text-muted">{t("mgmt.now.itemOf", { n: p.index + 1, total: p.items.length })}</p>
        </div>
      )}

      <div className="px-5 py-4">{curBox}</div>

      <div className="border-t border-line px-5 py-3">
        <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{p ? t("mgmt.now.nextInBlock") : t("mgmt.control.next")}</p>
        {shown.length ? (
          <ol className="space-y-1.5">
            {shown.map((e) => {
              const Icon = typeIcon(e);
              return (
                <li key={e.key} className="flex items-center gap-2.5 text-sm">
                  <span className="w-11 shrink-0 font-mono text-xs text-muted tabular-nums">{fmtTime(e.startAt)}</span>
                  <Icon className={cx("size-3.5 shrink-0", e.type === "filler" ? "text-line" : "text-muted")} />
                  <span className={cx("min-w-0 flex-1 truncate", e.type === "filler" && "text-muted")} title={label(e)}>
                    {label(e)}
                  </span>
                  {e.warning && <Badge tone="warn">!</Badge>}
                  <span className="shrink-0 font-mono text-xs text-muted tabular-nums">{fmtDuration(ms(e.endAt) - ms(e.startAt))}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted">{p ? t("mgmt.now.lastInBlock") : t("mgmt.control.emptySchedule")}</p>
        )}
        {more > 0 && <p className="mt-1.5 text-xs text-muted">{t("mgmt.now.more", { count: more })}</p>}
        {after && (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-surface-2/70 px-3 py-2 text-xs">
            <span className="font-semibold text-muted uppercase">{t("mgmt.now.after")}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{after.title}</span>
            <span className="font-mono text-muted tabular-nums">{fmtTime(after.startAt)}</span>
          </p>
        )}
        {c.lastError && <p className="mt-2 truncate text-xs text-danger">{c.lastError}</p>}
      </div>
    </Card>
  );
}

function LiveLine({ text, since }: { text: string; since: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-lg bg-onair text-white">
        <Radio className="size-4.5" />
      </span>
      <div>
        <p className="font-semibold">{text}</p>
        <p className="text-xs text-muted">{t("mgmt.now.liveSince", { time: fmtTime(since) })}</p>
      </div>
    </div>
  );
}

/** Small player for the channel's stream (Owncast page or HLS); editors set the URL here. */
function PreviewPane({ channelId, preview, onClose, onSaved }: { channelId: number; preview: Preview | undefined; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const has = !!preview?.url;

  const startEdit = () => {
    setUrl(preview?.url ?? preview?.suggestion ?? "");
    setErr(null);
    setEditing(true);
  };
  const save = async (value: string) => {
    setBusy(true);
    setErr(null);
    try {
      await put(`/api/dashboard/previews/${channelId}`, { url: value.trim() });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line bg-surface-2/50 p-3">
      {has && !editing && (
        <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
          {preview!.kind === "video" ? (
            <video src={preview!.url!} className="size-full" autoPlay muted playsInline controls />
          ) : (
            <iframe src={preview!.url!} title={t("mgmt.now.watch")} className="size-full border-0" allow="autoplay; fullscreen" allowFullScreen />
          )}
        </div>
      )}
      {!has && !editing && (
        <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line text-center">
          <div className="px-4">
            <MonitorPlay className="mx-auto size-6 text-muted" />
            <p className="mt-2 text-sm font-medium">{t("mgmt.now.noPreview")}</p>
            <p className="text-xs text-muted">{canEdit ? t("mgmt.now.noPreviewHint") : t("mgmt.now.noPreviewAsk")}</p>
            {canEdit && (
              <Button size="sm" className="mt-3" onClick={startEdit}>
                {t("mgmt.now.setPreview")}
              </Button>
            )}
          </div>
        </div>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(url);
          }}
        >
          <label className="block text-xs font-medium" htmlFor={`pv-${channelId}`}>
            {t("mgmt.now.previewUrl")}
          </label>
          <Input id={`pv-${channelId}`} className="font-mono text-[12.5px]" value={url} placeholder="http://owncast.example.org:8080/embed/video" onChange={(e) => setUrl(e.target.value)} autoFocus />
          <p className="text-xs text-muted">{preview?.suggestion && !preview.url ? t("mgmt.now.suggested") : t("mgmt.now.previewUrlHint")}</p>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" loading={busy} disabled={!url.trim()}>
              {t("common.save")}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            {has && (
              <Button size="sm" variant="ghost" type="button" className="ml-auto text-danger" onClick={() => void save("")}>
                {t("mgmt.now.removePreview")}
              </Button>
            )}
          </div>
        </form>
      )}
      {!editing && (
        <div className="mt-2 flex items-center justify-end gap-1">
          {has && canEdit && (
            <Button size="sm" variant="ghost" icon={<Settings2 className="size-4" />} onClick={startEdit}>
              {t("mgmt.now.changePreview")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={onClose}>
            {t("mgmt.now.close")}
          </Button>
        </div>
      )}
    </div>
  );
}
