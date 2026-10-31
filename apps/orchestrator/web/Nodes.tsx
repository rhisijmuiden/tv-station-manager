import { Alert, PageHeader } from "@tvsm/ui";
import { useTranslation } from "react-i18next";

export function NodesPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("orch.nodes.title")} description={t("orch.nodes.intro")} />
      <Alert tone="brand">{t("orch.nodes.comingSoon")}</Alert>
    </>
  );
}
