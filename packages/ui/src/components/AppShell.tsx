import { ChevronDown, ChevronsLeft, Info, LogOut, Menu, Moon, ShieldAlert, Sun, UserRound } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { post } from "../api";
import { LANGUAGES } from "../i18n";
import { useSession, useTheme } from "../session";
import { InfoDialog } from "./InfoDialog";
import { cx } from "./ui";

export interface NavItem {
  /** Route; for an item with `children` it is only a stable key (the item opens and closes the submenu). */
  to: string;
  /** i18n key */
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  /** Hide unless the user has at least this role (admin > editor > operator). */
  minRole?: "admin" | "editor" | "operator";
  /** Other routes (and their sub-routes) that count as this item, e.g. the tabs of one page. */
  also?: string[];
  /** A submenu: the item folds open to show these (opens by itself when one of them is the current page). */
  children?: NavItem[];
}
export interface NavGroup {
  /** i18n key, omit for the first unlabeled group */
  label?: string;
  minRole?: "admin" | "editor" | "operator";
  items: NavItem[];
}

/** Folded menu groups and submenus, remembered per browser. */
const FOLD_KEY = "tvsm.nav.folded";
const readFolded = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};
const under = (path: string, to: string) => path === to || path.startsWith(`${to}/`);
const pathMatches = (path: string, item: NavItem) => (item.end || item.to === "/" ? path === item.to : under(path, item.to)) || !!item.also?.some((p) => under(path, p));
const containsPath = (path: string, item: NavItem): boolean => (item.children ? item.children.some((c) => containsPath(path, c)) : pathMatches(path, item));

const rank = (r?: string) => ({ admin: 3, editor: 2, operator: 1 })[r ?? ""] ?? 0;
export const roleAtLeast = (role: string | undefined, min?: string) => !min || rank(role) >= rank(min);

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
  // Submenus start folded, groups start open; the page you are on always stays visible.
  const [folded, setFolded] = useState(readFolded);
  const isFolded = (key: string, def: boolean) => folded[key] ?? def;
  const toggleFold = (key: string, def: boolean) =>
    setFolded((f) => {
      const next = { ...f, [key]: !(f[key] ?? def) };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
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
  const navLink = (item: NavItem, sub: boolean) => (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={() => setMobileOpen(false)}
      title={mini ? t(item.label) : undefined}
      className={({ isActive: own }) => {
        const isActive = own || !!item.also?.some((p) => under(location.pathname, p));
        return cx(
          "group relative flex items-center gap-3 rounded-md font-medium transition",
          sub ? "py-1.5 text-[13px]" : "py-2 text-[13.5px]",
          mini ? "justify-center px-0" : sub ? "px-2.5" : "px-3",
          isActive ? "bg-brand text-white shadow-md shadow-brand/30" : "text-sidebar-fg/80 hover:bg-white/5 hover:text-white",
        );
      }}
    >
      <item.icon className={cx("shrink-0", sub ? "size-4" : "size-[18px]")} />
      {!mini && <span className="truncate">{t(item.label)}</span>}
    </NavLink>
  );

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

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-5">
        {nav
          .filter((g) => roleAtLeast(user?.role, g.minRole))
          .map((g) => ({
            ...g,
            items: g.items
              .filter((i) => roleAtLeast(user?.role, i.minRole))
              .map((i) => (i.children ? { ...i, children: i.children.filter((c) => roleAtLeast(user?.role, c.minRole)) } : i))
              .filter((i) => !i.children || i.children.length > 0),
          }))
          .filter((g) => g.items.length > 0)
          .map((group, gi) => {
            const groupKey = `group:${group.label ?? gi}`;
            const here = group.items.some((i) => containsPath(location.pathname, i));
            const groupOpen = mini || !group.label || here || !isFolded(groupKey, false);
            return (
              <div key={gi}>
                {group.label && !mini && (
                  <button
                    onClick={() => !here && toggleFold(groupKey, false)}
                    className={cx("group/g mb-1.5 flex w-full items-center gap-1 rounded px-3 py-0.5 text-left text-[11px] font-semibold tracking-wider text-white/35 uppercase", !here && "hover:text-white/70")}
                    aria-expanded={groupOpen}
                  >
                    <span className="flex-1">{t(group.label)}</span>
                    {!here && <ChevronDown className={cx("size-3.5 opacity-0 transition group-hover/g:opacity-100", !groupOpen && "-rotate-90 opacity-100")} />}
                  </button>
                )}
                {group.label && mini && <div className="mx-3 mb-2 border-t border-white/10" />}
                {groupOpen && (
                  <ul className="space-y-1">
                    {group.items.map((item) =>
                      item.children ? (
                        mini ? (
                          item.children.map((c) => <li key={c.to}>{navLink(c, false)}</li>)
                        ) : (
                          <li key={item.to}>
                            {(() => {
                              const subKey = `sub:${item.to}`;
                              const inside = containsPath(location.pathname, item);
                              const open = inside || !isFolded(subKey, true);
                              return (
                                <>
                                  <button
                                    onClick={() => !inside && toggleFold(subKey, true)}
                                    aria-expanded={open}
                                    className={cx(
                                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium transition",
                                      inside ? "text-white" : "text-sidebar-fg/80 hover:bg-white/5 hover:text-white",
                                    )}
                                  >
                                    <item.icon className="size-[18px] shrink-0" />
                                    <span className="flex-1 truncate">{t(item.label)}</span>
                                    <span className="rounded-full bg-white/8 px-1.5 text-[10.5px] font-semibold text-white/50">{item.children.length}</span>
                                    <ChevronDown className={cx("size-4 shrink-0 text-white/40 transition", !open && "-rotate-90")} />
                                  </button>
                                  {open && (
                                    <ul className="mt-1 ml-[21px] space-y-0.5 border-l border-white/10 pl-2">
                                      {item.children.map((c) => (
                                        <li key={c.to}>{navLink(c, true)}</li>
                                      ))}
                                    </ul>
                                  )}
                                </>
                              );
                            })()}
                          </li>
                        )
                      ) : (
                        <li key={item.to}>{navLink(item, false)}</li>
                      ),
                    )}
                  </ul>
                )}
              </div>
            );
          })}
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
                <p className="truncate text-[11px] text-white/40">{t(`users.roles.${user?.role}`, { defaultValue: user?.role })}</p>
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
          {/* Pages with a docked side panel (data-wide-page) get more room. */}
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 has-[[data-wide-page]]:max-w-[112rem]">{children}</div>
        </main>
      </div>
      <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} logo={logoMark} />
    </div>
  );
}
