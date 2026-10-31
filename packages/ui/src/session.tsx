import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: string;
  language: string;
}
export interface SystemInfo {
  app: { id: string; name: string };
  version: string;
  channel: "production" | "test";
  packaged: boolean;
  hostname: string;
  os: string;
  node: string;
  arch: string;
  uptimeSeconds: number;
}
export interface UpdateCheck {
  current: string;
  channel: "production" | "test";
  latest: string | null;
  available: boolean;
  isDowngrade: boolean;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  canApply: boolean;
  reason?: string;
  checkedAt: string;
}

interface Session {
  status: "loading" | "setup" | "anonymous" | "ready";
  user: SessionUser | null;
  defaultPasswordInUse: boolean;
  info: SystemInfo | null;
  lastCheck: UpdateCheck | null;
  setLastCheck: (c: UpdateCheck | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Session, "refresh" | "setLastCheck">>({ status: "loading", user: null, defaultPasswordInUse: false, info: null, lastCheck: null });
  const refresh = useCallback(async () => {
    const s = await get<{ setupRequired: boolean; user: SessionUser | null; defaultPasswordInUse?: boolean }>("/api/auth/status");
    if (s.setupRequired) return setState((p) => ({ ...p, status: "setup", user: null }));
    if (!s.user) return setState((p) => ({ ...p, status: "anonymous", user: null }));
    const [info, upd] = await Promise.all([get<SystemInfo>("/api/system/info"), get<{ lastCheck: UpdateCheck | null }>("/api/system/update")]);
    setState({ status: "ready", user: s.user, defaultPasswordInUse: !!s.defaultPasswordInUse, info, lastCheck: upd.lastCheck });
  }, []);
  useEffect(() => {
    void refresh();
    const h = () => void refresh();
    window.addEventListener("tvsm:unauthorized", h);
    return () => window.removeEventListener("tvsm:unauthorized", h);
  }, [refresh]);
  const setLastCheck = useCallback((c: UpdateCheck | null) => setState((p) => ({ ...p, lastCheck: c })), []);
  return <Ctx.Provider value={{ ...state, refresh, setLastCheck }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function useTheme() {
  const read = (): "light" | "dark" => {
    try {
      const v = localStorage.getItem("tvsm.theme");
      if (v === "light" || v === "dark") return v;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("tvsm.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}
