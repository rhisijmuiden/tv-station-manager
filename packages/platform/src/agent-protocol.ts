/** Wire format between tvsm-agent (on a node) and the orchestrator. Shared by both sides. */

export const AGENT_API = "/agent-api/v1";

export type NodeRole = "unassigned" | "management" | "studio" | "other";
export type NodeStatus = "pending" | "approved" | "rejected";
export type CommandType = "restart-agent" | "reboot" | "update-agent";

export interface NodeFacts {
  hostname: string;
  platform: NodeJS.Platform | string;
  os: string;
  arch: string;
  agentVersion: string;
  ips: string[];
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
  status: "done" | "failed";
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
      update: { channel: "production" | "test"; repository: string };
    };

export const fingerprintOf = async (secret: string) => {
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(secret).digest("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
};
