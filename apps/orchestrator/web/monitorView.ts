/**
 * Monitoring page model. Pure (tested in test/monitorView.test.ts), shared by the 2D overview and the 3D room.
 *
 * Everything the orchestrator monitors becomes one `MonItem` in a layer of the signal path:
 * core > management > TV nodes > switchers > converters > distribution, with infrastructure as a supporting layer.
 * A new kind of equipment only needs a mapping into a layer here; both views pick it up by themselves.
 */
import type {
  Block,
  CheckType,
  Health,
  Issue,
  OwncastStatus,
  ProbeResult,
} from "../server/monitorlogic";

// ---- the /api/monitoring answer ---------------------------------------------------------------

export interface Metrics {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  uptimeSeconds: number | null;
}
export interface MonNode {
  id: string;
  name: string;
  role: string;
  group: "studio" | "management" | "other";
  status: string;
  hostname: string;
  platform: string | null;
  ip: string | null;
  agentVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  metrics: Metrics | null;
  casparcg: { connected: boolean; channels: number } | null;
  linkedDevice: string | null;
  health: Health;
  issues: Issue[];
}
export interface MonAtem {
  id: string;
  name: string;
  host: string;
  location: string;
  online: boolean;
  lastSeenAt?: string | null;
  model: string | null;
  control: string;
  health: Health;
  issues: Issue[];
}
export interface MonTeranex {
  id: string;
  name: string;
  host: string;
  location: string;
  online: boolean;
  lastSeenAt?: string | null;
  model: string | null;
  input: { source: string | null; format: string | null; signal: boolean | null; audio: string | null } | null;
  output: string | null;
  health: Health;
  issues: Issue[];
}
export interface MonKiloview {
  id: string;
  name: string;
  kind: "encoder" | "decoder";
  host: string;
  location: string;
  online: boolean;
  lastSeenAt?: string | null;
  model: string | null;
  /** Encoder only. */
  input: { source: string | null; format: string | null; signal: boolean | null } | null;
  bitrateKbps: number | null;
  /** Encoder: enabled streams. */
  streams: { name: string; type: string; running: boolean }[];
  /** Decoder: watched outputs. */
  outputs: { connector: string; format: string | null; source: string | null; playing: boolean | null; streamFormat: string | null }[];
  temperature: number | null;
  cpu: number | null;
  health: Health;
  issues: Issue[];
}
export interface MonDevice {
  id: string;
  name: string;
  block: Block;
  checkType: CheckType;
  target: string;
  nodeId: string | null;
  manualStatus: Health;
  location: string;
  notes: string;
  health: Health;
  issues: Issue[];
  result: ProbeResult | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  changedAt: string | null;
  agent: {
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: string | null;
    metrics: Metrics | null;
  } | null;
}
export interface MonCore {
  name: string;
  hostname: string;
  version: string;
  channel: string;
  uptimeSeconds: number;
  mailConfigured: boolean;
  lastBackup: { status: string; at: string } | null;
  health: Health;
  issues: Issue[];
}
export interface Overview {
  checkedAt: string;
  core: MonCore;
  nodes: MonNode[];
  atems: MonAtem[];
  /** Older servers do not send it. */
  teranexes?: MonTeranex[];
  /** Older servers do not send it. */
  kiloviews?: MonKiloview[];
  devices: MonDevice[];
  summary: Record<Health, number>;
}
export type { OwncastStatus };

// ---- layers and items ----------------------------------------------------------------------------

export const LAYERS = [
  "core",
  "management",
  "nodes",
  "switchers",
  "converters",
  "transport",
  "distribution",
  "infrastructure",
] as const;
export type LayerId = (typeof LAYERS)[number];
/** Layers on the signal path; the rest are supporting layers, shown after a divider. */
export const SIGNAL_LAYERS: LayerId[] = [
  "core",
  "management",
  "nodes",
  "switchers",
  "converters",
  "transport",
  "distribution",
];

export type MonItem =
  | {
      key: string;
      kind: "core";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: null;
      core: MonCore;
    }
  | {
      key: string;
      kind: "node";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: Metrics | null;
      node: MonNode;
    }
  | {
      key: string;
      kind: "atem";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: null;
      atem: MonAtem;
    }
  | {
      key: string;
      kind: "teranex";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: null;
      teranex: MonTeranex;
    }
  | {
      key: string;
      kind: "kiloview";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: null;
      kiloview: MonKiloview;
    }
  | {
      key: string;
      kind: "device";
      layer: LayerId;
      name: string;
      host: string;
      health: Health;
      issues: Issue[];
      metrics: Metrics | null;
      device: MonDevice;
    };

export function nodeLayer(n: Pick<MonNode, "group" | "status">): LayerId {
  if (n.status !== "approved") return "infrastructure";
  return n.group === "studio"
    ? "nodes"
    : n.group === "management"
      ? "management"
      : "infrastructure";
}
export const deviceLayer = (d: Pick<MonDevice, "block">): LayerId =>
  d.block === "distribution" ? "distribution" : "infrastructure";

const byName = (a: MonItem, b: MonItem) =>
  a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/** All monitored things as items, in layer order, sorted by name within a layer. Nodes that are linked to a device are shown with that device. */
export function toItems(o: Overview): MonItem[] {
  const items: MonItem[] = [
    {
      key: "core",
      kind: "core",
      layer: "core",
      name: o.core.name,
      host: o.core.hostname,
      health: o.core.health,
      issues: o.core.issues,
      metrics: null,
      core: o.core,
    },
  ];
  for (const n of o.nodes) {
    if (n.linkedDevice) continue;
    items.push({
      key: `node:${n.id}`,
      kind: "node",
      layer: nodeLayer(n),
      name: n.name,
      host: n.ip ?? n.hostname,
      health: n.health,
      issues: n.issues,
      metrics: n.online ? n.metrics : null,
      node: n,
    });
  }
  for (const a of o.atems)
    items.push({
      key: `atem:${a.id}`,
      kind: "atem",
      layer: "switchers",
      name: a.name,
      host: a.host,
      health: a.health,
      issues: a.issues,
      metrics: null,
      atem: a,
    });
  for (const x of o.teranexes ?? [])
    items.push({
      key: `teranex:${x.id}`,
      kind: "teranex",
      layer: "converters",
      name: x.name,
      host: x.host,
      health: x.health,
      issues: x.issues,
      metrics: null,
      teranex: x,
    });
  for (const k of o.kiloviews ?? [])
    items.push({
      key: `kiloview:${k.id}`,
      kind: "kiloview",
      layer: "transport",
      name: k.name,
      host: k.host,
      health: k.health,
      issues: k.issues,
      metrics: null,
      kiloview: k,
    });
  for (const d of o.devices)
    items.push({
      key: `device:${d.id}`,
      kind: "device",
      layer: deviceLayer(d),
      name: d.name,
      host: d.checkType === "manual" ? d.location : d.target,
      health: d.health,
      issues: d.issues,
      metrics: d.agent?.online ? d.agent.metrics : null,
      device: d,
    });
  const order = (l: LayerId) => LAYERS.indexOf(l);
  return items.sort((a, b) => order(a.layer) - order(b.layer) || byName(a, b));
}

const RANK: Record<Health, number> = { ok: 0, unknown: 1, warn: 2, down: 3 };
export const worstHealth = (list: { health: Health }[]): Health =>
  list.reduce<Health>(
    (w, i) => (RANK[i.health] > RANK[w] ? i.health : w),
    "ok",
  );

export interface Filter {
  layer: LayerId | "all";
  health: Health | "all";
  query: string;
}
export function matches(i: MonItem, f: Filter): boolean {
  if (f.layer !== "all" && i.layer !== f.layer) return false;
  if (f.health !== "all" && i.health !== f.health) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  const extra =
    i.kind === "node"
      ? `${i.node.role} ${i.node.hostname}`
      : i.kind === "atem"
        ? `${i.atem.model ?? ""} ${i.atem.location}`
        : i.kind === "teranex"
          ? `${i.teranex.model ?? ""} ${i.teranex.location} ${i.teranex.input?.format ?? ""}`
          : i.kind === "kiloview"
            ? `kiloview ${i.kiloview.model ?? ""} ${i.kiloview.location} ${i.kiloview.input?.format ?? ""} ${i.kiloview.outputs.map((x) => `${x.connector} ${x.source ?? ""}`).join(" ")}`
          : i.kind === "device"
            ? `${i.device.checkType} ${i.device.location} ${i.device.notes}`
            : "";
  return `${i.name} ${i.host} ${extra}`.toLowerCase().includes(q);
}

export interface LayerSummary {
  layer: LayerId;
  total: number;
  health: Health;
  counts: Record<Health, number>;
}
export function summarize(items: MonItem[]): Record<LayerId, LayerSummary> {
  const out = {} as Record<LayerId, LayerSummary>;
  for (const l of LAYERS) {
    const list = items.filter((i) => i.layer === l);
    const counts: Record<Health, number> = {
      ok: 0,
      warn: 0,
      down: 0,
      unknown: 0,
    };
    for (const i of list) counts[i.health]++;
    out[l] = {
      layer: l,
      total: list.length,
      health: worstHealth(list),
      counts,
    };
  }
  return out;
}

/** Everything that is not OK, worst first. */
export function attention(items: MonItem[]): MonItem[] {
  return items
    .filter((i) => i.health !== "ok")
    .sort((a, b) => RANK[b.health] - RANK[a.health] || byName(a, b));
}

/** Above this many items the 2D view starts compact and the 3D room only labels problems and the selection. */
export const MANY_ITEMS = 24;

/** Keeps the last `max` values per key (the CPU line in the detail panel is built from the 5-second refreshes). */
export function pushHistory(
  hist: Record<string, number[]>,
  items: MonItem[],
  max = 60,
): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  for (const i of items) {
    const v = i.metrics?.cpu;
    if (v == null) continue;
    next[i.key] = [...(hist[i.key] ?? []), v].slice(-max);
  }
  return next;
}

/** SVG polyline points for values 0..100 in a w x h box. */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const step = w / (values.length - 1);
  return values
    .map(
      (v, n) =>
        `${+(n * step).toFixed(1)},${+(h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1)}`,
    )
    .join(" ");
}

// ---- 3D room layout ---------------------------------------------------------------------------------

/** Rows of platforms in the room, following the signal path. */
export const ROOM_ROWS: LayerId[][] = [
  ["core", "management", "nodes"],
  ["switchers", "converters", "transport", "distribution"],
  ["infrastructure"],
];
export const CELL = 104;
const PAD = 160;
const GAP = 140;
const HEAD = 52;

export interface Platform {
  layer: LayerId;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
}
export interface Room {
  width: number;
  height: number;
  platforms: Record<LayerId, Platform>;
}

/** Columns for n boxes: a single row up to 3, then a grid a bit wider than tall. */
export const columnsFor = (n: number) =>
  n <= 3 ? Math.max(1, n) : Math.ceil(Math.sqrt(n * 1.6));

/** Platform per layer, sized by its number of items; rows centred under each other. */
export function roomLayout(counts: Record<LayerId, number>): Room {
  const rows = ROOM_ROWS.map((row) => {
    const ps = row.map((layer) => {
      const n = Math.max(1, counts[layer] ?? 0);
      const cols = columnsFor(n);
      return {
        layer,
        cols,
        w: cols * CELL + 40,
        h: Math.ceil(n / cols) * CELL + HEAD + 12,
        x: 0,
        y: 0,
      };
    });
    return {
      ps,
      w: ps.reduce((a, p) => a + p.w, 0) + GAP * (ps.length - 1),
      h: Math.max(...ps.map((p) => p.h)),
    };
  });
  const inner = Math.max(...rows.map((r) => r.w));
  const platforms = {} as Record<LayerId, Platform>;
  let y = PAD;
  for (const r of rows) {
    let x = PAD + (inner - r.w) / 2;
    for (const p of r.ps) {
      platforms[p.layer] = { ...p, x, y: y + (r.h - p.h) / 2 };
      x += p.w + GAP;
    }
    y += r.h + GAP;
  }
  return { width: inner + PAD * 2, height: y - GAP + PAD, platforms };
}

/** Centre of box `index` on a platform. */
export function slot(p: Platform, index: number): { x: number; y: number } {
  const col = index % p.cols;
  const row = Math.floor(index / p.cols);
  return {
    x: p.x + 20 + col * CELL + CELL / 2,
    y: p.y + HEAD + row * CELL + CELL / 2,
  };
}

/** Cables between platforms: the signal path, plus a dotted supporting link from the core to the infrastructure. */
export const ROOM_LINKS: [LayerId, LayerId][] = [
  ["core", "management"],
  ["management", "nodes"],
  ["nodes", "switchers"],
  ["switchers", "converters"],
  ["converters", "transport"],
  ["transport", "distribution"],
  ["core", "infrastructure"],
];

/** Footprint and height (px) of a box per kind of equipment. */
export function boxSize(i: MonItem): [w: number, d: number, h: number] {
  if (i.kind === "core") return [64, 64, 84];
  if (i.kind === "atem") return [86, 46, 22];
  if (i.kind === "teranex") return [76, 44, 20];
  if (i.kind === "kiloview") return [60, 40, 16];
  if (i.kind === "node")
    return i.layer === "management"
      ? [62, 62, 70]
      : i.layer === "nodes"
        ? [56, 56, 72]
        : [54, 54, 52];
  return i.device.block === "distribution" ? [54, 54, 42] : [54, 54, 34];
}

export interface Camera {
  /** Rotation around the vertical axis, degrees. */
  angle: number;
  /** Tilt of the floor, degrees (0 = seen from above). */
  tilt: number;
  zoom: number;
}

/**
 * Where a point of the floor (x, y on the floor, z up) ends up relative to the centre of the stage, before
 * perspective. Mirrors the CSS `scale(zoom) rotateX(tilt) rotateZ(angle)` on a floor centred on the stage.
 */
export function rotate(
  room: Pick<Room, "width" | "height">,
  cam: Camera,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  const a = (cam.angle * Math.PI) / 180;
  const t = (cam.tilt * Math.PI) / 180;
  const px = x - room.width / 2;
  const py = y - room.height / 2;
  const x1 = px * Math.cos(a) - py * Math.sin(a);
  const y1 = px * Math.sin(a) + py * Math.cos(a);
  const y2 = y1 * Math.cos(t) - z * Math.sin(t);
  const z2 = y1 * Math.sin(t) + z * Math.cos(t);
  return { x: x1 * cam.zoom, y: y2 * cam.zoom, z: z2 };
}

/** Screen position inside a stage of w x h with CSS `perspective: d` and `perspective-origin: 50% oy%`. */
export function project(
  room: Pick<Room, "width" | "height">,
  cam: Camera,
  stage: { w: number; h: number; d: number; oy: number },
  x: number,
  y: number,
  z: number,
): { x: number; y: number } {
  const r = rotate(room, cam, x, y, z);
  const ox = stage.w / 2;
  const oy = stage.h * stage.oy;
  const k = stage.d / (stage.d - r.z);
  return {
    x: ox + (stage.w / 2 + r.x - ox) * k,
    y: oy + (stage.h / 2 + r.y - oy) * k,
  };
}

/** Zoom that fits the platforms (the floor without its empty border, plus 90 px of height) in a stage of w x h. */
export function fitZoom(
  room: Pick<Room, "width" | "height">,
  w: number,
  h: number,
  angle: number,
  tilt: number,
): number {
  const m = PAD - 30;
  const pts = [m, room.width - m].flatMap((x) =>
    [m, room.height - m].flatMap((y) =>
      [0, 90].map((z) => rotate(room, { angle, tilt, zoom: 1 }, x, y, z)),
    ),
  );
  // The floor turns around the centre of the stage, so fit twice the farthest point on each axis.
  const bw = 2 * Math.max(...pts.map((p) => Math.abs(p.x)));
  const bh = 2 * Math.max(...pts.map((p) => Math.abs(p.y)));
  return Math.max(0.15, Math.min(1.2, (w * 0.98) / bw, (h * 0.94) / bh));
}
