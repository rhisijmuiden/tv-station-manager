/**
 * Physical front-panel layout per ATEM model family. Pure (tested in test/atemLayout.test.ts).
 *
 * The drawing is a faithful-but-simplified picture of the hardware: the number of source buttons matches the
 * model, the labels and tally come from the switcher itself. Unknown models fall back to a generic panel
 * derived from what the switcher reports.
 */

export interface PanelInput {
  id: number;
  longName: string;
  shortName: string;
  kind: "external" | "black" | "bars" | "color" | "mediaplayer" | "supersource" | "other";
  port: string | null;
}

/** mini = ATEM Mini / Mini Pro / SDI, extreme = Mini Extreme, studio = Television Studio with built-in panel, rack = rack-mount unit. */
export type PanelFamily = "mini" | "extreme" | "studio" | "rack" | "generic";

export interface PanelSpec {
  family: PanelFamily;
  /** Physical source buttons per row (program / preview / source). */
  sourceButtons: number;
  /** Rows of source buttons, top to bottom. */
  rows: ("program" | "preview" | "source")[];
  /** Streaming / recording keys (Pro and ISO models). */
  streaming: boolean;
  /** Per-input audio keys above the source buttons (ATEM Mini family). */
  audio: boolean;
  /** Video output selector row (Mini Pro / Extreme). */
  outputSelect: boolean;
  tbar: boolean;
  lcd: boolean;
  /** Height in rack units for rack models. */
  rackUnits: number;
}

const MINI = ["Mini", "MiniPro", "MiniProISO", "SDI", "SDIProISO"];
const EXTREME = ["MiniExtreme", "MiniExtremeISO", "MiniExtremeISOG2", "SDIExtremeISO"];
const STUDIO = ["TVSProHD", "TVSPro4K", "TelevisionStudioHD8", "TelevisionStudioHD8ISO", "TelevisionStudio4K8"];
const RACK = [
  "TVS",
  "TVSHD",
  "OneME",
  "TwoME",
  "PS4K",
  "OneME4K",
  "TwoME4K",
  "TwoMEBS4K",
  "Constellation",
  "Constellation8K",
  "ConstellationHD1ME",
  "ConstellationHD2ME",
  "ConstellationHD4ME",
  "Constellation4K1ME",
  "Constellation4K2ME",
  "Constellation4K4ME",
  "Constellation4K4MEPlus",
];
const STREAMING = ["MiniPro", "MiniProISO", "SDIProISO", ...EXTREME];

export function familyOf(modelKey: string): PanelFamily {
  if (MINI.includes(modelKey)) return "mini";
  if (EXTREME.includes(modelKey)) return "extreme";
  if (STUDIO.includes(modelKey)) return "studio";
  if (RACK.includes(modelKey)) return "rack";
  return "generic";
}

export function panelFor(modelKey: string, info: { inputs: PanelInput[]; mixEffects: number }): PanelSpec {
  const family = familyOf(modelKey);
  const externals = info.inputs.filter((i) => i.kind === "external").length;
  const base = { streaming: STREAMING.includes(modelKey), audio: false, outputSelect: false, tbar: false, lcd: false, rackUnits: 0 };
  switch (family) {
    case "mini":
      return { ...base, family, sourceButtons: 4, rows: ["source"], audio: true, outputSelect: base.streaming };
    case "extreme":
      return { ...base, family, sourceButtons: 8, rows: ["source"], audio: true, outputSelect: true };
    case "studio":
      // Inputs plus black and the media players on the same row, like the hardware.
      return { ...base, family, sourceButtons: Math.max(8, externals) + 3, rows: ["program", "preview"], tbar: true, lcd: true };
    case "rack":
      return { ...base, family, sourceButtons: Math.min(20, Math.max(8, externals)), rows: ["source"], lcd: true, rackUnits: info.mixEffects > 1 || externals > 20 ? 2 : 1 };
    default:
      return { ...base, family, sourceButtons: Math.min(20, Math.max(4, info.inputs.length)), rows: ["program", "preview"], tbar: true };
  }
}

/**
 * Which switcher source sits under each physical button, left to right. `null` = a button without a source
 * (e.g. a model with fewer inputs connected than buttons).
 */
export function buttonSources(spec: PanelSpec, inputs: PanelInput[]): (PanelInput | null)[] {
  const ext = inputs.filter((i) => i.kind === "external");
  let order: PanelInput[];
  if (spec.family === "mini" || spec.family === "extreme") order = ext;
  else if (spec.family === "studio") {
    const black = inputs.filter((i) => i.kind === "black");
    const mp = inputs.filter((i) => i.kind === "mediaplayer").slice(0, 2);
    const ins = ext.slice(0, spec.sourceButtons - black.length - mp.length);
    order = [...ins, ...Array<PanelInput | null>(Math.max(0, spec.sourceButtons - ins.length - black.length - mp.length)).fill(null), ...black, ...mp] as PanelInput[];
  } else if (spec.family === "rack") order = ext;
  else order = inputs;
  return Array.from({ length: spec.sourceButtons }, (_, i) => order[i] ?? null);
}

/** Text printed on a key cap: the input number for physical inputs, otherwise the short name. */
export const capLabel = (i: PanelInput) => (i.kind === "external" ? String(i.id) : i.shortName);
