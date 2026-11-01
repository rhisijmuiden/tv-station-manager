import { Check, Copy, KeyRound, PlugZap, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, get, post, put } from "../api";
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Mono, PageHeader, Select, Spinner, Switch } from "../components/ui";

type Role = "admin" | "editor" | "operator";
interface SsoConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  buttonLabel: string;
  autoCreateUsers: boolean;
  defaultRole: Role;
  useAppRoles: boolean;
  roleValues: Record<Role, string>;
  allowedDomains: string[];
  redirectUri: string;
  callbackPath: string;
}
type Result = { tone: "ok" | "danger"; text: string } | null;
const ROLES: Role[] = ["admin", "editor", "operator"];

function CopyValue({ value }: { value: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
      <Mono>
        <span className="break-all">{value}</span>
      </Mono>
      <button
        type="button"
        className="ml-auto shrink-0 text-muted hover:text-fg"
        title={t("sso.copy")}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

export function SsoPage() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<SsoConfig | null>(null);
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    void get<SsoConfig>("/api/settings/sso").then((c) => {
      setCfg(c);
      setDomains(c.allowedDomains.join(", "));
    });
  }, []);
  if (!cfg) return <Spinner />;

  const set = <K extends keyof SsoConfig>(k: K, v: SsoConfig[K]) => setCfg({ ...cfg, [k]: v });
  const payload = () => {
    const { redirectUri: _r, callbackPath: _c, ...rest } = cfg;
    return { ...rest, allowedDomains: domains.split(/[,;\s]+/).filter(Boolean) };
  };
  const redirectUri = cfg.publicUrl ? `${cfg.publicUrl.replace(/\/+$/, "")}${cfg.callbackPath}` : cfg.redirectUri;
  const errorText = (e: unknown) => {
    if (e instanceof ApiError && e.code === "validation_failed") {
      const issue = (e.body as { issues?: { message?: string }[] })?.issues?.[0]?.message ?? "";
      return t(`sso.errors.${issue}`, { defaultValue: t("sso.errors.validation") });
    }
    return e instanceof ApiError ? t(`sso.errors.${e.code}`, { defaultValue: e.message }) : (e as Error).message;
  };
  const run = async (name: string, fn: () => Promise<Result>) => {
    setBusy(name);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      setResult({ tone: "danger", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", async () => {
      const c = await put<SsoConfig>("/api/settings/sso", payload());
      setCfg(c);
      return { tone: "ok", text: t("common.saved") };
    });
  const test = () =>
    run("test", async () => {
      const r = await post<{ ok: boolean; error?: string }>("/api/settings/sso/test", { config: payload() });
      return r.ok ? { tone: "ok", text: t("sso.testOk") } : { tone: "danger", text: `${t("sso.testFailed")} ${r.error ?? ""}` };
    });

  return (
    <>
      <PageHeader
        title={t("sso.title")}
        description={t("sso.intro")}
        actions={
          <>
            <Button variant="secondary" icon={<PlugZap className="size-4" />} loading={busy === "test"} onClick={test}>
              {t("sso.test")}
            </Button>
            <Button loading={busy === "save"} onClick={save}>
              {t("common.save")}
            </Button>
          </>
        }
      />
      {result && (
        <Alert tone={result.tone} className="mb-6">
          {result.text}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<KeyRound className="size-4" />} title={t("sso.provider")} actions={<Switch checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={t("common.enabled")} />} />
          <CardBody className="grid gap-4">
            <Field label={t("sso.tenantId")} hint={t("sso.tenantIdHint")}>
              {(id) => <Input id={id} value={cfg.tenantId} onChange={(e) => set("tenantId", e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />}
            </Field>
            <Field label={t("sso.clientId")} hint={t("sso.clientIdHint")}>
              {(id) => <Input id={id} value={cfg.clientId} onChange={(e) => set("clientId", e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />}
            </Field>
            <Field label={t("sso.clientSecret")} hint={t("sso.clientSecretHint")}>
              {(id) => <Input id={id} type="password" value={cfg.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} autoComplete="new-password" />}
            </Field>
            <Field label={`${t("sso.buttonLabel")} (${t("common.optional")})`}>
              {(id) => <Input id={id} value={cfg.buttonLabel} onChange={(e) => set("buttonLabel", e.target.value)} placeholder={t("auth.signInMicrosoft")} />}
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<ShieldCheck className="size-4" />} title={t("sso.registration")} description={t("sso.registrationIntro")} />
          <CardBody className="grid gap-4">
            <Field label={t("sso.redirectUri")} hint={t("sso.redirectUriHint")}>
              {() => <CopyValue value={redirectUri} />}
            </Field>
            <Field label={`${t("sso.publicUrl")} (${t("common.optional")})`} hint={t("sso.publicUrlHint")}>
              {(id) => <Input id={id} value={cfg.publicUrl} onChange={(e) => set("publicUrl", e.target.value)} placeholder="https://tv.example.com" />}
            </Field>
            {redirectUri.startsWith("http://") && !/^http:\/\/localhost[:/]/.test(redirectUri) && <Alert tone="warn">{t("sso.httpsRequired")}</Alert>}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader icon={<Users className="size-4" />} title={t("sso.accounts")} />
          <CardBody className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <Switch checked={cfg.autoCreateUsers} onChange={(v) => set("autoCreateUsers", v)} label={t("sso.autoCreate")} description={t("sso.autoCreateHint")} />
              <Field label={t("sso.defaultRole")} hint={cfg.useAppRoles ? t("sso.defaultRoleAppRoles") : t(`users.roleHelp.${cfg.defaultRole}`)}>
                {(id) => (
                  <Select id={id} value={cfg.defaultRole} disabled={cfg.useAppRoles} onChange={(e) => set("defaultRole", e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`users.roles.${r}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={`${t("sso.allowedDomains")} (${t("common.optional")})`} hint={t("sso.allowedDomainsHint")}>
                {(id) => <Input id={id} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="ijmond360.nl" />}
              </Field>
            </div>
            <div className="space-y-4">
              <Switch checked={cfg.useAppRoles} onChange={(v) => set("useAppRoles", v)} label={t("sso.useAppRoles")} description={t("sso.useAppRolesHint")} />
              {cfg.useAppRoles && (
                <div className="grid gap-3">
                  {ROLES.map((r) => (
                    <Field key={r} label={t("sso.roleValue", { role: t(`users.roles.${r}`) })}>
                      {(id) => <Input id={id} value={cfg.roleValues[r]} onChange={(e) => set("roleValues", { ...cfg.roleValues, [r]: e.target.value })} />}
                    </Field>
                  ))}
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
      <Alert tone="brand" className="mt-6">
        {t("sso.fallback")}
      </Alert>
    </>
  );
}
