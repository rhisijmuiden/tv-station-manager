/**
 * Role & software of a node (inventory, automatic agent updates, provisioning progress) and the "Change role" wizard:
 * 1. pick the role, 2. settings + software, 3. check the plan (warnings; type the node name when it is on air), start.
 * The orchestrator checks the plan again when the job is queued.
 */
import { Alert, ApiError, Badge, Button, Dialog, Field, Input, Mono, Select, Switch, cx, get, post, put } from "@tvsm/ui";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Cpu, Info, Layers, Loader2, Play, Radio, Settings2, ShieldAlert, Tv, Wand2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NodeInfo } from "./Nodes";

export interface Inventory {
  collectedAt: string;
  os: string | null;
  powershell: string | null;
  desktopVideo: string | null;
  decklinks: string[];
  gpu: { name: string; driver: string | null } | null;
  ffmpeg: string | null;
  vcredist: string | null;
  casparcg: string | null;
  mediamtx: string | null;
  shareCredentials: boolean;
  rebootPending: boolean;
  studioParked: boolean;
}
export interface CommandRow {
  id: number;
  type: string;
  status: string;
  result: string | null;
  progress: string | null;
  createdAt: string;
}
type ProvRole = "playout" | "live" | "studio" | "none";
const PROV_ROLES: ProvRole[] = ["playout", "live", "studio", "none"];
const VIDEO_MODES = ["1080i5000", "1080p5000", "1080p2500", "720p5000", "1080i5994", "1080p2997", "1080p5994", "720p5994", "2160p5000", "2160p2500"];
interface PlanItem {
  key: string;
  params?: Record<string, string | number>;
}
interface Plan {
  steps: PlanItem[];
  warnings: (PlanItem & { level: "block" | "danger" | "warn" | "info" })[];
  blocked: boolean;
  requireTypedName: boolean;
  disruptive: boolean;
}
interface AgentSettings {
  autoUpdate: boolean;
  windowStart: string;
  windowEnd: string;
  deckLinkSource: string;
}

const roleIcon: Record<ProvRole, ReactNode> = {
  playout: <Tv className="size-5" />,
  live: <Radio className="size-5" />,
  studio: <Layers className="size-5" />,
  none: <XCircle className="size-5" />,
};
const currentProvRole = (n: NodeInfo): ProvRole | null => {
  const r = n.metrics?.studio?.role;
  if (r) return r;
  return n.metrics?.inventory?.studioParked ? "none" : null;
};

/** Software list + automatic updates + running job + "Change role" button, in the node detail dialog. */
export function RoleSoftwarePanel({ node, commands, latestAgent, onChanged }: { node: NodeInfo; commands: CommandRow[]; latestAgent: string | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [wizard, setWizard] = useState(false);
  const inv = node.metrics?.inventory ?? null;
  const job = commands.find((c) => c.type === "provision" && (c.status === "queued" || c.status === "sent"));
  const last = commands.find((c) => c.type === "provision" && (c.status === "done" || c.status === "failed"));
  const windows = node.platform === "win32";
  const outdated = latestAgent && node.agentVersion && latestAgent !== node.agentVersion;
  const sw = (label: string, value: string | null, hint?: string) => (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-2 text-right">
        {value ? <Mono>{value}</Mono> : <Badge>{t("orch.prov.notInstalled")}</Badge>}
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </dd>
    </div>
  );
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Settings2 className="size-4" /> {t("orch.prov.title")}
        </p>
        {inv?.rebootPending && <Badge tone="warn">{t("orch.prov.rebootPending")}</Badge>}
        <span className="ml-auto" />
        {windows && node.status === "approved" && (
          <Button size="sm" icon={<Wand2 className="size-4" />} onClick={() => setWizard(true)} disabled={!!job}>
            {t("orch.prov.changeRole")}
          </Button>
        )}
      </div>

      {job && (
        <Alert tone="brand" className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            <span className="font-medium">{t("orch.prov.jobRunning", { id: job.id })}</span>
            <span>
              {job.status === "queued" ? t("orch.prov.jobQueued") : t(`orch.prov.progress_${job.progress ?? "start"}`, { defaultValue: job.progress ?? "" })}
            </span>
            {job.status === "queued" && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={async () => {
                  await post(`/api/nodes/${node.id}/provision/${job.id}/cancel`).catch(() => undefined);
                  onChanged();
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </Alert>
      )}
      {!job && last && (
        <Alert tone={last.status === "done" ? "ok" : "danger"} className="mb-4">
          <p className="font-medium">{last.status === "done" ? t("orch.prov.jobDone", { id: last.id }) : t("orch.prov.jobFailed", { id: last.id })}</p>
          {last.result && <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap">{last.result}</pre>}
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <dl className="divide-y divide-line">
          <div className="flex items-center justify-between gap-4 py-2 text-sm">
            <dt className="text-muted">{t("orch.nodes.agent")}</dt>
            <dd className="flex items-center gap-2">
              <Mono>v{node.agentVersion}</Mono>
              {outdated ? <Badge tone="warn">{t("orch.prov.newer", { v: latestAgent })}</Badge> : latestAgent ? <Badge tone="ok">{t("orch.prov.upToDate")}</Badge> : null}
            </dd>
          </div>
          {windows && (
            <>
              {sw("CasparCG", inv?.casparcg ?? null)}
              {sw(t("orch.prov.mediamtx"), inv?.mediamtx ?? null)}
              {sw("FFmpeg", inv?.ffmpeg ?? null)}
              {sw(t("orch.prov.desktopVideo"), inv?.desktopVideo ?? null, inv ? t("orch.prov.devices", { count: inv.decklinks.length }) : undefined)}
              {sw(t("orch.prov.vcredist"), inv?.vcredist ?? null)}
            </>
          )}
        </dl>
        <div className="space-y-3">
          <Switch
            checked={node.autoUpdate}
            onChange={async (v) => {
              await put(`/api/nodes/${node.id}/auto-update`, { enabled: v });
              onChanged();
            }}
            label={t("orch.prov.autoUpdate")}
            description={t("orch.prov.autoUpdateHint")}
          />
          {windows && inv?.gpu && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Cpu className="size-3.5" /> {inv.gpu.name}
              {inv.gpu.driver ? ` · ${inv.gpu.driver}` : ""}
            </p>
          )}
          {windows && !inv && <p className="text-xs text-muted">{node.capabilities.includes("inventory") ? t("orch.prov.inventoryPending") : t("orch.prov.inventoryOld")}</p>}
          {inv && inv.decklinks.length > 0 && (
            <ul className="space-y-1 text-xs text-muted">
              {inv.decklinks.map((d, i) => (
                <li key={i}>
                  <Mono>{d}</Mono>
                </li>
              ))}
            </ul>
          )}
          {!windows && <p className="text-xs text-muted">{t("orch.prov.linuxHint")}</p>}
        </div>
      </div>
      {wizard && (
        <ProvisionWizard
          node={node}
          onClose={() => setWizard(false)}
          onDone={() => {
            setWizard(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

const levelTone = { block: "danger", danger: "danger", warn: "warn", info: "brand" } as const;
const levelIcon = {
  block: <XCircle className="size-4 shrink-0" />,
  danger: <ShieldAlert className="size-4 shrink-0" />,
  warn: <AlertTriangle className="size-4 shrink-0" />,
  info: <Info className="size-4 shrink-0" />,
};

export function ProvisionWizard({ node, onClose, onDone }: { node: NodeInfo; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const studio = node.metrics?.studio ?? null;
  const inv = node.metrics?.inventory ?? null;
  const current = currentProvRole(node);
  const [step, setStep] = useState(1);
  const [ctx, setCtx] = useState<{ managementHosts: string[]; deckLinkSource: boolean } | null>(null);
  const [f, setF] = useState({
    role: (current && current !== "none" ? current : "playout") as ProvRole,
    outputs: "",
    videoMode: "",
    mediaPath: "",
    smbUser: "",
    smbPassword: "",
    managementHost: "",
    ffmpeg: !inv?.ffmpeg,
    decklink: false,
    rebootWhenDone: false,
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void get<{ managementHosts: string[]; deckLinkSource: boolean }>(`/api/nodes/${node.id}/provision`).then((c) => {
      setCtx(c);
      setF((p) => ({ ...p, managementHost: p.managementHost || c.managementHosts[0] || "" }));
    });
  }, [node.id]);

  const body = () => ({
    role: f.role,
    ...(f.role !== "none"
      ? {
          ...(f.outputs ? { outputs: Number(f.outputs) } : {}),
          ...(f.videoMode ? { videoMode: f.videoMode } : {}),
          ...(f.mediaPath ? { mediaPath: f.mediaPath } : {}),
          ...(f.smbUser ? { smbUser: f.smbUser, smbPassword: f.smbPassword } : {}),
          ...(f.managementHost ? { managementHosts: [f.managementHost] } : {}),
          components: [...(f.ffmpeg ? ["ffmpeg"] : []), ...(f.decklink ? ["decklink"] : [])],
        }
      : { components: [] }),
    rebootWhenDone: f.rebootWhenDone,
  });
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await post<Plan>(`/api/nodes/${node.id}/provision/plan`, body()));
      setTyped("");
      setStep(3);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/nodes/${node.id}/provision`, { ...body(), confirmName: typed });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "confirm_name" ? t("orch.prov.confirmWrong") : e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const canStart = plan && !plan.blocked && (!plan.requireTypedName || typed.trim().toLowerCase() === node.name.trim().toLowerCase());

  const Steps = () => (
    <ol className="mb-5 flex items-center gap-2 text-xs">
      {[t("orch.prov.wizRole"), t("orch.prov.wizSettings"), t("orch.prov.wizCheck")].map((label, i) => (
        <li key={i} className="flex items-center gap-2">
          <span className={cx("flex size-6 items-center justify-center rounded-full font-semibold", step > i + 1 ? "bg-ok text-white" : step === i + 1 ? "bg-brand text-white" : "bg-surface-2 text-muted")}>
            {step > i + 1 ? <CheckCircle2 className="size-4" /> : i + 1}
          </span>
          <span className={cx(step === i + 1 ? "font-medium" : "text-muted")}>{label}</span>
          {i < 2 && <span className="mx-1 h-px w-6 bg-line" />}
        </li>
      ))}
    </ol>
  );

  const footer = (
    <>
      {step > 1 && (
        <Button variant="secondary" icon={<ArrowLeft className="size-4" />} onClick={() => setStep(step - 1)} disabled={busy}>
          {t("orch.prov.back")}
        </Button>
      )}
      <span className="flex-1" />
      <Button variant="secondary" onClick={onClose}>
        {t("common.cancel")}
      </Button>
      {step === 1 && (
        <Button icon={<ArrowRight className="size-4" />} onClick={() => (f.role === "none" ? void check() : setStep(2))} loading={busy}>
          {t("orch.prov.next")}
        </Button>
      )}
      {step === 2 && (
        <Button icon={<ArrowRight className="size-4" />} onClick={() => void check()} loading={busy}>
          {t("orch.prov.checkPlan")}
        </Button>
      )}
      {step === 3 && (
        <Button variant={plan?.disruptive ? "danger" : "primary"} icon={<Play className="size-4" />} onClick={() => void start()} loading={busy} disabled={!canStart}>
          {t("orch.prov.start")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={t("orch.prov.wizTitle", { name: node.name })} wide footer={footer}>
      <Steps />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("orch.prov.roleIntro")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {PROV_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setF({ ...f, role: r })}
                className={cx(
                  "flex gap-3 rounded-lg border p-4 text-left transition",
                  f.role === r ? "border-brand bg-brand/5 ring-2 ring-brand/30" : "border-line hover:border-brand/50 hover:bg-surface-2/60",
                )}
              >
                <span className={cx("mt-0.5", f.role === r ? "text-brand" : "text-muted")}>{roleIcon[r]}</span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {t(`orch.prov.role_${r}`)}
                    {current === r && <Badge tone="ok">{t("orch.prov.current")}</Badge>}
                  </span>
                  <span className="mt-1 block text-xs text-muted">{t(`orch.prov.roleDesc_${r}`)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("orch.prov.outputs")} hint={studio ? t("orch.prov.outputsNow", { n: studio.outputs.length }) : inv ? t("orch.prov.devices", { count: inv.decklinks.length }) : undefined}>
              {(id) => (
                <Select id={id} value={f.outputs} onChange={(e) => setF({ ...f, outputs: e.target.value })}>
                  <option value="">{studio ? t("orch.prov.keep") : "1"}</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("orch.prov.videoMode")} hint={studio?.outputs[0] ? t("orch.prov.now", { v: studio.outputs[0].format }) : undefined}>
              {(id) => (
                <Select id={id} value={f.videoMode} onChange={(e) => setF({ ...f, videoMode: e.target.value })}>
                  <option value="">{studio ? t("orch.prov.keep") : "1080i5000"}</option>
                  {VIDEO_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("orch.prov.mediaPath")} hint={studio?.mediaPath ? t("orch.prov.now", { v: studio.mediaPath }) : t("orch.prov.mediaPathHint")}>
              {(id) => <Input id={id} className="font-mono text-[13px]" placeholder={studio?.mediaPath ?? "\\\\10.40.0.154\\TV_Data\\Uitzending"} value={f.mediaPath} onChange={(e) => setF({ ...f, mediaPath: e.target.value })} />}
            </Field>
            <Field label={t("orch.prov.managementHost")} hint={t("orch.prov.managementHostHint")}>
              {(id) => <Input id={id} className="font-mono text-[13px]" placeholder="10.40.6.202" value={f.managementHost} onChange={(e) => setF({ ...f, managementHost: e.target.value })} />}
            </Field>
            <Field label={`${t("orch.prov.smbUser")} (${t("common.optional")})`} hint={inv?.shareCredentials ? t("orch.prov.smbKeep") : undefined}>
              {(id) => <Input id={id} autoComplete="off" value={f.smbUser} onChange={(e) => setF({ ...f, smbUser: e.target.value })} />}
            </Field>
            {f.smbUser && (
              <Field label={t("orch.prov.smbPassword")} hint={t("orch.prov.smbPasswordHint")}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.smbPassword} onChange={(e) => setF({ ...f, smbPassword: e.target.value })} />}
              </Field>
            )}
          </div>
          <div className="space-y-3 rounded-lg border border-line p-4">
            <p className="text-[13px] font-semibold">{t("orch.prov.software")}</p>
            <p className="text-xs text-muted">{t("orch.prov.softwareAlways")}</p>
            <Switch checked={f.ffmpeg} onChange={(v) => setF({ ...f, ffmpeg: v })} label={t("orch.prov.compFfmpeg")} description={inv?.ffmpeg ? t("orch.prov.now", { v: inv.ffmpeg }) : t("orch.prov.compFfmpegHint")} />
            <Switch
              checked={f.decklink}
              onChange={(v) => ctx?.deckLinkSource && setF({ ...f, decklink: v, rebootWhenDone: v ? true : f.rebootWhenDone })}
              label={t("orch.prov.compDecklink")}
              description={!ctx?.deckLinkSource ? t("orch.prov.compDecklinkNoSource") : inv?.desktopVideo ? t("orch.prov.now", { v: inv.desktopVideo }) : t("orch.prov.compDecklinkHint")}
            />
          </div>
          <Switch checked={f.rebootWhenDone} onChange={(v) => setF({ ...f, rebootWhenDone: v })} label={t("orch.prov.reboot")} description={t("orch.prov.rebootHint")} />
        </div>
      )}

      {step === 3 && plan && (
        <div className="space-y-5">
          {plan.warnings.length > 0 && (
            <ul className="space-y-2">
              {plan.warnings.map((w, i) => (
                <li key={i}>
                  <Alert tone={levelTone[w.level]}>
                    <span className="flex gap-2">
                      {levelIcon[w.level]}
                      <span>{t(`orch.prov.warn_${w.key}`, { ...w.params, defaultValue: w.key })}</span>
                    </span>
                  </Alert>
                </li>
              ))}
            </ul>
          )}
          <div>
            <p className="mb-2 text-[13px] font-semibold">{t("orch.prov.whatHappens")}</p>
            <ol className="space-y-1.5 text-sm">
              {plan.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] text-muted">{i + 1}</span>
                  <span>{t(`orch.prov.step_${s.key}`, { ...s.params, role: s.params?.role ? t(`orch.nodes.role_${s.params.role}`) : "", defaultValue: s.key })}</span>
                </li>
              ))}
            </ol>
          </div>
          {plan.requireTypedName && !plan.blocked && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
              <Field label={t("orch.prov.typeName", { name: node.name })}>
                {(id) => <Input id={id} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={node.name} />}
              </Field>
            </div>
          )}
          {!plan.blocked && !plan.requireTypedName && plan.disruptive && <p className="text-xs text-muted">{t("orch.prov.disruptiveHint")}</p>}
        </div>
      )}
    </Dialog>
  );
}

/** Nodes page: automatic agent updates and the DeckLink driver source. */
export function AgentSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [s, setS] = useState<AgentSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) void get<AgentSettings>("/api/nodes-settings").then(setS);
  }, [open]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put("/api/nodes-settings", s);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("orch.prov.settingsTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void save()} disabled={!s}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {s && (
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Switch checked={s.autoUpdate} onChange={(v) => setS({ ...s, autoUpdate: v })} label={t("orch.prov.autoUpdateAll")} description={t("orch.prov.autoUpdateAllHint")} />
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("orch.prov.windowStart")}>{(id) => <Input id={id} type="time" value={s.windowStart} onChange={(e) => setS({ ...s, windowStart: e.target.value })} />}</Field>
            <Field label={t("orch.prov.windowEnd")}>{(id) => <Input id={id} type="time" value={s.windowEnd} onChange={(e) => setS({ ...s, windowEnd: e.target.value })} />}</Field>
          </div>
          <p className="-mt-2 text-xs text-muted">{t("orch.prov.windowHint")}</p>
          <Field label={t("orch.prov.deckLinkSource")} hint={t("orch.prov.deckLinkSourceHint")}>
            {(id) => (
              <Input
                id={id}
                className="font-mono text-[13px]"
                placeholder="\\10.40.0.154\TV_Data\Software\Desktop_Video_15.3.1.zip"
                value={s.deckLinkSource}
                onChange={(e) => setS({ ...s, deckLinkSource: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}
