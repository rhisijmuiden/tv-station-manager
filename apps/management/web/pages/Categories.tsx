import { Alert, Button, Card, Dialog, Field, Input, PageHeader, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { errorText, fmtDuration, useCategories, type ContentCategory } from "../lib";

export const CATEGORY_COLORS = ["#1DB97A", "#3B6CFF", "#FF3D57", "#F5A524", "#8B5CF6", "#06B6D4", "#EC4899", "#64748B", "#84CC16", "#F97316"];

export function ColorPicker({ value, onChange, colors = CATEGORY_COLORS }: { value: string; onChange: (c: string) => void; colors?: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} className={cx("size-6 rounded-full ring-offset-2 ring-offset-surface transition", value === c && "ring-2 ring-fg")} style={{ background: c }} aria-label={c} />
      ))}
    </div>
  );
}

export function CategoriesPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { categories, reload } = useCategories();
  const [form, setForm] = useState<Partial<ContentCategory> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form?.name) return;
    setErr(null);
    try {
      const body = { name: form.name, color: form.color ?? CATEGORY_COLORS[0] };
      if (form.id) await put(`/api/categories/${form.id}`, body);
      else await post("/api/categories", body);
      setForm(null);
      void reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async (c: ContentCategory) => {
    if (!confirm(t("mgmt.categoriesPage.confirmDelete", { name: c.name }))) return;
    await del(`/api/categories/${c.id}`);
    void reload();
  };

  return (
    <>
      <PageHeader
        title={t("mgmt.categoriesPage.title")}
        description={t("mgmt.categoriesPage.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setForm({ color: CATEGORY_COLORS[(categories?.length ?? 0) % CATEGORY_COLORS.length] })}>
              {t("mgmt.categoriesPage.new")}
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {categories?.map((c) => (
          <Card key={c.id}>
            <div className="flex items-start gap-4 p-5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl text-white shadow-sm" style={{ background: c.color }}>
                <Tags className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{c.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  <Link to={`/media?categoryId=${c.id}`} className="hover:text-brand hover:underline">
                    {t("mgmt.categoriesPage.media", { n: c.mediaCount, d: fmtDuration(c.mediaMs) })}
                  </Link>
                </p>
                <p className="text-xs text-muted">{t("mgmt.categoriesPage.usage", { blocks: c.blockCount, slots: c.slotCount })}</p>
              </div>
              {canEdit && (
                <span className="flex shrink-0">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setForm(c)} title={t("common.edit")} />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(c)} title={t("common.delete")} />
                </span>
              )}
            </div>
          </Card>
        ))}
        {categories && !categories.length && (
          <Card className="sm:col-span-2 xl:col-span-3">
            <div className="px-5 py-12 text-center">
              <Tags className="mx-auto mb-3 size-8 text-muted" />
              <p className="font-medium">{t("mgmt.categoriesPage.none")}</p>
              <p className="text-sm text-muted">{t("mgmt.categoriesPage.noneIntro")}</p>
            </div>
          </Card>
        )}
      </div>
      {categories && categories.length > 0 && <p className="mt-4 text-sm text-muted">{t("mgmt.categoriesPage.tip")}</p>}

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t("mgmt.categoriesPage.edit") : t("mgmt.categoriesPage.new")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!form?.name} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("common.name")}>{(id) => <Input id={id} autoFocus value={form.name ?? ""} placeholder={t("mgmt.categoriesPage.placeholder")} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.blocks.color")}</p>
              <ColorPicker value={form.color ?? ""} onChange={(color) => setForm({ ...form, color })} />
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
