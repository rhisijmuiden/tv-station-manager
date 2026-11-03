import {
  Alert,
  ApiError,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  Textarea,
  cx,
  del,
  get,
  post,
  put,
  roleAtLeast,
  useSession,
} from "@tvsm/ui";
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Cpu,
  Globe,
  HardDrive,
  LayoutGrid,
  Network,
  Plus,
  RefreshCw,
  Radio,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Tv,
  Repeat,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  BLOCKS,
  CHECK_TYPES,
  MANUAL_STATUSES,
  type Block,
  type CheckType,
  type Health,
  type Issue,
  type OwncastStatus,
} from "../server/monitorlogic";
import { MonitoringRoom } from "./MonitoringRoom";
import {
  LAYERS,
  MANY_ITEMS,
  SIGNAL_LAYERS,
  attention,
  matches,
  pushHistory,
  sparkPoints,
  summarize,
  toItems,
  type Filter,
  type LayerId,
  type MonDevice,
  type MonItem,
  type MonNode,
  type Overview,
} from "./monitorView";
import "./monitoring.css";

const REFRESH_MS = 5000;

const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  down: "bg-danger",
  unknown: "bg-muted/50",
};
const HEALTH_TEXT: Record<Health, string> = {
  ok: "text-ok",
  warn: "text-warn",
  down: "text-danger",
  unknown: "text-muted",
};
const HEALTH_RING: Record<Health, string> = {
  ok: "border-t-ok",
  warn: "border-t-warn",
  down: "border-t-danger",
  unknown: "border-t-line",
};

export function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d
    ? `${d}d ${h}h`
    : h
      ? `${h}h ${String(m).padStart(2, "0")}m`
      : `${m}m`;
}

function useIssueText() {
  const { t } = useTranslation();
  return (i: Issue) => {
    const params: Record<string, string | number> = { ...(i.params ?? {}) };
    if (typeof params.since === "string")
      params.since = new Date(params.since).toLocaleString();
    return t(`orch.mon.issue.${i.code}`, { ...params, defaultValue: i.code });
  };
}

function Dot({ health, pulse }: { health: Health; pulse?: boolean }) {
  return (
    <span
      className={cx(
        "relative inline-block size-2.5 shrink-0 rounded-full",
        HEALTH_DOT[health],
      )}
    >
      {pulse && health === "ok" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40" />
      )}
      {health === "down" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-danger opacity-50" />
      )}
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
        <div
          className={cx("h-full rounded-full", tone)}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}
// ---- device dialog ----------------------------------------------------------------------------------

const CHECK_ICON: Record<CheckType, ReactNode> = {
  owncast: <Radio className="size-4" />,
  http: <Globe className="size-4" />,
  tcp: <Activity className="size-4" />,
  manual: <Wrench className="size-4" />,
};

function OwncastStats({ o, big }: { o: OwncastStatus; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={cx(
        "grid grid-cols-3 gap-2 rounded-md bg-surface-2/70 p-2 text-center",
        big && "p-3",
      )}
    >
      <div>
        <div
          className={cx(
            "font-semibold tabular-nums",
            big ? "text-2xl" : "text-lg",
          )}
        >
          {o.viewers}
        </div>
        <div className="text-[10px] text-muted uppercase">
          {t("orch.mon.viewers")}
        </div>
      </div>
      <div>
        <div
          className={cx(
            "font-semibold tabular-nums",
            big ? "text-2xl" : "text-lg",
          )}
        >
          {o.sessionMaxViewers}
        </div>
        <div className="text-[10px] text-muted uppercase">
          {t("orch.mon.peakSession")}
        </div>
      </div>
      <div>
        <div
          className={cx(
            "font-semibold tabular-nums",
            big ? "text-2xl" : "text-lg",
          )}
        >
          {o.overallMaxViewers}
        </div>
        <div className="text-[10px] text-muted uppercase">
          {t("orch.mon.peakAll")}
        </div>
      </div>
    </div>
  );
}

function DeviceDialog({
  device,
  block,
  nodes,
  onClose,
  onDone,
}: {
  device?: MonDevice;
  block: Block;
  nodes: MonNode[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const text = useIssueText();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const operator = roleAtLeast(user?.role, "operator");
  const [f, setF] = useState({
    name: device?.name ?? "",
    block: device?.block ?? block,
    checkType:
      device?.checkType ??
      (block === "distribution"
        ? "owncast"
        : block === "extra"
          ? "manual"
          : "tcp"),
    target: device?.target ?? "",
    nodeId: device?.nodeId ?? "",
    manualStatus: device?.manualStatus ?? "ok",
    location: device?.location ?? "",
    notes: device?.notes ?? "",
  });
  const [cur, setCur] = useState(device);
  const [events, setEvents] = useState<
    { type: string; message: string; at: string }[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (device)
      void get<{ events: typeof events }>(
        `/api/monitoring/devices/${device.id}`,
      ).then((r) => setEvents(r.events));
  }, [device]);
  const fail = (e: unknown) =>
    setError(
      e instanceof ApiError
        ? t(`orch.mon.err_${e.code}`, { defaultValue: e.message })
        : String(e),
    );
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
    if (!device || !confirm(t("orch.mon.confirmDelete", { name: device.name })))
      return;
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
      setCur(
        await post<MonDevice>(`/api/monitoring/devices/${device.id}/check`),
      );
      setEvents(
        (
          await get<{ events: typeof events }>(
            `/api/monitoring/devices/${device.id}`,
          )
        ).events,
      );
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
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              loading={busy === "delete"}
              onClick={remove}
            >
              {t("common.delete")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {admin ? t("common.cancel") : t("common.close")}
          </Button>
          {admin && (
            <Button
              loading={busy === "save"}
              onClick={save}
              disabled={
                !f.name || (f.checkType !== "manual" && !f.target.trim())
              }
            >
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
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 text-sm font-semibold",
                  HEALTH_TEXT[cur.health],
                )}
              >
                <Dot health={cur.health} /> {t(`orch.mon.health.${cur.health}`)}
              </span>
              {r?.ms != null && <Badge>{r.ms} ms</Badge>}
              {r?.httpStatus != null && <Badge>HTTP {r.httpStatus}</Badge>}
              {r?.owncast?.version && (
                <Badge>Owncast {r.owncast.version}</Badge>
              )}
              {r?.owncast && (
                <Badge tone={r.owncast.online ? "danger" : "neutral"}>
                  {r.owncast.online ? t("orch.mon.live") : t("orch.mon.offAir")}
                </Badge>
              )}
              <span className="ml-auto text-xs text-muted">
                {cur.lastCheckAt
                  ? `${t("orch.mon.lastCheck")}: ${new Date(cur.lastCheckAt).toLocaleTimeString()}`
                  : cur.checkType === "manual"
                    ? t("orch.mon.manualHint")
                    : ""}
              </span>
              {cur.checkType !== "manual" && operator && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RefreshCw className="size-3.5" />}
                  loading={busy === "check"}
                  onClick={checkNow}
                >
                  {t("orch.mon.checkNow")}
                </Button>
              )}
            </div>
            {cur.issues.map((i, n) => (
              <p
                key={n}
                className={cx(
                  "text-sm",
                  i.level === "down" ? "text-danger" : "text-warn",
                )}
              >
                {text(i)}
              </p>
            ))}
            {r?.owncast && (
              <>
                {(r.owncast.name || r.owncast.streamTitle) && (
                  <p className="text-sm">
                    <span className="font-medium">{r.owncast.name}</span>
                    {r.owncast.streamTitle && (
                      <span className="text-muted">
                        {" "}
                        · {r.owncast.streamTitle}
                      </span>
                    )}
                  </p>
                )}
                <OwncastStats o={r.owncast} big />
                <p className="text-xs text-muted">
                  {r.owncast.online &&
                    r.owncast.lastConnectTime &&
                    `${t("orch.mon.liveSince")} ${new Date(r.owncast.lastConnectTime).toLocaleString()}`}
                  {!r.owncast.online &&
                    r.owncast.lastDisconnectTime &&
                    `${t("orch.mon.offlineSince")} ${new Date(r.owncast.lastDisconnectTime).toLocaleString()}`}
                </p>
              </>
            )}
            {cur.agent && (
              <div className="rounded-md bg-surface-2/60 p-2.5">
                <p className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                  <Cpu className="size-3.5 text-muted" />
                  {t("orch.mon.agentOn", { name: cur.agent.name })}
                  <span
                    className={cur.agent.online ? "text-ok" : "text-danger"}
                  >
                    ·{" "}
                    {cur.agent.online
                      ? t("orch.nodes.online")
                      : t("orch.nodes.offline")}
                  </span>
                </p>
                {cur.agent.metrics && (
                  <div className="flex gap-3">
                    <MiniBar label="CPU" value={cur.agent.metrics.cpu} />
                    <MiniBar label="RAM" value={cur.agent.metrics.mem} />
                    <MiniBar
                      label={t("orch.mon.disk")}
                      value={cur.agent.metrics.disk}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {admin ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("orch.atem.name")}>
              {(id) => (
                <Input
                  id={id}
                  value={f.name}
                  placeholder={
                    f.checkType === "owncast" ? "Owncast website" : "UNAS Pro"
                  }
                  onChange={(e) => setF({ ...f, name: e.target.value })}
                />
              )}
            </Field>
            <Field label={t("orch.mon.block")}>
              {(id) => (
                <Select
                  id={id}
                  value={f.block}
                  onChange={(e) =>
                    setF({ ...f, block: e.target.value as Block })
                  }
                >
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
                      className={cx(
                        "flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left text-xs transition",
                        f.checkType === c
                          ? "border-brand bg-brand/8 ring-1 ring-brand"
                          : "border-line hover:bg-surface-2",
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {CHECK_ICON[c]} {t(`orch.mon.check_${c}`)}
                      </span>
                      <span className="text-muted">
                        {t(`orch.mon.check_${c}_hint`)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {f.checkType !== "manual" ? (
              <Field
                label={t("orch.mon.target")}
                hint={t(`orch.mon.target_${f.checkType}_hint`)}
                className="sm:col-span-2"
              >
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono"
                    value={f.target}
                    placeholder={
                      f.checkType === "owncast"
                        ? "http://10.40.6.127:8080"
                        : f.checkType === "tcp"
                          ? "10.40.0.154:445"
                          : "https://ijmond360.nl"
                    }
                    onChange={(e) => setF({ ...f, target: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <Field
                label={t("orch.mon.manualStatus")}
                hint={t("orch.mon.manualHint")}
                className="sm:col-span-2"
              >
                {(id) => (
                  <Select
                    id={id}
                    value={f.manualStatus}
                    onChange={(e) =>
                      setF({ ...f, manualStatus: e.target.value as Health })
                    }
                  >
                    {MANUAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`orch.mon.health.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field
              label={`${t("orch.mon.agent")} (${t("common.optional")})`}
              hint={t("orch.mon.agentHint")}
              className="sm:col-span-2"
            >
              {(id) => (
                <Select
                  id={id}
                  value={f.nodeId}
                  onChange={(e) => setF({ ...f, nodeId: e.target.value })}
                >
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
            <Field
              label={`${t("orch.atem.location")} (${t("common.optional")})`}
            >
              {(id) => (
                <Input
                  id={id}
                  value={f.location}
                  placeholder={t("orch.atem.locationPlaceholder")}
                  onChange={(e) => setF({ ...f, location: e.target.value })}
                />
              )}
            </Field>
            <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>
              {(id) => (
                <Textarea
                  id={id}
                  className="min-h-10 font-sans text-sm"
                  value={f.notes}
                  onChange={(e) => setF({ ...f, notes: e.target.value })}
                />
              )}
            </Field>
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
            <p className="mb-1.5 text-xs font-semibold tracking-wider text-muted uppercase">
              {t("orch.mon.history")}
            </p>
            <ul className="max-h-48 divide-y divide-line overflow-auto rounded-lg border border-line text-xs">
              {events.map((e, i) => (
                <li key={i} className="flex gap-3 px-3 py-1.5">
                  <span className="shrink-0 font-mono text-muted">
                    {new Date(e.at).toLocaleString()}
                  </span>
                  <span
                    className={cx(
                      e.type === "down"
                        ? "text-danger"
                        : e.type === "warn"
                          ? "text-warn"
                          : e.type === "ok"
                            ? "text-ok"
                            : undefined,
                    )}
                  >
                    {e.message}
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

// ---- items ----------------------------------------------------------------------------------------

const LAYER_ICON: Record<LayerId, typeof Tv> = {
  core: ShieldCheck,
  management: Clapperboard,
  nodes: Tv,
  switchers: SlidersHorizontal,
  converters: Repeat,
  distribution: Radio,
  infrastructure: HardDrive,
};

function itemIcon(i: MonItem, cls = "size-4") {
  if (i.kind === "device")
    return (
      <span className="contents [&>svg]:size-4">
        {CHECK_ICON[i.device.checkType]}
      </span>
    );
  if (i.kind === "node" && i.layer === "infrastructure")
    return <Server className={cls} />;
  const I = LAYER_ICON[i.layer];
  return <I className={cls} />;
}

/** One line under the name: what the item is and where it lives. */
function useItemSub() {
  const { t } = useTranslation();
  return (i: MonItem): ReactNode => {
    switch (i.kind) {
      case "core":
        return `v${i.core.version} · ${i.core.channel}`;
      case "node":
        return (
          <>
            {i.node.status === "approved"
              ? t(`orch.nodes.role_${i.node.role}`, {
                  defaultValue: i.node.role,
                })
              : t(`orch.nodes.status_${i.node.status}`, {
                  defaultValue: i.node.status,
                })}{" "}
            · <Mono>{i.host}</Mono>
          </>
        );
      case "atem":
        return (
          <>
            {i.atem.model ?? "ATEM"} · <Mono>{i.host}</Mono>
          </>
        );
      case "teranex":
        return (
          <>
            {i.teranex.model ?? "Teranex"} · <Mono>{i.host}</Mono>
          </>
        );
      case "device":
        return i.device.checkType === "manual" ? (
          [i.device.location || t("orch.mon.check_manual"), i.device.notes]
            .filter(Boolean)
            .join(" · ")
        ) : (
          <Mono>{i.device.target}</Mono>
        );
    }
  };
}

/** Small status badge at the right of a tile. */
function ItemBadge({ i }: { i: MonItem }) {
  const { t } = useTranslation();
  if (i.kind === "core")
    return (
      <span className="text-[11px] text-muted">{`${t("orch.mon.up")} ${uptime(i.core.uptimeSeconds)}`}</span>
    );
  if (i.kind === "node")
    return i.node.casparcg ? (
      <Badge tone={i.node.casparcg.connected ? "ok" : "danger"}>CasparCG</Badge>
    ) : null;
  if (i.kind === "atem")
    return i.atem.control === "locked" ? (
      <Badge tone="warn">{t("orch.mon.locked")}</Badge>
    ) : (
      <Badge tone="brand">{t("orch.mon.automation")}</Badge>
    );
  if (i.kind === "teranex")
    return i.teranex.input?.signal === false ? (
      <Badge tone="danger">{t("orch.teranex.noSignalShort")}</Badge>
    ) : i.teranex.input?.format ? (
      <Badge tone="brand">{i.teranex.input.format}</Badge>
    ) : null;
  const r = i.device.result;
  if (r?.owncast)
    return (
      <Badge tone={r.owncast.online ? "danger" : "neutral"}>
        {r.owncast.online ? t("orch.mon.live") : t("orch.mon.offAir")}
      </Badge>
    );
  return r?.ms != null ? (
    <span className="text-[11px] text-muted tabular-nums">{r.ms} ms</span>
  ) : null;
}

function Metrics3({ m }: { m: MonItem["metrics"] }) {
  const { t } = useTranslation();
  if (!m) return null;
  return (
    <div className="flex gap-3">
      <MiniBar label="CPU" value={m.cpu} />
      <MiniBar label="RAM" value={m.mem} />
      <MiniBar label={t("orch.mon.disk")} value={m.disk} />
    </div>
  );
}

function ItemTile({
  i,
  compact,
  selected,
  onSelect,
}: {
  i: MonItem;
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const text = useIssueText();
  const sub = useItemSub();
  const frame = cx(
    "group flex w-full min-w-0 flex-col rounded-lg border bg-surface text-left transition hover:border-brand-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
    selected
      ? "border-brand ring-2 ring-brand/40"
      : i.health === "down"
        ? "border-danger/50 bg-danger/[0.04]"
        : i.health === "warn"
          ? "border-warn/60"
          : "border-line",
  );
  if (compact) {
    const value =
      i.metrics?.cpu != null
        ? `${i.metrics.cpu}%`
        : i.kind === "device" && i.device.result?.ms != null
          ? `${i.device.result.ms} ms`
          : t(`orch.mon.health.${i.health}`);
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cx(frame, "gap-0.5 px-3 py-2")}
        title={i.issues.map(text).join("\n") || undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Dot health={i.health} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {i.name}
          </span>
          <span
            className={cx(
              "shrink-0 font-mono text-[11px]",
              i.health === "ok" ? "text-muted" : HEALTH_TEXT[i.health],
            )}
          >
            {value}
          </span>
        </span>
        <span className="truncate pl-[18px] font-mono text-[11px] text-muted">
          {i.host || "—"}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(frame, "gap-2 p-3")}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-muted group-hover:text-brand">
          {itemIcon(i)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <Dot health={i.health} pulse />
            <span className="min-w-0 text-sm font-semibold break-words">
              {i.name}
            </span>
          </span>
          <span className="mt-0.5 block text-xs break-words text-muted">
            {sub(i)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <ItemBadge i={i} />
        </span>
      </span>
      {i.kind === "device" && i.device.result?.owncast && (
        <OwncastStats o={i.device.result.owncast} />
      )}
      <Metrics3 m={i.metrics} />
      {i.issues.length > 0 && (
        <span className="block space-y-0.5">
          {i.issues.slice(0, 2).map((x, n) => (
            <span
              key={n}
              className={cx(
                "flex items-start gap-1.5 text-xs",
                x.level === "down" ? "text-danger" : "text-warn",
              )}
            >
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{text(x)}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

// ---- signal path ------------------------------------------------------------------------------------

function SignalPath({
  items,
  layer,
  onLayer,
}: {
  items: MonItem[];
  layer: LayerId | "all";
  onLayer: (l: LayerId | "all") => void;
}) {
  const { t } = useTranslation();
  const sum = summarize(items);
  const step = (l: LayerId) => {
    const Icon = LAYER_ICON[l];
    const on = layer === l;
    return (
      <button
        key={l}
        type="button"
        aria-pressed={on}
        onClick={() => onLayer(on ? "all" : l)}
        className={cx(
          "inline-flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition",
          on
            ? "border-brand bg-brand/10"
            : "border-line bg-surface hover:border-brand-light",
        )}
      >
        <Icon className="size-[18px] text-brand" />
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">
            {t(`orch.mon.layer_${l}`)}
          </span>
          <span className="text-xs text-muted">
            {t("orch.mon.items", { count: sum[l].total })}
          </span>
        </span>
        <span
          className={cx(
            "ml-1 size-2.5 rounded-full",
            sum[l].total ? HEALTH_DOT[sum[l].health] : "bg-line",
          )}
        />
      </button>
    );
  };
  return (
    <section
      aria-label={t("orch.mon.path")}
      className="mb-5 rounded-xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="mb-2.5 flex flex-wrap justify-between gap-2 text-xs">
        <span className="font-semibold tracking-wider text-muted uppercase">
          {t("orch.mon.path")}
        </span>
        <span className="text-muted">{t("orch.mon.pathHint")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {SIGNAL_LAYERS.map((l, n) => (
          <span key={l} className="contents">
            {n > 0 && (
              <ChevronRight className="size-4 text-brand-light" aria-hidden />
            )}
            {step(l)}
          </span>
        ))}
        <span className="mx-1.5 h-8 w-px bg-line" aria-hidden />
        {LAYERS.filter((l) => !SIGNAL_LAYERS.includes(l)).map(step)}
      </div>
    </section>
  );
}

// ---- detail panel -----------------------------------------------------------------------------------

function Sparkline({ values }: { values: number[] }) {
  const { t } = useTranslation();
  if (values.length < 2) return null;
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{t("orch.mon.cpuHistory")}</p>
      <svg
        viewBox="0 0 300 60"
        preserveAspectRatio="none"
        className="block h-16 w-full rounded-md bg-surface-2/60"
        role="img"
        aria-label={t("orch.mon.cpuHistory")}
      >
        <line
          x1="0"
          x2="300"
          y1="6"
          y2="6"
          stroke="var(--tvsm-danger)"
          strokeOpacity=".5"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={sparkPoints(values, 300, 60)}
          fill="none"
          stroke="var(--tvsm-primary)"
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function DetailPanel({
  i,
  history,
  onOpen,
  onRefresh,
}: {
  i: MonItem | null;
  history: number[];
  onOpen: (i: MonItem) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const text = useIssueText();
  const sub = useItemSub();
  const nav = useNavigate();
  const { user } = useSession();
  const operator = roleAtLeast(user?.role, "operator");
  const [events, setEvents] = useState<
    { type: string; message: string; at: string }[]
  >([]);
  const [checking, setChecking] = useState(false);
  const deviceId = i?.kind === "device" ? i.device.id : null;
  const changedAt = i?.kind === "device" ? i.device.changedAt : null;
  useEffect(() => {
    setEvents([]);
    if (deviceId)
      void get<{ events: typeof events }>(
        `/api/monitoring/devices/${deviceId}`,
      ).then(
        (r) => setEvents(r.events.slice(0, 5)),
        () => undefined,
      );
  }, [deviceId, changedAt]);

  if (!i)
    return (
      <p className="p-5 text-sm text-muted">{t("orch.mon.noSelection")}</p>
    );

  const when = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString() : "—";
  const facts: [string, ReactNode][] = [];
  if (i.kind === "core") {
    facts.push(
      [t("orch.mon.address"), i.core.hostname],
      [t("orch.mon.version"), `${i.core.version} · ${i.core.channel}`],
      [t("orch.mon.uptime"), uptime(i.core.uptimeSeconds)],
    );
    facts.push(
      [
        t("orch.mon.mail"),
        i.core.mailConfigured
          ? t("orch.mon.health.ok")
          : t("orch.mon.health.warn"),
      ],
      [
        t("orch.mon.backup"),
        i.core.lastBackup ? when(i.core.lastBackup.at) : "—",
      ],
    );
  } else if (i.kind === "node") {
    const n = i.node;
    facts.push(
      [t("orch.mon.address"), n.ip ?? n.hostname],
      [t("orch.mon.lastSeen"), when(n.lastSeenAt)],
      [t("orch.mon.agentVersion"), n.agentVersion ?? "—"],
      [t("orch.mon.platform"), n.platform ?? "—"],
    );
    if (n.metrics?.uptimeSeconds != null)
      facts.push([t("orch.mon.uptime"), uptime(n.metrics.uptimeSeconds)]);
    if (n.casparcg)
      facts.push([t("orch.mon.channels"), String(n.casparcg.channels)]);
  } else if (i.kind === "atem") {
    facts.push(
      [t("orch.mon.address"), i.atem.host],
      [t("orch.mon.model"), i.atem.model ?? "—"],
      [
        t("orch.mon.control"),
        i.atem.control === "locked"
          ? t("orch.mon.locked")
          : t("orch.mon.automation"),
      ],
    );
    if (i.atem.location) facts.push([t("orch.mon.location"), i.atem.location]);
  } else if (i.kind === "teranex") {
    const x = i.teranex;
    facts.push(
      [t("orch.mon.address"), x.host],
      [t("orch.mon.model"), x.model ?? "—"],
      [
        t("orch.teranex.input"),
        x.input
          ? x.input.signal === false
            ? t("orch.teranex.noSignal")
            : [x.input.source, x.input.format].filter(Boolean).join(" · ") || "—"
          : "—",
      ],
      [t("orch.teranex.audio"), x.input?.audio ?? "—"],
      [t("orch.teranex.output"), x.output ?? "—"],
    );
    if (x.location) facts.push([t("orch.mon.location"), x.location]);
  } else {
    const d = i.device;
    facts.push([t("orch.mon.checkType"), t(`orch.mon.check_${d.checkType}`)]);
    if (d.checkType !== "manual")
      facts.push(
        [t("orch.mon.address"), d.target],
        [t("orch.mon.lastCheck"), when(d.lastCheckAt)],
      );
    if (d.result?.ms != null)
      facts.push([
        "",
        `${d.result.ms} ms${d.result.httpStatus ? ` · HTTP ${d.result.httpStatus}` : ""}`,
      ]);
    if (d.location) facts.push([t("orch.mon.location"), d.location]);
    if (d.agent)
      facts.push([
        t("orch.mon.agent"),
        `${d.agent.name} · ${d.agent.online ? t("orch.nodes.online") : t("orch.nodes.offline")}`,
      ]);
  }
  const checkNow = async () => {
    if (!deviceId) return;
    setChecking(true);
    try {
      await post(`/api/monitoring/devices/${deviceId}/check`);
      onRefresh();
    } finally {
      setChecking(false);
    }
  };
  const inDiagram =
    i.kind === "node" || i.kind === "atem" || i.kind === "teranex";

  return (
    <div className="divide-y divide-line">
      <div className="space-y-3 p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand">
            {itemIcon(i, "size-5")}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-semibold">
              {i.name}
            </h2>
            <p className="truncate text-xs text-muted">{sub(i)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 font-semibold",
              HEALTH_TEXT[i.health],
            )}
          >
            <Dot health={i.health} /> {t(`orch.mon.health.${i.health}`)}
          </span>
          <span className="text-muted">
            {t("orch.mon.layer")}: {t(`orch.mon.layer_${i.layer}`)}
          </span>
          <span className="ml-auto">
            <ItemBadge i={i} />
          </span>
        </div>
        {i.issues.length > 0 && (
          <ul
            className={cx(
              "space-y-1 rounded-lg border px-3 py-2.5 text-sm",
              i.health === "down"
                ? "border-danger/40 bg-danger/8 text-danger"
                : "border-warn/50 bg-warn/10 text-fg",
            )}
          >
            {i.issues.map((x, n) => (
              <li key={n} className="flex items-start gap-2">
                <AlertTriangle
                  className={cx(
                    "mt-0.5 size-4 shrink-0",
                    x.level === "down" ? "text-danger" : "text-warn",
                  )}
                />
                {text(x)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5">
        {facts.map(([k, v], n) => (
          <div key={n} className="min-w-0">
            <dt className="text-[11px] text-muted">{k}</dt>
            <dd className="font-mono text-xs break-words">{v}</dd>
          </div>
        ))}
      </dl>

      {(i.metrics || (i.kind === "device" && i.device.result?.owncast)) && (
        <div className="space-y-3 p-5">
          {i.kind === "device" && i.device.result?.owncast && (
            <OwncastStats o={i.device.result.owncast} big />
          )}
          <Metrics3 m={i.metrics} />
          <Sparkline values={history} />
        </div>
      )}

      {events.length > 0 && (
        <div className="p-5">
          <p className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">
            {t("orch.mon.history")}
          </p>
          <ul className="space-y-1.5 text-xs">
            {events.map((e, n) => (
              <li key={n} className="flex gap-2.5">
                <span className="shrink-0 font-mono text-muted">
                  {new Date(e.at).toLocaleTimeString()}
                </span>
                <span
                  className={cx(
                    e.type === "down"
                      ? "text-danger"
                      : e.type === "warn"
                        ? "text-warn"
                        : e.type === "ok"
                          ? "text-ok"
                          : undefined,
                  )}
                >
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 p-5">
        <Button onClick={() => onOpen(i)}>{t("orch.mon.open")}</Button>
        {deviceId &&
          i.kind === "device" &&
          i.device.checkType !== "manual" &&
          operator && (
            <Button
              variant="secondary"
              icon={<RefreshCw className="size-3.5" />}
              loading={checking}
              onClick={checkNow}
            >
              {t("orch.mon.checkNow")}
            </Button>
          )}
        {inDiagram && (
          <Button
            variant="secondary"
            icon={<Network className="size-4" />}
            onClick={() => nav("/diagram")}
          >
            {t("orch.mon.inDiagram")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- page ------------------------------------------------------------------------------------------

type View = "2d" | "3d";
type Density = "cards" | "compact";
const readPref = <T extends string>(
  key: string,
  allowed: readonly T[],
): T | null => {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  } catch {
    return null;
  }
};
const writePref = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // private window or blocked storage: the choice just is not remembered
  }
};

export function MonitoringPage() {
  const { t } = useTranslation();
  const text = useIssueText();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [o, setO] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{
    device?: MonDevice;
    block: Block;
  } | null>(null);
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({
    layer: "all",
    health: "all",
    query: "",
  });
  const [view, setViewState] = useState<View>(
    () => readPref("tvsm.mon.view", ["2d", "3d"] as const) ?? "2d",
  );
  const [density, setDensityState] = useState<Density | null>(() =>
    readPref("tvsm.mon.density", ["cards", "compact"] as const),
  );
  const panel = useRef<HTMLElement>(null);
  const setView = (v: View) => {
    setViewState(v);
    writePref("tvsm.mon.view", v);
  };
  const setDensity = (d: Density) => {
    setDensityState(d);
    writePref("tvsm.mon.density", d);
  };

  const load = useCallback(async () => {
    try {
      const r = await get<Overview>("/api/monitoring");
      setO(r);
      setHistory((h) => pushHistory(h, toItems(r)));
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

  const items = useMemo(() => (o ? toItems(o) : []), [o]);
  const visible = useMemo(
    () => new Set(items.filter((i) => matches(i, filter)).map((i) => i.key)),
    [items, filter],
  );
  const problems = useMemo(() => attention(items), [items]);

  if (!o)
    return (
      <PageHeader
        title={t("orch.mon.title")}
        description={t("orch.mon.intro")}
      />
    );

  const many = items.length > MANY_ITEMS;
  const compact = (density ?? (many ? "compact" : "cards")) === "compact";
  const current =
    items.find((i) => i.key === selected) ?? problems[0] ?? items[0] ?? null;
  const select = (key: string) => {
    setSelected(key);
    if (window.innerWidth < 1024)
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const open = (i: MonItem) => {
    if (i.kind === "core") nav("/system/backup");
    else if (i.kind === "node") nav("/nodes");
    else if (i.kind === "atem") nav(`/atem/${i.atem.id}`);
    else if (i.kind === "teranex") nav(`/teranex/${i.teranex.id}`);
    else setDialog({ device: i.device, block: i.device.block });
  };

  const s = o.summary;
  const total = s.ok + s.warn + s.down + s.unknown;
  const allOk = !s.down && !s.warn;
  const filtered =
    filter.layer !== "all" || filter.health !== "all" || !!filter.query.trim();
  const sum = summarize(items);
  const segment = (on: boolean) =>
    cx(
      "inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-sm font-semibold transition",
      on ? "bg-brand text-white" : "text-brand-dark hover:bg-surface-2",
    );

  return (
    <div data-wide-page>
      <PageHeader
        title={t("orch.mon.title")}
        description={t("orch.mon.intro")}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs text-muted">
              <span
                className={cx(
                  "size-2 rounded-full",
                  failed ? "bg-danger" : "animate-pulse bg-ok",
                )}
              />
              {failed
                ? t("orch.mon.refreshFailed")
                : `${t("orch.mon.updated")} ${new Date(o.checkedAt).toLocaleTimeString()}`}
            </span>
            <div
              role="group"
              aria-label={t("orch.mon.view")}
              className="flex gap-1 rounded-lg border border-line bg-surface p-1"
            >
              <button
                type="button"
                aria-pressed={view === "2d"}
                className={segment(view === "2d")}
                onClick={() => setView("2d")}
              >
                <LayoutGrid className="size-4" />
                {t("orch.mon.view2d")}
              </button>
              <button
                type="button"
                aria-pressed={view === "3d"}
                className={segment(view === "3d")}
                onClick={() => setView("3d")}
              >
                <Box className="size-4" />
                {t("orch.mon.view3d")}
              </button>
            </div>
            {admin && (
              <Button
                icon={<Plus className="size-4" />}
                onClick={() =>
                  setDialog({
                    block:
                      filter.layer === "distribution"
                        ? "distribution"
                        : "infrastructure",
                  })
                }
              >
                {t("orch.mon.addDevice")}
              </Button>
            )}
          </div>
        }
      />

      <div
        className={cx(
          "mb-5 flex flex-wrap items-center gap-4 rounded-xl border px-5 py-4",
          allOk
            ? "border-ok/40 bg-ok/8"
            : s.down
              ? "border-danger/40 bg-danger/8"
              : "border-warn/50 bg-warn/10",
        )}
      >
        {allOk ? (
          <CheckCircle2 className="size-8 text-ok" />
        ) : s.down ? (
          <XCircle className="size-8 text-danger" />
        ) : (
          <AlertTriangle className="size-8 text-warn" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-semibold">
            {allOk
              ? t("orch.mon.allOk")
              : t("orch.mon.attention", { down: s.down, warn: s.warn })}
          </p>
          <p className="text-sm text-muted">
            {t("orch.mon.summary", { ok: s.ok, total })}
          </p>
        </div>
        <div
          role="group"
          aria-label={t("orch.mon.filterHealth")}
          className="flex flex-wrap gap-2"
        >
          {(["all", "ok", "warn", "down", "unknown"] as const).map((h) => {
            if (h !== "all" && !s[h]) return null;
            const on = filter.health === h;
            return (
              <button
                key={h}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter({ ...filter, health: on ? "all" : h })}
                className={cx(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition",
                  on
                    ? "border-sidebar bg-sidebar text-white"
                    : "border-line bg-surface text-fg hover:border-brand-light",
                )}
              >
                <span
                  className={cx(
                    "size-2 rounded-full",
                    h === "all" ? "bg-brand" : HEALTH_DOT[h],
                  )}
                />
                {h === "all"
                  ? t("orch.mon.allCount", { count: total })
                  : `${s[h]} ${t(`orch.mon.health.${h}`).toLowerCase()}`}
              </button>
            );
          })}
        </div>
      </div>

      <SignalPath
        items={items}
        layer={filter.layer}
        onLayer={(layer) => setFilter({ ...filter, layer })}
      />

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[999_1_560px] space-y-4">
          {view === "2d" ? (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex h-10 min-w-0 flex-[1_1_260px] items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-brand">
                  <Search className="size-4 shrink-0 text-muted" />
                  <span className="sr-only">{t("orch.mon.search")}</span>
                  <input
                    type="search"
                    value={filter.query}
                    placeholder={t("orch.mon.search")}
                    onChange={(e) =>
                      setFilter({ ...filter, query: e.target.value })
                    }
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                </label>
                <div
                  role="group"
                  aria-label={t("orch.mon.density")}
                  className="flex gap-1 rounded-lg border border-line bg-surface p-1"
                >
                  <button
                    type="button"
                    aria-pressed={!compact}
                    className={cx(segment(!compact), "h-8 text-xs")}
                    onClick={() => setDensity("cards")}
                  >
                    {t("orch.mon.cards")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={compact}
                    className={cx(segment(compact), "h-8 text-xs")}
                    onClick={() => setDensity("compact")}
                  >
                    {t("orch.mon.compact")}
                  </button>
                </div>
                <span className="text-xs text-muted">
                  {t("orch.mon.shown", {
                    shown: visible.size,
                    total: items.length,
                  })}
                </span>
                {filtered && (
                  <button
                    type="button"
                    className="text-xs font-medium text-brand hover:underline"
                    onClick={() =>
                      setFilter({ layer: "all", health: "all", query: "" })
                    }
                  >
                    {t("orch.mon.clearFilters")}
                  </button>
                )}
              </div>

              <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
                {LAYERS.map((l) => {
                  const list = items.filter(
                    (i) => i.layer === l && visible.has(i.key),
                  );
                  const block: Block | null =
                    l === "distribution"
                      ? "distribution"
                      : l === "infrastructure"
                        ? "infrastructure"
                        : null;
                  const empty = sum[l].total === 0;
                  if (!list.length && !(empty && !filtered && block))
                    return null;
                  const Icon = LAYER_ICON[l];
                  const parts = (["down", "warn", "unknown", "ok"] as Health[])
                    .filter((h) => sum[l].counts[h])
                    .map(
                      (h) =>
                        `${sum[l].counts[h]} ${t(`orch.mon.health.${h}`).toLowerCase()}`,
                    );
                  return (
                    <section
                      key={l}
                      aria-label={t(`orch.mon.layer_${l}`)}
                      className={cx(
                        "overflow-hidden rounded-xl border border-t-4 border-line bg-surface shadow-[var(--tvsm-shadow-card)]",
                        list.length > 2 && "col-span-full",
                        HEALTH_RING[empty ? "unknown" : sum[l].health],
                      )}
                    >
                      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                          <Icon className="size-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h2 className="font-display text-base font-semibold tracking-tight">
                            {t(`orch.mon.layer_${l}`)}
                          </h2>
                          <p className="text-xs text-muted">
                            {[t(`orch.mon.layerDesc_${l}`), ...parts].join(
                              " · ",
                            )}
                          </p>
                        </div>
                        {admin && block && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Plus className="size-3.5" />}
                            onClick={() => setDialog({ block })}
                          >
                            {t("orch.mon.add")}
                          </Button>
                        )}
                      </header>
                      {list.length ? (
                        <div
                          className={cx(
                            "grid gap-2 p-4",
                            compact
                              ? "[grid-template-columns:repeat(auto-fill,minmax(min(100%,10.5rem),1fr))]"
                              : "[grid-template-columns:repeat(auto-fill,minmax(min(100%,15.5rem),1fr))]",
                          )}
                        >
                          {list.map((i) => (
                            <ItemTile
                              key={i.key}
                              i={i}
                              compact={compact}
                              selected={current?.key === i.key}
                              onSelect={() => select(i.key)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="p-4 text-sm text-muted">
                          {l === "distribution"
                            ? t("orch.mon.noDist")
                            : t("orch.mon.noExtra")}
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>
              {visible.size === 0 && (
                <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center text-sm text-muted">
                  {t("orch.mon.noResults")}
                </div>
              )}
            </>
          ) : (
            <MonitoringRoom
              items={items}
              visible={visible}
              selected={current?.key ?? null}
              onSelect={select}
              many={many}
            />
          )}

          <section
            aria-label={t("orch.mon.problems")}
            className="overflow-hidden rounded-xl border border-line bg-surface"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <h2 className="flex items-center gap-2 font-display text-base font-semibold">
                <AlertTriangle
                  className={cx(
                    "size-5",
                    problems.length ? "text-warn" : "text-muted",
                  )}
                />
                {t("orch.mon.problems")}
              </h2>
              <span className="text-xs text-muted">
                {problems.length
                  ? t("orch.mon.problemsIntro")
                  : t("orch.mon.allFine")}
              </span>
            </header>
            <ul className="divide-y divide-line">
              {problems.map((i) => (
                <li key={i.key}>
                  <button
                    type="button"
                    onClick={() => select(i.key)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-3 text-left text-sm transition hover:bg-surface-2/60 sm:flex-nowrap"
                  >
                    <Dot health={i.health} />
                    <span className="min-w-0 flex-1 truncate font-medium sm:w-48 sm:flex-none">
                      {i.name}
                    </span>
                    <span
                      className={cx(
                        "order-last w-full pl-5 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:pl-0",
                        HEALTH_TEXT[i.health],
                      )}
                    >
                      {i.issues.length
                        ? i.issues.map(text).join(" · ")
                        : t(`orch.mon.health.${i.health}`)}
                    </span>
                    <span className="text-xs font-medium text-brand">
                      {t("orch.mon.details")} →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside
          ref={panel}
          aria-label={t("orch.mon.detail")}
          className="w-full min-w-0 flex-[1_1_300px] scroll-mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--tvsm-shadow-card)] lg:sticky lg:top-4 lg:max-w-sm"
        >
          <DetailPanel
            i={current}
            history={current ? (history[current.key] ?? []) : []}
            onOpen={open}
            onRefresh={() => void load()}
          />
        </aside>
      </div>

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
