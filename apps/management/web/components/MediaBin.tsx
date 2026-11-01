import { Card, Input, Select, cx } from "@tvsm/ui";
import { AlertTriangle, Check, Film, FolderOpen, GripVertical, Library, PanelRightClose, PanelRightOpen, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fmtDuration, useCategories, useGet, type BlockSummary, type MediaItem } from "../lib";
import { startDrag, type DragPayload } from "./dnd";

type LibraryPayload = Exclude<DragPayload, { kind: "row" }>;

const OPEN_KEY = "tvsm.bin.open";
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

/**
 * Page layout with the media library docked on the right. Editors drag clips (or blocks) from it into
 * the hour clock, the week, a rundown or a block. `onAdd` is the click alternative (touch screens).
 */
export function WithMediaBin({ children, onAdd, categoryId, blocks = true, hint }: { children: ReactNode; onAdd?: (p: LibraryPayload) => void; categoryId?: number | null; blocks?: boolean; hint?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      /* private mode */
    }
  };
  return (
    <div data-wide-page className={cx("grid items-start gap-6", open ? "xl:grid-cols-[minmax(0,1fr)_340px]" : "xl:grid-cols-[minmax(0,1fr)_44px]")}>
      {/* A container, so the page inside lays out by its own width rather than the window's. */}
      <div className="@container min-w-0">{children}</div>
      {open ? (
        <MediaBin onAdd={onAdd} categoryId={categoryId} blocks={blocks} hint={hint} onClose={toggle} />
      ) : (
        <button onClick={toggle} className="sticky top-4 hidden h-48 w-11 flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface text-muted shadow-sm transition hover:text-brand xl:flex" title={t("mgmt.bin.open")}>
          <PanelRightOpen className="size-4" />
          <span className="text-xs font-semibold tracking-wide [writing-mode:vertical-rl]">{t("mgmt.bin.title")}</span>
        </button>
      )}
    </div>
  );
}

function MediaBin({ onAdd, categoryId, blocks: showBlocks, hint, onClose }: { onAdd?: (p: LibraryPayload) => void; categoryId?: number | null; blocks: boolean; hint?: ReactNode; onClose: () => void }) {
  const { t } = useTranslation();
  const { categories } = useCategories();
  const [tab, setTab] = useState<"media" | "blocks">("media");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(categoryId ? String(categoryId) : "");
  const [folder, setFolder] = useState("");
  const [sel, setSel] = useState<MediaItem[]>([]);
  useEffect(() => setTheme(categoryId ? String(categoryId) : ""), [categoryId]);
  useEffect(() => {
    const h = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(h);
  }, [q]);
  const params = new URLSearchParams({ limit: "300", ...(query ? { q: query } : {}), ...(folder ? { folder } : {}), ...(theme ? { categoryId: theme } : {}) });
  const media = useGet<{ items: MediaItem[]; total: number; folders: string[] }>(tab === "media" ? `/api/media?${params}` : null);
  const blockList = useGet<{ blocks: BlockSummary[] }>(tab === "blocks" ? "/api/blocks" : null);
  const catById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
  const blocks = (blockList.data?.blocks ?? []).filter((b) => !query || b.name.toLowerCase().includes(query.toLowerCase()));
  const selected = (m: MediaItem) => sel.some((x) => x.id === m.id);
  const toggle = (m: MediaItem) => setSel((s) => (s.some((x) => x.id === m.id) ? s.filter((x) => x.id !== m.id) : [...s, m]));
  const selMs = sel.reduce((s, m) => s + (m.durationMs ?? 0), 0);

  return (
    <Card className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="grid size-7 place-items-center rounded-md bg-brand/10 text-brand">
          <Library className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t("mgmt.bin.title")}</span>
          <span className="block truncate text-[11px] text-muted">{t("mgmt.bin.dragHint")}</span>
        </span>
        <button onClick={onClose} className="hidden rounded p-1 text-muted hover:bg-surface-2 hover:text-fg xl:block" title={t("mgmt.bin.close")}>
          <PanelRightClose className="size-4" />
        </button>
      </div>
      {showBlocks && (
        <div className="flex gap-1 border-b border-line px-3 pt-2">
          {(["media", "blocks"] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={cx("-mb-px border-b-2 px-3 pb-2 text-[13px] font-medium transition", tab === k ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg")}>
              {t(`mgmt.bin.tab_${k}`)}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
          <Input className="h-8 pl-8 text-[13px]" placeholder={t("mgmt.media.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {tab === "media" && (
          <div className="grid grid-cols-2 gap-2">
            <Select className="h-8 text-[12px]" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label={t("mgmt.categoriesPage.one")}>
              <option value="">{t("mgmt.categoriesPage.all")}</option>
              <option value="none">{t("mgmt.categoriesPage.withoutCategory")}</option>
              {categories?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select className="h-8 text-[12px]" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label={t("mgmt.bin.folder")}>
              <option value="">{t("mgmt.media.allFolders")}</option>
              {media.data?.folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </div>
        )}
        {hint && <p className="text-[11px] text-muted">{hint}</p>}
      </div>

      {tab === "media" && sel.length > 0 && (
        <div
          draggable
          onDragStart={(e) => startDrag(e, { kind: "media", media: sel }, t("mgmt.bin.clips", { n: sel.length }))}
          className="flex cursor-grab items-center gap-2 border-b border-brand/30 bg-brand/8 px-3 py-2 text-[12px] active:cursor-grabbing"
        >
          <GripVertical className="size-3.5 text-brand" />
          <span className="flex-1 font-medium">{t("mgmt.bin.selection", { n: sel.length, d: fmtDuration(selMs) })}</span>
          {onAdd && (
            <button className="rounded px-1.5 py-0.5 font-semibold text-brand hover:bg-brand/10" onClick={() => (onAdd({ kind: "media", media: sel }), setSel([]))}>
              {t("common.add")}
            </button>
          )}
          <button className="rounded px-1.5 py-0.5 text-muted hover:text-fg" onClick={() => setSel([])}>
            {t("mgmt.bin.clear")}
          </button>
        </div>
      )}

      <ul className="min-h-40 flex-1 divide-y divide-line overflow-y-auto">
        {tab === "media" &&
          media.data?.items.map((m) => {
            const on = selected(m);
            const cat = m.categoryId ? catById.get(m.categoryId) : undefined;
            const drag = on && sel.length > 1 ? sel : [m];
            return (
              <li
                key={m.id}
                draggable
                onDragStart={(e) => startDrag(e, { kind: "media", media: drag }, drag.length > 1 ? t("mgmt.bin.clips", { n: drag.length }) : m.title || m.name)}
                className={cx("group flex cursor-grab items-center gap-2 px-3 py-2 text-[13px] transition active:cursor-grabbing", on ? "bg-brand/8" : "hover:bg-surface-2/70")}
                title={m.path}
              >
                <button onClick={() => toggle(m)} className={cx("grid size-4 shrink-0 place-items-center rounded border transition", on ? "border-brand bg-brand text-white" : "border-line group-hover:border-brand/60")} aria-label={t("mgmt.bin.select")}>
                  {on && <Check className="size-3" />}
                </button>
                <span className="h-7 w-1 shrink-0 rounded-full" style={{ background: cat?.color ?? "var(--color-line)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.title || m.name}</span>
                  <span className="flex items-center gap-1 truncate text-[11px] text-muted">
                    {m.folder && (
                      <>
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{m.folder}</span>
                      </>
                    )}
                    {cat && <span className="truncate">· {cat.name}</span>}
                  </span>
                </span>
                {m.durationMs == null && <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-label={t("mgmt.warnings.no_duration")} />}
                <span className="font-mono text-[11px] text-muted">{fmtDuration(m.durationMs)}</span>
                {onAdd && (
                  <button onClick={() => onAdd({ kind: "media", media: [m] })} className="rounded p-0.5 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-brand/10 hover:text-brand focus:opacity-100" aria-label={t("common.add")}>
                    <Plus className="size-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        {tab === "blocks" &&
          blocks.map((b) => (
            <li key={b.id} draggable onDragStart={(e) => startDrag(e, { kind: "block", block: b }, b.name)} className="group flex cursor-grab items-center gap-2 px-3 py-2 text-[13px] transition hover:bg-surface-2/70 active:cursor-grabbing">
              <GripVertical className="size-3.5 shrink-0 text-muted/60" />
              <span className="grid size-6 shrink-0 place-items-center rounded text-white" style={{ background: b.color }}>
                <Film className="size-3" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{b.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {t(`mgmt.bin.kind_${b.kind}`)} · {t("mgmt.bin.items", { n: b.itemCount })}
                </span>
              </span>
              <span className="font-mono text-[11px] text-muted">{fmtDuration(b.durationMs)}</span>
              {onAdd && (
                <button onClick={() => onAdd({ kind: "block", block: b })} className="rounded p-0.5 text-muted opacity-0 transition group-hover:opacity-100 hover:bg-brand/10 hover:text-brand focus:opacity-100" aria-label={t("common.add")}>
                  <Plus className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        {tab === "media" && media.data && !media.data.items.length && <li className="px-4 py-10 text-center text-[13px] text-muted">{t("mgmt.media.none")}</li>}
        {tab === "blocks" && blockList.data && !blocks.length && <li className="px-4 py-10 text-center text-[13px] text-muted">{t("mgmt.blocks.none")}</li>}
      </ul>
      {tab === "media" && media.data && media.data.total > media.data.items.length && <p className="border-t border-line px-3 py-2 text-[11px] text-muted">{t("mgmt.bin.more", { n: media.data.items.length, total: media.data.total })}</p>}
    </Card>
  );
}
