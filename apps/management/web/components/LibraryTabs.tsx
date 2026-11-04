import { cx } from "@tvsm/ui";
import { FolderOpen, Newspaper, Satellite, Video, Webcam } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/media", label: "mgmt.plan.library.media", icon: FolderOpen },
  { to: "/recordings", label: "mgmt.plan.library.recordings", icon: Video },
  { to: "/beeldkrant", label: "mgmt.plan.library.beeldkrant", icon: Newspaper },
  { to: "/webcams", label: "mgmt.plan.library.webcams", icon: Webcam },
  { to: "/remote", label: "mgmt.plan.library.live", icon: Satellite },
];

/** The library: everything that can go on air, one page with a tab per kind (the pages themselves stay as they are). */
export function LibraryTabs({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <nav className="mb-5 flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" aria-label={t("mgmt.plan.library.title")}>
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => cx("inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold transition", isActive ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>
            <tab.icon className="size-4" />
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>
      {children}
    </>
  );
}
