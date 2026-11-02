import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Select, Switch, del, post, put } from "@tvsm/ui";
import { Hash, Lock, MonitorPlay, Network, Pencil, Plus, Radio, SlidersHorizontal, Square, Trash2 } from "lucide-react";
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
  lock: { by: string | null; reason: string } | null;
}
interface OrchLink {
  enabled: boolean;
  url: string;
  hasToken: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  locks: { host: string; name: string; by: string | null; reason: string }[];
  known: { host: string; name: string }[];
}

/** Link to the orchestrator: it tells which ATEMs are locked for manual control there. */
function OrchestratorLinkCard({ atems }: { atems: Atem[] }) {
  const { t } = useTranslation();
  const link = useGet<OrchLink>("/api/orchestrator-link", 5000);
  const [f, setF] = useState<{ enabled: boolean; url: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = link.data;
  if (!d) return null;
  const form = f ?? { enabled: d.enabled, url: d.url, token: "" };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await put("/api/orchestrator-link", { enabled: form.enabled, url: form.url, token: form.token || undefined });
      setF(null);
      await link.reload();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const unmatched = d.enabled && d.lastOkAt ? atems.filter((a) => !d.known.some((k) => k.host === a.host.trim().toLowerCase())) : [];
  return (
    <Card>
      <CardHeader
        icon={<Network className="size-4" />}
        title={t("mgmt.devices.orchestrator")}
        description={t("mgmt.devices.orchestratorIntro")}
        actions={
          d.enabled &&
          (d.lastError ? (
            <Badge tone="danger">{t("mgmt.devices.orchUnreachable")}</Badge>
          ) : d.lastOkAt ? (
            <Badge tone="ok">{t("mgmt.devices.orchConnected")}</Badge>
          ) : (
            <Badge>{t("mgmt.devices.connecting")}</Badge>
          ))
        }
      />
      <div className="space-y-4 px-5 pb-5">
        {err && <Alert tone="danger">{err}</Alert>}
        {d.enabled && d.lastError && (
          <Alert tone="warn">
            {d.lastError}
            {d.locks.length > 0 && <span className="block text-xs">{t("mgmt.devices.orchKeepLocks")}</span>}
          </Alert>
        )}
        <Switch checked={form.enabled} onChange={(enabled) => setF({ ...form, enabled })} label={t("mgmt.devices.orchEnabled")} description={t("mgmt.devices.orchEnabledHint")} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("mgmt.devices.orchUrl")}>{(id) => <Input id={id} className="font-mono" placeholder="http://10.40.6.201:8080" value={form.url} onChange={(e) => setF({ ...form, url: e.target.value })} />}</Field>
          <Field label={t("mgmt.devices.orchToken")} hint={d.hasToken ? t("mgmt.devices.orchTokenKept") : t("mgmt.devices.orchTokenHint")}>
            {(id) => <Input id={id} type="password" autoComplete="off" className="font-mono" placeholder={d.hasToken ? "••••••••" : ""} value={form.token} onChange={(e) => setF({ ...form, token: e.target.value })} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={busy} onClick={() => void save()} disabled={!f}>
            {t("common.save")}
          </Button>
          {d.lastOkAt && <span className="text-xs text-muted">{t("mgmt.devices.orchLastOk", { at: new Date(d.lastOkAt).toLocaleTimeString() })}</span>}
        </div>
        {d.locks.length > 0 && (
          <div className="space-y-1.5">
            {d.locks.map((l) => (
              <p key={l.host} className="flex items-center gap-2 text-sm">
                <Badge tone="warn">
                  <Lock className="size-3" /> {t("mgmt.devices.locked")}
                </Badge>
                <span className="font-medium">{l.name}</span> <span className="font-mono text-xs text-muted">{l.host}</span>
                <span className="text-xs text-muted">
                  {t("mgmt.devices.lockedBy", { by: l.by ?? "?" })}
                  {l.reason ? ` · ${l.reason}` : ""}
                </span>
              </p>
            ))}
          </div>
        )}
        {unmatched.length > 0 && <Alert tone="warn">{t("mgmt.devices.orchUnmatched", { names: unmatched.map((a) => `${a.name} (${a.host})`).join(", ") })}</Alert>}
      </div>
    </Card>
  );
}
interface Studio {
  id: number;
  name: string;
  host: string;
  port: number;
  publicHost: string | null;
  ingestApiPort: number;
  role: StudioRole;
  enabled: boolean;
  status: { connected: boolean; version: string | null; channels?: number[] | null };
  ingest: { reachable: boolean; error: string | null };
  identifyUntil: string | null;
}
type Kind = "atem" | "studio" | "live";
type StudioRole = "playout" | "live" | "both";
const STUDIO_ROLES: StudioRole[] = ["playout", "live", "both"];
type Form = Record<string, string | number | boolean | null | undefined> & { id?: number };

export function DevicesPage() {
  const { t } = useTranslation();
  const atems = useGet<{ atems: Atem[] }>("/api/atems", 3000);
  const studios = useGet<{ studios: Studio[] }>("/api/studios", 3000);
  const live = useGet<{ sources: LiveSource[] }>("/api/live-sources");
  const [edit, setEdit] = useState<{ kind: Kind; form: Form } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [idErr, setIdErr] = useState<string | null>(null);
  const identify = async (s: Studio, on: boolean) => {
    setIdErr(null);
    if (on && !confirm(t("mgmt.devices.identifyConfirm", { name: s.name }))) return;
    try {
      await post(`/api/studios/${s.id}/identify`, { on });
      await studios.reload();
    } catch (e) {
      setIdErr(errorText(t, e));
    }
  };
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
          ? { name: f.name, host: f.host, port: Number(f.port) || 5250, publicHost: f.publicHost || null, ingestApiPort: Number(f.ingestApiPort) || 9997, role: f.role || "both", enabled: f.enabled ?? true }
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
                    <p className="flex items-center gap-2 font-medium">
                      {a.name}
                      {a.lock && (
                        <Badge tone="warn">
                          <Lock className="size-3" /> {t("mgmt.devices.locked")}
                        </Badge>
                      )}
                    </p>
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

        <OrchestratorLinkCard atems={atems.data?.atems ?? []} />

        <Card>
          <CardHeader
            icon={<MonitorPlay className="size-4" />}
            title={t("mgmt.devices.studios")}
            description={t("mgmt.devices.studiosIntro")}
            actions={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit({ kind: "studio", form: { port: 5250, ingestApiPort: 9997, role: studios.data?.studios.some((x) => x.role !== "live") ? "live" : "playout", enabled: true } })}>
                {t("mgmt.devices.addStudio")}
              </Button>
            }
          />
          <div className="space-y-2 border-b border-line px-5 py-3 text-[13px] text-muted">
            {idErr && <Alert tone="danger">{idErr}</Alert>}
            <details>
              <summary className="cursor-pointer font-medium text-brand">{t("mgmt.devices.numberingTitle")}</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(t("mgmt.devices.numbering", { returnObjects: true }) as string[]).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {studios.data?.studios.map((s) => (
                <tr key={s.id}>
                  <td className="w-8 py-3 pl-5">
                    <Dot on={s.status.connected} />
                  </td>
                  <td className="px-3 py-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {s.name}
                      <Badge tone={s.role === "live" ? "danger" : s.role === "playout" ? "brand" : "neutral"}>{t(`mgmt.devices.role_${s.role}`)}</Badge>
                    </p>
                    <p className="font-mono text-xs text-muted">
                      {s.host}:{s.port}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-muted">
                    <p>{s.status.connected ? `CasparCG ${s.status.version ?? ""}` : s.enabled ? t("mgmt.devices.connecting") : t("common.disabled")}</p>
                    {s.enabled && <p className={s.ingest.reachable ? "text-xs" : "text-xs text-warn"}>{s.ingest.reachable ? t("mgmt.devices.ingestOk") : t("mgmt.devices.ingestDown")}</p>}
                    {s.status.channels?.length ? <p className="text-xs">{t("mgmt.devices.outputs", { count: s.status.channels.length })}</p> : null}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {s.identifyUntil ? (
                      <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={() => void identify(s, false)}>
                        {t("mgmt.devices.identifyStop")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={!s.status.connected} icon={<Hash className="size-3.5" />} title={t("mgmt.devices.identifyHint")} onClick={() => void identify(s, true)}>
                        {t("mgmt.devices.identify")}
                      </Button>
                    )}
                  </td>
                  {actions("studio", { id: s.id, name: s.name, host: s.host, port: s.port, publicHost: s.publicHost, ingestApiPort: s.ingestApiPort, role: s.role, enabled: s.enabled }, s.name)}
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
              <Field label={t("mgmt.devices.role")} hint={t(`mgmt.devices.roleHint_${(f.role as StudioRole) || "both"}`)}>
                {(id) => (
                  <Select id={id} value={String(f.role || "both")} onChange={(e) => set("role", e.target.value)}>
                    {STUDIO_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`mgmt.devices.role_${r}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
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
