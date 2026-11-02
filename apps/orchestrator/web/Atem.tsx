import { Alert, ApiError, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Mono, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowLeft, Cable, Copy, Gamepad2, KeyRound, Network, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AtemControl, type ControlState } from "./AtemControl";
import { AtemFrontPanel, type PanelSnapshot } from "./AtemPanel";
import type { PanelInput } from "./atemLayout";
import type { NodeInfo } from "./Nodes";

interface Snapshot extends PanelSnapshot {
  model: number;
  protocol: string | null;
  auxes: number;
  mediaPlayers: number;
  superSources: number;
  multiviewers: number;
  auxSources?: (number | null)[];
  inputs: (PanelInput & { namesDefault: boolean })[];
}
interface Switcher {
  id: string;
  name: string;
  host: string;
  location: string;
  notes: string;
  online: boolean;
  lastSeenAt: string | null;
  snapshot: Snapshot | null;
  inputs: { inputId: number; nodeId: string | null; note: string }[];
  control: ControlState;
}

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`orch.atem.err_${e.code}`, { defaultValue: e.message }) : String(e));
}

function Status({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={cx("relative size-2.5 rounded-full", on ? "bg-ok" : "bg-danger")}>{on && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40" />}</span>
      <span className={on ? "text-ok" : "text-danger"}>{on ? t("orch.nodes.online") : t("orch.nodes.offline")}</span>
    </span>
  );
}

function SwitcherDialog({ sw, onClose, onDone }: { sw?: Switcher; onClose: () => void; onDone: (s: Switcher) => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({ name: sw?.name ?? "", host: sw?.host ?? "", location: sw?.location ?? "", notes: sw?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(sw ? await put<Switcher>(`/api/atem/${sw.id}`, f) : await post<Switcher>("/api/atem", f));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={sw ? t("orch.atem.edit") : t("orch.atem.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={save} disabled={!f.name || !f.host}>
            {sw ? t("common.save") : t("orch.atem.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t("orch.atem.name")}>{(id) => <Input id={id} value={f.name} placeholder="ATEM Studio 1" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t("orch.atem.host")} hint={t("orch.atem.hostHint")}>
          {(id) => <Input id={id} className="font-mono" value={f.host} placeholder="10.40.6.240" onChange={(e) => setF({ ...f, host: e.target.value })} />}
        </Field>
        <Field label={`${t("orch.atem.location")} (${t("common.optional")})`}>
          {(id) => <Input id={id} value={f.location} placeholder={t("orch.atem.locationPlaceholder")} onChange={(e) => setF({ ...f, location: e.target.value })} />}
        </Field>
        <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>
          {(id) => <Textarea id={id} className="font-sans text-sm" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function InputDialog({ sw, input, nodes, onClose, onDone }: { sw: Switcher; input: PanelInput; nodes: NodeInfo[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const meta = sw.inputs.find((m) => m.inputId === input.id);
  const [f, setF] = useState({ longName: input.longName, shortName: input.shortName, nodeId: meta?.nodeId ?? "", note: meta?.note ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renamed = f.longName !== input.longName || f.shortName !== input.shortName;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/atem/${sw.id}/inputs/${input.id}`, { ...f, nodeId: f.nodeId || null });
      onDone();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("orch.atem.renameTitle", { n: input.kind === "external" ? input.id : input.shortName })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={save} disabled={!f.longName.trim() || !f.shortName.trim() || (renamed && !sw.online)}>
            {renamed ? t("orch.atem.writeToAtem") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!sw.online && <Alert tone="warn">{t("orch.atem.offlineRename")}</Alert>}
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label={t("orch.atem.longName")} hint={`${f.longName.length} / 20`}>
            {(id) => <Input id={id} maxLength={20} value={f.longName} onChange={(e) => setF({ ...f, longName: e.target.value })} />}
          </Field>
          <Field label={t("orch.atem.shortName")} hint={`${f.shortName.length} / 4`}>
            {(id) => <Input id={id} maxLength={4} className="font-mono uppercase" value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value.toUpperCase() })} />}
          </Field>
        </div>
        <p className="text-xs text-muted">{t("orch.atem.namesHint")}</p>
        <Field label={`${t("orch.atem.fedBy")} (${t("common.optional")})`} hint={t("orch.atem.fedByHint")}>
          {(id) => (
            <Select id={id} value={f.nodeId} onChange={(e) => setF({ ...f, nodeId: e.target.value })}>
              <option value="">{t("orch.atem.noNode")}</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} ({t(`orch.nodes.role_${n.role}`)})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`${t("orch.atem.note")} (${t("common.optional")})`}>
          {(id) => <Input id={id} maxLength={200} value={f.note} placeholder={t("orch.atem.notePlaceholder")} onChange={(e) => setF({ ...f, note: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function useApprovedNodes() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  useEffect(() => {
    void get<{ nodes: NodeInfo[] }>("/api/nodes").then((r) => setNodes(r.nodes.filter((n) => n.status === "approved")));
  }, []);
  return nodes;
}

function Detail({ id }: { id: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const editor = roleAtLeast(user?.role, "editor");
  const nodes = useApprovedNodes();
  const [d, setD] = useState<{ switcher: Switcher; events: { type: string; message: string; at: string }[] } | null>(null);
  const [picked, setPicked] = useState<PanelInput | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => get<typeof d>(`/api/atem/${id}`).then(setD), [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 3000);
    return () => clearInterval(i);
  }, [load]);
  if (!d) return null;
  const sw = d.switcher;
  const s = sw.snapshot;
  const nodeName = (nid: string | null) => nodes.find((n) => n.id === nid)?.name;
  const Row = ({ k, v }: { k: string; v: ReactNode }) => (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/atem" className="text-muted hover:text-fg" aria-label={t("orch.atem.back")}>
              <ArrowLeft className="size-5" />
            </Link>
            {sw.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-3">
            <Status on={sw.online} />
            <Mono>{sw.host}</Mono>
            {s && <Badge tone="brand">{s.productName ?? s.modelKey}</Badge>}
            {sw.location && <span>{sw.location}</span>}
          </span>
        }
        actions={
          admin && (
            <>
              <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                {t("orch.atem.edit")}
              </Button>
              <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                {t("orch.atem.remove")}
              </Button>
            </>
          )
        }
      />
      {!s ? (
        <Alert tone="warn">{t("orch.atem.neverSeen")}</Alert>
      ) : (
        <div className="space-y-6">
          {!sw.online && <Alert tone="warn">{t("orch.atem.offlineSnapshot")}</Alert>}
          <Card>
            <CardHeader title={t("orch.atem.frontPanel")} description={editor ? t("orch.atem.frontPanelHint") : t("orch.atem.frontPanelReadOnly")} icon={<SlidersHorizontal className="size-4" />} />
            <CardBody>
              <AtemFrontPanel s={s} onPick={editor ? setPicked : undefined} />
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-danger" /> {t("orch.atem.program")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-ok" /> {t("orch.atem.preview")}
                </span>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title={t("orch.control.title")}
              description={t("orch.control.intro")}
              icon={<Gamepad2 className="size-4" />}
              actions={
                <Link to="/diagram" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
                  <Network className="size-4" /> {t("orch.nav.diagram")}
                </Link>
              }
            />
            <CardBody>
              <AtemControl sw={sw} onChanged={() => void load()} />
            </CardBody>
          </Card>
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader title={t("orch.atem.inputs")} description={t("orch.atem.inputsIntro")} icon={<Cable className="size-4" />} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs whitespace-nowrap text-muted">
                      <th className="px-5 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">{t("orch.atem.port")}</th>
                      <th className="px-3 py-2 font-medium">{t("orch.atem.longName")}</th>
                      <th className="px-3 py-2 font-medium">{t("orch.atem.shortName")}</th>
                      <th className="px-3 py-2 font-medium">{t("orch.atem.fedBy")}</th>
                      <th className="px-5 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {s.inputs.map((i) => {
                      const m = sw.inputs.find((x) => x.inputId === i.id);
                      const me = (list: (number | null)[]) => {
                        const idx = list.indexOf(i.id);
                        return idx < 0 ? null : s.mixEffects > 1 ? ` ${idx + 1}` : "";
                      };
                      const onPgm = me(s.program);
                      const onPvw = onPgm == null ? me(s.preview) : null;
                      return (
                        <tr key={i.id} className="hover:bg-surface-2/50">
                          <td className="px-5 py-2.5">
                            <span className="flex items-center gap-2 whitespace-nowrap">
                              <Mono>{i.id}</Mono>
                              {onPgm != null && <Badge tone="danger">PGM{onPgm}</Badge>}
                              {onPvw != null && <Badge tone="ok">PVW{onPvw}</Badge>}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{i.port ?? t(`orch.atem.kind_${i.kind}`)}</td>
                          <td className="px-3 py-2.5">
                            {i.longName}
                            {i.namesDefault && <span className="ml-2 text-xs text-muted">({t("orch.atem.default")})</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            <Mono>{i.shortName}</Mono>
                          </td>
                          <td className="px-3 py-2.5">
                            {nodeName(m?.nodeId ?? null) ?? <span className="text-muted">–</span>}
                            {m?.note && <span className="block text-xs text-muted">{m.note}</span>}
                          </td>
                          <td className="px-5 py-2.5 text-right">
                            {editor && (
                              <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setPicked(i)}>
                                {t("orch.atem.rename")}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="space-y-6">
              <Card>
                <CardHeader title={t("orch.atem.device")} />
                <CardBody className="pt-1">
                  <dl className="divide-y divide-line">
                    <Row k={t("orch.atem.model")} v={s.productName ?? s.modelKey} />
                    <Row k={t("orch.atem.protocol")} v={<Mono>{s.protocol ?? "–"}</Mono>} />
                    <Row k={t("orch.atem.videoMode")} v={<Mono>{s.videoMode ?? "–"}</Mono>} />
                    <Row k={t("orch.atem.mixEffects")} v={s.mixEffects} />
                    <Row k={t("orch.atem.keyers")} v={`${s.keyers.join(" / ") || 0} + ${s.downstreamKeyers} DSK`} />
                    <Row k={t("orch.atem.auxes")} v={s.auxes} />
                    <Row k={t("orch.atem.mediaPlayers")} v={s.mediaPlayers} />
                    <Row k={t("orch.atem.superSources")} v={s.superSources} />
                    <Row k={t("orch.atem.multiviewers")} v={s.multiviewers} />
                    <Row k={t("orch.nodes.lastSeen")} v={sw.lastSeenAt ? new Date(sw.lastSeenAt).toLocaleString() : "–"} />
                  </dl>
                  {sw.notes && <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{sw.notes}</p>}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t("orch.nodes.events")} />
                <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
                  {d.events.map((e, i) => (
                    <li key={i} className="px-5 py-2.5">
                      <p>{e.message}</p>
                      <p className="text-xs text-muted">{new Date(e.at).toLocaleString()}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </div>
      )}
      {picked && (
        <InputDialog
          sw={sw}
          input={picked}
          nodes={nodes}
          onClose={() => setPicked(null)}
          onDone={() => {
            setPicked(null);
            // The switcher confirms the new name a moment later.
            setTimeout(() => void load(), 400);
          }}
        />
      )}
      {editing && (
        <SwitcherDialog
          sw={sw}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("orch.atem.removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await del(`/api/atem/${sw.id}`);
                nav("/atem");
              }}
            >
              {t("orch.atem.remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("orch.atem.removeText", { name: sw.name })}</p>
      </Dialog>
    </>
  );
}

/** The token management nodes use to read which ATEMs are locked (Devices → Orchestrator link on the management node). */
function AutomationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<{ token: string; path: string; lastPollAt: { at: string; ip: string } | null } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void get<typeof d>("/api/automation").then(setD);
  }, []);
  const url = window.location.origin;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("orch.automation.title")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      {d && (
        <div className="space-y-4 text-sm">
          <p>{t("orch.automation.intro")}</p>
          <Field label={t("orch.automation.url")}>{(id) => <Input id={id} readOnly className="font-mono" value={url} onFocus={(e) => e.target.select()} />}</Field>
          <Field label={t("orch.automation.token")}>
            {(id) => (
              <div className="flex gap-2">
                <Input id={id} readOnly className="font-mono" value={d.token} onFocus={(e) => e.target.select()} />
                <Button
                  variant="secondary"
                  icon={<Copy className="size-4" />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(d.token);
                    setCopied(true);
                  }}
                >
                  {copied ? t("orch.automation.copied") : t("orch.automation.copy")}
                </Button>
              </div>
            )}
          </Field>
          <p className="text-xs text-muted">
            {d.lastPollAt ? t("orch.automation.lastPoll", { at: new Date(d.lastPollAt.at).toLocaleString(), ip: d.lastPollAt.ip }) : t("orch.automation.neverPolled")}
          </p>
          {confirm ? (
            <Alert tone="warn">
              <p className="mb-2">{t("orch.automation.regenerateText")}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setConfirm(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    setD(await post<NonNullable<typeof d>>("/api/automation/token"));
                    setConfirm(false);
                    setCopied(false);
                  }}
                >
                  {t("orch.automation.regenerate")}
                </Button>
              </div>
            </Alert>
          ) : (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => setConfirm(true)}>
              {t("orch.automation.regenerate")}
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

function List() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useSession();
  const admin = roleAtLeast(user?.role, "admin");
  const [list, setList] = useState<Switcher[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [automation, setAutomation] = useState(false);
  const load = useCallback(() => get<{ switchers: Switcher[] }>("/api/atem").then((r) => setList(r.switchers)), []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 5000);
    return () => clearInterval(i);
  }, [load]);
  if (!list) return null;
  return (
    <>
      <PageHeader
        title={t("orch.atem.title")}
        description={t("orch.atem.intro")}
        actions={
          admin && (
            <>
              <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setAutomation(true)}>
                {t("orch.automation.button")}
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                {t("orch.atem.add")}
              </Button>
            </>
          )
        }
      />
      {list.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <SlidersHorizontal className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("orch.atem.empty")}</p>
            <p className="mt-1 text-sm text-muted">{t("orch.atem.emptyHint")}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((sw) => {
            const s = sw.snapshot;
            const ext = s?.inputs.filter((i) => i.kind === "external").length ?? 0;
            const pgm = s?.inputs.find((i) => i.id === s.program[0]);
            return (
              <button key={sw.id} type="button" onClick={() => nav(`/atem/${sw.id}`)} className="text-left">
                <Card className="h-full transition hover:-translate-y-0.5 hover:shadow-lg">
                  <CardBody>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{sw.name}</p>
                        <p className="truncate text-sm text-muted">{s?.productName ?? s?.modelKey ?? t("orch.atem.unknownModel")}</p>
                      </div>
                      <Status on={sw.online} />
                    </div>
                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted">{t("orch.atem.host")}</dt>
                        <dd>
                          <Mono>{sw.host}</Mono>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.atem.inputs")}</dt>
                        <dd>{s ? ext : "–"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.atem.videoMode")}</dt>
                        <dd>
                          <Mono>{s?.videoMode ?? "–"}</Mono>
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                      {pgm && (
                        <>
                          <Badge tone="danger">PGM</Badge> {pgm.longName}
                        </>
                      )}
                      <span className="ml-auto">
                        {sw.control.mode === "locked" ? <Badge tone="warn">{t("orch.control.locked")}</Badge> : <Badge tone="brand">{t("orch.control.automation")}</Badge>}
                      </span>
                    </div>
                    {sw.location && <p className="mt-2 text-xs text-muted">{sw.location}</p>}
                  </CardBody>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      {automation && <AutomationDialog onClose={() => setAutomation(false)} />}
      {adding && (
        <SwitcherDialog
          onClose={() => setAdding(false)}
          onDone={(s) => {
            setAdding(false);
            nav(`/atem/${s.id}`);
          }}
        />
      )}
    </>
  );
}

export function AtemPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <List />;
}
