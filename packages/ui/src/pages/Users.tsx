import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, del, get, post, put } from "../api";
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select } from "../components/ui";
import { useSession } from "../session";

interface User {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: string;
  language: string;
}
const ROLES = ["admin", "editor", "operator"] as const;
const tone = (r: string) => (r === "admin" ? "danger" : r === "editor" ? "brand" : "neutral") as "danger" | "brand" | "neutral";

export function UsersPage() {
  const { t } = useTranslation();
  const { user: me } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [edit, setEdit] = useState<(Partial<User> & { password?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void get<{ users: User[] }>("/api/users").then((r) => setUsers(r.users)), []);
  useEffect(load, [load]);

  const save = async () => {
    if (!edit) return;
    setError(null);
    try {
      const body = { displayName: edit.displayName || null, email: edit.email || null, role: edit.role ?? "editor", language: edit.language ?? "en", password: edit.password ?? "" };
      if (edit.id) await put(`/api/users/${edit.id}`, body);
      else await post("/api/users", { ...body, username: edit.username });
      setEdit(null);
      load();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      setError(t(`users.errors.${code}`, { defaultValue: t("users.errors.generic") }));
    }
  };
  const remove = async (u: User) => {
    if (!confirm(t("users.confirmDelete", { name: u.username }))) return;
    try {
      await del(`/api/users/${u.id}`);
      load();
    } catch (e) {
      alert(t(`users.errors.${e instanceof ApiError ? e.code : "generic"}`, { defaultValue: t("users.errors.generic") }));
    }
  };

  return (
    <>
      <PageHeader
        title={t("users.title")}
        description={t("users.intro")}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEdit({ role: "editor", language: "nl" })}>
            {t("users.add")}
          </Button>
        }
      />
      <Card>
        <CardHeader icon={<Users className="size-4" />} title={t("users.list")} description={t("users.rolesHelp")} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">{t("auth.username")}</th>
                <th className="px-5 py-2.5 font-medium">{t("account.displayName")}</th>
                <th className="px-5 py-2.5 font-medium">{t("users.role")}</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-5 py-3 font-medium">{u.username}</td>
                  <td className="px-5 py-3 text-muted">{u.displayName ?? "–"}</td>
                  <td className="px-5 py-3">
                    <Badge tone={tone(u.role)}>{t(`users.roles.${u.role}`, { defaultValue: u.role })}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit({ ...u })}>
                      {t("common.edit")}
                    </Button>
                    {u.id !== me?.id && (
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(u)}>
                        {t("common.delete")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? t("users.edit") : t("users.add")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()}>{t("common.save")}</Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label={t("auth.username")}>{(id) => <Input id={id} value={edit.username ?? ""} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, username: e.target.value })} />}</Field>
            <Field label={t("account.displayName")}>{(id) => <Input id={id} value={edit.displayName ?? ""} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} />}</Field>
            <Field label={t("auth.email")}>{(id) => <Input id={id} type="email" value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("users.role")} hint={t(`users.roleHelp.${edit.role ?? "editor"}`)}>
                {(id) => (
                  <Select id={id} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`users.roles.${r}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t("account.language")}>
                {(id) => (
                  <Select id={id} value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>
                    <option value="en">English</option>
                    <option value="nl">Nederlands</option>
                  </Select>
                )}
              </Field>
            </div>
            <Field label={edit.id ? t("users.newPassword") : t("auth.password")} hint={t("auth.passwordHint")}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={edit.password ?? ""} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />}
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
