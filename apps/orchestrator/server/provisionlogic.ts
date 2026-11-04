/**
 * Pure planning for "provision" commands (role change / software installation on a Windows node). The orchestrator
 * shows the plan before anything happens and checks it again when the command is queued, so the confirmation
 * (typing the node name when the node is on air) cannot be skipped. Shared with the web UI for the role mapping.
 */
import type { InstallerRole, NodeInventory, ProvisionComponent, StudioRole, StudioStatus } from "@tvsm/platform/agent-protocol";
import { z } from "zod";

/** Orchestrator node role ↔ installer role. */
export const PROVISION_ROLES = ["playout", "live", "studio", "none"] as const;
export type ProvisionRole = (typeof PROVISION_ROLES)[number];
export const installerRole = (r: ProvisionRole): InstallerRole => ({ playout: "tv", live: "ingest", studio: "both", none: "none" } as const)[r];
/** The node role (orchestrator) a provisioned node gets. */
export const nodeRoleAfter = (r: ProvisionRole) => (r === "none" ? "other" : r);

export const VIDEO_MODES = ["1080i5000", "1080p5000", "1080p2500", "720p5000", "1080i5994", "1080p2997", "1080p5994", "720p5994", "2160p5000", "2160p2500"] as const;

export const provisionRequestSchema = z.object({
  role: z.enum(PROVISION_ROLES),
  /** Empty = keep what the node has (or 1 on a bare node). */
  outputs: z.number().int().min(1).max(8).optional(),
  videoMode: z.enum(VIDEO_MODES).optional(),
  keyer: z.enum(["default", "external", "internal"]).optional(),
  htmlGpu: z.enum(["auto", "on", "off"]).optional(),
  mediaPath: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^\\\\[^\\]+\\[^\\]+/.test(v) || /^[A-Za-z]:\\/.test(v), "unc_or_local")
    .optional(),
  smbUser: z.string().trim().max(200).optional(),
  smbPassword: z.string().max(500).optional(),
  managementHosts: z.array(z.string().trim().min(1).max(253)).max(4).optional(),
  components: z.array(z.enum(["vcredist", "ffmpeg", "decklink"])).max(3).default([]),
  rebootWhenDone: z.boolean().default(false),
  /** The node name, typed by the user; required when the plan says so. */
  confirmName: z.string().max(200).optional(),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export type Level = "block" | "danger" | "warn" | "info";
export interface PlanItem {
  key: string;
  params?: Record<string, string | number>;
}
export interface PlanWarning extends PlanItem {
  level: Level;
}
export interface ProvisionPlan {
  steps: PlanItem[];
  warnings: PlanWarning[];
  /** Something blocks the job (offline, not Windows, another job running, missing input). */
  blocked: boolean;
  /** The user has to type the node name: the node is on air or its playout is removed. */
  requireTypedName: boolean;
  /** SDI outputs go black for a moment (CasparCG restart) or stop. */
  disruptive: boolean;
}

export interface PlanNode {
  name: string;
  platform: string | null;
  online: boolean;
  role: string;
  agentCapabilities: string[];
  studio: StudioStatus | null;
  inventory: NodeInventory | null;
  /** A provisioning job is queued or running. */
  busy: boolean;
}

/** Where this node is on air: an ATEM input fed by the node (atem_inputs.node_id) on program or preview. */
export interface OnAir {
  atem: string;
  input: number;
  inputName: string;
  bus: "program" | "preview";
}

export interface PlanContext {
  onAir: OnAir[];
  /** Desktop Video installer source configured in the agent settings. */
  deckLinkSource: string;
}

const studioRoleOf = (r: ProvisionRole): StudioRole | null => (r === "none" ? null : r);

export function planProvision(node: PlanNode, req: ProvisionRequest, ctx: PlanContext): ProvisionPlan {
  const steps: PlanItem[] = [];
  const warnings: PlanWarning[] = [];
  const warn = (level: Level, key: string, params?: PlanItem["params"]) => warnings.push({ level, key, ...(params ? { params } : {}) });
  const inv = node.inventory;
  const studio = node.studio;
  const hasStudio = !!studio;
  const target = studioRoleOf(req.role);
  const components = new Set<ProvisionComponent>(req.components);

  if (node.platform !== "win32") warn("block", "notWindows");
  if (!node.online) warn("block", "offline");
  if (node.busy) warn("block", "busy");
  if (components.has("decklink") && !ctx.deckLinkSource) warn("block", "deckLinkNoSource");
  if (req.smbUser && !req.smbPassword) warn("block", "smbPasswordMissing");
  if (req.role !== "none" && !req.mediaPath && !studio?.mediaPath) warn("warn", "noMediaPath");

  // ---- on air ----------------------------------------------------------------------------------
  for (const a of ctx.onAir) {
    const params = { atem: a.atem, input: a.input, name: a.inputName || String(a.input) };
    if (a.bus === "program") warn("danger", "onAirProgram", params);
    else warn("warn", "onAirPreview", params);
  }
  const inUse = studio?.ingest.streams.filter((s) => s.ready && s.readers > 0).length ?? 0;
  if (inUse > 0) warn("warn", "liveInUse", { n: inUse });

  // ---- steps -----------------------------------------------------------------------------------
  if (!node.agentCapabilities.includes("provision")) {
    steps.push({ key: "updateAgent" });
    warn("info", "agentUpdateFirst");
  }
  if (req.role === "none") {
    if (hasStudio) {
      steps.push({ key: "disableStudio" });
      warn("danger", "removeStudio");
    } else warn("info", "nothingToRemove");
  } else {
    const needsVc = !inv?.vcredist;
    if (components.has("vcredist") || needsVc) {
      components.add("vcredist");
      steps.push({ key: "vcredist", params: { state: inv?.vcredist ? "update" : "install" } });
    }
    if (components.has("decklink")) {
      steps.push({ key: "decklink", params: { current: inv?.desktopVideo ?? "–" } });
      warn("warn", "deckLinkReboot");
    } else if (inv && !inv.desktopVideo) warn("warn", "noDeckLink");
    if (components.has("ffmpeg")) steps.push({ key: "ffmpeg", params: { current: inv?.ffmpeg ?? "–" } });
    steps.push({ key: "casparcg", params: { current: inv?.casparcg ?? "–" } });
    steps.push({ key: "mediamtx", params: { current: inv?.mediamtx ?? "–" } });
    const before = studio?.outputs.length ?? 0;
    const outputs = req.outputs ?? (before || 1);
    const mode = req.videoMode ?? studio?.outputs[0]?.format ?? "1080i5000";
    steps.push({ key: "config", params: { outputs, mode } });
    if (before > outputs) warn("warn", "outputsFewer", { from: before, to: outputs });
    if (studio?.outputs[0] && studio.outputs[0].format !== mode) warn("warn", "videoModeChange", { from: studio.outputs[0].format, to: mode });
    if (inv && inv.decklinks.length > 0 && outputs > inv.decklinks.length) warn("warn", "moreOutputsThanDevices", { outputs, devices: inv.decklinks.length });
    if (req.mediaPath || req.smbUser) steps.push({ key: "share", params: { path: req.mediaPath || studio?.mediaPath || "" } });
    steps.push({ key: "firewall" });
    if (!req.managementHosts?.length) warn("warn", "noManagementHost");
    steps.push({ key: "restartServices" });
    if (hasStudio) warn("warn", "casparRestart");
  }
  const reboot = req.rebootWhenDone;
  if (reboot) {
    steps.push({ key: "reboot" });
    warn("warn", "rebootPlanned");
  } else if (components.has("decklink")) warn("info", "rebootYourself");
  const after = nodeRoleAfter(req.role);
  steps.push({ key: "setRole", params: { role: after } });
  if (hasStudio && studio?.role !== target) warn("info", "managementSync");
  if (!hasStudio && target) warn("info", "managementAdd");

  const requireTypedName = warnings.some((w) => w.level === "danger");
  return {
    steps,
    warnings,
    blocked: warnings.some((w) => w.level === "block"),
    requireTypedName,
    disruptive: hasStudio || reboot,
  };
}

/** The node name the user typed matches (case and surrounding spaces ignored). */
export const confirmMatches = (typed: string | undefined, name: string) => !!typed && typed.trim().toLowerCase() === name.trim().toLowerCase();
