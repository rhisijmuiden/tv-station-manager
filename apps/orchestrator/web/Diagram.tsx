import "@xyflow/react/dist/style.css";
import "./diagram.css";
import { Alert, ApiError, Badge, Button, Card, CardBody, Dialog, Field, Input, Mono, PageHeader, Select, Textarea, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
  applyNodeChanges,
} from "@xyflow/react";
import {
  ArrowLeftRight,
  Box,
  Cable as CableIcon,
  Camera,
  Cast,
  ExternalLink,
  HardDrive,
  LayoutGrid,
  Lock,
  Monitor,
  Network,
  Pencil,
  Plus,
  Server,
  SlidersHorizontal,
  Trash2,
  Unplug,
  Video,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { AtemControl, type ControlState } from "./AtemControl";
import { TransportBadge } from "./Hyperdeck";
import { autoLayout, CABLES, CARD_PRESETS, cardFromPreset, DEVICE_TYPES, linkError, trace, type Card as CardT, type Link, type LinkTally, type ResolvedPort } from "../server/diagramlogic";

interface AtemInfo {
  host: string;
  model: string | null;
  mixEffects: number;
  auxes: number;
  program: (number | null)[];
  preview: (number | null)[];
  auxSources: (number | null)[];
  inputs: { id: number; longName: string; shortName: string; kind: string; port: string | null }[];
  control: ControlState;
}
interface Device {
  id: string;
  kind: "node" | "atem" | "hyperdeck" | "device";
  refId: string | null;
  name: string;
  deviceType: string;
  x: number;
  y: number;
  cards: CardT[];
  notes: string;
  ports: ResolvedPort[];
  online: boolean | null;
  node: { role: string; hostname: string } | null;
  atem: AtemInfo | null;
  hyperdeck?: { host: string; model: string | null; status: string | null; timecode: string | null } | null;
}
interface DiagramData {
  devices: Device[];
  links: Link[];
  broken: string[];
  available: { nodes: { id: string; name: string; role: string }[]; atems: { id: string; name: string }[]; hyperdecks?: { id: string; name: string; model: string | null }[] };
}

const TYPE_ICON: Record<string, LucideIcon> = { server: Server, camera: Camera, converter: ArrowLeftRight, encoder: Cast, recorder: HardDrive, monitor: Monitor, router: Network, other: Box };
const iconOf = (d: Device) => (d.kind === "atem" ? SlidersHorizontal : d.kind === "hyperdeck" ? Video : (TYPE_ICON[d.deviceType] ?? Box));

const TALLY_COLOR: Record<Exclude<LinkTally, null>, string> = { air: "var(--tvsm-on-air)", program: "var(--tvsm-danger)", preview: "var(--tvsm-success)" };

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`orch.diagram.err_${e.code}`, { defaultValue: t(`orch.atem.err_${e.code}`, { defaultValue: e.message }) }) : String(e));
}

/** Port tally per device (for the dots on the port rows), shared with the custom nodes without re-creating them. */
const TallyContext = createContext<{ ports: Record<string, LinkTally>; editing: boolean }>({ ports: {}, editing: false });

// ---- nodes on the canvas -------------------------------------------------------------------

type DeviceNodeData = { dev: Device };

function PortRow({ p, devId, extra }: { p: ResolvedPort; devId: string; extra?: React.ReactNode }) {
  const { ports, editing } = useContext(TallyContext);
  const tally = ports[`${devId}|${p.key}`] ?? null;
  const dot = <span className={cx("size-2 shrink-0 rounded-full", tally === "air" ? "bg-onair shadow-[0_0_6px_var(--tvsm-on-air)]" : tally === "program" ? "bg-danger" : tally === "preview" ? "bg-ok" : "bg-line")} />;
  return (
    <div className={cx("relative flex h-[26px] items-center gap-2 px-3 text-[12px]", p.dir === "out" && "flex-row-reverse text-right")}>
      <Handle
        type={p.dir === "in" ? "target" : "source"}
        position={p.dir === "in" ? Position.Left : Position.Right}
        id={p.key}
        isConnectable={editing}
        className={cx("tvsm-handle", p.dir === "in" ? "tvsm-handle-in" : "tvsm-handle-out")}
      />
      {dot}
      {p.input != null && <span className="font-mono text-[10px] text-muted">{p.input}</span>}
      <span className="min-w-0 flex-1 truncate">{p.label}</span>
      {p.type && <span className="font-mono text-[9px] text-muted uppercase">{p.type}</span>}
      {extra}
    </div>
  );
}

function NodeShell({ dev, selected, children, accent }: { dev: Device; selected: boolean; children: React.ReactNode; accent?: "locked" | null }) {
  const { t } = useTranslation();
  const Icon = iconOf(dev);
  const sub = dev.kind === "atem" ? (dev.atem?.model ?? dev.atem?.host ?? "") : dev.kind === "hyperdeck" ? (dev.hyperdeck?.model ?? dev.hyperdeck?.host ?? "HyperDeck") : dev.kind === "node" ? `${t(`orch.nodes.role_${dev.node?.role ?? "unassigned"}`, { defaultValue: dev.node?.role ?? "" })} · ${dev.node?.hostname ?? ""}` : t(`orch.diagram.type_${dev.deviceType}`);
  return (
    <div
      className={cx(
        "w-[300px] rounded-xl border bg-surface shadow-card transition",
        selected ? "border-brand ring-2 ring-brand/40" : accent === "locked" ? "border-warn ring-2 ring-warn/30" : "border-line",
      )}
    >
      <div className={cx("flex items-center gap-2.5 rounded-t-[11px] px-3 py-2.5", dev.kind === "atem" ? "bg-[color-mix(in_oklab,var(--tvsm-sidebar)_92%,black)] text-white" : "border-b border-line bg-surface-2/60")}>
        <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", dev.kind === "atem" ? "bg-white/10" : "bg-brand/10 text-brand")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-tight font-semibold">{dev.name}</p>
          <p className={cx("truncate text-[11px] leading-tight", dev.kind === "atem" ? "text-white/55" : "text-muted")}>{sub}</p>
        </div>
        {dev.kind === "hyperdeck" && dev.hyperdeck?.status === "record" && <TransportBadge status="record" />}
        {dev.online != null && <span title={dev.online ? t("orch.nodes.online") : t("orch.nodes.offline")} className={cx("size-2.5 shrink-0 rounded-full", dev.online ? "bg-ok" : "bg-danger")} />}
        {accent === "locked" && <Lock className="size-3.5 text-warn" />}
      </div>
      {children}
    </div>
  );
}

const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<Node<DeviceNodeData>>) {
  const { t } = useTranslation();
  const dev = data.dev;
  const byCard = dev.cards.map((c) => ({ c, ports: dev.ports.filter((p) => p.key.startsWith(`${c.id}:`)) }));
  return (
    <NodeShell dev={dev} selected={selected}>
      {byCard.length === 0 && <p className="px-3 py-3 text-[11px] text-muted">{t("orch.diagram.noCards")}</p>}
      {byCard.map(({ c, ports }) => (
        <div key={c.id} className="border-b border-line/60 py-1 last:border-0">
          <p className="px-3 pt-1 pb-0.5 text-[10px] font-semibold tracking-wider text-muted uppercase">{c.name}</p>
          {ports.map((p) => (
            <PortRow key={p.key} p={p} devId={dev.id} extra={p.channel ? <Badge tone="brand">ch {p.channel}</Badge> : null} />
          ))}
        </div>
      ))}
    </NodeShell>
  );
});

const AtemNode = memo(function AtemNode({ data, selected }: NodeProps<Node<DeviceNodeData>>) {
  const { t } = useTranslation();
  const dev = data.dev;
  const a = dev.atem;
  const ins = dev.ports.filter((p) => p.dir === "in");
  const outs = dev.ports.filter((p) => p.dir === "out");
  const name = (id: number | null | undefined) => (id == null ? null : (a?.inputs.find((i) => i.id === id)?.shortName ?? (id >= 10010 ? `M/E${Math.floor((id - 10010) / 10) + 1}${id % 10 ? " PVW" : ""}` : `#${id}`)));
  const tag = (id: number) => (a?.program.includes(id) ? "pgm" : a?.preview.includes(id) ? "pvw" : null);
  return (
    <NodeShell dev={dev} selected={selected} accent={a?.control.mode === "locked" ? "locked" : null}>
      {!a || ins.length + outs.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-muted">{t("orch.diagram.atemUnknown")}</p>
      ) : (
        <>
          <div className="flex items-center justify-between px-3 pt-2 text-[10px] font-semibold tracking-wider text-muted uppercase">
            <span>{t("orch.atem.inputs")}</span>
            <span className={cx("inline-flex items-center gap-1 normal-case", a.control.mode === "locked" ? "text-warn" : "text-brand")}>
              {a.control.mode === "locked" ? <Lock className="size-3" /> : <Wand2 className="size-3" />}
              {a.control.mode === "locked" ? t("orch.control.locked") : t("orch.control.automation")}
            </span>
          </div>
          <div className="py-1">
            {ins.map((p) => {
              const tg = tag(p.input!);
              return (
                <PortRow
                  key={p.key}
                  p={p}
                  devId={dev.id}
                  extra={tg && <span className={cx("rounded px-1 text-[9px] font-bold text-white", tg === "pgm" ? "bg-danger" : "bg-ok")}>{tg === "pgm" ? "PGM" : "PVW"}</span>}
                />
              );
            })}
          </div>
          <p className="border-t border-line/60 px-3 pt-2 text-right text-[10px] font-semibold tracking-wider text-muted uppercase">{t("orch.diagram.outputs")}</p>
          <div className="py-1">
            {outs.map((p) => {
              const src = p.key === "pgm" ? name(a.program[0]) : p.key.startsWith("aux:") ? name(a.auxSources[Number(p.key.slice(4)) - 1]) : null;
              return <PortRow key={p.key} p={p} devId={dev.id} extra={src && <span className="rounded bg-surface-2 px-1 font-mono text-[9px] text-muted">{src}</span>} />;
            })}
          </div>
        </>
      )}
    </NodeShell>
  );
});

const nodeTypes = { device: DeviceNode, atem: AtemNode };

// ---- dialogs ------------------------------------------------------------------------------------

const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function CardsEditor({ cards, onChange, channels }: { cards: CardT[]; onChange: (c: CardT[]) => void; channels: boolean }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState("decklink-4k-extreme-12g");
  const patch = (i: number, c: Partial<CardT>) => onChange(cards.map((x, j) => (j === i ? { ...x, ...c } : x)));
  return (
    <div className="space-y-3">
      {cards.map((c, i) => (
        <div key={c.id} className="rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-2">
            <Input className="h-8 flex-1 font-medium" value={c.name} maxLength={60} onChange={(e) => patch(i, { name: e.target.value })} />
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => onChange(cards.filter((_, j) => j !== i))} aria-label={t("orch.diagram.removeCard")} />
          </div>
          <div className="space-y-1.5 p-3">
            {c.ports.map((p, k) => (
              <div key={p.id} className={cx("grid items-center gap-1.5", channels ? "grid-cols-[7.5rem_minmax(0,1fr)_4.5rem_4.5rem_auto]" : "grid-cols-[7.5rem_minmax(0,1fr)_4.5rem_auto]")}>
                <Select
                  className="h-8 text-xs"
                  value={p.dir}
                  onChange={(e) => patch(i, { ports: c.ports.map((x, m) => (m === k ? { ...x, dir: e.target.value as "in" | "out" } : x)) })}
                >
                  <option value="out">{t("orch.diagram.dirOut")}</option>
                  <option value="in">{t("orch.diagram.dirIn")}</option>
                </Select>
                <Input className="h-8 text-xs" value={p.label} maxLength={40} onChange={(e) => patch(i, { ports: c.ports.map((x, m) => (m === k ? { ...x, label: e.target.value } : x)) })} />
                <Input className="h-8 px-2 font-mono text-xs uppercase" value={p.type ?? ""} maxLength={16} placeholder="SDI" onChange={(e) => patch(i, { ports: c.ports.map((x, m) => (m === k ? { ...x, type: e.target.value || undefined } : x)) })} />
                {channels && (
                  <Input
                    className="h-8 px-2 text-xs"
                    type="number"
                    min={1}
                    max={64}
                    title={t("orch.diagram.channelHint")}
                    placeholder="ch"
                    disabled={p.dir !== "out"}
                    value={p.channel ?? ""}
                    onChange={(e) => patch(i, { ports: c.ports.map((x, m) => (m === k ? { ...x, channel: e.target.value ? Number(e.target.value) : null } : x)) })}
                  />
                )}
                <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t("orch.diagram.removePort")} onClick={() => patch(i, { ports: c.ports.filter((_, m) => m !== k) })}>
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              onClick={() => {
                let n = c.ports.length + 1;
                while (c.ports.some((p) => p.id === `p${n}`)) n++;
                patch(i, { ports: [...c.ports, { id: `p${n}`, label: `SDI ${n}`, dir: "out", type: "SDI" }] });
              }}
            >
              {t("orch.diagram.addPort")}
            </Button>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Select className="h-9" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {Object.entries(CARD_PRESETS).map(([k, p]) => (
            <option key={k} value={k}>
              {p.name}
            </option>
          ))}
          <option value="custom">{t("orch.diagram.customCard")}</option>
        </Select>
        <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange([...cards, cardFromPreset(preset, newId("c"), { name: t("orch.diagram.customCard") })])}>
          {t("orch.diagram.addCard")}
        </Button>
      </div>
    </div>
  );
}

function DeviceDialog({ dev, onClose, onDone }: { dev: Device; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({ name: dev.kind === "device" ? dev.name : "", deviceType: dev.deviceType, notes: dev.notes, cards: dev.cards });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/diagram/devices/${dev.id}`, { ...f, cards: dev.kind === "atem" ? undefined : f.cards });
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
      wide
      onClose={onClose}
      title={t("orch.diagram.editDevice", { name: dev.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={save} disabled={dev.kind === "device" && !f.name.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("orch.diagram.name")} hint={dev.kind !== "device" ? t("orch.diagram.nameFromInventory") : undefined}>
            {(id) => <Input id={id} value={f.name} maxLength={80} placeholder={dev.kind !== "device" ? dev.name : ""} onChange={(e) => setF({ ...f, name: e.target.value })} />}
          </Field>
          {dev.kind !== "atem" && (
            <Field label={t("orch.diagram.deviceType")}>
              {(id) => (
                <Select id={id} value={f.deviceType} onChange={(e) => setF({ ...f, deviceType: e.target.value })}>
                  {DEVICE_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {t(`orch.diagram.type_${d}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {dev.kind !== "atem" ? (
          <div>
            <p className="mb-1 text-sm font-medium">{t("orch.diagram.cards")}</p>
            <p className="mb-3 text-xs text-muted">{t("orch.diagram.cardsHint")}</p>
            <CardsEditor cards={f.cards} channels={dev.kind === "node"} onChange={(cards) => setF({ ...f, cards })} />
          </div>
        ) : (
          <Alert tone="brand">{t("orch.diagram.atemPortsHint")}</Alert>
        )}
        <Field label={`${t("orch.nodes.notes")} (${t("common.optional")})`}>
          {(id) => <Textarea id={id} className="font-sans text-sm" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

function AddDialog({ data, onClose, onAdd }: { data: DiagramData; onClose: () => void; onAdd: (body: Record<string, unknown>) => Promise<void> }) {
  const { t } = useTranslation();
  const err = useErr();
  const decks = data.available.hyperdecks ?? [];
  const [kind, setKind] = useState<"node" | "atem" | "hyperdeck" | "device">(data.available.nodes.length ? "node" : data.available.atems.length ? "atem" : decks.length ? "hyperdeck" : "device");
  const [refId, setRefId] = useState("");
  const [name, setName] = useState("");
  const [deviceType, setDeviceType] = useState("camera");
  const [preset, setPreset] = useState("decklink-4k-extreme-12g");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = kind === "node" ? data.available.nodes : kind === "atem" ? data.available.atems : kind === "hyperdeck" ? decks : [];
  const chosen = refId || list[0]?.id || "";
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      // HyperDecks get the connectors of their model from the server.
      const cards = kind === "atem" || kind === "hyperdeck" || preset === "" ? [] : [cardFromPreset(preset, "c1", { name: t("orch.diagram.customCard") })];
      await onAdd(kind === "device" ? { kind, name, deviceType, cards } : { kind, refId: chosen, cards });
    } catch (e) {
      setError(err(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("orch.diagram.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={add} disabled={kind === "device" ? !name.trim() : !chosen}>
            {t("orch.diagram.place")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["node", "atem", "hyperdeck", "device"] as const).map((k) => {
            const Icon = k === "node" ? Server : k === "atem" ? SlidersHorizontal : k === "hyperdeck" ? Video : Camera;
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setRefId("");
                  if (k === "device") setPreset("camera");
                  else setPreset("decklink-4k-extreme-12g");
                }}
                className={cx("flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition", kind === k ? "border-brand bg-brand/5 text-brand" : "border-line text-muted hover:text-fg")}
              >
                <Icon className="size-5" />
                {t(`orch.diagram.kind_${k}`)}
              </button>
            );
          })}
        </div>
        {kind !== "device" &&
          (list.length === 0 ? (
            <p className="text-sm text-muted">{kind === "node" ? t("orch.diagram.allNodesPlaced") : kind === "hyperdeck" ? t("orch.diagram.allHyperdecksPlaced") : t("orch.diagram.allAtemsPlaced")}</p>
          ) : (
            <Field label={t(`orch.diagram.kind_${kind}`)}>
              {(id) => (
                <Select id={id} value={chosen} onChange={(e) => setRefId(e.target.value)}>
                  {list.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ))}
        {kind === "device" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("orch.diagram.name")}>{(id) => <Input id={id} value={name} maxLength={80} placeholder={t("orch.diagram.namePlaceholder")} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={t("orch.diagram.deviceType")}>
              {(id) => (
                <Select id={id} value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
                  {DEVICE_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {t(`orch.diagram.type_${d}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        {kind !== "atem" && kind !== "hyperdeck" && (
          <Field label={t("orch.diagram.firstCard")} hint={t("orch.diagram.firstCardHint")}>
            {(id) => (
              <Select id={id} value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">{t("orch.diagram.noCard")}</option>
                {Object.entries(CARD_PRESETS).map(([k, p]) => (
                  <option key={k} value={k}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {kind === "atem" && <p className="text-xs text-muted">{t("orch.diagram.atemPortsHint")}</p>}
        {kind === "hyperdeck" && <p className="text-xs text-muted">{t("orch.diagram.hyperdeckPortsHint")}</p>}
      </div>
    </Dialog>
  );
}

// ---- side panel -----------------------------------------------------------------------------

function LinkPanel({ link, data, editing, onChanged }: { link: Link; data: DiagramData; editing: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [f, setF] = useState({ cable: link.cable, label: link.label });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF({ cable: link.cable, label: link.label }), [link.id, link.cable, link.label]);
  const end = (e: Link["from"]) => {
    const d = data.devices.find((x) => x.id === e.device);
    return { dev: d?.name ?? "?", port: d?.ports.find((p) => p.key === e.port)?.label ?? e.port };
  };
  const a = end(link.from);
  const b = end(link.to);
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm">
        <p>
          <span className="text-muted">{t("orch.diagram.from")}</span> <span className="font-medium">{a.dev}</span> · {a.port}
        </p>
        <p>
          <span className="text-muted">{t("orch.diagram.to")}</span> <span className="font-medium">{b.dev}</span> · {b.port}
        </p>
      </div>
      {data.broken.includes(link.id) && <Alert tone="warn">{t("orch.diagram.brokenLink")}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t("orch.diagram.cable")}>
        {(id) => (
          <Select id={id} disabled={!editing} value={f.cable} onChange={(e) => setF({ ...f, cable: e.target.value as Link["cable"] })}>
            {CABLES.map((c) => (
              <option key={c} value={c}>
                {t(`orch.diagram.cable_${c}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={`${t("orch.diagram.cableLabel")} (${t("common.optional")})`}>
        {(id) => <Input id={id} disabled={!editing} maxLength={60} value={f.label} placeholder={t("orch.diagram.cableLabelPlaceholder")} onChange={(e) => setF({ ...f, label: e.target.value })} />}
      </Field>
      {editing && (
        <div className="flex justify-between gap-2">
          <Button
            variant="secondary"
            icon={<Unplug className="size-4" />}
            onClick={async () => {
              await del(`/api/diagram/links/${link.id}`).catch((e) => setError(err(e)));
              onChanged();
            }}
          >
            {t("orch.diagram.removeCable")}
          </Button>
          <Button
            onClick={async () => {
              await put(`/api/diagram/links/${link.id}`, f).catch((e) => setError(err(e)));
              onChanged();
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}

function DevicePanel({ dev, editing, onEdit, onRemove, onChanged }: { dev: Device; editing: boolean; onEdit: () => void; onRemove: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const a = dev.atem;
  return (
    <div className="space-y-4">
      {dev.kind === "atem" && a && dev.refId && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <Mono>{a.host}</Mono>
            <RouterLink to={`/atem/${dev.refId}`} className="inline-flex items-center gap-1 text-brand hover:underline">
              {t("orch.diagram.openAtem")} <ExternalLink className="size-3" />
            </RouterLink>
          </div>
          <AtemControl
            compact
            sw={{ id: dev.refId, online: !!dev.online, control: a.control, snapshot: { mixEffects: a.mixEffects, auxes: a.auxes, inputs: a.inputs, program: a.program, preview: a.preview, auxSources: a.auxSources } }}
            onChanged={onChanged}
          />
        </>
      )}
      {dev.kind !== "atem" && (
        <div className="space-y-2 text-sm">
          {dev.cards.length === 0 && <p className="text-muted">{t("orch.diagram.noCards")}</p>}
          {dev.cards.map((c) => (
            <div key={c.id}>
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-muted">
                {t("orch.diagram.portCount", { outs: c.ports.filter((p) => p.dir === "out").length, ins: c.ports.filter((p) => p.dir === "in").length })}
              </p>
            </div>
          ))}
          {dev.kind === "hyperdeck" && dev.refId && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-2">
                <TransportBadge status={dev.hyperdeck?.status} />
                {dev.hyperdeck?.status && <Mono>{dev.hyperdeck.timecode}</Mono>}
              </span>
              <RouterLink to={`/hyperdeck/${dev.refId}`} className="inline-flex items-center gap-1 text-brand hover:underline">
                {t("orch.diagram.openHyperdeck")} <ExternalLink className="size-3" />
              </RouterLink>
            </div>
          )}
          {dev.kind === "node" && dev.refId && (
            <RouterLink to="/nodes" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
              {t("orch.diagram.openNodes")} <ExternalLink className="size-3" />
            </RouterLink>
          )}
        </div>
      )}
      {dev.notes && <p className="text-sm whitespace-pre-wrap text-muted">{dev.notes}</p>}
      {editing && (
        <div className="flex justify-between gap-2 border-t border-line pt-4">
          <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={onRemove}>
            {t("orch.diagram.removeFromDiagram")}
          </Button>
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={onEdit}>
            {dev.kind === "atem" ? t("orch.diagram.notes") : t("orch.diagram.editPorts")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Legend() {
  const { t } = useTranslation();
  const item = (color: string, label: string, dashed?: boolean, thick?: boolean) => (
    <span className="flex items-center gap-1.5">
      <svg width="22" height="6" aria-hidden>
        <line x1="1" y1="3" x2="21" y2="3" stroke={color} strokeWidth={thick ? 4 : 2} strokeDasharray={dashed ? "4 3" : undefined} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {item("var(--tvsm-on-air)", t("orch.diagram.legendAir"), false, true)}
      {item("var(--tvsm-danger)", t("orch.atem.program"))}
      {item("var(--tvsm-success)", t("orch.atem.preview"))}
      {item("var(--tvsm-text-muted)", t("orch.diagram.legendCable"))}
      {item("var(--tvsm-warning)", t("orch.diagram.legendBroken"), true)}
    </div>
  );
}

// ---- page -------------------------------------------------------------------------------------

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.dataset.theme === "dark"));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

type Selection = { type: "device" | "link"; id: string } | null;

function DiagramInner() {
  const { t } = useTranslation();
  const err = useErr();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const dark = useDark();
  const flow = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<DiagramData | null>(null);
  const [nodes, setNodes] = useState<Node<DeviceNodeData>[]>([]);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [adding, setAdding] = useState(false);
  const [editDev, setEditDev] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await get<DiagramData>("/api/diagram");
    setData(d);
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return d.devices.map((dev) => {
        const o = old.get(dev.id);
        return { id: dev.id, type: dev.kind === "atem" ? "atem" : "device", position: o ? o.position : { x: dev.x, y: dev.y }, data: { dev }, selected: o?.selected };
      });
    });
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(err(e)));
    const i = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const tally = useMemo(() => {
    if (!data) return { links: {} as Record<string, LinkTally>, ports: {} as Record<string, LinkTally> };
    const atems = Object.fromEntries(data.devices.filter((d) => d.atem).map((d) => [d.id, { program: d.atem!.program, preview: d.atem!.preview, auxSources: d.atem!.auxSources }]));
    const links = trace(data.links, atems);
    const ports: Record<string, LinkTally> = {};
    const rank = (x: LinkTally) => (x === "air" ? 3 : x === "program" ? 2 : x === "preview" ? 1 : 0);
    for (const l of data.links) {
      const tl = links[l.id] ?? null;
      for (const k of [`${l.from.device}|${l.from.port}`, `${l.to.device}|${l.to.port}`]) if (rank(tl) > rank(ports[k] ?? null)) ports[k] = tl;
    }
    return { links, ports };
  }, [data]);

  const edges: Edge[] = useMemo(
    () =>
      (data?.links ?? []).map((l) => {
        const tl = tally.links[l.id] ?? null;
        const broken = data!.broken.includes(l.id);
        const color = broken ? "var(--tvsm-warning)" : tl ? TALLY_COLOR[tl] : "var(--tvsm-text-muted)";
        const selected = sel?.type === "link" && sel.id === l.id;
        return {
          id: l.id,
          source: l.from.device,
          sourceHandle: l.from.port,
          target: l.to.device,
          targetHandle: l.to.port,
          animated: tl === "air",
          selected,
          label: l.label || (l.cable !== "sdi" ? t(`orch.diagram.cable_${l.cable}`) : undefined),
          labelStyle: { fontSize: 10, fill: "var(--tvsm-text-muted)" },
          labelBgStyle: { fill: "var(--tvsm-surface)" },
          style: { stroke: color, strokeWidth: tl === "air" ? 4 : tl ? 3 : selected ? 3 : 2, strokeDasharray: broken ? "6 4" : undefined, opacity: tl || selected ? 1 : 0.75 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        };
      }),
    [data, tally, sel, t],
  );

  const onNodesChange: OnNodesChange<Node<DeviceNodeData>> = useCallback((changes) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const savePositions = async (list: { id: string; x: number; y: number }[]) => {
    try {
      await put("/api/diagram/layout", { positions: list });
    } catch (e) {
      setError(err(e));
    }
  };

  const ports = useCallback((id: string) => data?.devices.find((d) => d.id === id)?.ports, [data]);
  const isValid = useCallback(
    (c: Connection | Edge) => !!c.source && !!c.target && !!c.sourceHandle && !!c.targetHandle && !linkError({ device: c.source, port: c.sourceHandle }, { device: c.target, port: c.targetHandle }, ports, data?.links ?? []),
    [ports, data],
  );
  const onConnect = async (c: Connection) => {
    if (!c.sourceHandle || !c.targetHandle) return;
    setError(null);
    try {
      const l = await post<Link>("/api/diagram/links", { from: { device: c.source, port: c.sourceHandle }, to: { device: c.target, port: c.targetHandle } });
      await load();
      setSel({ type: "link", id: l.id });
    } catch (e) {
      setError(err(e));
    }
  };

  const center = () => {
    const r = wrap.current?.getBoundingClientRect();
    const p = r ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 }) : { x: 0, y: 0 };
    return { x: Math.round(p.x - 150), y: Math.round(p.y) };
  };

  const arrange = async (d: DiagramData | null = data) => {
    if (!d) return;
    const pos = autoLayout(
      d.devices.map((x) => ({ id: x.id, ports: x.ports.length + x.cards.length, portOrder: x.ports.map((p) => p.key) })),
      d.links,
    );
    setNodes((ns) => ns.map((n) => (pos[n.id] ? { ...n, position: pos[n.id]! } : n)));
    await savePositions(Object.entries(pos).map(([id, p]) => ({ id, ...p })));
    setTimeout(() => void flow.fitView({ padding: 0.15, duration: 400 }), 50);
  };

  /** Empty diagram: place every approved node and ATEM, then arrange. */
  const placeAll = async () => {
    if (!data) return;
    setBusy(true);
    try {
      // Management nodes have no video connectors: they are left out (and can still be added by hand).
      for (const n of data.available.nodes.filter((x) => x.role !== "management")) await post("/api/diagram/devices", { kind: "node", refId: n.id, cards: ["studio", "playout", "live"].includes(n.role) ? [cardFromPreset("decklink-4k-extreme-12g", "c1")] : [] });
      for (const a of data.available.atems) await post("/api/diagram/devices", { kind: "atem", refId: a.id });
      for (const h of data.available.hyperdecks ?? []) await post("/api/diagram/devices", { kind: "hyperdeck", refId: h.id });
      const d = await get<DiagramData>("/api/diagram");
      setData(d);
      setNodes(d.devices.map((dev) => ({ id: dev.id, type: dev.kind === "atem" ? "atem" : "device", position: { x: dev.x, y: dev.y }, data: { dev } })));
      setEditing(true);
      await arrange(d);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = sel?.type === "device" ? data?.devices.find((d) => d.id === sel.id) : undefined;
  const selectedLink = sel?.type === "link" ? data?.links.find((l) => l.id === sel.id) : undefined;
  const lockedCount = data?.devices.filter((d) => d.atem?.control.mode === "locked").length ?? 0;

  if (!data) return null;
  const empty = data.devices.length === 0;
  const placeable = data.available.nodes.filter((x) => x.role !== "management").length + data.available.atems.length + (data.available.hyperdecks?.length ?? 0);
  const tallyCtx = { ports: tally.ports, editing };

  return (
    <div data-wide-page>
      <PageHeader
        title={t("orch.diagram.title")}
        description={t("orch.diagram.intro")}
        actions={
          canEdit && (
            <>
              {editing && (
                <>
                  <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                    {t("orch.diagram.add")}
                  </Button>
                  <Button variant="secondary" icon={<LayoutGrid className="size-4" />} onClick={() => void arrange()} disabled={empty}>
                    {t("orch.diagram.arrange")}
                  </Button>
                </>
              )}
              <Button variant={editing ? "primary" : "secondary"} icon={<Pencil className="size-4" />} onClick={() => setEditing(!editing)}>
                {editing ? t("orch.diagram.done") : t("orch.diagram.edit")}
              </Button>
            </>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {empty ? (
        <Card>
          <CardBody className="py-14 text-center">
            <Network className="mx-auto mb-3 size-9 text-brand" />
            <p className="font-medium">{t("orch.diagram.empty")}</p>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted">{t("orch.diagram.emptyHint")}</p>
            {canEdit && (
              <div className="mt-5 flex justify-center gap-2">
                <Button icon={<Wand2 className="size-4" />} loading={busy} disabled={placeable === 0} onClick={() => void placeAll()}>
                  {t("orch.diagram.placeAll", { n: placeable })}
                </Button>
                <Button
                  variant="secondary"
                  icon={<Plus className="size-4" />}
                  onClick={() => {
                    setEditing(true);
                    setAdding(true);
                  }}
                >
                  {t("orch.diagram.add")}
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div ref={wrap} className={cx("tvsm-flow relative h-[calc(100vh-14rem)] min-h-[560px] overflow-hidden rounded-xl border bg-surface shadow-card", editing ? "border-brand/50" : "border-line")}>
            <TallyContext.Provider value={tallyCtx}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                colorMode={dark ? "dark" : "light"}
                onNodesChange={onNodesChange}
                nodesDraggable={editing}
                nodesConnectable={editing}
                elementsSelectable
                deleteKeyCode={null}
                isValidConnection={isValid}
                onConnect={(c) => void onConnect(c)}
                onNodeClick={(_, n) => setSel({ type: "device", id: n.id })}
                onEdgeClick={(_, e) => setSel({ type: "link", id: e.id })}
                onPaneClick={() => setSel(null)}
                onNodeDragStop={(_, __, moved) => {
                  void savePositions(moved.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
                }}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.15}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
                connectionLineStyle={{ stroke: "var(--tvsm-primary)", strokeWidth: 2.5 }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => ((n.data as DeviceNodeData).dev.kind === "atem" ? "var(--tvsm-sidebar)" : "var(--tvsm-primary)")} maskColor="color-mix(in srgb, var(--tvsm-bg) 70%, transparent)" />
              </ReactFlow>
            </TallyContext.Provider>
            {editing && (
              <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg">
                <CableIcon className="mr-1.5 inline size-3.5" />
                {t("orch.diagram.editingHint")}
              </div>
            )}
          </div>
          <div className="space-y-4">
            <Card>
              <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3.5">
                <p className="truncate font-semibold">{selected ? selected.name : selectedLink ? t("orch.diagram.cable") : t("orch.diagram.overview")}</p>
                {sel && (
                  <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setSel(null)} aria-label={t("common.cancel")}>
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <CardBody>
                {selected ? (
                  <DevicePanel
                    dev={selected}
                    editing={editing}
                    onChanged={() => void load()}
                    onEdit={() => setEditDev(selected)}
                    onRemove={async () => {
                      await del(`/api/diagram/devices/${selected.id}`).catch((e) => setError(err(e)));
                      setSel(null);
                      await load();
                    }}
                  />
                ) : selectedLink ? (
                  <LinkPanel link={selectedLink} data={data} editing={editing} onChanged={() => void load()} />
                ) : (
                  <div className="space-y-4 text-sm">
                    <dl className="grid grid-cols-3 gap-3">
                      <div>
                        <dt className="text-xs text-muted">{t("orch.diagram.devices")}</dt>
                        <dd className="text-lg font-semibold">{data.devices.length}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.diagram.cables")}</dt>
                        <dd className="text-lg font-semibold">{data.links.length}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">{t("orch.control.locked")}</dt>
                        <dd className={cx("text-lg font-semibold", lockedCount > 0 && "text-warn")}>{lockedCount}</dd>
                      </div>
                    </dl>
                    <p className="text-muted">{editing ? t("orch.diagram.helpEdit") : t("orch.diagram.help")}</p>
                    {data.broken.length > 0 && <Alert tone="warn">{t("orch.diagram.brokenCount", { count: data.broken.length })}</Alert>}
                    {data.devices
                      .filter((d) => d.atem)
                      .map((d) => (
                        <button key={d.id} type="button" onClick={() => setSel({ type: "device", id: d.id })} className="flex w-full items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left hover:border-brand">
                          <span className="flex min-w-0 items-center gap-2">
                            <SlidersHorizontal className="size-4 shrink-0 text-muted" />
                            <span className="truncate font-medium">{d.name}</span>
                          </span>
                          {d.atem!.control.mode === "locked" ? (
                            <Badge tone="warn">
                              <Lock className="size-3" /> {t("orch.control.locked")}
                            </Badge>
                          ) : (
                            <Badge tone="brand">
                              <Wand2 className="size-3" /> {t("orch.control.automation")}
                            </Badge>
                          )}
                        </button>
                      ))}
                  </div>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardBody className="py-3.5">
                <Legend />
              </CardBody>
            </Card>
          </div>
        </div>
      )}
      {adding && (
        <AddDialog
          data={data}
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            const r = await post<{ id: string }>("/api/diagram/devices", { ...body, ...center() });
            setAdding(false);
            await load();
            setSel({ type: "device", id: r.id });
          }}
        />
      )}
      {editDev && (
        <DeviceDialog
          dev={editDev}
          onClose={() => setEditDev(null)}
          onDone={() => {
            setEditDev(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

export function DiagramPage() {
  return (
    <ReactFlowProvider>
      <DiagramInner />
    </ReactFlowProvider>
  );
}
