/**
 * Teranex helpers shared by the orchestrator server and its web UI (pure: no I/O).
 *
 * Blackmagic Teranex converters (Teranex AV, Express, 2D / 3D processor) speak the Teranex Ethernet Protocol on TCP
 * 9800: plain text blocks like Videohub. A block is a header line ending in ":" and "Key: value" lines, closed by an
 * empty line. Right after connecting the device sends its whole status (PROTOCOL PREAMBLE, TERANEX DEVICE,
 * VIDEO INPUT, VIDEO OUTPUT, GENLOCK, ...) and later the blocks that change.
 * The orchestrator only READS: it never sends a block that changes a setting, only PING as keep-alive.
 */
import { cardFromPreset, type Card } from "./diagramlogic.js";

export interface TeranexBlock {
  header: string;
  fields: Record<string, string>;
}

/** Splits protocol text into complete blocks; `rest` is an unfinished block to keep for the next chunk. */
export function parseBlocks(text: string): { blocks: TeranexBlock[]; rest: string } {
  const norm = text.replace(/\r\n?/g, "\n");
  const blocks: TeranexBlock[] = [];
  let pos = 0;
  for (;;) {
    const end = norm.indexOf("\n\n", pos);
    if (end < 0) break;
    const lines = norm.slice(pos, end).split("\n");
    pos = end + 2;
    // Leading empty lines (the device sometimes sends an extra one) are skipped.
    while (lines.length && !lines[0]!.trim()) lines.shift();
    if (!lines.length) continue;
    const head = lines.shift()!.trim();
    // "ACK" / "NAK" answers have no colon.
    if (!head.endsWith(":")) {
      blocks.push({ header: head, fields: {} });
      continue;
    }
    const fields: Record<string, string> = {};
    for (const l of lines) {
      const i = l.indexOf(":");
      if (i <= 0) continue;
      fields[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    blocks.push({ header: head.slice(0, -1).trim().toUpperCase(), fields });
  }
  // Whitespace between blocks is not an unfinished block.
  const rest = norm.slice(pos);
  return { blocks, rest: rest.trim() ? rest : "" };
}

export interface TeranexSnapshot {
  /** As the device reports it, e.g. "Teranex AV". */
  model: string;
  protocolVersion: string | null;
  softwareVersion: string | null;
  label: string | null;
  uniqueId: string | null;
  input: {
    /** SDI / HDMI / Optical / Analog ... */
    videoSource: string | null;
    /** Embedded / AES / Analog ... */
    audioSource: string | null;
    /** Format seen on the input, e.g. "1080i50". */
    videoMode: string | null;
    /** null when the device does not report it. */
    signalPresent: boolean | null;
  };
  output: { videoMode: string | null; option: string | null };
  genlock: { reference: string | null; locked: boolean | null };
  /** Every block as last reported, for the read-only "all settings" view. */
  blocks: Record<string, Record<string, string>>;
}

export const emptySnapshot = (): TeranexSnapshot => ({
  model: "Teranex",
  protocolVersion: null,
  softwareVersion: null,
  label: null,
  uniqueId: null,
  input: { videoSource: null, audioSource: null, videoMode: null, signalPresent: null },
  output: { videoMode: null, option: null },
  genlock: { reference: null, locked: null },
  blocks: {},
});

/** Field lookup without caring about case ("Video mode" / "Video Mode"). */
function pick(fields: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const k = Object.keys(fields).find((f) => f.toLowerCase() === n.toLowerCase());
    if (k != null && fields[k] !== "") return fields[k];
  }
  return undefined;
}
export function yesNo(v: string | undefined): boolean | null | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (["true", "yes", "on", "1", "locked", "present"].includes(s)) return true;
  if (["false", "no", "off", "0", "unlocked", "none", "not present", "absent"].includes(s)) return false;
  return null;
}

/** Folds one status block into the snapshot (in place). Returns false for blocks that carry no status (ACK / NAK). */
export function applyBlock(s: TeranexSnapshot, b: TeranexBlock): boolean {
  if (b.header === "ACK" || b.header === "NAK" || !Object.keys(b.fields).length) return false;
  s.blocks[b.header] = { ...(s.blocks[b.header] ?? {}), ...b.fields };
  const f = b.fields;
  switch (b.header) {
    case "PROTOCOL PREAMBLE":
      s.protocolVersion = pick(f, "Version") ?? s.protocolVersion;
      break;
    case "TERANEX DEVICE":
    case "DEVICE":
      s.model = pick(f, "Model name", "Model", "Device name") ?? s.model;
      s.softwareVersion = pick(f, "Software version", "Software Version", "Firmware version") ?? s.softwareVersion;
      s.label = pick(f, "Label", "Device label", "Friendly name") ?? s.label;
      s.uniqueId = pick(f, "Unique ID", "Unique id") ?? s.uniqueId;
      break;
    case "VIDEO INPUT": {
      s.input.videoSource = pick(f, "Video source", "Input") ?? s.input.videoSource;
      s.input.audioSource = pick(f, "Audio source") ?? s.input.audioSource;
      s.input.videoMode = pick(f, "Video mode", "Video format") ?? s.input.videoMode;
      const sig = yesNo(pick(f, "Signal present", "Signal"));
      if (sig !== undefined) s.input.signalPresent = sig;
      break;
    }
    case "VIDEO OUTPUT":
      s.output.videoMode = pick(f, "Video mode", "Video format") ?? s.output.videoMode;
      s.output.option = pick(f, "Output option") ?? s.output.option;
      break;
    case "GENLOCK": {
      s.genlock.reference = pick(f, "Gen reference", "Reference", "Type") ?? s.genlock.reference;
      const l = yesNo(pick(f, "Signal locked", "Locked"));
      if (l !== undefined) s.genlock.locked = l;
      break;
    }
  }
  return true;
}

/** "1080i50", "1080i 50", "1080I50" -> "1080i50": compare formats without caring about spaces / case. */
export const normFormat = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toLowerCase();

/** Input formats as the front panel shows them, for the "expected input" picker. */
export const COMMON_FORMATS = ["1080i50", "1080p25", "1080p50", "720p50", "576i50", "2160p25", "2160p50", "1080i59.94", "1080p29.97", "1080p59.94", "720p59.94", "486i59.94"];

/** Diagram card preset per Teranex family (connectors from Blackmagic's tech specs). */
export function teranexPreset(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (/\bav\b/.test(m)) return "teranex-av";
  if (/express/.test(m)) return "teranex-express";
  if (/2d|3d|processor/.test(m)) return "teranex-processor";
  return "teranex";
}
export const teranexCards = (model: string | null | undefined): Card[] => [{ ...cardFromPreset(teranexPreset(model), "c1"), name: model?.trim() || "Teranex" }];

/** Front-panel style buttons: which one is lit for the reported source. */
export function sourceKey(v: string | null | undefined): "sdi" | "hdmi" | "optical" | "analog" | "embedded" | "aes" | null {
  const s = (v ?? "").toLowerCase();
  if (!s) return null;
  if (s.includes("hdmi")) return "hdmi";
  if (s.includes("opt") || s.includes("fiber") || s.includes("fibre")) return "optical";
  if (s.includes("embed")) return "embedded";
  if (s.includes("aes")) return "aes";
  if (s.includes("anal") || s.includes("anlg") || s.includes("component") || s.includes("composite")) return "analog";
  if (s.includes("sdi")) return "sdi";
  return null;
}
