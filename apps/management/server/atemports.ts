/**
 * ATEM inputs as the physical ports on the back of the switcher (docs/atem-ports.md). Pure: shared by the server and
 * the web UI, so a channel says "SDI in 8 · CASPARCG01" instead of a bare input number.
 *
 * The switcher itself reports per input whether it is an external connector and which kind (SDI, HDMI, ...),
 * so this works for every model without a hand-made table: a Television Studio HD reports 1-4 HDMI and 5-8 SDI,
 * a Production Studio 4K reports SDI. The input number is the number printed on the connector.
 */

/** Connector kinds the ATEM reports (atem-connection `ExternalPortType` keys) and how they are written. */
const PORT_TEXT: Record<string, string> = {
  SDI: "SDI",
  HDMI: "HDMI",
  Component: "Component",
  Composite: "Composite",
  SVideo: "S-Video",
};

export interface PortInput {
  id: number;
  longName: string;
  shortName: string;
  external: boolean;
  /** Connector kind (ExternalPortType key, e.g. "SDI"); null/absent when unknown. */
  port?: string | null;
  /** True while the ATEM still has its factory name for this input. */
  namesDefault?: boolean;
}

export type PortParts =
  /** A connector on the back: `port` is "SDI"/"HDMI"/... or null when the switcher did not say. `name` is the
   *  input's own name, null while it is still the factory name ("Camera 8") or equals the connector text. */
  | { kind: "physical"; number: number; port: string | null; name: string | null }
  /** Black, colour bars, colour generator, media player, SuperSource: the ATEM's own name. */
  | { kind: "internal"; number: number; name: string }
  /** The input is not (or no longer) known: only the number. */
  | { kind: "unknown"; number: number };

/** Factory names: "Camera 8", "Input 8", "HDMI 1", "SDI 5", "Cam8", "8". */
const DEFAULT_NAME = /^(camera|cam|input|in|hdmi|sdi)?\s*\d+$/i;

export function portText(port: string | null | undefined): string | null {
  if (!port) return null;
  return PORT_TEXT[port] ?? null;
}

export function portParts(inputs: readonly PortInput[] | null | undefined, number: number): PortParts {
  const i = inputs?.find((x) => x.id === number);
  if (!i) return { kind: "unknown", number };
  if (!i.external) return { kind: "internal", number, name: i.longName || i.shortName || String(number) };
  const name = i.longName.trim();
  const port = portText(i.port);
  const isDefault = i.namesDefault === true || !name || DEFAULT_NAME.test(name) || (port != null && name.toUpperCase() === `${port} ${number}`.toUpperCase());
  return { kind: "physical", number, port, name: isDefault ? null : name };
}

/** Inputs split for a picker: the connectors first (by number), then the ATEM's internal sources. */
export function groupInputs<T extends PortInput>(inputs: readonly T[]): { physical: T[]; internal: T[] } {
  const sorted = [...inputs].sort((a, b) => a.id - b.id);
  return { physical: sorted.filter((i) => i.external), internal: sorted.filter((i) => !i.external) };
}

/** "HDMI 1-4 · SDI 5-8": the connector layout of a switcher in one line, for documentation and the Devices page. */
export function portSummary(inputs: readonly PortInput[]): string {
  const groups: { port: string; from: number; to: number }[] = [];
  for (const i of groupInputs(inputs).physical) {
    const port = portText(i.port) ?? "?";
    const last = groups[groups.length - 1];
    if (last && last.port === port && last.to === i.id - 1) last.to = i.id;
    else groups.push({ port, from: i.id, to: i.id });
  }
  return groups.map((g) => `${g.port} ${g.from === g.to ? g.from : `${g.from}-${g.to}`}`).join(" · ");
}
