import { ChevronsLeft, Info, LogOut, Menu, Moon, ShieldAlert, Sun, UserRound } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { post } from "../api";
import { LANGUAGES } from "../i18n";
import { useSession, useTheme } from "../session";
import { InfoDialog } from "./InfoDialog";
import { cx } from "./ui";

export interface NavItem {
  to: string;
  /** i18n key */
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}
export interface NavGroup {
  /** i18n key, omit for the first unlabeled group */
  label?: string;
  items: NavItem[];
}

export function AppShell({ nav, logo, logoMark, children }: { nav: NavGroup[]; logo: string; logoMark: string; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { info, user, lastCheck, refresh, defaultPasswordInUse } = useSession();
  const [theme, setTheme] = useTheme();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("tvsm.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const location = useLocation();
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("tvsm.sidebar", c ? "open" : "collapsed");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };
  const logout = async () => {
    await post("/api/auth/logout");
    await refresh();
  };
  const mini = collapsed && !mobileOpen;

  const sidebar = (
    <aside
      className={cx(
        "flex h-full flex-col bg-sidebar text-sidebar-fg transition-[width] duration-200",
        mini ? "w-[72px]" : "w-64",
      )}
    >
      <div className={cx("flex h-16 items-center border-b border-white/5", mini ? "justify-center px-2" : "justify-between px-5")}>
        {mini ? <img src={logoMark} alt={info?.app.name} className="size-9" /> : <img src={logo} alt={info?.app.name} className="h-9 text-white" style={{ color: "white" }} />}
        {!mini && (
          <button onClick={toggleCollapsed} className="hidden rounded-md p-1.5 text-white/40 hover:bg-white/5 hover:text-white lg:block" aria-label={t("nav.collapse")}>
            <ChevronsLeft className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {nav.map((group, gi) => (
          <div key={gi}>
            {group.label && !mini && <p className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-white/35 uppercase">{t(group.label)}</p>}
            {group.label && mini && <div className="mx-3 mb-2 border-t border-white/10" />}
            <ul className="space-y-1">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={() => setMobileOpen(false)}
                    title={mini ? t(item.label) : undefined}
                    className={({ isActive }) =>
                      cx(
                        "group relative flex items-center gap-3 rounded-md py-2 text-[13.5px] font-medium transition",
                        mini ? "justify-center px-0" : "px-3",
                        isActive ? "bg-brand text-white shadow-md shadow-brand/30" : "text-sidebar-fg/80 hover:bg-white/5 hover:text-white",
                      )
                    }
                  >
                    <item.icon className="size-[18px] shrink-0" />
                    {!mini && <span className="truncate">{t(item.label)}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-white/5 p-3">
        <button
          onClick={() => setInfoOpen(true)}
          className={cx("flex w-full items-center gap-3 rounded-md py-2 text-[13.5px] text-sidebar-fg/80 hover:bg-white/5 hover:text-white", mini ? "justify-center" : "px-3")}
          title={mini ? t("nav.info") : undefined}
        >
          <span className="relative">
            <Info className="size-[18px]" />
            {lastCheck?.available && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-onair ring-2 ring-sidebar" />}
          </span>
          {!mini && (
            <span className="flex flex-1 items-center justify-between">
              <span>{t("nav.info")}</span>
              <span className="font-mono text-[11px] text-white/40">v{info?.version}</span>
            </span>
          )}
        </button>

        {!mini ? (
          <div className="flex items-center gap-2 px-1 py-1">
            <div className="flex flex-1 rounded-md bg-white/5 p-0.5" role="group" aria-label={t("nav.language")}>
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => void i18n.changeLanguage(l.code)}
                  className={cx(
                    "flex-1 rounded-[5px] py-1 text-xs font-semibold uppercase transition",
                    i18n.language === l.code ? "bg-white/10 text-white" : "text-white/45 hover:text-white",
                  )}
                  title={l.label}
                >
                  {l.code}
                </button>
              ))}
            </div>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="rounded-md bg-white/5 p-1.5 text-white/60 hover:text-white"
              aria-label={t("nav.theme")}
              title={t(theme === "dark" ? "nav.light" : "nav.dark")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </div>
        ) : (
          <button onClick={toggleCollapsed} className="flex w-full justify-center rounded-md py-2 text-white/40 hover:bg-white/5 hover:text-white" aria-label={t("nav.collapse")}>
            <ChevronsLeft className="size-4 rotate-180" />
          </button>
        )}

        <div className={cx("flex items-center gap-3 rounded-md py-2", mini ? "justify-center" : "px-3")}>
          <NavLink to="/account" className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-xs font-bold text-white" title={t("nav.account")}>
            {user?.username.slice(0, 2).toUpperCase() ?? <UserRound className="size-4" />}
          </NavLink>
          {!mini && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-white">{user?.displayName || user?.username}</p>
                <p className="truncate text-[11px] text-white/40">{user?.role}</p>
              </div>
              <button onClick={logout} className="rounded-md p-1.5 text-white/40 hover:bg-white/5 hover:text-white" title={t("nav.logout")} aria-label={t("nav.logout")}>
                <LogOut className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-full">
      <div className="hidden h-full shrink-0 lg:block">{sidebar}</div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)} style={{ background: "rgb(10 14 26 / 0.55)" }}>
          <div className="h-full w-64" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-2 hover:bg-surface-2" aria-label={t("nav.menu")}>
            <Menu className="size-5" />
          </button>
          <img src={logoMark} alt="" className="size-7" />
          <span className="font-semibold">{info?.app.name}</span>
        </header>
        {defaultPasswordInUse && (
          <div className="flex flex-wrap items-center gap-3 border-b border-warn/30 bg-warn/15 px-4 py-2.5 text-sm sm:px-8">
            <ShieldAlert className="size-4 shrink-0 text-warn" />
            <span className="flex-1">{t("auth.defaultPasswordWarning")}</span>
            <NavLink to="/account" className="font-semibold text-brand hover:underline">
              {t("auth.changeNow")}
            </NavLink>
          </div>
        )}
        <main key={location.pathname} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">{children}</div>
        </main>
      </div>
      <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} logo={logoMark} />
    </div>
  );
}
