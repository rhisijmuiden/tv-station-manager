import { get, Badge, Card, CardBody, CardHeader, PageHeader, cx } from "@tvsm/ui";
import { CheckCircle2, Circle, DatabaseBackup, Radio, Server, SlidersHorizontal, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface Overview {
  nodes: { total: number; online: number; pending: number };
  atem: { total: number; online: number };
  hyperdecks?: { total: number; online: number; recording: number };
  mailConfigured: boolean;
  backupTargets: number;
  lastBackup: { status: string; startedAt: string; kind: string } | null;
}

function Stat({ label, value, icon, tone }: { label: string; value: React.ReactNode; icon: React.ReactNode; tone: string }) {
  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        <div className={cx("grid size-11 place-items-center rounded-lg", tone)}>{icon}</div>
        <div>
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
        </div>
      </CardBody>
    </Card>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    void get<Overview>("/api/orchestrator/overview").then(setO);
  }, []);
  if (!o) return null;
  const steps = [
    { done: o.mailConfigured, label: t("orch.dashboard.stepMail"), to: "/system/mail" },
    { done: o.backupTargets > 0, label: t("orch.dashboard.stepBackup"), to: "/system/backup" },
    { done: o.lastBackup?.status === "success", label: t("orch.dashboard.stepFirstBackup"), to: "/system/backup" },
    { done: o.nodes.total > 0, label: t("orch.dashboard.stepNodes"), to: "/nodes" },
  ];
  return (
    <>
      <PageHeader title={t("orch.dashboard.title")} description={t("orch.dashboard.intro")} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t("orch.dashboard.total")} value={o.nodes.total} icon={<Server className="size-5" />} tone="bg-brand/10 text-brand" />
        <Stat label={t("orch.dashboard.online")} value={o.nodes.pending ? <span>{o.nodes.online} <span className="text-sm font-medium text-warn">· {o.nodes.pending} {t("orch.dashboard.pending").toLowerCase()}</span></span> : o.nodes.online} icon={<Radio className="size-5" />} tone="bg-ok/12 text-ok" />
        <Link to="/atem">
          <Stat
            label={t("orch.atem.dashboard")}
            value={o.atem.total ? <span>{o.atem.online} <span className="text-sm font-medium text-muted">/ {o.atem.total} {t("orch.dashboard.online").toLowerCase()}</span></span> : 0}
            icon={<SlidersHorizontal className="size-5" />}
            tone={o.atem.online < o.atem.total ? "bg-danger/12 text-danger" : "bg-brand/10 text-brand"}
          />
        </Link>
        {!!o.hyperdecks?.total && (
          <Link to="/hyperdeck">
            <Stat
              label={t("orch.hyperdeck.dashboard")}
              value={
                <span>
                  {o.hyperdecks.online} <span className="text-sm font-medium text-muted">/ {o.hyperdecks.total} {t("orch.dashboard.online").toLowerCase()}</span>
                  {o.hyperdecks.recording > 0 && <span className="text-sm font-medium text-danger"> · {o.hyperdecks.recording} {t("orch.hyperdeck.recordingNow")}</span>}
                </span>
              }
              icon={<Video className="size-5" />}
              tone={o.hyperdecks.online < o.hyperdecks.total ? "bg-danger/12 text-danger" : "bg-brand/10 text-brand"}
            />
          </Link>
        )}
        <Stat
          label={t("orch.dashboard.lastBackup")}
          value={<span className="text-base">{o.lastBackup ? new Date(o.lastBackup.startedAt).toLocaleString() : t("orch.dashboard.none")}</span>}
          icon={<DatabaseBackup className="size-5" />}
          tone="bg-warn/15 text-warn"
        />
      </div>
      <Card>
        <CardHeader title={t("orch.dashboard.setup")} description={t("orch.dashboard.setupIntro")} actions={<Badge tone="brand">{steps.filter((s) => s.done).length} / {steps.length}</Badge>} />
        <ul className="divide-y divide-line">
          {steps.map((s) => (
            <li key={s.label}>
              <Link to={s.to} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-surface-2/60">
                {s.done ? <CheckCircle2 className="size-5 text-ok" /> : <Circle className="size-5 text-line" />}
                <span className={cx("flex-1 text-sm", s.done && "text-muted line-through")}>{s.label}</span>
                <span className="text-xs font-medium text-brand">{t("orch.dashboard.open")} →</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
