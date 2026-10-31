import { DatabaseBackup, Mail, PackageCheck, Users } from "lucide-react";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell, type NavGroup } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { initI18n } from "./i18n";
import { AccountPage } from "./pages/Account";
import { LoginPage, SetupPage } from "./pages/Auth";
import { BackupPage } from "./pages/Backup";
import { MailPage } from "./pages/Mail";
import { UpdatesPage } from "./pages/Updates";
import { UsersPage } from "./pages/Users";
import { SessionProvider, useSession, useTheme } from "./session";
import logoOnDark from "../../../branding/logo-on-dark.svg";
import logoMark from "../../../branding/logo-mark.svg";

export interface AppRoute {
  path: string;
  element: ReactNode;
}

export interface PlatformAppOptions {
  appName: string;
  /** App navigation (shown above the System group). */
  nav: NavGroup[];
  routes: AppRoute[];
  /** App-specific translations, merged with the platform strings. */
  translations: { en: Record<string, unknown>; nl: Record<string, unknown> };
}

const systemNav: NavGroup = {
  label: "nav.system",
  minRole: "admin",
  items: [
    { to: "/system/users", label: "nav.users", icon: Users },
    { to: "/system/mail", label: "nav.mail", icon: Mail },
    { to: "/system/backup", label: "nav.backup", icon: DatabaseBackup },
    { to: "/system/updates", label: "nav.updates", icon: PackageCheck },
  ],
};

function Gate({ opts }: { opts: PlatformAppOptions }) {
  const { status } = useSession();
  useTheme();
  if (status === "loading")
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  if (status === "setup") return <SetupPage appName={opts.appName} logo={logoOnDark} />;
  if (status === "anonymous") return <LoginPage appName={opts.appName} logo={logoOnDark} />;
  return (
    <AppShell nav={[...opts.nav, systemNav]} logo={logoOnDark} logoMark={logoMark}>
      <Routes>
        {opts.routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="/system/users" element={<UsersPage />} />
        <Route path="/system/mail" element={<MailPage />} />
        <Route path="/system/backup" element={<BackupPage />} />
        <Route path="/system/updates" element={<UpdatesPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export function mountPlatformApp(opts: PlatformAppOptions) {
  initI18n(opts.translations);
  document.title = opts.appName;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <SessionProvider>
          <Gate opts={opts} />
        </SessionProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
