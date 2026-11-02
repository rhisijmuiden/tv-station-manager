import { Badge, Button, Dialog, Input, Select, cx } from "@tvsm/ui";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CATEGORIES, categoryTone, fmtDuration, useCategories, useGet, type MediaItem } from "../lib";

/** Dialog to pick one or more media files from the library. */
export function MediaPicker({
  open,
  onClose,
  onPick,
  multiple = true,
  category,
  categoryId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (m: MediaItem[]) => void;
  multiple?: boolean;
  category?: string;
  /** Preselects a content category (sport, culture…). */
  categoryId?: number | null;
}) {
  const { t } = useTranslation();
  const { categories } = useCategories();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(category ?? "");
  const [theme, setTheme] = useState(categoryId ? String(categoryId) : "");
  useEffect(() => {
    if (open) setTheme(categoryId ? String(categoryId) : "");
  }, [open, categoryId]);
  const [folder, setFolder] = useState("");
  const [sel, setSel] = useState<MediaItem[]>([]);
  const params = new URLSearchParams({ limit: "200", ...(q ? { q } : {}), ...(cat ? { category: cat } : {}), ...(folder ? { folder } : {}), ...(theme ? { categoryId: theme } : {}) });
  const { data } = useGet<{ items: MediaItem[]; total: number; folders: string[] }>(open ? `/api/media?${params}` : null);
  const toggle = (m: MediaItem) => {
    if (!multiple) return setSel([m]);
    setSel((s) => (s.some((x) => x.id === m.id) ? s.filter((x) => x.id !== m.id) : [...s, m]));
  };
  const close = () => {
    setSel([]);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={t("mgmt.media.pick")}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            {sel.length} {t("mgmt.media.selected")} · {fmtDuration(sel.reduce((s, m) => s + (m.durationMs ?? 0), 0))}
          </span>
          <Button variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!sel.length}
            onClick={() => {
              onPick(sel);
              close();
            }}
          >
            {t("common.add")}
          </Button>
        </>
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_150px_150px_170px]">
        <Input placeholder={t("mgmt.media.search")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <Select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{t("mgmt.media.allCategories")}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`mgmt.categories.${c}`)}
            </option>
          ))}
        </Select>
        <Select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label={t("mgmt.categoriesPage.one")}>
          <option value="">{t("mgmt.categoriesPage.all")}</option>
          <option value="none">{t("mgmt.categoriesPage.withoutCategory")}</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">{t("mgmt.media.allFolders")}</option>
          {data?.folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </div>
      <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-md border border-line">
        {data?.items.map((m) => {
          const on = sel.some((x) => x.id === m.id);
          return (
            <li key={m.id}>
              <button onClick={() => toggle(m)} className={cx("flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition", on ? "bg-brand/10" : "hover:bg-surface-2")}>
                <span className={cx("grid size-5 shrink-0 place-items-center rounded border", on ? "border-brand bg-brand text-white" : "border-line")}>{on && <Check className="size-3.5" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.title || m.name}</span>
                  <span className="block truncate text-xs text-muted">{m.path}</span>
                </span>
                {m.durationMs == null && <AlertTriangle className="size-4 text-warn" aria-label={t("mgmt.warnings.no_duration")} />}
                <Badge tone={categoryTone(m.category)}>{t(`mgmt.categories.${m.category}`)}</Badge>
                <span className="w-16 text-right font-mono text-xs text-muted">{fmtDuration(m.durationMs)}</span>
              </button>
            </li>
          );
        })}
        {data && !data.items.length && <li className="px-3 py-8 text-center text-sm text-muted">{t("mgmt.media.none")}</li>}
      </ul>
    </Dialog>
  );
}
