import { GitBranch, PackageCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { get, put } from "../api";
import { UpdateStatus } from "../components/InfoDialog";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Mono, PageHeader, Switch, cx } from "../components/ui";
import { useSession } from "../session";

interface UpdateSettings {
  channel: "production" | "test";
  repository: string;
  githubToken: string;
  autoCheck: boolean;
}

export function UpdatesPage() {
  const { t } = useTranslation();
  const { info, refresh, setLastCheck } = useSession();
  const [s, setS] = useState<UpdateSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void get<{ settings: UpdateSettings }>("/api/system/update").then((r) => setS(r.settings));
  }, []);
  if (!s || !info) return null;

  const save = async (next = s) => {
    setBusy(true);
    try {
      setS(await put<UpdateSettings>("/api/system/update/settings", next));
      setLastCheck(null);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t("updates.title")} description={t("updates.intro")} />
      {saved && (
        <Alert tone="ok" className="mb-6">
          {t("common.saved")}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<PackageCheck className="size-4" />} title={t("updates.current")} />
          <CardBody className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="font-mono text-2xl font-semibold">v{info.version}</span>
              <Badge tone={info.channel === "production" ? "ok" : "warn"}>{t(`channel.${info.channel}`)}</Badge>
            </div>
            <UpdateStatus />
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<GitBranch className="size-4" />} title={t("updates.channel")} />
          <CardBody className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {(["production", "test"] as const).map((ch) => (
                <button
                  key={ch}
                  onClick={() => {
                    const next = { ...s, channel: ch };
                    setS(next);
                    void save(next);
                  }}
                  className={cx(
                    "rounded-lg border p-4 text-left transition",
                    s.channel === ch ? "border-brand bg-brand/5 ring-3 ring-brand/15" : "border-line hover:border-muted",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cx("size-2.5 rounded-full", ch === "production" ? "bg-ok" : "bg-warn")} />
                    <span className="font-semibold">{t(`channel.${ch}`)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{t(`channel.${ch}Hint`)}</p>
                </button>
              ))}
            </div>
            <Field label={t("updates.repository")}>
              {(id) => <Input id={id} className="font-mono" value={s.repository} onChange={(e) => setS({ ...s, repository: e.target.value })} />}
            </Field>
            <Field label={`${t("updates.token")} (${t("common.optional")})`} hint={t("updates.tokenHint")}>
              {(id) => <Input id={id} type="password" value={s.githubToken} onChange={(e) => setS({ ...s, githubToken: e.target.value })} autoComplete="off" />}
            </Field>
            <Switch checked={s.autoCheck} onChange={(v) => setS({ ...s, autoCheck: v })} label={t("updates.autoCheck")} />
            <div className="flex justify-end">
              <Button loading={busy} onClick={() => save()}>
                {t("common.save")}
              </Button>
            </div>
            <p className="text-xs text-muted">
              <Mono>{info.hostname}</Mono> · {info.os}
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
