import { useSyncExternalStore } from "react";

/**
 * Phone detection for the mobile layout. Decided by screen size and touch, not by the browser's name:
 * a phone held upright (narrow screen) or on its side (touch and a low screen) gets the mobile layout.
 * People can switch to the desktop layout anyway; that choice is kept per browser.
 */
export type ViewChoice = "auto" | "desktop";
const KEY = "tvsm.view";
const QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 500px)";

const readChoice = (): ViewChoice => {
  try {
    return localStorage.getItem(KEY) === "desktop" ? "desktop" : "auto";
  } catch {
    return "auto";
  }
};
let choice: ViewChoice = typeof window === "undefined" ? "auto" : readChoice();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const media = typeof window === "undefined" || !window.matchMedia ? null : window.matchMedia(QUERY);
media?.addEventListener?.("change", emit);

/** The original viewport meta, so "desktop layout" can widen it and "mobile layout" restore it. */
let viewportDefault: string | null = null;
function applyViewport() {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  viewportDefault ??= meta.content;
  // A phone in desktop layout renders a laptop-wide page the person can zoom, like "request desktop site".
  meta.content = choice === "desktop" && isSmallScreen() ? "width=1280" : viewportDefault;
}
const isSmallScreen = () => !!media?.matches || (typeof window !== "undefined" && Math.min(window.screen?.width ?? 9999, window.screen?.height ?? 9999) < 768);
applyViewport();

/** True when this screen should use the phone layout. */
export const isMobileView = () => choice === "auto" && !!media?.matches;

export function setViewChoice(next: ViewChoice) {
  choice = next;
  try {
    if (next === "desktop") localStorage.setItem(KEY, "desktop");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
  applyViewport();
  emit();
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** Re-renders when the phone layout turns on or off (rotating, resizing, the person's choice). */
export const useMobile = () => useSyncExternalStore(subscribe, isMobileView, () => false);

/** The person's choice and whether this device is small enough to offer the phone layout at all. */
export const useViewChoice = () => {
  const c = useSyncExternalStore(subscribe, () => choice, () => "auto" as ViewChoice);
  return { choice: c, smallScreen: isSmallScreen(), setChoice: setViewChoice };
};
