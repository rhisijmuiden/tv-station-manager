import { ArrowUpCircle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { useSession, type UpdateCheck } from "../session";
import { Alert, Badge, Button, Dialog, Mono } from "./ui";

export function formatUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** Shared check / install logic used by the Info dialog and the Updates page. */
export function useUpdater() {
  const { lastCheck, setLastCheck, info, refresh } = useSession();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setLastCheck(await post<UpdateCheck>("/api/system/update/check"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    const from = info?.version;
    try {
      await post("/api/system/update/apply");
      // Wait for the service to come back with a new version.
      const started = Date.now();
      const poll = async () => {
        try {
          const h = await get<{ version: string }>("/api/system/health");
          if (h.version !== from) return window.location.reload();
        } catch {
          /* restarting */
        }
        if (Date.now() - started < 10 * 60_000) setTimeout(poll, 3000);
        else {
          setInstalling(false);
          await refresh();
        }
      };
      setTimeout(poll, 5000);
    } catch (e) {
      setInstalling(false);
      setError((e as Error).message);
    }
  };
  return { lastCheck, checking, installing, error, check, install };
}

export function UpdateStatus({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { lastCheck, checking, installing, error, check, install } = useUpdater();
  return (
    <div className="space-y-3">
      {installing && <Alert tone="brand">{t("info.installing")}</Alert>}
      {error && <Alert tone="danger">{t("info.updateFailed", { error })}</Alert>}
      {lastCheck && !installing && (
        <div className="flex items-start gap-3 rounded-md border border-line bg-surface-2/60 p-4">
          {lastCheck.available ? <ArrowUpCircle className="mt-0.5 size-5 text-brand" /> : <CheckCircle2 className="mt-0.5 size-5 text-ok" />}
          <div className="flex-1 text-sm">
            <p className="font-medium">
              {lastCheck.available
                ? t(lastCheck.isDowngrade ? "info.downgradeAvailable" : "info.available", { version: lastCheck.latest })
                : t("info.upToDate")}
            </p>
            <p className="mt-0.5 text-xs text-muted">{t("info.lastChecked", { time: new Date(lastCheck.checkedAt).toLocaleString() })}</p>
            {lastCheck.available && !lastCheck.canApply && <p className="mt-2 text-xs text-warn">{t("info.devBuild")}</p>}
            {lastCheck.available && lastCheck.releaseUrl && !compact && (
              <a href={lastCheck.releaseUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
                {t("info.releaseNotes")} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={checking} onClick={check} disabled={installing}>
          {checking ? t("info.checking") : t("info.checkUpdates")}
        </Button>
        {lastCheck?.available && lastCheck.canApply && (
          <Button icon={<ArrowUpCircle className="size-4" />} loading={installing} onClick={install}>
            {t("info.updateNow")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function InfoDialog({ open, onClose, logo }: { open: boolean; onClose: () => void; logo: string }) {
  const { t } = useTranslation();
  const { info, refresh } = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  if (!info) return null;
  const rows: [string, React.ReactNode][] = [
    [t("info.version"), <Mono key="v">{info.version}</Mono>],
    [t("info.channel"), <Badge key="c" tone={info.channel === "production" ? "ok" : "warn"}>{t(`channel.${info.channel}`)}</Badge>],
    [t("info.hostname"), <Mono key="h">{info.hostname}</Mono>],
    [t("info.os"), info.os],
    [t("info.runtime"), <Mono key="n">Node.js {info.node} ({info.arch})</Mono>],
    [t("info.uptime"), formatUptime(info.uptimeSeconds)],
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("info.title")}
      footer={
        <>
          <Button variant="ghost" onClick={() => (onClose(), navigate("/system/updates"))}>
            {t("info.openUpdates")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="mb-5 flex items-center gap-4">
        <img src={logo} alt="" className="size-12" />
        <div>
          <p className="text-lg font-semibold">{info.app.name}</p>
          <p className="text-sm text-muted">
            <Mono>v{info.version}</Mono>
          </p>
        </div>
      </div>
      <dl className="mb-5 divide-y divide-line rounded-md border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <UpdateStatus compact />
    </Dialog>
  );
}
