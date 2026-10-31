import { Mail, PlugZap, Send, ShieldCheck, Signature, UserRound, Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { get, post, put } from "../api";
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Spinner, Switch, Textarea } from "../components/ui";

interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  minTlsVersion: "TLSv1.2" | "TLSv1.3";
  verifyCertificate: boolean;
  auth: { method: "none" | "password" | "oauth2"; username: string; password: string; oauth2ClientId: string; oauth2ClientSecret: string; oauth2RefreshToken: string; oauth2TokenUrl: string };
  fromName: string;
  fromAddress: string;
  replyTo: string;
  dkim: { enabled: boolean; domain: string; selector: string; privateKey: string };
  alertRecipients: string[];
}

type Result = { tone: "ok" | "danger"; text: string } | null;

export function MailPage() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<MailConfig | null>(null);
  const [recipients, setRecipients] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    void get<MailConfig>("/api/settings/mail").then((c) => {
      setCfg(c);
      setRecipients(c.alertRecipients.join(", "));
    });
  }, []);
  if (!cfg) return <Spinner />;

  const set = <K extends keyof MailConfig>(k: K, v: MailConfig[K]) => setCfg({ ...cfg, [k]: v });
  const setAuth = (k: keyof MailConfig["auth"], v: string) => setCfg({ ...cfg, auth: { ...cfg.auth, [k]: v } });
  const setDkim = (k: keyof MailConfig["dkim"], v: string | boolean) => setCfg({ ...cfg, dkim: { ...cfg.dkim, [k]: v } });
  const payload = () => ({ ...cfg, alertRecipients: recipients.split(/[,;\s]+/).filter(Boolean) });

  const run = async (name: string, fn: () => Promise<Result>) => {
    setBusy(name);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      setResult({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", async () => {
      const c = await put<MailConfig>("/api/settings/mail", payload());
      setCfg(c);
      return { tone: "ok", text: t("common.saved") };
    });
  const verify = () =>
    run("verify", async () => {
      const r = await post<{ ok: boolean; error?: string }>("/api/settings/mail/verify", { config: payload() });
      return r.ok ? { tone: "ok", text: t("mail.verifyOk") } : { tone: "danger", text: r.error! };
    });
  const sendTest = () =>
    run("test", async () => {
      const r = await post<{ ok: boolean; error?: string }>("/api/settings/mail/test", { to: testTo, config: payload() });
      return r.ok ? { tone: "ok", text: t("mail.testSent") } : { tone: "danger", text: r.error! };
    });

  const onSecurity = (s: MailConfig["security"]) => setCfg({ ...cfg, security: s, port: s === "tls" ? 465 : s === "starttls" ? 587 : 25 });

  return (
    <>
      <PageHeader
        title={t("mail.title")}
        description={t("mail.intro")}
        actions={
          <>
            <Button variant="secondary" icon={<PlugZap className="size-4" />} loading={busy === "verify"} onClick={verify}>
              {t("mail.verify")}
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
          <CardHeader icon={<Mail className="size-4" />} title={t("mail.server")} actions={<Switch checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={t("mail.enabled")} />} />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label={t("mail.host")} className="sm:col-span-2">
              {(id) => <Input id={id} value={cfg.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" />}
            </Field>
            <Field label={t("mail.port")}>{(id) => <Input id={id} type="number" value={cfg.port} onChange={(e) => set("port", Number(e.target.value))} />}</Field>
            <Field label={t("mail.security")} className="sm:col-span-2">
              {(id) => (
                <Select id={id} value={cfg.security} onChange={(e) => onSecurity(e.target.value as MailConfig["security"])}>
                  {(["starttls", "tls", "none"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`mail.sec_${s}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("mail.minTls")}>
              {(id) => (
                <Select id={id} value={cfg.minTlsVersion} onChange={(e) => set("minTlsVersion", e.target.value as MailConfig["minTlsVersion"])}>
                  <option>TLSv1.2</option>
                  <option>TLSv1.3</option>
                </Select>
              )}
            </Field>
            <div className="sm:col-span-3">
              <Switch checked={cfg.verifyCertificate} onChange={(v) => set("verifyCertificate", v)} label={t("mail.verifyCert")} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<ShieldCheck className="size-4" />} title={t("mail.authentication")} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mail.authMethod")} className="sm:col-span-2">
              {(id) => (
                <Select id={id} value={cfg.auth.method} onChange={(e) => setAuth("method", e.target.value)}>
                  {(["password", "oauth2", "none"] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`mail.auth_${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {cfg.auth.method !== "none" && (
              <Field label={t("mail.username")} className={cfg.auth.method === "oauth2" ? "sm:col-span-2" : ""}>
                {(id) => <Input id={id} value={cfg.auth.username} onChange={(e) => setAuth("username", e.target.value)} autoComplete="off" />}
              </Field>
            )}
            {cfg.auth.method === "password" && (
              <Field label={t("mail.password")}>
                {(id) => <Input id={id} type="password" value={cfg.auth.password} onChange={(e) => setAuth("password", e.target.value)} autoComplete="new-password" />}
              </Field>
            )}
            {cfg.auth.method === "oauth2" && (
              <>
                <Field label={t("mail.clientId")}>{(id) => <Input id={id} value={cfg.auth.oauth2ClientId} onChange={(e) => setAuth("oauth2ClientId", e.target.value)} />}</Field>
                <Field label={t("mail.clientSecret")}>
                  {(id) => <Input id={id} type="password" value={cfg.auth.oauth2ClientSecret} onChange={(e) => setAuth("oauth2ClientSecret", e.target.value)} />}
                </Field>
                <Field label={t("mail.refreshToken")} className="sm:col-span-2">
                  {(id) => <Input id={id} type="password" value={cfg.auth.oauth2RefreshToken} onChange={(e) => setAuth("oauth2RefreshToken", e.target.value)} />}
                </Field>
                <Field label={`${t("mail.tokenUrl")} (${t("common.optional")})`} className="sm:col-span-2">
                  {(id) => (
                    <Input id={id} value={cfg.auth.oauth2TokenUrl} onChange={(e) => setAuth("oauth2TokenUrl", e.target.value)} placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" />
                  )}
                </Field>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<UserRound className="size-4" />} title={t("mail.sender")} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mail.fromName")}>{(id) => <Input id={id} value={cfg.fromName} onChange={(e) => set("fromName", e.target.value)} />}</Field>
            <Field label={t("mail.fromAddress")}>
              {(id) => <Input id={id} type="email" value={cfg.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} placeholder="tv@example.com" />}
            </Field>
            <Field label={`${t("mail.replyTo")} (${t("common.optional")})`} className="sm:col-span-2">
              {(id) => <Input id={id} type="email" value={cfg.replyTo} onChange={(e) => set("replyTo", e.target.value)} />}
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<Signature className="size-4" />} title={t("mail.dkim")} actions={<Switch checked={cfg.dkim.enabled} onChange={(v) => setDkim("enabled", v)} label="" />} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mail.dkimDomain")}>{(id) => <Input id={id} value={cfg.dkim.domain} onChange={(e) => setDkim("domain", e.target.value)} disabled={!cfg.dkim.enabled} />}</Field>
            <Field label={t("mail.dkimSelector")}>
              {(id) => <Input id={id} value={cfg.dkim.selector} onChange={(e) => setDkim("selector", e.target.value)} disabled={!cfg.dkim.enabled} placeholder="tvsm" />}
            </Field>
            <Field label={t("mail.dkimKey")} className="sm:col-span-2">
              {(id) => (
                <Textarea id={id} value={cfg.dkim.privateKey} onChange={(e) => setDkim("privateKey", e.target.value)} disabled={!cfg.dkim.enabled} placeholder="-----BEGIN PRIVATE KEY-----" />
              )}
            </Field>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader icon={<Bell className="size-4" />} title={t("mail.alerts")} />
          <CardBody className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <Field label={t("mail.alertRecipients")} hint={t("mail.alertRecipientsHint")}>
              {(id) => <Input id={id} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="ops@example.com, editor@example.com" />}
            </Field>
            <div />
            <Field label={t("mail.testTo")}>{(id) => <Input id={id} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />}</Field>
            <Button variant="secondary" icon={<Send className="size-4" />} loading={busy === "test"} onClick={sendTest} disabled={!testTo}>
              {t("mail.sendTest")}
            </Button>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
