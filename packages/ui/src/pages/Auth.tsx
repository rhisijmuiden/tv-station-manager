import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { post } from "../api";
import { Alert, Button, Field, Input } from "../components/ui";
import { LANGUAGES } from "../i18n";
import { useSession } from "../session";

function AuthLayout({ logo, title, intro, children }: { logo: string; title: string; intro?: string; children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-sidebar px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60rem 40rem at 10% -10%, color-mix(in srgb, var(--tvsm-primary) 35%, transparent), transparent 60%), radial-gradient(40rem 30rem at 110% 110%, color-mix(in srgb, var(--tvsm-accent) 22%, transparent), transparent 60%)",
        }}
      />
      <div className="relative w-full max-w-md">
        <img src={logo} alt="" className="mx-auto mb-8 h-12" />
        <div className="rounded-xl border border-line bg-surface p-8 shadow-2xl">
          <h1 className="font-display text-xl font-semibold">{title}</h1>
          {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
          <div className="mt-6">{children}</div>
        </div>
        <div className="mt-6 flex justify-center gap-4 text-xs">
          {LANGUAGES.map((l) => (
            <button key={l.code} onClick={() => void i18n.changeLanguage(l.code)} className={i18n.language === l.code ? "font-semibold text-white" : "text-white/50 hover:text-white"}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoginPage({ appName, logo }: { appName: string; logo: string }) {
  const { t } = useTranslation();
  const { refresh } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      await post("/api/auth/login", { username, password });
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout logo={logo} title={t("auth.signInTitle", { app: appName })}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{t("auth.invalid")}</Alert>}
        <Field label={t("auth.username")}>{(id) => <Input id={id} autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label={t("auth.password")}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          {t("auth.signIn")}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SetupPage({ appName, logo }: { appName: string; logo: string }) {
  const { t, i18n } = useTranslation();
  const { refresh } = useSession();
  const [f, setF] = useState({ username: "admin", email: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError(t("auth.passwordMismatch"));
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/setup", { username: f.username, password: f.password, email: f.email || undefined, language: i18n.language === "nl" ? "nl" : "en" });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthLayout logo={logo} title={t("auth.setupTitle", { app: appName })} intro={t("auth.setupIntro")}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t("auth.username")}>{(id) => <Input id={id} value={f.username} onChange={set("username")} autoComplete="username" />}</Field>
        <Field label={`${t("auth.email")} (${t("common.optional")})`}>{(id) => <Input id={id} type="email" value={f.email} onChange={set("email")} />}</Field>
        <Field label={t("auth.password")} hint={t("auth.passwordHint")}>
          {(id) => <Input id={id} type="password" minLength={10} value={f.password} onChange={set("password")} autoComplete="new-password" />}
        </Field>
        <Field label={t("auth.passwordConfirm")}>{(id) => <Input id={id} type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" />}</Field>
        <Button type="submit" className="w-full" loading={busy}>
          {t("auth.createAccount")}
        </Button>
      </form>
    </AuthLayout>
  );
}
