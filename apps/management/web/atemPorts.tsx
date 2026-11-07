import { useTranslation } from "react-i18next";
import { useChannels, useGet } from "./lib";
import { groupInputs, portParts, type PortInput } from "../server/atemports";

type T = (k: string, o?: Record<string, unknown>) => string;

/**
 * An ATEM input as its connector: "SDI in 8 · CASPARCG01", "HDMI in 2", "Colour bars" (docs/atem-ports.md).
 * `withName: false` leaves the input's own name off ("SDI in 8").
 */
export function portLabel(t: T, inputs: readonly PortInput[] | null | undefined, n: number, opts: { withName?: boolean } = {}): string {
  const p = portParts(inputs, n);
  if (p.kind === "internal") return p.name;
  const base = p.kind === "physical" && p.port ? t("mgmt.atemPorts.port", { port: p.port, n }) : t("mgmt.atemPorts.input", { n });
  return p.kind === "physical" && p.name && opts.withName !== false ? `${base} · ${p.name}` : base;
}

export function usePortLabel() {
  const { t } = useTranslation();
  return (inputs: readonly PortInput[] | null | undefined, n: number, opts?: { withName?: boolean }) => portLabel(t, inputs, n, opts);
}

/** Picker options: the connectors on the back first, then the switcher's own sources (black, bars, media players). */
export function PortOptions({ inputs }: { inputs: readonly PortInput[] }) {
  const { t } = useTranslation();
  const { physical, internal } = groupInputs(inputs);
  return (
    <>
      {physical.length > 0 && (
        <optgroup label={t("mgmt.atemPorts.physical")}>
          {physical.map((i) => (
            <option key={i.id} value={i.id}>
              {portLabel(t, inputs, i.id)}
            </option>
          ))}
        </optgroup>
      )}
      {internal.length > 0 && (
        <optgroup label={t("mgmt.atemPorts.internal")}>
          {internal.map((i) => (
            <option key={i.id} value={i.id}>
              {portLabel(t, inputs, i.id)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

interface AtemRow {
  id: number;
  status: { inputs: PortInput[] };
}

/** The inputs of the ATEM each channel switches on (last known when the switcher is offline). */
export function useChannelInputs(): (channelId: number | null | undefined) => PortInput[] | undefined {
  const { channels } = useChannels();
  const atems = useGet<{ atems: AtemRow[] }>("/api/atems", 30000);
  return (channelId) => {
    const ch = channels?.find((c) => c.id === channelId);
    return atems.data?.atems.find((a) => a.id === ch?.atemId)?.status.inputs;
  };
}
