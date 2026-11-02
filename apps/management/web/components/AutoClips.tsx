import { Alert, Button, Dialog, Field, Input, Select, cx, post } from "@tvsm/ui";
import { Dices, FolderOpen, Repeat, Sparkles, Tags, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtDuration, useCategories, useGet } from "../lib";

/** "Newest clips" rule of a block item (mirrors `server/autofill.ts`). */
export interface AutoRule {
  source: "category" | "folder";
  categoryId: number | null;
  folder: string;
  count: number;
  maxAgeDays: number | null;
  maxMinutes: number | null;
  pick: "newest" | "rotate" | "random";
  order: "newest_first" | "oldest_first";
}
export interface AutoInfo {
  autoRule: AutoRule;
  autoSourceName: string | null;
  autoClips: { id: number; name: string; durationMs: number }[];
  effectiveDurationMs: number;
}
/** A new dynamic slot: one clip from a folder, in turn (the usual hour build-up: ad, bumper, item, bumper). */
export const defaultRule = (): AutoRule => ({ source: "folder", categoryId: null, folder: "", count: 1, maxAgeDays: null, maxMinutes: null, pick: "rotate", order: "newest_first" });

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
  const [preview, setPreview] = useState<AutoInfo | null>(null);
  useEffect(() => {
    if (open) setR(rule ?? defaultRule());
  }, [open, rule]);
  const ready = r.source === "category" ? r.categoryId != null : r.folder !== "";
  useEffect(() => {
    if (!open || !ready) return setPreview(null);
    const h = setTimeout(() => void post<AutoInfo>("/api/blocks/auto-preview", { autoRule: r }).then(setPreview, () => setPreview(null)), 200);
    return () => clearTimeout(h);
  }, [open, ready, r]);

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
          <Button disabled={!ready || !preview} onClick={() => preview && onSave(preview)}>
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
            <Field label={t("mgmt.auto.folder")} hint={t("mgmt.auto.folderHint")}>
              {(id) => (
                <Select id={id} value={r.folder} onChange={(e) => setR({ ...r, folder: e.target.value })}>
                  <option value="">{t("mgmt.auto.chooseFolder")}</option>
                  {folders.data?.folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
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
          {!ready ? (
            <p className="text-sm text-muted">{t("mgmt.auto.pickSource")}</p>
          ) : !preview ? null : preview.autoClips.length === 0 ? (
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
