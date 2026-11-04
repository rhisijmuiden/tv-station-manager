/** Wire format between tvsm-agent (on a node) and the orchestrator. Shared by both sides. */

export const AGENT_API = "/agent-api/v1";

/** studio = playout + live on one node; playout = runs the schedule; live = RTMP/SRT ingest from events. */
export type NodeRole = "unassigned" | "management" | "studio" | "playout" | "live" | "other";
export type NodeStatus = "pending" | "approved" | "rejected";
export type CommandType = "restart-agent" | "reboot" | "update-agent" | "restart-casparcg" | "restart-ingest" | "provision";

/**
 * What an agent can do, sent in every heartbeat. The orchestrator holds back commands an agent does not support yet
 * (e.g. "provision" waits until the agent has updated itself).
 */
export type AgentCapability = "provision" | "inventory" | "auto-update";
export const AGENT_CAPABILITIES: AgentCapability[] = ["provision", "inventory", "auto-update"];

export interface NodeFacts {
  hostname: string;
  platform: NodeJS.Platform | string;
  os: string;
  arch: string;
  agentVersion: string;
  ips: string[];
  /** Missing on agents older than the provisioning release. */
  capabilities?: AgentCapability[];
}

export interface NodeMetrics {
  cpuCount: number;
  /** 0-100, averaged since the previous heartbeat. */
  cpuPercent: number;
  load1?: number;
  memTotal: number;
  memUsed: number;
  disks: { mount: string; total: number; used: number }[];
  uptimeSeconds: number;
  agentUptimeSeconds: number;
  /** Only on studio nodes (Windows + CasparCG), set up with install-studio.ps1. */
  studio?: StudioStatus;
  /** Installed software and hardware (Windows nodes), refreshed every few minutes. */
  inventory?: NodeInventory;
  /** Set while a provisioning job (role change / installation) runs on the node. */
  provisioning?: { commandId: number; step: string; startedAt: string } | null;
}

/** Software and hardware found on a (Windows) node; null = not installed / not found. */
export interface NodeInventory {
  collectedAt: string;
  os: string | null;
  powershell: string | null;
  /** Blackmagic Desktop Video (DeckLink driver) version. */
  desktopVideo: string | null;
  /** DeckLink devices Windows sees, e.g. "DeckLink Duo (1)". */
  decklinks: string[];
  gpu: { name: string; driver: string | null } | null;
  ffmpeg: string | null;
  vcredist: string | null;
  casparcg: string | null;
  mediamtx: string | null;
  /** Credentials for the media share are stored (smb.cred). */
  shareCredentials: boolean;
  /** Windows waits for a restart (driver or update installed). */
  rebootPending: boolean;
  /** Studio settings were parked by a "no studio role" change (studio.json.disabled). */
  studioParked: boolean;
}

/** Role as the Windows installer names it (install-studio.ps1 -Role), "none" = remove the studio services. */
export type InstallerRole = "tv" | "ingest" | "both" | "none";
export type ProvisionComponent = "vcredist" | "ffmpeg" | "decklink";

/** Payload of a "provision" command: what the node becomes and which software it installs. */
export interface ProvisionPayload {
  role: InstallerRole;
  outputs?: number;
  videoMode?: string;
  keyer?: "default" | "external" | "internal";
  htmlGpu?: "auto" | "on" | "off";
  mediaPath?: string;
  smbUser?: string;
  /** Only sent once; the orchestrator removes it from its database after delivery. */
  smbPassword?: string;
  managementHosts?: string[];
  managementUrl?: string;
  components: ProvisionComponent[];
  /** URL (https) or UNC path of the Blackmagic Desktop Video installer (.zip or .msi). */
  deckLinkSource?: string;
  rebootWhenDone?: boolean;
  channel: "production" | "test";
  repository: string;
}

/** Agent self-update policy sent by the orchestrator. Times are HH:MM in the node's local time; empty = any time. */
export interface AutoUpdatePolicy {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
}

const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** True when `now` (local time) falls inside the update window; a window may run past midnight (22:00-04:00). */
export function inUpdateWindow(now: Date, windowStart: string, windowEnd: string) {
  const a = minutesOf(windowStart);
  const b = minutesOf(windowEnd);
  if (a == null || b == null || a === b) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  return a < b ? t >= a && t < b : t >= a || t < b;
}

const assetArch = (arch: string) => ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[arch] ?? arch;
/** Release asset of the agent for a platform: the zip build-zip.sh makes on Windows, a .deb elsewhere. */
export const agentAssetName = (version: string, platform: string, arch = "x64") => {
  const v = version.replace(/^v/, "").replace(/[-~]/g, ".");
  return platform === "win32" ? `tvsm-agent_${v}_windows-x64.zip` : `tvsm-agent_${v}_${assetArch(arch)}.deb`;
};

/** What a studio node was installed as (install-studio.ps1 -Role tv|ingest|both). */
export type StudioRole = "playout" | "live" | "studio";

export interface StudioStatus {
  casparcg: {
    /** Windows service state, e.g. "running", "stopped", "missing". */
    service: string;
    /** AMCP (TCP 5250) answers. */
    connected: boolean;
    version: string | null;
    channels: { id: number; format: string; status: string }[];
  };
  ingest: {
    service: string;
    /** Push URL for remote contributors, e.g. rtmp://10.40.5.11/live (stream key = name). */
    rtmpUrl: string | null;
    streams: { name: string; ready: boolean; readers: number; tracks: string[] }[];
  };
  /** DeckLink outputs as configured in casparcg.config (device -> CasparCG channel). */
  outputs: { device: number; channel: number; format: string }[];
  mediaPath: string | null;
  mediaReachable: boolean | null;
  /** Role chosen in the installer; the orchestrator proposes it when the node is approved. Older agents leave it out. */
  role?: StudioRole | null;
}

export interface EnrollRequest extends NodeFacts {}
export interface EnrollResponse {
  nodeId: string;
  secret: string;
  /** Short code shown on the node and in the orchestrator, to check you approve the right machine. */
  fingerprint: string;
}

export interface CommandResult {
  id: number;
  /** running = a long job (provisioning) reports progress; the final result follows in a later heartbeat. */
  status: "done" | "failed" | "running";
  result?: string;
}

export interface HeartbeatRequest extends NodeFacts {
  metrics: NodeMetrics;
  results?: CommandResult[];
}

export interface AgentCommand {
  id: number;
  type: CommandType;
  payload?: Record<string, unknown>;
}

export type HeartbeatResponse =
  | { status: "pending"; fingerprint: string; intervalSeconds: number }
  | { status: "rejected" }
  | {
      status: "approved";
      name: string;
      role: NodeRole;
      intervalSeconds: number;
      commands: AgentCommand[];
      update: {
        channel: "production" | "test";
        repository: string;
        /** Newest agent release on the channel for this node's platform, when the orchestrator knows it. */
        latest?: string | null;
        auto?: AutoUpdatePolicy;
      };
    };

export const fingerprintOf = async (secret: string) => {
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(secret).digest("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
};
