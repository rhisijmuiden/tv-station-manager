/**
 * HyperDeck helpers shared by the orchestrator server and its web UI (pure: no I/O).
 */
import { cardFromPreset, type Card } from "./diagramlogic.js";

export type TransportStatus = "preview" | "stopped" | "play" | "forward" | "rewind" | "jog" | "shuttle" | "record";
export type SlotStatus = "empty" | "mounting" | "error" | "mounted";

export interface HyperdeckSlot {
  id: number;
  status: SlotStatus;
  volumeName: string;
  /** Recording time left on this slot in the current format, in seconds. */
  recordingTime: number;
  videoFormat: string | null;
}
export interface HyperdeckSnapshot {
  /** As the deck reports it, e.g. "HyperDeck Studio 4K Pro". */
  model: string;
  protocolVersion: number | null;
  transport: {
    status: TransportStatus;
    speed: number;
    slotId: number | null;
    clipId: number | null;
    timecode: string;
    displayTimecode: string;
    videoFormat: string | null;
    /** Format seen on the selected input (newer models). */
    inputVideoFormat: string | null;
    loop: boolean;
  };
  slots: HyperdeckSlot[];
  /** Selected recording input (SDI / HDMI / ...) and codec. */
  videoInput: string | null;
  fileFormat: string | null;
  /** "Remote" must be enabled on the deck, otherwise transport commands are refused. */
  remoteEnabled: boolean | null;
}

/** Diagram card preset per HyperDeck family (connectors from Blackmagic's tech specs). */
export function hyperdeckPreset(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (/hd\s*mini/.test(m)) return "hyperdeck-studio-hd-mini";
  if (/studio/.test(m) && /(4k|hd)\s*(pro|plus)/.test(m)) return "hyperdeck-studio-pro";
  if (/extreme/.test(m)) return "hyperdeck-extreme";
  return "hyperdeck";
}
export const hyperdeckCards = (model: string | null | undefined): Card[] => [{ ...cardFromPreset(hyperdeckPreset(model), "c1"), name: model?.trim() || "HyperDeck" }];

/** Recording time left on the active (or first mounted) slot, in seconds; null when nothing is mounted. */
export function recordTimeLeft(s: HyperdeckSnapshot | null | undefined): number | null {
  if (!s) return null;
  const mounted = s.slots.filter((x) => x.status === "mounted");
  const active = mounted.find((x) => x.id === s.transport.slotId) ?? mounted[0];
  return active ? active.recordingTime : null;
}

/** Below this many seconds left the UI warns (and the orchestrator mails once while recording). */
export const LOW_RECORD_TIME_S = 15 * 60;

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Clip name the deck records into: letters, digits, space, dash and underscore only (the protocol is line based). */
export function cleanClipName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
