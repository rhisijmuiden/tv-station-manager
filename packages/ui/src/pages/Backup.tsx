import { CalendarClock, DatabaseBackup, History, Pencil, Plus, PlugZap, RotateCcw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { del, formatBytes, get, post, put } from "../api";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Switch, Textarea } from "../components/ui";

type Protocol = "ftp" | "ftps" | "scp";
interface Target {
  id?: number;
  name: string;
  protocol: Protocol;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}
interface Run {
  id: string;
  targetName: string | null;
  kind: "full" | "incremental";
  status: "running" | "success" | "failed";
  remoteName: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  error: string | null;
  startedAt: string;
}
interface Schedule {
  enabled: boolean;
  targetIds: number[];
  fullCron: string;
  incrementalCron: string;
  retentionFull: number;
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
  nextRuns?: (string | null)[];
}
interface RemoteBackup {
  id: string;
  kind: "full" | "incremental";
  createdAt: string;
  host: string;
  version: string;
  archive: string;
  fileCount: number;
}

const defaults: Record<Protocol, Target["config"]> = {
  ftp: { host: "", port: 21, username: "", password: "", directory: "/backups" },
  ftps: { host: "", port: 21, username: "", password: "", directory: "/backups", tlsMode: "explicit", verifyCertificate: true },
  scp: { host: "", port: 22, username: "", authMethod: "key", password: "", privateKey: "", passphrase: "", directory: "backups", hostKeySha256: "" },
};

const statusTone = { success: "ok", failed: "danger", running: "brand" } as const;

function TargetDialog({ initial, onClose, onSaved }: { initial: Target | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [tg, setTg] = useState<Target>(initial ?? { name: "", protocol: "scp", enabled: true, config: { ...defaults.scp } });
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const c = tg.config;
  const setC = (k: string, v: string | number | boolean) => setTg({ ...tg, config: { ...c, [k]: v } });
  const str = (k: string) => String(c[k] ?? "");

  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const r = await post<{ ok: boolean; details?: string; error?: string; hostKeySha256?: string }>("/api/backup/targets/test", tg);
      if (r.ok && r.hostKeySha256 && !c.hostKeySha256) setC("hostKeySha256", r.hostKeySha256);
      setMsg(r.ok ? { tone: "ok", text: `${t("backup.testOk")}: ${r.details}` } : { tone: "danger", text: r.error! });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      await post("/api/backup/targets", tg);
      onSaved();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={initial ? t("common.edit") : t("backup.addTarget")}
      footer={
        <>
          <Button variant="secondary" icon={<PlugZap className="size-4" />} loading={busy === "test"} onClick={test}>
            {t("common.test")}
          </Button>
          <Button loading={busy === "save"} onClick={save} disabled={!tg.name || !c.host}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-6">
        <Field label={t("common.name")} className="sm:col-span-4">
          {(id) => <Input id={id} value={tg.name} onChange={(e) => setTg({ ...tg, name: e.target.value })} placeholder="NAS offsite" />}
        </Field>
        <Field label={t("backup.protocol")} className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={tg.protocol} disabled={!!initial} onChange={(e) => setTg({ ...tg, protocol: e.target.value as Protocol, config: { ...defaults[e.target.value as Protocol] } })}>
              <option value="scp">SCP (SSH)</option>
              <option value="ftps">FTPS</option>
              <option value="ftp">FTP</option>
            </Select>
          )}
        </Field>
        <Field label={t("backup.host")} className="sm:col-span-4">
          {(id) => <Input id={id} value={str("host")} onChange={(e) => setC("host", e.target.value)} />}
        </Field>
        <Field label={t("backup.port")} className="sm:col-span-2">
          {(id) => <Input id={id} type="number" value={str("port")} onChange={(e) => setC("port", Number(e.target.value))} />}
        </Field>
        <Field label={t("backup.username")} className="sm:col-span-3">
          {(id) => <Input id={id} value={str("username")} onChange={(e) => setC("username", e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={t("backup.directory")} className="sm:col-span-3">
          {(id) => <Input id={id} value={str("directory")} onChange={(e) => setC("directory", e.target.value)} />}
        </Field>

        {tg.protocol === "ftps" && (
          <Field label={t("backup.tlsMode")} className="sm:col-span-3">
            {(id) => (
              <Select
                id={id}
                value={str("tlsMode")}
                onChange={(e) => setTg({ ...tg, config: { ...c, tlsMode: e.target.value, port: e.target.value === "implicit" ? 990 : 21 } })}
              >
                <option value="explicit">{t("backup.tls_explicit")}</option>
                <option value="implicit">{t("backup.tls_implicit")}</option>
              </Select>
            )}
          </Field>
        )}
        {tg.protocol !== "scp" && (
          <Field label={t("backup.password")} className="sm:col-span-3">
            {(id) => <Input id={id} type="password" value={str("password")} onChange={(e) => setC("password", e.target.value)} autoComplete="new-password" />}
          </Field>
        )}
        {tg.protocol === "ftps" && (
          <div className="sm:col-span-6">
            <Switch checked={c.verifyCertificate !== false} onChange={(v) => setC("verifyCertificate", v)} label={t("backup.verifyCert")} />
          </div>
        )}

        {tg.protocol === "scp" && (
          <>
            <Field label={t("backup.authMethod")} className="sm:col-span-3">
              {(id) => (
                <Select id={id} value={str("authMethod")} onChange={(e) => setC("authMethod", e.target.value)}>
                  <option value="key">{t("backup.auth_key")}</option>
                  <option value="password">{t("backup.auth_password")}</option>
                </Select>
              )}
            </Field>
            {c.authMethod === "password" ? (
              <Field label={t("backup.password")} className="sm:col-span-3">
                {(id) => <Input id={id} type="password" value={str("password")} onChange={(e) => setC("password", e.target.value)} autoComplete="new-password" />}
              </Field>
            ) : (
              <>
                <Field label={`${t("backup.passphrase")} (${t("common.optional")})`} className="sm:col-span-3">
                  {(id) => <Input id={id} type="password" value={str("passphrase")} onChange={(e) => setC("passphrase", e.target.value)} />}
                </Field>
                <Field label={t("backup.privateKey")} className="sm:col-span-6">
                  {(id) => <Textarea id={id} value={str("privateKey")} onChange={(e) => setC("privateKey", e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />}
                </Field>
              </>
            )}
            <Field label={t("backup.hostKey")} hint={t("backup.hostKeyHint")} className="sm:col-span-6">
              {(id) => <Input id={id} className="font-mono text-xs" value={str("hostKeySha256")} onChange={(e) => setC("hostKeySha256", e.target.value)} />}
            </Field>
          </>
        )}
        <div className="sm:col-span-6">
          <Switch checked={tg.enabled} onChange={(v) => setTg({ ...tg, enabled: v })} label={t("common.enabled")} />
        </div>
      </div>
    </Dialog>
  );
}

export function BackupPage() {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<{ running: boolean; runs: Run[] }>({ running: false, runs: [] });
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [editing, setEditing] = useState<Target | null | "new">(null);
  const [runTarget, setRunTarget] = useState<number | "">("");
  const [restoreTarget, setRestoreTarget] = useState<number | "">("");
  const [remote, setRemote] = useState<RemoteBackup[] | null>(null);
  const [confirm, setConfirm] = useState<RemoteBackup | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "brand"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [tg, rn, sc] = await Promise.all([get<Target[]>("/api/backup/targets"), get<typeof runs>("/api/backup/runs"), get<Schedule>("/api/backup/schedule")]);
    setTargets(tg);
    setRuns(rn);
    setSchedule((s) => s ?? sc);
    if (tg[0]?.id) {
      setRunTarget((v) => v || tg[0]!.id!);
      setRestoreTarget((v) => v || tg[0]!.id!);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!runs.running) return;
    const i = setInterval(() => void get<typeof runs>("/api/backup/runs").then(setRuns), 2500);
    return () => clearInterval(i);
  }, [runs.running]);

  const runNow = async (kind: "full" | "incremental") => {
    if (!runTarget) return;
    await post("/api/backup/run", { targetId: runTarget, kind });
    setRuns((r) => ({ ...r, running: true }));
    setTimeout(() => void get<typeof runs>("/api/backup/runs").then(setRuns), 500);
  };
  const saveSchedule = async () => {
    setBusy("schedule");
    try {
      const { nextRuns: _n, ...s } = schedule!;
      setSchedule(await put<Schedule>("/api/backup/schedule", s));
      setMsg({ tone: "ok", text: t("common.saved") });
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const listRemote = async () => {
    if (!restoreTarget) return;
    setBusy("remote");
    setRemote(null);
    try {
      setRemote(await get<RemoteBackup[]>(`/api/backup/remote/${restoreTarget}`));
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const restore = async (b: RemoteBackup) => {
    setConfirm(null);
    setBusy("restore");
    try {
      await post("/api/backup/restore", { targetId: restoreTarget, backupId: b.id });
      setMsg({ tone: "brand", text: t("backup.restoring") });
      setTimeout(() => window.location.reload(), 8000);
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title={t("backup.title")} description={t("backup.intro")} />
      {msg && (
        <Alert tone={msg.tone} className="mb-6">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            icon={<Server className="size-4" />}
            title={t("backup.targets")}
            actions={
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
                {t("backup.addTarget")}
              </Button>
            }
          />
          <ul className="divide-y divide-line">
            {targets.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">{t("backup.noTargets")}</li>}
            {targets.map((tg) => (
              <li key={tg.id} className="flex items-center gap-4 px-5 py-3">
                <Badge tone="brand">{tg.protocol.toUpperCase()}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{tg.name}</p>
                  <p className="truncate text-xs text-muted">
                    <Mono>
                      {String(tg.config.username)}@{String(tg.config.host)}:{String(tg.config.directory)}
                    </Mono>
                  </p>
                </div>
                {!tg.enabled && <Badge>{t("common.disabled")}</Badge>}
                <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(tg)} aria-label={t("common.edit")} />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  aria-label={t("common.delete")}
                  onClick={async () => {
                    await del(`/api/backup/targets/${tg.id}`);
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader icon={<DatabaseBackup className="size-4" />} title={t("backup.runNow")} />
          <CardBody className="space-y-4">
            <Field label={t("backup.location")}>
              {(id) => (
                <Select id={id} value={runTarget} onChange={(e) => setRunTarget(Number(e.target.value))} disabled={!targets.length}>
                  {targets.map((tg) => (
                    <option key={tg.id} value={tg.id}>
                      {tg.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!runTarget || runs.running} loading={runs.running} onClick={() => runNow("full")}>
                {t("backup.full")}
              </Button>
              <Button className="flex-1" variant="secondary" disabled={!runTarget || runs.running} onClick={() => runNow("incremental")}>
                {t("backup.incremental")}
              </Button>
            </div>
          </CardBody>
        </Card>

        {schedule && (
          <Card className="lg:col-span-5">
            <CardHeader
              icon={<CalendarClock className="size-4" />}
              title={t("backup.schedule")}
              actions={
                <Button size="sm" loading={busy === "schedule"} onClick={saveSchedule}>
                  {t("common.save")}
                </Button>
              }
            />
            <CardBody className="grid gap-5 md:grid-cols-3">
              <div className="space-y-3 md:col-span-3">
                <Switch checked={schedule.enabled} onChange={(v) => setSchedule({ ...schedule, enabled: v })} label={t("backup.scheduleEnabled")} />
              </div>
              <Field label={t("backup.fullCron")} hint={schedule.nextRuns?.[0] ? `${t("backup.nextRun")}: ${new Date(schedule.nextRuns[0]).toLocaleString()}` : undefined}>
                {(id) => <Input id={id} className="font-mono" value={schedule.fullCron} onChange={(e) => setSchedule({ ...schedule, fullCron: e.target.value })} />}
              </Field>
              <Field label={t("backup.incrementalCron")} hint={schedule.nextRuns?.[1] ? `${t("backup.nextRun")}: ${new Date(schedule.nextRuns[1]).toLocaleString()}` : undefined}>
                {(id) => <Input id={id} className="font-mono" value={schedule.incrementalCron} onChange={(e) => setSchedule({ ...schedule, incrementalCron: e.target.value })} />}
              </Field>
              <Field label={t("backup.retention")} hint={t("backup.retentionHint")}>
                {(id) => <Input id={id} type="number" min={1} value={schedule.retentionFull} onChange={(e) => setSchedule({ ...schedule, retentionFull: Number(e.target.value) })} />}
              </Field>
              <p className="-mt-2 text-xs text-muted md:col-span-3">{t("backup.cronHint")}</p>
              <div className="md:col-span-2">
                <p className="mb-2 text-[13px] font-medium">{t("backup.useTargets")}</p>
                <div className="flex flex-wrap gap-2">
                  {targets.map((tg) => {
                    const on = schedule.targetIds.includes(tg.id!);
                    return (
                      <button
                        key={tg.id}
                        onClick={() => setSchedule({ ...schedule, targetIds: on ? schedule.targetIds.filter((x) => x !== tg.id) : [...schedule.targetIds, tg.id!] })}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition ${on ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-fg"}`}
                      >
                        {tg.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-3">
                <Switch checked={schedule.notifyOnFailure} onChange={(v) => setSchedule({ ...schedule, notifyOnFailure: v })} label={t("backup.notifyFailure")} />
                <Switch checked={schedule.notifyOnSuccess} onChange={(v) => setSchedule({ ...schedule, notifyOnSuccess: v })} label={t("backup.notifySuccess")} />
              </div>
            </CardBody>
          </Card>
        )}

        <Card className="lg:col-span-3">
          <CardHeader icon={<History className="size-4" />} title={t("backup.history")} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-medium">{t("backup.started")}</th>
                  <th className="px-2 py-2 font-medium">{t("backup.kind")}</th>
                  <th className="px-2 py-2 font-medium">{t("backup.location")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("backup.size")}</th>
                  <th className="px-5 py-2 font-medium">{t("common.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {runs.runs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-muted">
                      {t("backup.noRuns")}
                    </td>
                  </tr>
                )}
                {runs.runs.map((r) => (
                  <tr key={r.id} title={r.error ?? r.remoteName ?? ""}>
                    <td className="px-5 py-2.5 whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="px-2 py-2.5">{t(`backup.${r.kind}`)}</td>
                    <td className="px-2 py-2.5">{r.targetName ?? "–"}</td>
                    <td className="px-2 py-2.5 text-right whitespace-nowrap">
                      <Mono>{formatBytes(r.sizeBytes)}</Mono>
                    </td>
                    <td className="px-5 py-2.5">
                      <Badge tone={statusTone[r.status]}>{t(`backup.st_${r.status}`)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader icon={<RotateCcw className="size-4" />} title={t("backup.restoreTitle")} description={t("backup.restoreIntro")} />
          <CardBody className="space-y-4">
            <div className="flex gap-2">
              <Select value={restoreTarget} onChange={(e) => setRestoreTarget(Number(e.target.value))} disabled={!targets.length}>
                {targets.map((tg) => (
                  <option key={tg.id} value={tg.id}>
                    {tg.name}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" loading={busy === "remote"} onClick={listRemote} disabled={!restoreTarget}>
                {t("backup.loadRemote")}
              </Button>
            </div>
            {remote && remote.length === 0 && <p className="text-sm text-muted">{t("backup.noRemote")}</p>}
            {remote && remote.length > 0 && (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-md border border-line">
                {remote.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{new Date(b.createdAt).toLocaleString()}</p>
                      <p className="truncate text-xs text-muted">
                        {t(`backup.${b.kind}`)} · {b.host} · <Mono>v{b.version}</Mono>
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" loading={busy === "restore"} onClick={() => setConfirm(b)}>
                      {t("backup.restore")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {editing && (
        <TargetDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t("backup.restore")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => confirm && restore(confirm)}>
              {t("backup.restore")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirm && t("backup.restoreConfirm", { date: new Date(confirm.createdAt).toLocaleString() })}</p>
      </Dialog>
    </>
  );
}
