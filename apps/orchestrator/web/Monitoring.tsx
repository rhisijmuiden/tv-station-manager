import { Alert, ApiError, Badge, Button, Card, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Cpu,
  Globe,
  HardDrive,
  Plus,
  RefreshCw,
  Radio,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Tv,
  Users,
  Video,
  Wrench,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { BLOCKS, CHECK_TYPES, MANUAL_STATUSES, worst, type Block, type CheckType, type Health, type Issue, type OwncastStatus, type ProbeResult } from "../server/monitorlogic";
import "./monitoring.css";

interface Metrics {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  uptimeSeconds: number | null;
}
interface MonNode {
  id: string;
  name: string;
  role: string;
  group: "studio" | "management" | "other";
  status: string;
  hostname: string;
  platform: string | null;
  ip: string | null;
  agentVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  metrics: Metrics | null;
  casparcg: { connected: boolean; channels: number } | null;
  linkedDevice: string | null;
  health: Health;
  issues: Issue[];
}
interface MonAtem {
  id: string;
  name: string;
  host: string;
  location: string;
  online: boolean;
  model: string | null;
  control: string;
  health: Health;
  issues: Issue[];
}
interface MonDeck {
  id: string;
  name: string;
  host: string;
  location: string;
  online: boolean;
  model: string | null;
  transport: string | null;
  health: Health;
  issues: Issue[];
}
interface MonDevice {
  id: string;
  name: string;
  block: Block;
  checkType: CheckType;
  target: string;
  nodeId: string | null;
  manualStatus: Health;
  location: string;
  notes: string;
  health: Health;
  issues: Issue[];
  result: ProbeResult | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  changedAt: string | null;
  agent: { id: string; name: string; online: boolean; lastSeenAt: string | null; metrics: Metrics | null } | null;
}
interface Overview {
  checkedAt: string;
  core: { name: string; hostname: string; version: string; channel: string; uptimeSeconds: number; mailConfigured: boolean; lastBackup: { status: string; at: string } | null; health: Health; issues: Issue[] };
  nodes: MonNode[];
  atems: MonAtem[];
  hyperdecks: MonDeck[];
  devices: MonDevice[];
  summary: Record<Health, number>;
}

const REFRESH_MS = 5000;

const HEALTH_DOT: Record<Health, string> = { ok: "bg-ok", warn: "bg-warn", down: "bg-danger", unknown: "bg-muted/50" };
const HEALTH_TEXT: Record<Health, string> = { ok: "text-ok", warn: "text-warn", down: "text-danger", unknown: "text-muted" };
const HEALTH_STROKE: Record<Health, string> = { ok: "var(--tvsm-primary)", warn: "var(--tvsm-warning)", down: "var(--tvsm-danger)", unknown: "var(--tvsm-text-muted)" };
const HEALTH_RING: Record<Health, string> = { ok: "border-t-ok", warn: "border-t-warn", down: "border-t-danger", unknown: "border-t-line" };

export function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function useIssueText() {
  const { t } = useTranslation();
  return (i: Issue) => {
    const params: Record<string, string | number> = { ...(i.params ?? {}) };
    if (typeof params.since === "string") params.since = new Date(params.since).toLocaleString();
    return t(`orch.mon.issue.${i.code}`, { ...params, defaultValue: i.code });
  };
}

function Dot({ health, pulse }: { health: Health; pulse?: boolean }) {
  return (
    <span className={cx("relative inline-block size-2.5 shrink-0 rounded-full", HEALTH_DOT[health])}>
      {pulse && health === "ok" && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40" />}
      {health === "down" && <span className="absolute inset-0 animate-ping rounded-full bg-danger opacity-50" />}
    </span>
  );
}

function MiniBar({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  const tone = value >= 90 ? "bg-danger" : value >= 75 ? "bg-warn" : "bg-brand";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex justify-between text-[10px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{value}%</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

/** One monitored thing inside a block. */
function Tile({ health, icon, title, sub, issues, right, children, onClick }: { health: Health; icon: ReactNode; title: ReactNode; sub?: ReactNode; issues: Issue[]; right?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const text = useIssueText();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex w-full min-w-0 flex-col gap-2 rounded-lg border bg-surface p-3 text-left transition hover:-translate-y-px hover:shadow-[var(--tvsm-shadow-card)]",
        health === "down" ? "border-danger/50 bg-danger/[0.04]" : health === "warn" ? "border-warn/60" : "border-line",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-muted group-hover:text-brand">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Dot health={health} pulse />
            <span className="truncate text-sm font-semibold">{title}</span>
          </div>
          {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
        </div>
        {right && <div className="shrink-0 text-right">{right}</div>}
      </div>
      {children}
      {issues.length > 0 && (
        <ul className="space-y-0.5">
          {issues.slice(0, 3).map((i, n) => (
            <li key={n} className={cx("flex items-start gap-1.5 text-xs", i.level === "down" ? "text-danger" : "text-warn")}>
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{text(i)}</span>
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

function Section({ title, count, children }: { title: ReactNode; count?: number; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <span>{title}</span>
        {count != null && <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-fg tabular-nums">{count}</span>}
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">{children}</div>
    </div>
  );
}

function Block({ refEl, health, icon, title, subtitle, children, className, actions }: { refEl: RefObject<HTMLDivElement | null>; health: Health; icon: ReactNode; title: ReactNode; subtitle?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section ref={refEl} className={cx("relative z-10 rounded-xl border border-t-4 border-line bg-surface/95 shadow-[var(--tvsm-shadow-card)] backdrop-blur", HEALTH_RING[health], className)}>
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
            <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", HEALTH_TEXT[health])}>
              <Dot health={health} />
              {t(`orch.mon.health.${health}`)}
            </span>
          </div>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {actions}
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

// ---- lines between the blocks --------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
function useBoxes(container: RefObject<HTMLDivElement | null>, refs: Record<string, RefObject<HTMLDivElement | null>>, deps: unknown[]) {
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  useLayoutEffect(() => {
    const c = container.current;
    if (!c) return;
    const measure = () => {
      const base = c.getBoundingClientRect();
      const next: Record<string, Box> = {};
      for (const [k, r] of Object.entries(refs)) {
        const el = r.current;
        if (!el) continue;
        const b = el.getBoundingClientRect();
        next[k] = { x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height };
      }
      setBoxes(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    for (const r of Object.values(refs)) if (r.current) ro.observe(r.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return boxes;
}

function Lines({ boxes, health }: { boxes: Record<string, Box>; health: { infra: Health; dist: Health; extra: Health } }) {
  const { t } = useTranslation();
  const { core, infra, dist, extra } = boxes;
  if (!core || !infra) return null;
  // On narrow screens the blocks stack: then only straight vertical lines.
  const stacked = !!dist && dist.y > infra.y + 10;
  const cx0 = core.x + core.w / 2;
  const cy0 = core.y + core.h;
  const label = (x: number, y: number, text: string, anchor: "start" | "middle" | "end" = "middle") => (
    <text x={x} y={y} textAnchor={anchor} className="fill-[var(--tvsm-text-muted)] text-[10.5px] font-medium tracking-wide uppercase">
      {text}
    </text>
  );
  const drop = (to: Box, h: Health, cls: string, text: string) => {
    const tx = to.x + to.w / 2;
    const midY = cy0 + (to.y - cy0) / 2;
    const d = Math.abs(tx - cx0) < 4 ? `M ${cx0} ${cy0} L ${tx} ${to.y}` : `M ${cx0} ${cy0} L ${cx0} ${midY} L ${tx} ${midY} L ${tx} ${to.y}`;
    return (
      <g>
        <path d={d} className={cx("tvsm-mon-line", cls)} stroke={HEALTH_STROKE[h]} />
        <circle cx={tx} cy={to.y} r={3.5} fill={HEALTH_STROKE[h]} />
        {label(tx + (tx >= cx0 ? 8 : -8), midY + (Math.abs(tx - cx0) < 4 ? 0 : -6), text, Math.abs(tx - cx0) < 4 ? "start" : tx >= cx0 ? "start" : "end")}
      </g>
    );
  };
  return (
    <svg className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible" aria-hidden>
      <circle cx={cx0} cy={cy0} r={4} fill="var(--tvsm-primary)" />
      {drop(infra, health.infra, "tvsm-mon-flow", t("orch.mon.lineControl"))}
      {dist && !stacked && drop(dist, health.dist, "tvsm-mon-dotted", t("orch.mon.lineStatus"))}
      {dist && !stacked && (
        <g>
          <path d={`M ${infra.x + infra.w} ${infra.y + 70} L ${dist.x} ${infra.y + 70}`} className="tvsm-mon-line tvsm-mon-flow" stroke={HEALTH_STROKE[health.dist]} markerEnd="url(#tvsm-mon-arrow)" />
          {label(infra.x + infra.w + (dist.x - infra.x - infra.w) / 2, infra.y + 62, t("orch.mon.lineSignal"))}
        </g>
      )}
      {extra && (
        <path d={`M ${infra.x + infra.w / 2} ${(stacked && dist ? dist : infra).y + (stacked && dist ? dist : infra).h} L ${infra.x + infra.w / 2} ${extra.y}`} className="tvsm-mon-line tvsm-mon-dotted" stroke={HEALTH_STROKE[health.extra]} />
      )}
      <defs>
        <marker id="tvsm-mon-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={HEALTH_STROKE[health.dist]} />
        </marker>
      </defs>
    </svg>
  );
}

// ---- device dialog ----------------------------------------------------------------------------------

const CHECK_ICON: Record<CheckType, ReactNode> = { owncast: <Radio className="size-4" />, http: <Globe className="size-4" />, tcp: <Activity className="size-4" />, manual: <Wrench className="size-4" /> };

function OwncastStats({ o, big }: { o: OwncastStatus; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cx("grid grid-cols-3 gap-2 rounded-md bg-surface-2/70 p-2 text-center", big && "p-3")}>
      <div>
        <div className={cx("font-semibold tabular-nums", big ? "text-2xl" : "text-lg")}>{o.viewers}</div>
        <div className="text-[10px] text-muted uppercase">{t("orch.mon.viewers")}</div>
      </div>
      <div>
        <div className={cx("font-semibold tabular-nums", big ? "text-2xl" : "text-lg")}>{o.sessionMaxViewers}</div>
        <div className="text-[10px] text-muted uppercase">{t("orch.mon.peakSession")}</div>
      </div>
      <div>
        <div className={cx("font-semibold tabular-nums", big ? "text-2xl" : "text-lg")}>{o.overallMaxViewers}</div>
        <div className="text-[10px] text-muted uppercase">{t("orch.mon.peakAll")}</div>
      </div>
    </div>
  );
}

function DeviceDialog({ device, block, nodes, onClose, onDone }: { device?: MonDevice; block: Block; nodes: MonNode[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const text = useIssueText();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const operator = roleAtLeast(user?.role, "operator");
  const [f, setF] = useState({
    name: device?.name ?? "",
    block: device?.block ?? block,
    checkType: device?.checkType ?? (block === "distribution" ? "owncast" : block === "extra" ? "manual" : "tcp"),
    target: device?.target ?? "",
    nodeId: device?.nodeId ?? "",
    manualStatus: device?.manualStatus ?? "ok",
    location: device?.location ?? "",
    notes: device?.notes ?? "",
  });
  const [cur, setCur] = useState(device);
  const [events, setEvents] = useState<{ type: string; message: string; at: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (device) void get<{ events: typeof events }>(`/api/monitoring/devices/${device.id}`).then((r) => setEvents(r.events));
  }, [device]);
  const fail = (e: unknown) => setError(e instanceof ApiError ? t(`orch.mon.err_${e.code}`, { defaultValue: e.message }) : String(e));
  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const body = { ...f, nodeId: f.nodeId || null };
      if (device) await put(`/api/monitoring/devices/${device.id}`, body);
      else await post("/api/monitoring/devices", body);
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!device || !confirm(t("orch.mon.confirmDelete", { name: device.name }))) return;
    setBusy("delete");
    try {
      await del(`/api/monitoring/devices/${device.id}`);
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const checkNow = async () => {
    if (!device) return;
    setBusy("check");
    try {
      setCur(await post<MonDevice>(`/api/monitoring/devices/${device.id}/check`));
      setEvents((await get<{ events: typeof events }>(`/api/monitoring/devices/${device.id}`)).events);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const r = cur?.result;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={device ? device.name : t("orch.mon.addDevice")}
      footer={
        <>
          {device && admin && (
            <Button variant="ghost" className="mr-auto text-danger" loading={busy === "delete"} onClick={remove}>
              {t("common.delete")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {admin ? t("common.cancel") : t("common.close")}
          </Button>
          {admin && (
            <Button loading={busy === "save"} onClick={save} disabled={!f.name || (f.checkType !== "manual" && !f.target.trim())}>
              {device ? t("common.save") : t("orch.mon.addDevice")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {cur && (
          <div className="space-y-3 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className={cx("inline-flex items-center gap-1.5 text-sm font-semibold", HEALTH_TEXT[cur.health])}>
                <Dot health={cur.health} /> {t(`orch.mon.health.${cur.health}`)}
              </span>
              {r?.ms != null && <Badge>{r.ms} ms</Badge>}
              {r?.httpStatus != null && <Badge>HTTP {r.httpStatus}</Badge>}
              {r?.owncast?.version && <Badge>Owncast {r.owncast.version}</Badge>}
              {r?.owncast && <Badge tone={r.owncast.online ? "danger" : "neutral"}>{r.owncast.online ? t("orch.mon.live") : t("orch.mon.offAir")}</Badge>}
              <span className="ml-auto text-xs text-muted">{cur.lastCheckAt ? `${t("orch.mon.lastCheck")}: ${new Date(cur.lastCheckAt).toLocaleTimeString()}` : cur.checkType === "manual" ? t("orch.mon.manualHint") : ""}</span>
              {cur.checkType !== "manual" && operator && (
                <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={busy === "check"} onClick={checkNow}>
                  {t("orch.mon.checkNow")}
                </Button>
              )}
            </div>
            {cur.issues.map((i, n) => (
              <p key={n} className={cx("text-sm", i.level === "down" ? "text-danger" : "text-warn")}>
                {text(i)}
              </p>
            ))}
            {r?.owncast && (
              <>
                {(r.owncast.name || r.owncast.streamTitle) && (
                  <p className="text-sm">
                    <span className="font-medium">{r.owncast.name}</span>
                    {r.owncast.streamTitle && <span className="text-muted"> · {r.owncast.streamTitle}</span>}
                  </p>
                )}
                <OwncastStats o={r.owncast} big />
                <p className="text-xs text-muted">
                  {r.owncast.online && r.owncast.lastConnectTime && `${t("orch.mon.liveSince")} ${new Date(r.owncast.lastConnectTime).toLocaleString()}`}
                  {!r.owncast.online && r.owncast.lastDisconnectTime && `${t("orch.mon.offlineSince")} ${new Date(r.owncast.lastDisconnectTime).toLocaleString()}`}
                </p>
              </>
            )}
            {cur.agent && (
              <div className="rounded-md bg-surface-2/60 p-2.5">
                <p className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                  <Cpu className="size-3.5 text-muted" />
                  {t("orch.mon.agentOn", { name: cur.agent.name })}
                  <span className={cur.agent.online ? "text-ok" : "text-danger"}>· {cur.agent.online ? t("orch.nodes.online") : t("orch.nodes.offline")}</span>
                </p>
                {cur.agent.metrics && (
                  <div className="flex gap-3">
                    <MiniBar label="CPU" value={cur.agent.metrics.cpu} />
                    <MiniBar label="RAM" value={cur.agent.metrics.mem} />
                    <MiniBar label={t("orch.mon.disk")} value={cur.agent.metrics.disk} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {admin ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("orch.atem.name")}>{(id) => <Input id={id} value={f.name} placeholder={f.checkType === "owncast" ? "Owncast website" : "UNAS Pro"} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t("orch.mon.block")}>
              {(id) => (
                <Select id={id} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value as Block })}>
                  {BLOCKS.map((b) => (
                    <option key={b} value={b}>
                      {t(`orch.mon.block_${b}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("orch.mon.checkType")} className="sm:col-span-2">
              {() => (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CHECK_TYPES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setF({ ...f, checkType: c })}
                      className={cx("flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left text-xs transition", f.checkType === c ? "border-brand bg-brand/8 ring-1 ring-brand" : "border-line hover:bg-surface-2")}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {CHECK_ICON[c]} {t(`orch.mon.check_${c}`)}
                      </span>
                      <span className="text-muted">{t(`orch.mon.check_${c}_hint`)}</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {f.checkType !== "manual" ? (
              <Field label={t("orch.mon.target")} hint={t(`orch.mon.target_${f.checkType}_hint`)} className="sm:col-span-2">
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono"
                    value={f.target}
                    placeholder={f.checkType === "owncast" ? "http://10.40.6.127:8080" : f.checkType === "tcp" ? "10.40.0.154:445" : "https://ijmond360.nl"}
                    onChange={(e) => setF({ ...f, target: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <Field label={t("orch.mon.manualStatus")} hint={t("orch.mon.manualHint")} className="sm:col-span-2">
                {(id) => (
                  <Select id={id} value={f.manualStatus} onChange={(e) => setF({ ...f, manualStatus: e.target.value as Health })}>
                    {MANUAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`orch.mon.health.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label={`${t("orch.mon.agent")} (${t("common.optional")})`} hint={t("orch.mon.agentHint")} className="sm:col-span-2">
              {(id) => (
                <Select id={id} value={f.nodeId} onChange={(e) => setF({ ...f, nodeId: e.target.value })}>
                  <option value="">{t("orch.mon.noAgent")}</option>
                  {nodes
                    .filter((n) => n.status === "approved")
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.hostname})
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label={`${t("orch.atem.location")} (${t("common.optional")})`}>{(id) => <Input id={id} value={f.location} placeholder={t("orch.atem.locationPlaceholder")} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
            <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>{(id) => <Textarea id={id} className="min-h-10 font-sans text-sm" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
          </div>
        ) : (
          (cur?.notes || cur?.location) && (
            <p className="text-sm text-muted">
              {cur.location}
              {cur.location && cur.notes && " · "}
              {cur.notes}
            </p>
          )
        )}

        {events.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wider text-muted uppercase">{t("orch.mon.history")}</p>
            <ul className="max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line text-xs">
              {events.map((e, i) => (
                <li key={i} className="flex gap-3 px-3 py-1.5">
                  <span className="shrink-0 font-mono text-muted">{new Date(e.at).toLocaleString()}</span>
                  <span className={cx(e.type === "down" ? "text-danger" : e.type === "warn" ? "text-warn" : e.type === "ok" ? "text-ok" : undefined)}>{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- page ------------------------------------------------------------------------------------------

export function MonitoringPage() {
  const { t } = useTranslation();
  const text = useIssueText();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [o, setO] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ device?: MonDevice; block: Block } | null>(null);

  const load = useCallback(async () => {
    try {
      setO(await get<Overview>("/api/monitoring"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const container = useRef<HTMLDivElement>(null);
  const refs = { core: useRef<HTMLDivElement>(null), infra: useRef<HTMLDivElement>(null), dist: useRef<HTMLDivElement>(null), extra: useRef<HTMLDivElement>(null) };
  const shape = o ? `${o.nodes.length}/${o.atems.length}/${o.hyperdecks.length}/${o.devices.map((d) => d.block + d.issues.length).join()}/${o.nodes.map((n) => n.issues.length).join()}` : "";
  const boxes = useBoxes(container, refs, [shape, !!o]);

  if (!o) return <PageHeader title={t("orch.mon.title")} description={t("orch.mon.intro")} />;

  const visibleNodes = o.nodes.filter((n) => !n.linkedDevice);
  const studios = visibleNodes.filter((n) => n.group === "studio" && n.status === "approved");
  const managers = visibleNodes.filter((n) => n.group === "management" && n.status === "approved");
  const others = visibleNodes.filter((n) => n.group === "other" || n.status !== "approved");
  const dev = (b: Block) => o.devices.filter((d) => d.block === b);
  const infraHealth = worst([...visibleNodes.map((n) => n.health), ...o.atems.map((a) => a.health), ...o.hyperdecks.map((h) => h.health), ...dev("infrastructure").map((d) => d.health)]);
  const distHealth = worst(dev("distribution").map((d) => d.health));
  const extraHealth = worst(dev("extra").map((d) => d.health));
  const problems = [
    ...o.core.issues.map((i) => ({ name: o.core.name, i, go: () => nav("/system/backup") })),
    ...visibleNodes.flatMap((n) => n.issues.map((i) => ({ name: n.name, i, go: () => nav("/nodes") }))),
    ...o.atems.flatMap((a) => a.issues.map((i) => ({ name: a.name, i, go: () => nav(`/atem/${a.id}`) }))),
    ...o.hyperdecks.flatMap((h) => h.issues.map((i) => ({ name: h.name, i, go: () => nav(`/hyperdeck/${h.id}`) }))),
    ...o.devices.flatMap((d) => d.issues.map((i) => ({ name: d.name, i, go: () => setDialog({ device: d, block: d.block }) }))),
  ].sort((a, b) => (a.i.level === b.i.level ? 0 : a.i.level === "down" ? -1 : 1));
  const s = o.summary;
  const allOk = !s.down && !s.warn;

  const nodeTile = (n: MonNode) => (
    <Tile
      key={n.id}
      health={n.health}
      icon={n.group === "studio" ? <Tv className="size-4" /> : <Server className="size-4" />}
      title={n.name}
      sub={
        <>
          {t(`orch.nodes.role_${n.role}`, { defaultValue: n.role })} · <Mono>{n.ip ?? n.hostname}</Mono>
        </>
      }
      right={n.casparcg && <Badge tone={n.casparcg.connected ? "ok" : "danger"}>CasparCG</Badge>}
      issues={n.issues}
      onClick={() => nav("/nodes")}
    >
      {n.online && n.metrics && (
        <div className="flex gap-3">
          <MiniBar label="CPU" value={n.metrics.cpu} />
          <MiniBar label="RAM" value={n.metrics.mem} />
          <MiniBar label={t("orch.mon.disk")} value={n.metrics.disk} />
        </div>
      )}
    </Tile>
  );
  const deviceTile = (d: MonDevice) => (
    <Tile
      key={d.id}
      health={d.health}
      icon={CHECK_ICON[d.checkType]}
      title={d.name}
      sub={d.checkType === "manual" ? [d.location || t("orch.mon.check_manual"), d.notes].filter(Boolean).join(" · ") : <Mono>{d.target}</Mono>}
      right={d.result?.owncast ? <Badge tone={d.result.owncast.online ? "danger" : "neutral"}>{d.result.owncast.online ? t("orch.mon.live") : t("orch.mon.offAir")}</Badge> : d.result?.ms != null ? <span className="text-[11px] text-muted tabular-nums">{d.result.ms} ms</span> : null}
      issues={d.issues}
      onClick={() => setDialog({ device: d, block: d.block })}
    >
      {d.result?.owncast && <OwncastStats o={d.result.owncast} />}
      {d.agent?.metrics && d.agent.online && (
        <div className="flex gap-3">
          <MiniBar label="CPU" value={d.agent.metrics.cpu} />
          <MiniBar label="RAM" value={d.agent.metrics.mem} />
          <MiniBar label={t("orch.mon.disk")} value={d.agent.metrics.disk} />
        </div>
      )}
    </Tile>
  );
  const addBtn = (b: Block) =>
    admin && (
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ block: b })}>
        {t("orch.mon.add")}
      </Button>
    );

  return (
    <div data-wide-page>
      <PageHeader
        title={t("orch.mon.title")}
        description={t("orch.mon.intro")}
        actions={
          <span className="inline-flex items-center gap-2 text-xs text-muted">
            <span className={cx("size-2 rounded-full", failed ? "bg-danger" : "animate-pulse bg-ok")} />
            {failed ? t("orch.mon.refreshFailed") : `${t("orch.mon.updated")} ${new Date(o.checkedAt).toLocaleTimeString()}`}
          </span>
        }
      />

      <div className={cx("mb-6 flex flex-wrap items-center gap-4 rounded-xl border px-5 py-4", allOk ? "border-ok/40 bg-ok/8" : s.down ? "border-danger/40 bg-danger/8" : "border-warn/50 bg-warn/10")}>
        {allOk ? <CheckCircle2 className="size-8 text-ok" /> : s.down ? <XCircle className="size-8 text-danger" /> : <AlertTriangle className="size-8 text-warn" />}
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-semibold">{allOk ? t("orch.mon.allOk") : t("orch.mon.attention", { down: s.down, warn: s.warn })}</p>
          <p className="text-sm text-muted">{t("orch.mon.summary", { ok: s.ok, total: s.ok + s.warn + s.down + s.unknown })}</p>
        </div>
        <div className="flex gap-2">
          {(["ok", "warn", "down", "unknown"] as Health[]).map((h) =>
            s[h] ? (
              <span key={h} className={cx("inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-xs font-medium", HEALTH_TEXT[h])}>
                <Dot health={h} /> {s[h]} {t(`orch.mon.health.${h}`).toLowerCase()}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <div ref={container} className="relative">
        <Lines boxes={boxes} health={{ infra: infraHealth, dist: distHealth, extra: extraHealth }} />

        {/* Core */}
        <div className="mx-auto mb-16 max-w-xl">
          <Block refEl={refs.core} health={o.core.health} icon={<ShieldCheck className="size-5" />} title={t("orch.mon.core")} subtitle={t("orch.mon.coreSub")}>
            <Tile
              health={o.core.health}
              icon={<Boxes className="size-4" />}
              title={o.core.name}
              sub={
                <>
                  <Mono>{o.core.hostname}</Mono> · v{o.core.version} · {o.core.channel}
                </>
              }
              right={<span className="text-[11px] text-muted">{t("orch.mon.up")} {uptime(o.core.uptimeSeconds)}</span>}
              issues={o.core.issues}
              onClick={() => nav("/system/backup")}
            >
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <Badge tone={o.core.mailConfigured ? "ok" : "warn"}>{t("orch.mon.mail")}</Badge>
                <Badge tone={o.core.lastBackup?.status === "success" ? "ok" : o.core.lastBackup ? "danger" : "warn"}>
                  {t("orch.mon.backup")}
                  {o.core.lastBackup ? ` · ${new Date(o.core.lastBackup.at).toLocaleDateString()}` : ""}
                </Badge>
                <Badge tone="brand">
                  {visibleNodes.filter((n) => n.status === "approved").length} {t("orch.mon.nodesManaged")}
                </Badge>
              </div>
            </Tile>
          </Block>
        </div>

        <div className="grid gap-16 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-x-24">
          {/* Infrastructure */}
          <Block
            refEl={refs.infra}
            health={infraHealth}
            icon={<SlidersHorizontal className="size-5" />}
            title={t("orch.mon.infra")}
            subtitle={t("orch.mon.infraSub", { studios: studios.length, atems: o.atems.length, decks: o.hyperdecks.length })}
            actions={addBtn("infrastructure")}
          >
            <Section title={t("orch.mon.studios")} count={studios.length}>
              {studios.length ? studios.map(nodeTile) : <p className="text-sm text-muted">{t("orch.mon.noStudios")}</p>}
            </Section>
            {managers.length > 0 && (
              <Section title={t("orch.mon.management")} count={managers.length}>
                {managers.map(nodeTile)}
              </Section>
            )}
            {o.atems.length > 0 && (
              <Section title={t("orch.nav.atem")} count={o.atems.length}>
                {o.atems.map((a) => (
                  <Tile
                    key={a.id}
                    health={a.health}
                    icon={<SlidersHorizontal className="size-4" />}
                    title={a.name}
                    sub={
                      <>
                        {a.model ?? "ATEM"} · <Mono>{a.host}</Mono>
                      </>
                    }
                    right={a.control === "locked" ? <Badge tone="warn">{t("orch.mon.locked")}</Badge> : <Badge tone="brand">{t("orch.mon.automation")}</Badge>}
                    issues={a.issues}
                    onClick={() => nav(`/atem/${a.id}`)}
                  />
                ))}
              </Section>
            )}
            {o.hyperdecks.length > 0 && (
              <Section title={t("orch.nav.hyperdeck")} count={o.hyperdecks.length}>
                {o.hyperdecks.map((h) => (
                  <Tile
                    key={h.id}
                    health={h.health}
                    icon={<Video className="size-4" />}
                    title={h.name}
                    sub={
                      <>
                        {h.model ?? "HyperDeck"} · <Mono>{h.host}</Mono>
                      </>
                    }
                    right={h.transport === "record" ? <Badge tone="danger">REC</Badge> : h.transport ? <Badge>{t(`orch.hyperdeck.status_${h.transport}`, { defaultValue: h.transport })}</Badge> : null}
                    issues={h.issues}
                    onClick={() => nav(`/hyperdeck/${h.id}`)}
                  />
                ))}
              </Section>
            )}
            {dev("infrastructure").length > 0 && (
              <Section title={t("orch.mon.otherInfra")} count={dev("infrastructure").length}>
                {dev("infrastructure").map(deviceTile)}
              </Section>
            )}
            {others.length > 0 && (
              <Section title={t("orch.mon.otherNodes")} count={others.length}>
                {others.map(nodeTile)}
              </Section>
            )}
          </Block>

          {/* Distribution */}
          <Block refEl={refs.dist} health={distHealth} icon={<Users className="size-5" />} title={t("orch.mon.dist")} subtitle={t("orch.mon.distSub")} actions={addBtn("distribution")} className="self-start">
            {dev("distribution").length ? (
              <div className="grid gap-2">{dev("distribution").map(deviceTile)}</div>
            ) : (
              <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">
                <Radio className="mx-auto mb-2 size-6 text-brand" />
                <p>{t("orch.mon.noDist")}</p>
                {admin && (
                  <Button size="sm" className="mt-3" icon={<Plus className="size-3.5" />} onClick={() => setDialog({ block: "distribution" })}>
                    {t("orch.mon.addOwncast")}
                  </Button>
                )}
              </div>
            )}
          </Block>
        </div>

        {/* Extra equipment */}
        <div className="mt-16">
          <Block refEl={refs.extra} health={extraHealth} icon={<HardDrive className="size-5" />} title={t("orch.mon.extra")} subtitle={t("orch.mon.extraSub")} actions={addBtn("extra")}>
            {dev("extra").length ? (
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">{dev("extra").map(deviceTile)}</div>
            ) : (
              <p className="text-sm text-muted">{t("orch.mon.noExtra")}</p>
            )}
          </Block>
        </div>
      </div>

      {problems.length > 0 && (
        <Card className="mt-8">
          <CardHeader title={t("orch.mon.problems")} description={t("orch.mon.problemsIntro")} icon={<AlertTriangle className="size-5 text-warn" />} />
          <ul className="divide-y divide-line">
            {problems.map((p, n) => (
              <li key={n}>
                <button type="button" onClick={p.go} className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-3 text-left text-sm transition hover:bg-surface-2/60 sm:flex-nowrap">
                  <Dot health={p.i.level} />
                  <span className="min-w-0 flex-1 truncate font-medium sm:w-48 sm:flex-none">{p.name}</span>
                  <span className={cx("order-last w-full pl-5 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:pl-0", p.i.level === "down" ? "text-danger" : "text-warn")}>{text(p.i)}</span>
                  <span className="text-xs font-medium text-brand">{t("orch.dashboard.open")} →</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {dialog && (
        <DeviceDialog
          device={dialog.device}
          block={dialog.block}
          nodes={o.nodes}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
