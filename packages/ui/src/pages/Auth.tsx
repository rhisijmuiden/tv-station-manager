import { useEffect, useState, type FormEvent } from "react";
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
            "radial-gradient(60rem 40rem at 10% -10%, rgb(59 108 255 / 0.35), transparent 60%), radial-gradient(40rem 30rem at 110% 110%, rgb(255 61 87 / 0.18), transparent 60%)",
        }}
      />
      <div className="relative w-full max-w-md">
        <img src={logo} alt="TV Station Manager" className="mx-auto mb-8 h-12" />
        <div className="rounded-xl border border-line bg-surface p-8 shadow-2xl">
          <h1 className="text-xl font-semibold">{title}</h1>
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

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="size-5" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

/** Reads ?sso_error=... left by a failed Microsoft sign-in, and removes it from the address bar. */
function useSsoError() {
  const [code] = useState(() => new URLSearchParams(window.location.search).get("sso_error"));
  useEffect(() => {
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("sso_error");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [code]);
  return code;
}

export function LoginPage({ appName, logo }: { appName: string; logo: string }) {
  const { t } = useTranslation();
  const { refresh, sso } = useSession();
  const ssoError = useSsoError();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLocal, setShowLocal] = useState(!sso);
  const returnTo = window.location.pathname + window.location.search.replace(/[?&]sso_error=[^&]*/, "");
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
      {ssoError && (
        <Alert tone="danger" className="mb-4">
          {t(`auth.ssoErrors.${ssoError}`, { defaultValue: t("auth.ssoErrors.generic") })}
        </Alert>
      )}
      {sso && (
        <>
          <a
            href={`/api/auth/sso/login?returnTo=${encodeURIComponent(returnTo || "/")}`}
            className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-line bg-surface-2 text-sm font-semibold transition hover:border-brand hover:bg-surface"
          >
            <MicrosoftLogo />
            {sso.label || t("auth.signInMicrosoft")}
          </a>
          {!showLocal && (
            <button type="button" onClick={() => setShowLocal(true)} className="mt-4 w-full text-center text-xs text-muted hover:text-fg">
              {t("auth.useLocalAccount")}
            </button>
          )}
          {showLocal && (
            <div className="my-5 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" />
              {t("auth.orLocal")}
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
        </>
      )}
      {showLocal && <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{t("auth.invalid")}</Alert>}
        <Field label={t("auth.username")}>{(id) => <Input id={id} autoFocus={!sso} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label={t("auth.password")}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          {t("auth.signIn")}
        </Button>
      </form>}
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
