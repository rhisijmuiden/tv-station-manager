/**
 * The orchestrator's monitoring page, shown here natively: this node fetches the picture from the
 * orchestrator with the automation token (Setup > Devices > Orchestrator link), so nobody signs in there.
 * Read-only: adding devices, checks and the links into orchestrator pages stay in the orchestrator.
 */
import { Alert, Badge, Button, roleAtLeast, useSession } from "@tvsm/ui";
import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { MonitoringPage } from "../../../orchestrator/web/Monitoring";

const eventsUrl = (id: string) => `/api/orchestrator-monitoring/devices/${encodeURIComponent(id)}/events`;
const KNOWN = ["orchestrator_not_linked", "orchestrator_token_rejected", "orchestrator_unreachable", "orchestrator_outdated"];

function LinkProblem({ code }: { code: string }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const nav = useNavigate();
  const key = KNOWN.includes(code) ? code : "orchestrator_unreachable";
  return (
    <Alert tone={key === "orchestrator_not_linked" ? "brand" : "warn"}>
      <p className="font-semibold">{t(`mgmt.mon.${key}`)}</p>
      <p className="mt-1">{t(`mgmt.mon.${key}_hint`)}</p>
      {roleAtLeast(user?.role, "admin") ? (
        <Button size="sm" variant="secondary" className="mt-3" icon={<Network className="size-3.5" />} onClick={() => nav("/devices")}>
          {t("mgmt.mon.openLink")}
        </Button>
      ) : (
        <p className="mt-2 text-xs text-muted">{t("mgmt.mon.askAdmin")}</p>
      )}
    </Alert>
  );
}

export function OrchestratorMonitoringPage() {
  const { t } = useTranslation();
  return (
    <MonitoringPage
      endpoint="/api/orchestrator-monitoring"
      eventsUrl={eventsUrl}
      readOnly
      description={t("mgmt.mon.intro")}
      badge={<Badge tone="brand">{t("mgmt.mon.fromOrchestrator")}</Badge>}
      renderError={(code) => <LinkProblem code={code} />}
    />
  );
}
