import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import nl from "./nl.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "nl", label: "Nederlands" },
] as const;

const STORAGE_KEY = "tvsm.language";

function initialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "nl") return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith("nl") ? "nl" : "en";
}

/** Initialise i18n with the platform strings plus app-specific resources (same shape: { en: {...}, nl: {...} }). */
export function initI18n(appResources: { en: Record<string, unknown>; nl: Record<string, unknown> }) {
  const resources: Resource = {
    en: { translation: { ...en, ...appResources.en } },
    nl: { translation: { ...nl, ...appResources.nl } },
  };
  void i18n.use(initReactI18next).init({ resources, lng: initialLanguage(), fallbackLng: "en", interpolation: { escapeValue: false } });
  i18n.on("languageChanged", (lng) => {
    document.documentElement.lang = lng;
    try {
      localStorage.setItem(STORAGE_KEY, lng);
    } catch {
      /* ignore */
    }
  });
  document.documentElement.lang = i18n.language;
  return i18n;
}
