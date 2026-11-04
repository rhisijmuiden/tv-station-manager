/**
 * Pure: the channel as a stack of layers. Content plays at the bottom; the base layer (logo, clock, ticker) sits on top.
 * Per kind of content the channel decides which parts of the base layer stay on air, e.g. no logo during a beeldkrant
 * (it carries its own logo) or during commercials. Stored in the channel's graphics JSON as `layers`.
 */
import { z } from "zod";

export const LAYER_KINDS = ["media", "beeldkrant", "webcam", "live", "lineup", "info", "commercial", "filler"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

const part = (on: boolean) => z.object({ logo: z.boolean().default(on), clock: z.boolean().default(on), ticker: z.boolean().default(on) }).default({ logo: on, clock: on, ticker: on });
export type LayerRule = { logo: boolean; clock: boolean; ticker: boolean };

/** The defaults keep what the director always did: a beeldkrant, webcam, coming-up slide, info page or commercial hides the overlay. */
export const layersSchema = z.object({
  media: part(true),
  beeldkrant: part(false),
  webcam: part(false),
  live: part(true),
  lineup: part(false),
  info: part(false),
  commercial: part(false),
  filler: part(true),
});
export type Layers = z.infer<typeof layersSchema>;

export interface LayerEvent {
  type: "media" | "live" | "beeldkrant" | "webcam" | "lineup" | "info" | "filler";
  leaf?: { blockKind?: "program" | "commercial"; category?: string; showOverlay?: boolean };
}

/** Which kind of content an on-air event is, for the layer rules. Commercials win over the item type. */
export function layerKind(e: LayerEvent | null | undefined): LayerKind {
  if (!e) return "filler";
  if (e.leaf?.blockKind === "commercial" || e.leaf?.category === "commercial") return "commercial";
  return e.type;
}

const ALL_ON: LayerRule = { logo: true, clock: true, ticker: true };

/**
 * What of the base layer is on air for an event. A beeldkrant or webcam that asks to keep the overlay
 * ("show the channel overlay" on the beeldkrant/webcam itself) shows it all.
 */
export function baseLayer(layers: Layers, e: LayerEvent | null | undefined): LayerRule & { kind: LayerKind } {
  const kind = layerKind(e);
  const keep = (kind === "beeldkrant" || kind === "webcam" || kind === "info") && !!e?.leaf?.showOverlay;
  return { kind, ...(keep ? ALL_ON : layers[kind]) };
}
