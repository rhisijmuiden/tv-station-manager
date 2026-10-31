import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Textarea, cx, del, formatBytes, get, post, put } from "@tvsm/ui";
import { Clock, Cpu, HardDrive, MemoryStick, Plus, Power, RefreshCw, RotateCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type Role = "unassigned" | "management" | "studio" | "other";
interface Metrics {
  cpuCount: number;
  cpuPercent: number;
  memTotal: number;
  memUsed: number;
  disks: { mount: string; total: number; used: number }[];
  uptimeSeconds: number;
}
export interface NodeInfo {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected";
  role: Role;
  fingerprint: string;
  hostname: string;
  platform: string | null;
  os: string | null;
  agentVersion: string | null;
  ips: string[];
  remoteIp: string | null;
  notes: string;
  metrics: Metrics | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}
interface Detail {
  node: NodeInfo;
  events: { type: string; message: string; at: string }[];
  commands: { id: number; type: string; status: string; result: string | null; createdAt: string }[];
}
const ROLES: Role[] = ["management", "studio", "other", "unassigned"];

function useAgo() {
  const { t } = useTranslation();
  return (iso: string | null) => {
    if (!iso) return t("orch.nodes.never");
    const s = Math.max(0, Math.round((Date.now() - new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime()) / 1000));
    if (s < 90) return t("orch.nodes.secondsAgo", { n: s });
    if (s < 5400) return t("orch.nodes.minutesAgo", { n: Math.round(s / 60) });
    return t("orch.nodes.hoursAgo", { n: Math.round(s / 3600) });
  };
}

function Meter({ value, label }: { value: number; label?: string }) {
  const tone = value >= 90 ? "bg-danger" : value >= 75 ? "bg-warn" : "bg-brand";
  return (
    <div className="flex min-w-24 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className={cx("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-10 text-right font-mono text-[11px] text-muted">{label ?? `${Math.round(value)}%`}</span>
    </div>
  );
}

const pct = (used: number, total: number) => (total ? (used / total) * 100 : 0);
const mainDisk = (m: Metrics) => m.disks.reduce((a, b) => (b.total > (a?.total ?? 0) ? b : a), m.disks[0]);

export function StatusDot({ node }: { node: NodeInfo }) {
  const { t } = useTranslation();
  const on = node.online;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" title={on ? t("orch.nodes.online") : t("orch.nodes.offline")}>
      <span className={cx("relative size-2.5 rounded-full", on ? "bg-ok" : "bg-danger")}>
        {on && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40" />}
      </span>
      <span className={on ? "text-ok" : "text-danger"}>{on ? t("orch.nodes.online") : t("orch.nodes.offline")}</span>
    </span>
  );
}

export interface InstallInfo {
  channel: "production" | "test";
  repository: string;
}

function InstallDialog({ open, onClose, install }: { open: boolean; onClose: () => void; install?: InstallInfo }) {
  const { t } = useTranslation();
  const url = window.location.origin;
  // Agents follow the orchestrator's own update channel.
  const channel = install?.channel ?? "production";
  const repo = install?.repository ?? "rhisijmuiden/tv-station-manager";
  const raw = `https://raw.githubusercontent.com/${repo}/${channel}/packaging`;
  const linux = `curl -fsSL ${raw}/install.sh | sudo bash -s -- agent --channel ${channel} --repo ${repo} --orchestrator ${url}`;
  const win = `iwr -useb ${raw}/windows/install-agent.ps1 -OutFile $env:TEMP\\install-agent.ps1; & $env:TEMP\\install-agent.ps1 -Orchestrator ${url} -Channel ${channel} -Repo ${repo}`;
  const Block = ({ title, cmd, hint }: { title: string; cmd: string; hint?: string }) => (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium">{title}</p>
      <pre className="overflow-x-auto rounded-md bg-sidebar p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-sidebar-fg">{cmd}</pre>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
  return (
    <Dialog open={open} onClose={onClose} title={t("orch.nodes.installTitle")} wide>
      <p className="mb-4 text-sm text-muted">{t("orch.nodes.installIntro")}</p>
      <div className="space-y-4">
        <Block title={t("orch.nodes.linux")} cmd={linux} />
        <Block title={t("orch.nodes.windows")} cmd={win} hint={t("orch.nodes.windowsHint")} />
        <Alert tone="brand">{t("orch.nodes.afterInstall")}</Alert>
      </div>
    </Dialog>
  );
}

function EditDialog({ node, mode, onClose, onDone }: { node: NodeInfo; mode: "approve" | "edit"; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: node.name, role: node.role === "unassigned" && mode === "approve" ? "studio" : node.role, notes: node.notes });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (mode === "approve") await post(`/api/nodes/${node.id}/approve`, f);
      else await put(`/api/nodes/${node.id}`, f);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "approve" ? t("orch.nodes.approveTitle") : t("orch.nodes.edit")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button icon={mode === "approve" ? <ShieldCheck className="size-4" /> : undefined} loading={busy} onClick={save} disabled={!f.name}>
            {mode === "approve" ? t("orch.nodes.approve") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === "approve" && (
          <div className="flex items-center justify-between rounded-md border border-line bg-surface-2/60 px-4 py-3">
            <span className="text-sm text-muted">{t("orch.nodes.fingerprint")}</span>
            <span className="font-mono text-lg font-semibold tracking-widest">{node.fingerprint}</span>
          </div>
        )}
        <Field label={t("orch.nodes.name")}>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t("orch.nodes.role")}>
          {(id) => (
            <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`orch.nodes.role_${r}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>
          {(id) => <Textarea id={id} className="font-sans text-sm" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function NodeDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const ago = useAgo();
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reboot" | "remove" | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => get<Detail>(`/api/nodes/${id}`).then(setD), [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 4000);
    return () => clearInterval(i);
  }, [load]);
  if (!d) return null;
  const n = d.node;
  const m = n.metrics;
  const send = async (type: string) => {
    await post(`/api/nodes/${n.id}/commands`, { type });
    setMsg(t("orch.nodes.queued"));
    void load();
  };
  const Row = ({ k, v }: { k: string; v: ReactNode }) => (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
  return (
    <>
      <Dialog open onClose={onClose} title={n.name} wide>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <StatusDot node={n} />
          <Badge tone="brand">{t(`orch.nodes.role_${n.role}`)}</Badge>
          <span className="text-xs text-muted">
            {t("orch.nodes.lastSeen")}: {ago(n.lastSeenAt)}
          </span>
        </div>
        {msg && (
          <Alert tone="ok" className="mb-4">
            {msg}
          </Alert>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          <dl className="divide-y divide-line">
            <Row k={t("orch.nodes.hostname")} v={<Mono>{n.hostname}</Mono>} />
            <Row k={t("orch.nodes.ip")} v={<Mono>{n.ips.join(", ") || n.remoteIp}</Mono>} />
            <Row k={t("orch.nodes.os")} v={n.os} />
            <Row k={t("orch.nodes.agent")} v={<Mono>v{n.agentVersion}</Mono>} />
            <Row k={t("orch.nodes.fingerprint")} v={<Mono>{n.fingerprint}</Mono>} />
            {m && <Row k={t("orch.nodes.uptime")} v={`${Math.floor(m.uptimeSeconds / 86400)}d ${Math.floor((m.uptimeSeconds % 86400) / 3600)}h`} />}
          </dl>
          {m && (
            <div className="space-y-3">
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                  <Cpu className="size-3.5" /> {t("orch.nodes.cpu")} · {m.cpuCount} cores
                </p>
                <Meter value={m.cpuPercent} />
              </div>
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                  <MemoryStick className="size-3.5" /> {t("orch.nodes.memory")} · {formatBytes(m.memUsed)} / {formatBytes(m.memTotal)}
                </p>
                <Meter value={pct(m.memUsed, m.memTotal)} />
              </div>
              {m.disks.map((dk) => (
                <div key={dk.mount}>
                  <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                    <HardDrive className="size-3.5" /> <Mono>{dk.mount}</Mono> · {formatBytes(dk.used)} / {formatBytes(dk.total)}
                  </p>
                  <Meter value={pct(dk.used, dk.total)} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t("orch.nodes.edit")}
          </Button>
          {n.status === "approved" && (
            <>
              <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => send("update-agent")}>
                {t("orch.nodes.updateAgent")}
              </Button>
              <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} onClick={() => send("restart-agent")}>
                {t("orch.nodes.restartAgent")}
              </Button>
              <Button size="sm" variant="secondary" icon={<Power className="size-4" />} onClick={() => setConfirm("reboot")}>
                {t("orch.nodes.reboot")}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm("remove")}>
            {t("orch.nodes.remove")}
          </Button>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-2 text-[13px] font-semibold">{t("orch.nodes.events")}</p>
            <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
              {d.events.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <Clock className="mt-0.5 size-3 shrink-0 text-muted" />
                  <span className="flex-1">{e.message}</span>
                  <span className="shrink-0 text-muted">{ago(e.at)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold">{t("orch.nodes.commands")}</p>
            <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
              {d.commands.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <Badge tone={c.status === "done" ? "ok" : c.status === "failed" ? "danger" : "neutral"}>{c.status}</Badge>
                  <Mono>{c.type}</Mono>
                  <span className="flex-1 truncate text-muted" title={c.result ?? ""}>
                    {c.result}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Dialog>
      {editing && (
        <EditDialog
          node={n}
          mode="edit"
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void load();
            onChanged();
          }}
        />
      )}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === "reboot" ? t("orch.nodes.reboot") : t("orch.nodes.remove")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (confirm === "reboot") await send("reboot");
                else {
                  await del(`/api/nodes/${n.id}`);
                  onChanged();
                  onClose();
                }
                setConfirm(null);
              }}
            >
              {confirm === "reboot" ? t("orch.nodes.reboot") : t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t(confirm === "reboot" ? "orch.nodes.rebootConfirm" : "orch.nodes.removeConfirm", { name: n.name })}</p>
      </Dialog>
    </>
  );
}

export function NodesPage() {
  const { t } = useTranslation();
  const ago = useAgo();
  const [data, setData] = useState<{ nodes: NodeInfo[]; install?: InstallInfo } | null>(null);
  const [install, setInstall] = useState(false);
  const [approving, setApproving] = useState<NodeInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => get<{ nodes: NodeInfo[] }>("/api/nodes").then(setData), []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 5000);
    return () => clearInterval(i);
  }, [load]);
  const pending = data?.nodes.filter((n) => n.status === "pending") ?? [];
  const nodes = data?.nodes.filter((n) => n.status !== "pending") ?? [];

  return (
    <>
      <PageHeader
        title={t("orch.nodes.title")}
        description={t("orch.nodes.intro")}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setInstall(true)}>
            {t("orch.nodes.add")}
          </Button>
        }
      />

      {pending.length > 0 && (
        <Card className="mb-6 border-warn/40">
          <CardHeader icon={<ShieldCheck className="size-4" />} title={`${t("orch.nodes.pending")} (${pending.length})`} description={t("orch.nodes.pendingIntro")} />
          <ul className="divide-y divide-line">
            {pending.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{n.hostname}</p>
                  <p className="truncate text-xs text-muted">
                    {n.os} · <Mono>{n.ips[0] ?? n.remoteIp}</Mono> · {ago(n.lastSeenAt ?? n.createdAt)}
                  </p>
                </div>
                <span className="rounded-md bg-surface-2 px-3 py-1 font-mono text-sm font-semibold tracking-widest">{n.fingerprint}</span>
                <Button size="sm" icon={<ShieldCheck className="size-4" />} onClick={() => setApproving(n)}>
                  {t("orch.nodes.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X className="size-4" />}
                  onClick={async () => {
                    await post(`/api/nodes/${n.id}/reject`);
                    void load();
                  }}
                >
                  {t("orch.nodes.reject")}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-3 font-medium">{t("orch.nodes.name")}</th>
                <th className="px-3 py-3 font-medium">{t("common.status")}</th>
                <th className="px-3 py-3 font-medium">{t("orch.nodes.role")}</th>
                <th className="px-3 py-3 font-medium">{t("orch.nodes.cpu")}</th>
                <th className="px-3 py-3 font-medium">{t("orch.nodes.memory")}</th>
                <th className="px-3 py-3 font-medium">{t("orch.nodes.disk")}</th>
                <th className="px-5 py-3 font-medium">{t("orch.nodes.lastSeen")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {nodes.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-muted">
                    {t("orch.nodes.none")}
                  </td>
                </tr>
              )}
              {nodes.map((n) => {
                const m = n.metrics;
                const dk = m && mainDisk(m);
                return (
                  <tr key={n.id} onClick={() => setSelected(n.id)} className={cx("cursor-pointer transition hover:bg-surface-2/60", n.status === "rejected" && "opacity-50")}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{n.name}</p>
                      <p className="text-xs text-muted">
                        <Mono>{n.ips[0] ?? n.remoteIp}</Mono> · {n.platform === "win32" ? "Windows" : n.os}
                      </p>
                    </td>
                    <td className="px-3 py-3">{n.status === "rejected" ? <Badge>{t("orch.nodes.rejected")}</Badge> : <StatusDot node={n} />}</td>
                    <td className="px-3 py-3">
                      <Badge tone={n.role === "studio" ? "danger" : n.role === "management" ? "brand" : "neutral"}>{t(`orch.nodes.role_${n.role}`)}</Badge>
                    </td>
                    <td className="px-3 py-3">{m && n.online ? <Meter value={m.cpuPercent} /> : "–"}</td>
                    <td className="px-3 py-3">{m && n.online ? <Meter value={pct(m.memUsed, m.memTotal)} /> : "–"}</td>
                    <td className="px-3 py-3">{dk ? <Meter value={pct(dk.used, dk.total)} /> : "–"}</td>
                    <td className="px-5 py-3 text-xs whitespace-nowrap text-muted">{ago(n.lastSeenAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <InstallDialog open={install} onClose={() => setInstall(false)} install={data?.install} />
      {approving && (
        <EditDialog
          node={approving}
          mode="approve"
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            void load();
          }}
        />
      )}
      {selected && <NodeDetail id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} />}
    </>
  );
}
