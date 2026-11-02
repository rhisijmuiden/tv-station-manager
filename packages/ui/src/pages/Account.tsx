import { KeyRound, UserRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { put } from "../api";
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "../components/ui";
import { LANGUAGES } from "../i18n";
import { useSession } from "../session";

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const { user, refresh } = useSession();
  const [profile, setProfile] = useState({ displayName: user?.displayName ?? "", email: user?.email ?? "", language: i18n.language });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const saveProfile = async () => {
    await put("/api/auth/profile", { displayName: profile.displayName || null, email: profile.email || null, language: profile.language });
    await i18n.changeLanguage(profile.language);
    await refresh();
    setMsg({ tone: "ok", text: t("common.saved") });
  };
  const savePassword = async () => {
    try {
      await put("/api/auth/password", pw);
      await refresh();
      setPw({ current: "", next: "" });
      setMsg({ tone: "ok", text: t("account.passwordChanged") });
    } catch {
      setMsg({ tone: "danger", text: t("account.wrongPassword") });
    }
  };

  return (
    <>
      <PageHeader title={t("account.title")} />
      {msg && (
        <Alert tone={msg.tone} className="mb-6">
          {msg.text}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<UserRound className="size-4" />} title={t("account.profile")} description={user?.username} />
          <CardBody className="space-y-4">
            <Field label={t("account.displayName")}>{(id) => <Input id={id} value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} />}</Field>
            <Field label={t("auth.email")}>{(id) => <Input id={id} type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />}</Field>
            <Field label={t("account.language")}>
              {(id) => (
                <Select id={id} value={profile.language} onChange={(e) => setProfile({ ...profile, language: e.target.value })}>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex justify-end">
              <Button onClick={saveProfile}>{t("common.save")}</Button>
            </div>
          </CardBody>
        </Card>
        {user?.authProvider === "entra" ? (
          <Card>
            <CardHeader icon={<KeyRound className="size-4" />} title={t("account.signInMethod")} />
            <CardBody>
              <p className="text-sm text-muted">{t("account.microsoftManaged")}</p>
            </CardBody>
          </Card>
        ) : (
        <Card>
          <CardHeader icon={<KeyRound className="size-4" />} title={t("account.changePassword")} />
          <CardBody className="space-y-4">
            <Field label={t("account.currentPassword")}>
              {(id) => <Input id={id} type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />}
            </Field>
            <Field label={t("account.newPassword")} hint={t("auth.passwordHint")}>
              {(id) => <Input id={id} type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />}
            </Field>
            <div className="flex justify-end">
              <Button onClick={savePassword} disabled={pw.next.length < 10}>
                {t("account.changePassword")}
              </Button>
            </div>
          </CardBody>
        </Card>
        )}
      </div>
    </>
  );
}
