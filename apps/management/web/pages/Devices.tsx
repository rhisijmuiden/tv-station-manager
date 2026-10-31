import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, del, post, put } from "@tvsm/ui";
import { MonitorPlay, Pencil, Plus, Radio, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Dot } from "./Dashboard";
import { errorText, useGet, type AtemStatus, type LiveSource } from "../lib";

interface Atem {
  id: number;
  name: string;
  host: string;
  enabled: boolean;
  status: AtemStatus;
}
interface Studio {
  id: number;
  name: string;
  host: string;
  port: number;
  publicHost: string | null;
  ingestApiPort: number;
  enabled: boolean;
  status: { connected: boolean; version: string | null };
  ingest: { reachable: boolean; error: string | null };
}
type Kind = "atem" | "studio" | "live";
type Form = Record<string, string | number | boolean | null | undefined> & { id?: number };

export function DevicesPage() {
  const { t } = useTranslation();
  const atems = useGet<{ atems: Atem[] }>("/api/atems", 3000);
  const studios = useGet<{ studios: Studio[] }>("/api/studios", 3000);
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources");
  const [edit, setEdit] = useState<{ kind: Kind; form: Form } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const url = { atem: "/api/atems", studio: "/api/studios", live: "/api/live-sources" };
  const reloadAll = () => {
    void atems.reload();
    void studios.reload();
    void live.reload();
  };
  const save = async () => {
    if (!edit) return;
    setErr(null);
    const { id, ...f } = edit.form;
    const body =
      edit.kind === "atem"
        ? { name: f.name, host: f.host, enabled: f.enabled ?? true }
        : edit.kind === "studio"
          ? { name: f.name, host: f.host, port: Number(f.port) || 5250, publicHost: f.publicHost || null, ingestApiPort: Number(f.ingestApiPort) || 9997, enabled: f.enabled ?? true }
          : { name: f.name, kind: "atem", atemInput: Number(f.atemInput) || 0 };
    try {
      if (id) await put(`${url[edit.kind]}/${id}`, body);
      else await post(url[edit.kind], body);
      setEdit(null);
      reloadAll();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async (kind: Kind, id: number, name: string) => {
    if (!confirm(t("mgmt.devices.confirmDelete", { name }))) return;
    await del(`${url[kind]}/${id}`);
    reloadAll();
  };
  const f = edit?.form ?? {};
  const set = (k: string, v: unknown) => edit && setEdit({ ...edit, form: { ...edit.form, [k]: v as string } });
  const actions = (kind: Kind, form: Form, name: string) => (
    <td className="px-5 py-3 text-right whitespace-nowrap">
      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit({ kind, form })} />
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(kind, form.id!, name)} />
    </td>
  );

  return (
    <>
      <PageHeader title={t("mgmt.devices.title")} description={t("mgmt.devices.intro")} />
      <div className="space-y-6">
        <Card>
          <CardHeader
            icon={<SlidersHorizontal className="size-4" />}
            title={t("mgmt.devices.atems")}
            description={t("mgmt.devices.atemsIntro")}
            actions={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ kind: "atem", form: { enabled: true } })}>
                {t("mgmt.devices.addAtem")}
              </Button>
            }
          />
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {atems.data?.atems.map((a) => (
                <tr key={a.id}>
                  <td className="w-8 py-3 pl-5">
                    <Dot on={a.status.connected} />
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-medium">{a.name}</p>
                    <p className="font-mono text-xs text-muted">{a.host}</p>
                  </td>
                  <td className="px-3 py-3 text-muted">
                    {a.status.connected ? (
                      <>
                        <p className="text-fg">{a.status.productName ?? a.status.model}</p>
                        <p className="text-xs">{t("mgmt.devices.atemCaps", { inputs: a.status.inputs.filter((i) => i.external).length, me: a.status.mixEffects })}</p>
                      </>
                    ) : !a.enabled ? (
                      t("common.disabled")
                    ) : (
                      t("mgmt.devices.connecting")
                    )}
                  </td>
                  {actions("atem", { id: a.id, name: a.name, host: a.host, enabled: a.enabled }, a.name)}
                </tr>
              ))}
              {atems.data && !atems.data.atems.length && (
                <tr>
                  <td className="px-5 py-6 text-center text-muted">{t("mgmt.devices.noAtems")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader
            icon={<MonitorPlay className="size-4" />}
            title={t("mgmt.devices.studios")}
            description={t("mgmt.devices.studiosIntro")}
            actions={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ kind: "studio", form: { port: 5250, ingestApiPort: 9997, enabled: true } })}>
                {t("mgmt.devices.addStudio")}
              </Button>
            }
          />
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {studios.data?.studios.map((s) => (
                <tr key={s.id}>
                  <td className="w-8 py-3 pl-5">
                    <Dot on={s.status.connected} />
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-medium">{s.name}</p>
                    <p className="font-mono text-xs text-muted">
                      {s.host}:{s.port}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-muted">
                    <p>{s.status.connected ? `CasparCG ${s.status.version ?? ""}` : s.enabled ? t("mgmt.devices.connecting") : t("common.disabled")}</p>
                    {s.enabled && <p className={s.ingest.reachable ? "text-xs" : "text-xs text-warn"}>{s.ingest.reachable ? t("mgmt.devices.ingestOk") : t("mgmt.devices.ingestDown")}</p>}
                  </td>
                  {actions("studio", { id: s.id, name: s.name, host: s.host, port: s.port, publicHost: s.publicHost, ingestApiPort: s.ingestApiPort, enabled: s.enabled }, s.name)}
                </tr>
              ))}
              {studios.data && !studios.data.studios.length && (
                <tr>
                  <td className="px-5 py-6 text-center text-muted">{t("mgmt.devices.noStudios")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader
            icon={<Radio className="size-4" />}
            title={t("mgmt.devices.live")}
            description={
              <>
                {t("mgmt.devices.liveIntro")}{" "}
                <Link to="/remote" className="font-medium text-brand">
                  {t("mgmt.devices.remoteLink")} →
                </Link>
              </>
            }
            actions={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ kind: "live", form: {} })}>
                {t("mgmt.devices.addLive")}
              </Button>
            }
          />
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {live.data?.sources.filter((l) => l.kind === "atem").map((l) => (
                <tr key={l.id}>
                  <td className="px-5 py-3">
                    <p className="font-medium">{l.name}</p>
                    {l.url && <p className="truncate font-mono text-xs text-muted">{l.url}</p>}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone="neutral">ATEM</Badge>
                  </td>
                  <td className="px-3 py-3 text-muted">ATEM input {l.atemInput}</td>
                  {actions("live", { id: l.id, name: l.name, atemInput: l.atemInput }, l.name)}
                </tr>
              ))}
              {live.data && !live.data.sources.some((l) => l.kind === "atem") && (
                <tr>
                  <td className="px-5 py-6 text-center text-muted">{t("mgmt.devices.noLive")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? t(`mgmt.devices.${edit.form.id ? "edit" : "add"}_${edit.kind}`) : ""}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={!f.name}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("common.name")}>{(id) => <Input id={id} value={String(f.name ?? "")} onChange={(e) => set("name", e.target.value)} />}</Field>
            {edit.kind !== "live" && (
              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <Field label={t("mgmt.devices.host")} hint={edit.kind === "atem" ? t("mgmt.devices.atemHostHint") : t("mgmt.devices.studioHostHint")}>
                  {(id) => <Input id={id} value={String(f.host ?? "")} placeholder="10.40.6.50" onChange={(e) => set("host", e.target.value)} />}
                </Field>
                {edit.kind === "studio" && <Field label={t("mgmt.devices.port")}>{(id) => <Input id={id} type="number" value={String(f.port ?? 5250)} onChange={(e) => set("port", e.target.value)} />}</Field>}
              </div>
            )}
            {edit.kind === "live" && (
              <Field label={t("mgmt.devices.atemInput")} hint={t("mgmt.devices.atemInputHint")}>{(id) => <Input id={id} type="number" min={0} value={String(f.atemInput ?? "")} onChange={(e) => set("atemInput", e.target.value)} />}</Field>
            )}
            {edit.kind === "studio" && (
              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <Field label={t("mgmt.devices.publicHost")} hint={t("mgmt.devices.publicHostHint")}>
                  {(id) => <Input id={id} value={String(f.publicHost ?? "")} placeholder="stream.example.org" onChange={(e) => set("publicHost", e.target.value)} />}
                </Field>
                <Field label={t("mgmt.devices.ingestApiPort")}>{(id) => <Input id={id} type="number" value={String(f.ingestApiPort ?? 9997)} onChange={(e) => set("ingestApiPort", e.target.value)} />}</Field>
              </div>
            )}
            {edit.kind !== "live" && <Switch checked={f.enabled !== false} onChange={(v) => set("enabled", v)} label={t("common.enabled")} />}
          </div>
        )}
      </Dialog>
    </>
  );
}
