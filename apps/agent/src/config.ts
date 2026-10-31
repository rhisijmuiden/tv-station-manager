import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

declare const __TVSM_VERSION__: string | undefined;
export const AGENT_VERSION = typeof __TVSM_VERSION__ === "string" ? __TVSM_VERSION__ : (process.env.TVSM_VERSION ?? "0.0.0-dev");

export interface AgentConfig {
  orchestratorUrl: string;
  nodeId?: string;
  secret?: string;
  fingerprint?: string;
}

export function configPath() {
  if (process.env.TVSM_AGENT_CONFIG) return process.env.TVSM_AGENT_CONFIG;
  if (process.platform === "win32") return join(process.env.ProgramData ?? "C:\\ProgramData", "TVSM", "agent", "agent.json");
  return "/etc/tvsm/agent/agent.json";
}

export function readConfig(): AgentConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as AgentConfig;
}

export function writeConfig(cfg: AgentConfig) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
