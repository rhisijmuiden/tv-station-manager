import { Alert, ApiError, Button, Dialog, Field, Input, Select, cx, post } from "@tvsm/ui";
import { CalendarClock, Dices, Loader2, FolderOpen, FolderTree, Repeat, Sparkles, Tags, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtDuration, useCategories, useGet } from "../lib";

/** "Newest clips" rule of a block item (mirrors `server/autofill.ts`). */
export interface AutoRule {
  source: "category" | "folder";
  categoryId: number | null;
  folder: string;
  /** Folder source: everything below the folder, or only its newest subfolder (a folder per week). */
  subfolders: "all" | "newest";
  count: number;
  maxAgeDays: number | null;
  maxMinutes: number | null;
  pick: "newest" | "rotate" | "random";
  order: "newest_first" | "oldest_first";
}
export interface AutoInfo {
  autoRule: AutoRule;
  autoSourceName: string | null;
  /** "Only the newest subfolder": the folder(s) it plays from right now. */
  autoFolders?: string[] | null;
  autoClips: { id: number; name: string; durationMs: number }[];
  effectiveDurationMs: number;
}
/** A new dynamic slot: one clip from a folder, in turn (the usual hour build-up: ad, bumper, item, bumper). */
export const defaultRule = (): AutoRule => ({ source: "folder", categoryId: null, folder: "", subfolders: "all", count: 1, maxAgeDays: null, maxMinutes: null, pick: "rotate", order: "newest_first" });

/** One line for the rundown: "Newest 5 clips from News", "In turn from Bumpers". */
export function autoLabel(t: (k: string, o?: Record<string, unknown>) => string, info: Pick<AutoInfo, "autoRule" | "autoSourceName">) {
  return t(`mgmt.auto.labels.${info.autoRule.pick ?? "newest"}`, { count: info.autoRule.count, source: info.autoSourceName ?? "?" });
}
const PICKS = ["rotate", "random", "newest"] as const;

/**
 * What the dynamic parts of a block being edited play now, computed together so a clip is not shown twice
 * (two bumper slots get two different bumpers, as on air). Index i belongs to rules[i]; null = not a dynamic part.
 */
export function useAutoPreviews(rules: (AutoRule | null | undefined)[]) {
  const key = JSON.stringify(rules.map((r) => r ?? null));
  const [previews, setPreviews] = useState<(AutoInfo | null)[] | null>(null);
  useEffect(() => {
    if (!rules.some(Boolean)) return setPreviews(null);
    let gone = false;
    void post<{ previews: (AutoInfo | null)[] }>("/api/blocks/auto-previews", { rules: JSON.parse(key) }).then(
      (r) => !gone && setPreviews(r.previews),
      () => undefined,
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return previews;
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Math.max(1, Math.round(Number(v))) || null);

/** Dialog where an editor sets up "newest clips": where they come from, how many, how old. Shows what would play now. */
export function AutoClipsDialog({ open, rule, onClose, onSave }: { open: boolean; rule: AutoRule | null; onClose: () => void; onSave: (info: AutoInfo) => void }) {
  const { t } = useTranslation();
  const { categories } = useCategories();
  const folders = useGet<{ folders: string[] }>(open ? "/api/media?limit=1" : null);
  const [r, setR] = useState<AutoRule>(rule ?? defaultRule());
  // Every folder plus the folders above it ("Programma/2026 Reportages" holds no clips itself but its week folders do).
  const allFolders = useMemo(() => {
    const set = new Set<string>();
    for (const f of folders.data?.folders ?? []) {
      const parts = f.split("/");
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    if (r.folder) set.add(r.folder);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  }, [folders.data, r.folder]);
  const hasSub = allFolders.some((f) => f.startsWith(`${r.folder}/`));
  const [preview, setPreview] = useState<AutoInfo | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewError, setPreviewError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (open) setR(rule ?? defaultRule());
  }, [open, rule]);
  const ready = r.source === "category" ? r.categoryId != null : r.folder !== "";
  useEffect(() => {
    setPreview(null);
    if (!open || !ready) return setPreviewState("idle");
    setPreviewState("loading");
    let gone = false;
    const h = setTimeout(
      () =>
        void post<AutoInfo>("/api/blocks/auto-preview", { autoRule: r }).then(
          (p) => {
            if (gone) return;
            setPreview(p);
            setPreviewState("idle");
          },
          (e: unknown) => {
            if (gone) return;
            setPreviewError(e instanceof ApiError ? `${e.status} ${e.code || e.message}` : String((e as Error)?.message ?? e));
            setPreviewState("error");
          },
        ),
      200,
    );
    return () => {
      gone = true;
      clearTimeout(h);
    };
  }, [open, ready, r, retry]);
  // Saving never waits for the preview: it only shows what would play now; the server checks the rule itself.
  const save = () => {
    const sourceName = r.source === "category" ? (categories?.find((c) => c.id === r.categoryId)?.name ?? null) : r.folder;
    onSave(preview ?? { autoRule: r, autoSourceName: sourceName, autoFolders: null, autoClips: [], effectiveDurationMs: 0 });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand" />
          {t("mgmt.auto.title")}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!ready} onClick={save}>
            {t(rule ? "common.save" : "mgmt.auto.add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        <div className="space-y-5">
          <p className="text-sm text-muted">{t("mgmt.auto.intro")}</p>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t("mgmt.auto.from")}</p>
            <div className="grid grid-cols-2 gap-2">
              {(["category", "folder"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setR({ ...r, source: s })}
                  className={cx("flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition", r.source === s ? "border-brand bg-brand/8 font-medium text-brand" : "border-line hover:bg-surface-2")}
                >
                  {s === "category" ? <Tags className="size-4" /> : <FolderOpen className="size-4" />}
                  {t(`mgmt.auto.source.${s}`)}
                </button>
              ))}
            </div>
          </div>
          {r.source === "category" ? (
            <Field label={t("mgmt.categoriesPage.one")}>
              {(id) => (
                <Select id={id} value={r.categoryId ?? ""} onChange={(e) => setR({ ...r, categoryId: Number(e.target.value) || null })}>
                  <option value="">{t("mgmt.auto.chooseCategory")}</option>
                  {categories?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <>
              <Field label={t("mgmt.auto.folder")} hint={hasSub ? undefined : t("mgmt.auto.folderHint")}>
                {(id) => (
                  <Select id={id} value={r.folder} onChange={(e) => setR({ ...r, folder: e.target.value })}>
                    <option value="">{t("mgmt.auto.chooseFolder")}</option>
                    {allFolders.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {r.folder !== "" && (hasSub || r.subfolders === "newest") && (
                <div>
                  <p className="mb-1.5 text-[13px] font-medium">{t("mgmt.auto.subfolders.label")}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["all", "newest"] as const).map((k) => {
                      const Icon = k === "all" ? FolderTree : CalendarClock;
                      return (
                        <button
                          key={k}
                          onClick={() => setR({ ...r, subfolders: k })}
                          className={cx("rounded-md border px-3 py-2.5 text-left transition", r.subfolders === k ? "border-brand bg-brand/8" : "border-line hover:bg-surface-2")}
                        >
                          <span className={cx("flex items-center gap-2 text-sm", r.subfolders === k && "font-medium text-brand")}>
                            <Icon className="size-4" />
                            {t(`mgmt.auto.subfolders.${k}`)}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">{t(`mgmt.auto.subfolders.${k}Hint`)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t("mgmt.auto.how")}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {PICKS.map((k) => {
                const Icon = k === "rotate" ? Repeat : k === "random" ? Dices : TrendingUp;
                return (
                  <button
                    key={k}
                    onClick={() => setR({ ...r, pick: k })}
                    className={cx("rounded-md border px-3 py-2.5 text-left transition", r.pick === k ? "border-brand bg-brand/8" : "border-line hover:bg-surface-2")}
                  >
                    <span className={cx("flex items-center gap-2 text-sm", r.pick === k && "font-medium text-brand")}>
                      <Icon className="size-4" />
                      {t(`mgmt.auto.picks.${k}`)}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{t(`mgmt.auto.pickHints.${k}`)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("mgmt.auto.count")} hint={t(r.pick === "newest" ? "mgmt.auto.countHint" : "mgmt.auto.countHintSlot")}>
              {(id) => <Input id={id} type="number" min={1} max={50} value={r.count} onChange={(e) => setR({ ...r, count: Math.min(50, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} />}
            </Field>
            <Field label={t("mgmt.auto.maxAge")} hint={t("mgmt.auto.optional")}>
              {(id) => <Input id={id} type="number" min={1} max={365} placeholder="—" value={r.maxAgeDays ?? ""} onChange={(e) => setR({ ...r, maxAgeDays: numOrNull(e.target.value) })} />}
            </Field>
            <Field label={t("mgmt.auto.maxMinutes")} hint={t("mgmt.auto.optional")}>
              {(id) => <Input id={id} type="number" min={1} max={240} placeholder="—" value={r.maxMinutes ?? ""} onChange={(e) => setR({ ...r, maxMinutes: numOrNull(e.target.value) })} />}
            </Field>
          </div>
          {r.pick === "newest" && (
          <Field label={t("mgmt.auto.order")}>
            {(id) => (
              <Select id={id} value={r.order} onChange={(e) => setR({ ...r, order: e.target.value as AutoRule["order"] })}>
                <option value="newest_first">{t("mgmt.auto.orders.newest_first")}</option>
                <option value="oldest_first">{t("mgmt.auto.orders.oldest_first")}</option>
              </Select>
            )}
          </Field>
          )}
        </div>
        <div className="rounded-lg border border-line bg-surface-2/50 p-4">
          <p className="text-[13px] font-semibold">{t("mgmt.auto.nowPlays")}</p>
          <p className="mb-3 text-xs text-muted">{t("mgmt.auto.nowPlaysHint")}</p>
          {ready && r.source === "folder" && r.subfolders === "newest" && preview && (
            <p className="mb-3 flex items-start gap-1.5 rounded-md bg-brand/8 px-2.5 py-2 text-xs text-brand">
              <CalendarClock className="mt-px size-3.5 shrink-0" />
              <span>
                {preview.autoFolders?.length
                  ? t("mgmt.auto.subfolders.now", { folder: preview.autoFolders.map((f) => f.slice(r.folder.length + 1)).join(", ") })
                  : t("mgmt.auto.subfolders.none")}
              </span>
            </p>
          )}
          {!ready ? (
            <p className="text-sm text-muted">{t("mgmt.auto.pickSource")}</p>
          ) : previewState === "error" ? (
            <Alert tone="warn">
              <p>{t("mgmt.auto.previewFailed")}</p>
              <p className="mt-1 font-mono text-xs opacity-80">{previewError}</p>
              <button className="mt-2 text-xs font-medium underline" onClick={() => setRetry((n) => n + 1)}>
                {t("mgmt.auto.retry")}
              </button>
            </Alert>
          ) : !preview ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" />
              {t("mgmt.auto.loading")}
            </p>
          ) : preview.autoClips.length === 0 ? (
            <Alert tone="warn">{t("mgmt.auto.noneYet")}</Alert>
          ) : (
            <>
              <ol className="space-y-1.5 text-sm">
                {preview.autoClips.map((c, i) => (
                  <li key={c.id} className="flex items-baseline gap-2">
                    <span className="w-4 shrink-0 text-right font-mono text-xs text-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="font-mono text-xs text-muted">{fmtDuration(c.durationMs)}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 border-t border-line pt-2 text-right text-xs text-muted">
                {t("mgmt.blocks.total")}: <span className="font-mono">{fmtDuration(preview.effectiveDurationMs)}</span>
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
