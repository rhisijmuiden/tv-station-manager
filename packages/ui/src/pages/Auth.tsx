import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { post } from "../api";
import { Alert, Button, Field, Input } from "../components/ui";
import { LANGUAGES } from "../i18n";
import { useSession } from "../session";
import { TvStatic } from "../components/TvStatic";

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

/** The login page: a big television without signal, the sign-in in the bottom of the cabinet. */
function TvLayout({ logo, title, children }: { logo: string; title: string; children: React.ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-sidebar px-3 py-8 sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60rem 40rem at 10% -10%, color-mix(in srgb, var(--tvsm-primary) 35%, transparent), transparent 60%), radial-gradient(40rem 30rem at 110% 110%, color-mix(in srgb, var(--tvsm-accent) 22%, transparent), transparent 60%)",
        }}
      />
      <div className="relative w-full max-w-3xl">
        <div
          className="rounded-[1.6rem] p-2.5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.8)] sm:rounded-[2.2rem] sm:p-5"
          style={{
            background: "linear-gradient(180deg, color-mix(in srgb, var(--tvsm-ink) 70%, #000) 0%, color-mix(in srgb, var(--tvsm-ink) 35%, #000) 100%)",
            boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.08), 0 40px 80px -30px rgb(0 0 0 / 0.8)",
          }}
        >
          <div className="relative aspect-video overflow-hidden rounded-[1rem] border-4 border-black/70 sm:rounded-[1.6rem]" style={{ boxShadow: "inset 0 0 40px rgb(0 0 0 / 0.9)" }}>
            <TvStatic logo={logo} />
          </div>
          <div className="relative flex flex-col items-center px-2 pt-5 pb-4 sm:pt-6 sm:pb-5">
            <span aria-hidden className="tv-led absolute top-6 right-3 hidden size-2 rounded-full bg-onair shadow-[0_0_8px_var(--tvsm-on-air)] sm:block" />
            <span aria-hidden className="absolute top-5 left-3 hidden gap-1.5 sm:flex">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-3.5 rounded-full border border-white/10 bg-black/40 shadow-inner" />
              ))}
            </span>
            <h1 className="mb-4 text-center font-display text-sm font-semibold tracking-wide text-white/70">{title}</h1>
            <div className="w-full max-w-sm">{children}</div>
          </div>
        </div>
        <div aria-hidden className="mx-auto h-5 w-24 sm:h-7 sm:w-32" style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--tvsm-ink) 30%, #000), #000)" }} />
        <div aria-hidden className="mx-auto h-2 w-56 rounded-full bg-black/70 sm:w-72" />
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
    <TvLayout logo={logo} title={t("auth.signInTitle", { app: appName })}>
      {ssoError && (
        <Alert tone="danger" className="mb-4">
          {t(`auth.ssoErrors.${ssoError}`, { defaultValue: t("auth.ssoErrors.generic") })}
        </Alert>
      )}
      {sso && (
        <>
          <a
            href={`/api/auth/sso/login?returnTo=${encodeURIComponent(returnTo || "/")}`}
            className="flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-white text-sm font-semibold text-[#1b1b1b] shadow-lg ring-1 ring-black/10 transition hover:-translate-y-px hover:shadow-xl focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-onair"
          >
            <MicrosoftLogo />
            {sso.label || t("auth.signInMicrosoft")}
          </a>
          {!showLocal && (
            <button type="button" onClick={() => setShowLocal(true)} className="mt-4 w-full text-center text-xs text-white/55 hover:text-white">
              {t("auth.useLocalAccount")}
            </button>
          )}
          {showLocal && (
            <div className="my-5 flex items-center gap-3 text-xs text-white/55">
              <span className="h-px flex-1 bg-white/15" />
              {t("auth.orLocal")}
              <span className="h-px flex-1 bg-white/15" />
            </div>
          )}
        </>
      )}
      {showLocal && <form onSubmit={submit} className="space-y-4 rounded-xl bg-surface p-5 shadow-lg">
        {error && <Alert tone="danger">{t("auth.invalid")}</Alert>}
        <Field label={t("auth.username")}>{(id) => <Input id={id} autoFocus={!sso} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label={t("auth.password")}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          {t("auth.signIn")}
        </Button>
      </form>}
    </TvLayout>
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
