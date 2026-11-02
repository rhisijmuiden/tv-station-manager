/**
 * Connection diagram logic, shared by the orchestrator server and its web UI (pure: no I/O).
 *
 * The diagram holds devices (an enrolled node, a registered ATEM, or any other box such as a camera or converter)
 * with ports, and links (cables) from an output port to an input port.
 * - Node / device ports come from their cards (DeckLink cards and the like, presets below).
 * - ATEM ports come from the switcher itself: `in:<inputId>` for every physical input, `pgm` (program out),
 *   `aux:<n>` and `mv:<n>` (multiview) outputs.
 * From the switchers' program/preview/aux state, `trace` works out which cables carry the on-air picture.
 */

export type PortDir = "in" | "out";
export interface Port {
  id: string;
  label: string;
  dir: PortDir;
  /** Connector, e.g. SDI, HDMI. */
  type?: string;
  /** CasparCG channel that plays on this output (studio nodes). */
  channel?: number | null;
}
export interface Card {
  id: string;
  /** Preset key, or "custom". */
  model: string;
  name: string;
  ports: Port[];
}
export type DeviceKind = "node" | "atem" | "hyperdeck" | "device";
export const DEVICE_TYPES = ["server", "camera", "converter", "encoder", "recorder", "monitor", "router", "other"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export const CABLES = ["sdi", "hdmi", "fiber", "ip", "other"] as const;
export type Cable = (typeof CABLES)[number];

export interface AtemPortSource {
  mixEffects: number;
  auxes: number;
  multiviewers: number;
  inputs: { id: number; longName: string; shortName: string; kind: string; port: string | null }[];
}

// ---- card presets -------------------------------------------------------------------

interface Preset {
  name: string;
  /** Labels per port; dir comes from the prefix. */
  ports: [PortDir, string, string?][];
}
const sdi = (dir: PortDir, label: string): [PortDir, string, string] => [dir, label, "SDI"];
const hdmi = (dir: PortDir, label: string): [PortDir, string, string] => [dir, label, "HDMI"];

export const CARD_PRESETS: Record<string, Preset> = {
  "decklink-4k-extreme-12g": { name: "DeckLink 4K Extreme 12G", ports: [sdi("out", "SDI Out A (fill)"), sdi("out", "SDI Out B (key)"), sdi("in", "SDI In A"), sdi("in", "SDI In B"), hdmi("out", "HDMI Out")] },
  "decklink-duo-2": { name: "DeckLink Duo 2", ports: [sdi("out", "SDI 1"), sdi("out", "SDI 2"), sdi("out", "SDI 3"), sdi("out", "SDI 4")] },
  "decklink-quad-2": { name: "DeckLink Quad 2", ports: Array.from({ length: 8 }, (_, i) => sdi("out", `SDI ${i + 1}`)) },
  "decklink-8k-pro": { name: "DeckLink 8K Pro", ports: [sdi("out", "SDI A"), sdi("out", "SDI B"), sdi("out", "SDI C"), sdi("out", "SDI D")] },
  "decklink-studio-4k": { name: "DeckLink Studio 4K", ports: [sdi("out", "SDI Out"), sdi("in", "SDI In"), hdmi("out", "HDMI Out")] },
  "decklink-mini-monitor-4k": { name: "DeckLink Mini Monitor 4K", ports: [sdi("out", "SDI Out"), hdmi("out", "HDMI Out")] },
  "decklink-mini-recorder-4k": { name: "DeckLink Mini Recorder 4K", ports: [sdi("in", "SDI In"), hdmi("in", "HDMI In")] },
  "ultrastudio-hd-mini": { name: "UltraStudio HD Mini", ports: [sdi("in", "SDI In"), sdi("out", "SDI Out"), hdmi("in", "HDMI In"), hdmi("out", "HDMI Out")] },
  camera: { name: "Camera", ports: [sdi("out", "SDI Out")] },
  "bidirectional-converter": { name: "Converter SDI/HDMI", ports: [sdi("in", "SDI In"), hdmi("out", "HDMI Out"), hdmi("in", "HDMI In"), sdi("out", "SDI Out")] },
  "monitor": { name: "Monitor", ports: [sdi("in", "SDI In"), hdmi("in", "HDMI In")] },
  // Blackmagic HyperDeck recorders / players.
  "hyperdeck-studio-pro": { name: "HyperDeck Studio Pro", ports: [sdi("in", "SDI In"), hdmi("in", "HDMI In"), sdi("out", "SDI Out A"), sdi("out", "SDI Out B"), sdi("out", "SDI Monitor Out"), hdmi("out", "HDMI Out")] },
  "hyperdeck-studio-hd-mini": { name: "HyperDeck Studio HD Mini", ports: [sdi("in", "SDI In"), sdi("out", "SDI Out"), hdmi("out", "HDMI Out")] },
  "hyperdeck-extreme": { name: "HyperDeck Extreme", ports: [sdi("in", "SDI In"), hdmi("in", "HDMI In"), sdi("out", "SDI Out"), sdi("out", "SDI Monitor Out"), hdmi("out", "HDMI Out")] },
  hyperdeck: { name: "HyperDeck", ports: [sdi("in", "SDI In"), sdi("out", "SDI Out")] },
};

/** A new card from a preset (or a custom card with `outs` outputs and `ins` inputs). */
export function cardFromPreset(model: string, id: string, custom?: { name?: string; outs?: number; ins?: number; type?: string }): Card {
  const p = CARD_PRESETS[model];
  if (p) return { id, model, name: p.name, ports: p.ports.map(([dir, label, type], i) => ({ id: `p${i + 1}`, label, dir, type })) };
  const type = custom?.type ?? "SDI";
  const outs = Math.max(0, Math.min(32, custom?.outs ?? 1));
  const ins = Math.max(0, Math.min(32, custom?.ins ?? 0));
  return {
    id,
    model: "custom",
    name: custom?.name?.trim() || "Card",
    ports: [
      ...Array.from({ length: outs }, (_, i) => ({ id: `o${i + 1}`, label: `${type} Out ${i + 1}`, dir: "out" as const, type })),
      ...Array.from({ length: ins }, (_, i) => ({ id: `i${i + 1}`, label: `${type} In ${i + 1}`, dir: "in" as const, type })),
    ],
  };
}

// ---- ports ----------------------------------------------------------------------------

export interface ResolvedPort extends Port {
  /** Full port id within the device. */
  key: string;
  /** Card the port belongs to (nodes/devices) or "inputs"/"outputs" (ATEM). */
  group: string;
  /** ATEM input number (ATEM `in:` ports). */
  input?: number;
}

export function cardPorts(cards: Card[]): ResolvedPort[] {
  return cards.flatMap((c) => c.ports.map((p) => ({ ...p, key: `${c.id}:${p.id}`, group: c.name })));
}

export function atemPorts(s: AtemPortSource | null | undefined): ResolvedPort[] {
  if (!s) return [];
  const ins: ResolvedPort[] = s.inputs
    .filter((i) => i.kind === "external")
    .map((i) => ({ key: `in:${i.id}`, id: `in:${i.id}`, label: i.longName, dir: "in", type: i.port ?? undefined, group: "inputs", input: i.id }));
  const outs: ResolvedPort[] = [{ key: "pgm", id: "pgm", label: "Program", dir: "out", group: "outputs" }];
  for (let n = 1; n <= s.auxes; n++) outs.push({ key: `aux:${n}`, id: `aux:${n}`, label: `Aux ${n}`, dir: "out", group: "outputs" });
  for (let n = 1; n <= s.multiviewers; n++) outs.push({ key: `mv:${n}`, id: `mv:${n}`, label: s.multiviewers > 1 ? `Multiview ${n}` : "Multiview", dir: "out", group: "outputs" });
  return [...ins, ...outs];
}

// ---- links ---------------------------------------------------------------------------

export interface LinkEnd {
  device: string;
  port: string;
}
export interface Link {
  id: string;
  from: LinkEnd;
  to: LinkEnd;
  cable: Cable;
  label: string;
}

/** Why a new cable is not allowed, or null. `ports(device)` returns the device's ports (undefined = unknown device). */
export function linkError(from: LinkEnd, to: LinkEnd, ports: (device: string) => ResolvedPort[] | undefined, links: Link[], ignoreId?: string): string | null {
  const fp = ports(from.device);
  const tp = ports(to.device);
  if (!fp || !tp) return "unknown_device";
  if (from.device === to.device) return "same_device";
  const a = fp.find((p) => p.key === from.port);
  const b = tp.find((p) => p.key === to.port);
  if (!a || !b) return "unknown_port";
  if (a.dir !== "out" || b.dir !== "in") return "direction";
  if (links.some((l) => l.id !== ignoreId && l.to.device === to.device && l.to.port === to.port)) return "input_taken";
  return null;
}

/** Drops links whose ports no longer exist (a card or ATEM input was removed). */
export function danglingLinks(links: Link[], ports: (device: string) => ResolvedPort[] | undefined): Link[] {
  const has = (e: LinkEnd) => !!ports(e.device)?.some((p) => p.key === e.port);
  return links.filter((l) => !has(l.from) || !has(l.to));
}

// ---- layout ----------------------------------------------------------------------------

export interface LayoutDevice {
  id: string;
  ports: number;
  /** Port keys top to bottom, so devices line up with the input they feed. */
  portOrder?: string[];
}
export const COLUMN_WIDTH = 420;
const ROW_GAP = 40;
const deviceHeight = (ports: number) => 96 + ports * 26;

/**
 * Columns by signal flow: sources (no incoming cables) on the left, every device one column right of its furthest
 * upstream device, so ATEM chains read left to right as a hierarchy. Within a column devices are ordered by the
 * average row of what feeds them, which keeps cables from crossing.
 */
export function autoLayout(devices: LayoutDevice[], links: Link[]): Record<string, { x: number; y: number }> {
  const ids = new Set(devices.map((d) => d.id));
  const edges = links.filter((l) => ids.has(l.from.device) && ids.has(l.to.device) && l.from.device !== l.to.device);
  const level = new Map(devices.map((d) => [d.id, 0]));
  // Longest path; bounded passes so a (wrongly drawn) loop cannot hang.
  for (let pass = 0; pass < devices.length; pass++) {
    let moved = false;
    for (const e of edges) {
      const want = level.get(e.from.device)! + 1;
      if (want > level.get(e.to.device)! && want < devices.length) {
        level.set(e.to.device, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns = new Map<number, LayoutDevice[]>();
  for (const d of devices) {
    const l = level.get(d.id)!;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l)!.push(d);
  }
  const byId = new Map(devices.map((d) => [d.id, d]));
  const rank = new Map<string, number>();
  const levels = [...columns.keys()].sort((a, b) => a - b);
  // Left to right: order by what feeds a device. Then right to left: order by the device + input a device feeds,
  // so a source sits next to the input it is cabled to.
  const place = (l: number, score: (d: LayoutDevice) => number) => {
    const col = columns.get(l)!;
    col.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
    col.forEach((d, i) => rank.set(d.id, i));
  };
  for (const l of levels)
    place(l, (d) => {
      const ups = edges.filter((e) => e.to.device === d.id && rank.has(e.from.device)).map((e) => rank.get(e.from.device)!);
      return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : Number.MAX_SAFE_INTEGER;
    });
  for (const l of [...levels].reverse())
    place(l, (d) => {
      const downs = edges
        .filter((e) => e.from.device === d.id && level.get(e.to.device)! > l)
        .map((e) => (level.get(e.to.device)! - l) * 1e6 + rank.get(e.to.device)! * 1000 + Math.max(0, byId.get(e.to.device)!.portOrder?.indexOf(e.to.port) ?? 0));
      return downs.length ? Math.min(...downs) : 1e12 + rank.get(d.id)!;
    });
  const out: Record<string, { x: number; y: number }> = {};
  for (const l of levels) {
    let y = 0;
    for (const d of columns.get(l)!) {
      out[d.id] = { x: l * COLUMN_WIDTH, y };
      y += deviceHeight(d.ports) + ROW_GAP;
    }
  }
  return out;
}

// ---- tally -----------------------------------------------------------------------------

export interface AtemTallyState {
  program: (number | null)[];
  preview: (number | null)[];
  /** Source per aux bus (ATEM source ids: inputs, or 10010 = M/E 1 program, 10011 = M/E 1 preview, 10020 = M/E 2 ...). */
  auxSources: (number | null)[];
}
export type LinkTally = "air" | "program" | "preview" | null;

/** The ATEM input an output port carries, or null when it is not an input (black, bars, multiview, ...). */
function sourceOf(st: AtemTallyState, port: string, kind: "program" | "preview"): number | null {
  const me = (n: number, which: "program" | "preview") => (which === "program" ? st.program[n] : st.preview[n]) ?? null;
  if (port === "pgm") return me(0, kind);
  const aux = /^aux:(\d+)$/.exec(port);
  if (!aux) return null;
  const src = st.auxSources[Number(aux[1]) - 1] ?? null;
  if (src == null) return null;
  if (src >= 10010 && src < 10100 && src % 10 <= 1) return me(Math.floor((src - 10010) / 10), src % 10 === 0 ? kind : "preview");
  return src;
}

/**
 * Colours the cables: "program" / "preview" = into the input an ATEM has on program / preview (M/E 1), "air" = part
 * of the chain that ends at a final ATEM's program (its program output is not cabled into another ATEM), traced back
 * through upstream ATEMs' program / aux outputs. `atems` maps diagram device id → switcher state.
 */
export function trace(links: Link[], atems: Record<string, AtemTallyState>): Record<string, LinkTally> {
  const out: Record<string, LinkTally> = {};
  const into = (device: string, input: number | null) => (input == null ? undefined : links.find((l) => l.to.device === device && l.to.port === `in:${input}`));
  for (const [dev, st] of Object.entries(atems)) {
    const pv = into(dev, st.preview[0] ?? null);
    if (pv) out[pv.id] = "preview";
  }
  for (const [dev, st] of Object.entries(atems)) {
    const pg = into(dev, st.program[0] ?? null);
    if (pg) out[pg.id] = "program";
  }
  const finals = Object.keys(atems).filter((dev) => !links.some((l) => l.from.device === dev && l.from.port === "pgm" && atems[l.to.device]));
  for (const dev of finals) {
    const seen = new Set<string>();
    let cur: string | undefined = dev;
    let input = atems[dev]!.program[0] ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const l = into(cur, input);
      if (!l) break;
      out[l.id] = "air";
      const up: AtemTallyState | undefined = atems[l.from.device];
      if (!up) break;
      input = sourceOf(up, l.from.port, "program");
      cur = l.from.device;
    }
  }
  return out;
}
