import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, Switch, cx, post, useSession, roleAtLeast } from "@tvsm/ui";
import { AlertTriangle, Lock, MonitorPlay, Play, Radio, RotateCcw, Scissors, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { StatusBadge } from "./RemoteSources";
import { errorText, fmtDuration, fmtTime, useGet, type AtemStatus, type Channel, type LiveSource } from "../lib";

interface Ev {
  key: string;
  type: "media" | "live" | "beeldkrant" | "filler";
  title: string;
  programTitle: string;
  startAt: string;
  endAt: string;
  blockKind: "program" | "commercial" | null;
  warning: string | null;
}
interface ChannelStatus {
  channel: Channel;
  automation: boolean;
  override: { liveSourceId: number; name: string; since: string } | null;
  current: Ev | null;
  upcoming: Ev[];
  atem: AtemStatus | null;
  playout: { connected: boolean; version: string | null } | null;
  onAir: { input: number; node: "playout" | "live" | "fallback" | "other"; studio: string | null; source: string | null } | null;
  standby: { liveSourceId: number; name: string; since: string } | null;
  atemLock: { name: string; by: string | null; at: string | null; reason: string } | null;
  lastError: string | null;
  graphics: { hidden: boolean; upNext: { visible: boolean; title: string } };
  asrun: { at: string; kind: string; title: string; detail: string | null; ok: number }[];
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Progress({ ev, now, offset }: { ev: Ev; now: number; offset: number }) {
  const s = Date.parse(ev.startAt);
  const e = Date.parse(ev.endAt);
  const t = now + offset;
  const pct = Math.min(100, Math.max(0, ((t - s) / (e - s)) * 100));
  const remaining = e - t;
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={cx("h-full rounded-full", remaining < 10_000 ? "bg-onair" : "bg-brand")} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-xs text-muted">
        <span>{fmtDuration(t - s)}</span>
        <span className={cx(remaining < 10_000 && "font-semibold text-onair")}>-{fmtDuration(Math.max(0, remaining))}</span>
      </div>
    </div>
  );
}

function ChannelControl({ s, offset, live, reload, canOperate }: { s: ChannelStatus; offset: number; live: LiveSource[]; reload: () => void; canOperate: boolean }) {
  const { t } = useTranslation();
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  const id = s.channel.id;
  const act = async (url: string, body?: unknown) => {
    setErr(null);
    try {
      await post(url, body);
      reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const me = s.channel.atemMe;
  const program = s.atem?.program[me] ?? null;
  const preview = s.atem?.preview[me] ?? null;
  const evLabel = (e: Ev) => (e.type === "filler" ? t("mgmt.control.filler") : e.title);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4" style={{ boxShadow: `inset 4px 0 0 ${s.channel.color}` }}>
        <h2 className="text-lg font-semibold">{s.channel.name}</h2>
        {s.override ? (
          <Badge tone="warn">
            <Radio className="size-3" /> {t("mgmt.control.liveOverride", { name: s.override.name })}
          </Badge>
        ) : s.automation ? (
          <Badge tone="danger">● {t("mgmt.control.onAir")}</Badge>
        ) : (
          <Badge>{t("mgmt.control.manual")}</Badge>
        )}
        {s.onAir && (
          <Badge tone={s.onAir.node === "live" ? "danger" : s.onAir.node === "playout" ? "brand" : "neutral"}>
            <MonitorPlay className="size-3" /> {t(`mgmt.control.node_${s.onAir.node}`, { studio: s.onAir.studio ?? "", input: s.onAir.input })}
          </Badge>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className={cx("size-2 rounded-full", s.atem?.connected ? "bg-ok" : "bg-danger")} /> ATEM
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className={cx("size-2 rounded-full", s.playout?.connected ? "bg-ok" : "bg-danger")} /> CasparCG
        </span>
        {canOperate && <Switch checked={s.automation} onChange={(on) => void act(`/api/control/${id}/automation`, { on })} label={t("mgmt.control.automation")} />}
      </div>
      <CardBody className="space-y-5">
        {s.atemLock && (
          <Alert tone="warn">
            <span className="flex items-start gap-2">
              <Lock className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">{t("mgmt.control.atemLocked", { by: s.atemLock.by ?? "?" })}</span>
                {s.atemLock.reason && <span> · {s.atemLock.reason}</span>}
                <span className="block text-xs opacity-80">{t("mgmt.control.atemLockedHint")}</span>
              </span>
            </span>
          </Alert>
        )}
        {s.standby && (
          <Alert tone="warn">
            <span className="flex items-center gap-2">
              <Radio className="size-4" />
              {t("mgmt.control.standby", { name: s.standby.name, since: fmtTime(s.standby.since, true) })}
            </span>
          </Alert>
        )}
        {(s.lastError || err) && (
          <Alert tone="danger">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" />
              {err ?? s.lastError}
            </span>
          </Alert>
        )}
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wider text-muted uppercase">{t("mgmt.control.now")}</p>
            {s.current ? (
              <>
                <p className="text-xl font-semibold">{evLabel(s.current)}</p>
                <p className="mb-3 text-sm text-muted">
                  {s.current.programTitle && s.current.programTitle !== s.current.title ? `${s.current.programTitle} · ` : ""}
                  {fmtTime(s.current.startAt, true)} – {fmtTime(s.current.endAt, true)}
                  {s.current.blockKind === "commercial" && (
                    <>
                      {" "}
                      · <Badge tone="warn">{t("mgmt.categories.commercial")}</Badge>
                    </>
                  )}
                </p>
                <Progress ev={s.current} now={now} offset={offset} />
              </>
            ) : (
              <p className="text-muted">{t("mgmt.control.nothing")}</p>
            )}
            <p className="mt-5 mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{t("mgmt.control.next")}</p>
            <ul className="divide-y divide-line rounded-md border border-line">
              {s.upcoming.slice(0, 6).map((e) => (
                <li key={e.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-16 font-mono text-xs text-muted">{fmtTime(e.startAt, true)}</span>
                  <span className={cx("min-w-0 flex-1 truncate", e.type === "filler" && "text-muted italic")}>{evLabel(e)}</span>
                  {e.warning && <AlertTriangle className="size-4 text-warn" aria-label={t(`mgmt.warnings.${e.warning}`)} />}
                  {e.type === "live" && <Badge tone="brand">{t("mgmt.blocks.types.live")}</Badge>}
                  {e.type === "beeldkrant" && <Badge tone="ok">{t("mgmt.blocks.types.beeldkrant")}</Badge>}
                  {e.blockKind === "commercial" && <Badge tone="warn">{t("mgmt.categories.commercial")}</Badge>}
                  <span className="font-mono text-xs text-muted">{fmtDuration(Date.parse(e.endAt) - Date.parse(e.startAt))}</span>
                </li>
              ))}
              {!s.upcoming.length && <li className="px-3 py-4 text-center text-sm text-muted">{t("mgmt.control.emptySchedule")}</li>}
            </ul>
          </div>

          <div className="space-y-5">
            {s.atem ? (
              <div>
                <p className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">
                  {t("mgmt.control.switcher")} {s.atem.productName ? `· ${s.atem.productName}` : ""} {s.atem.mixEffects > 1 ? `· M/E ${me + 1}` : ""}
                </p>
                <p className="mb-1 text-[11px] font-semibold text-onair">PROGRAM</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {s.atem.inputs.map((i) => (
                    <button
                      key={i.id}
                      disabled={!canOperate || !!s.atemLock}
                      onClick={() => void act(`/api/control/${id}/atem`, { action: "program", input: i.id })}
                      title={i.longName}
                      className={cx("h-10 min-w-12 rounded-md border px-2 text-xs font-semibold transition disabled:cursor-default", program === i.id ? "border-onair bg-onair text-white shadow-md shadow-onair/30" : "border-line bg-surface hover:border-onair/60")}
                    >
                      {i.shortName}
                    </button>
                  ))}
                </div>
                <p className="mb-1 text-[11px] font-semibold text-ok">PREVIEW</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {s.atem.inputs.map((i) => (
                    <button
                      key={i.id}
                      disabled={!canOperate || !!s.atemLock}
                      onClick={() => void act(`/api/control/${id}/atem`, { action: "preview", input: i.id })}
                      title={i.longName}
                      className={cx("h-10 min-w-12 rounded-md border px-2 text-xs font-semibold transition disabled:cursor-default", preview === i.id ? "border-ok bg-ok text-white" : "border-line bg-surface hover:border-ok/60")}
                    >
                      {i.shortName}
                    </button>
                  ))}
                </div>
                {canOperate && (
                  <div className="flex gap-2">
                    <Button variant="secondary" disabled={!!s.atemLock} icon={<Scissors className="size-4" />} onClick={() => void act(`/api/control/${id}/atem`, { action: "cut" })}>
                      CUT
                    </Button>
                    <Button variant="secondary" disabled={!!s.atemLock} icon={<Shuffle className="size-4" />} onClick={() => void act(`/api/control/${id}/atem`, { action: "auto" })}>
                      AUTO
                    </Button>
                  </div>
                )}
                {s.automation && canOperate && <p className="mt-2 text-xs text-muted">{t("mgmt.control.manualHint")}</p>}
              </div>
            ) : (
              <Alert tone="warn">{t("mgmt.control.noAtem")}</Alert>
            )}
            {canOperate && (
              <div>
                <p className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{t("mgmt.control.liveSources")}</p>
                <div className="flex flex-wrap gap-2">
                  {live.map((l) => (
                    <Button key={l.id} size="sm" variant={s.override?.liveSourceId === l.id ? "danger" : "secondary"} icon={<Play className="size-3.5" />} onClick={() => void act(`/api/control/${id}/live`, { liveSourceId: l.id })}>
                      {l.name}
                      {l.kind === "rtmp" && <StatusBadge s={l} />}
                    </Button>
                  ))}
                  {!live.length && <span className="text-sm text-muted">{t("mgmt.control.noLive")}</span>}
                  {live.some((l) => l.kind === "rtmp" && l.status?.state === "waiting") && <p className="w-full text-xs text-muted">{t("mgmt.control.remoteWaiting")}</p>}
                  {s.override && (
                    <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void act(`/api/control/${id}/resume`)}>
                      {t("mgmt.control.resume")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("mgmt.control.asrun")}</summary>
          <ul className="divide-y divide-line border-t border-line text-sm">
            {s.asrun.map((a, i) => (
              <li key={i} className="flex gap-3 px-3 py-1.5">
                <span className="w-16 font-mono text-xs text-muted">{fmtTime(a.at.endsWith("Z") ? a.at : `${a.at}Z`, true)}</span>
                <span className={cx("flex-1 truncate", !a.ok && "text-danger")}>{a.title}</span>
                <span className="truncate text-xs text-muted">{a.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      </CardBody>
    </Card>
  );
}

export function ControlPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const { data, reload } = useGet<{ serverTime: string; channels: ChannelStatus[] }>("/api/control", 1000);
  const { data: live } = useGet<{ sources: LiveSource[] }>("/api/live-sources", 3000);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (data) setOffset(Date.parse(data.serverTime) - Date.now());
  }, [data]);
  return (
    <>
      <PageHeader title={t("mgmt.control.title")} description={t("mgmt.control.intro")} />
      {data && !data.channels.length && (
        <Card>
          <CardHeader title={t("mgmt.control.noChannels")} description={t("mgmt.control.noChannelsIntro")} actions={<Link to="/channels" className="text-sm font-medium text-brand">{t("mgmt.open")} →</Link>} />
        </Card>
      )}
      <div className="space-y-6">
        {data?.channels.map((s) => <ChannelControl key={s.channel.id} s={s} offset={offset} live={live?.sources ?? []} reload={() => void reload()} canOperate={roleAtLeast(user?.role, "operator")} />)}
      </div>
    </>
  );
}
