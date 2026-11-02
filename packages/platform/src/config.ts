import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export interface AppIdentity {
  /** Short machine id, e.g. "orchestrator". Used for paths, unit names and package names. */
  id: string;
  /** Human readable name, e.g. "TV Station Orchestrator". */
  name: string;
  defaultPort: number;
}

export interface RuntimeConfig {
  app: AppIdentity;
  version: string;
  /** True when running from the installed .deb package (enables self-update). */
  packaged: boolean;
  dataDir: string;
  confDir: string;
  hostname: string;
  port: number;
  host: string;
}

declare const __TVSM_VERSION__: string | undefined;

export function resolveVersion(): string {
  if (typeof __TVSM_VERSION__ === "string") return __TVSM_VERSION__;
  return process.env.TVSM_VERSION ?? "0.0.0-dev";
}

export function loadRuntimeConfig(app: AppIdentity): RuntimeConfig {
  const packaged = process.env.TVSM_PACKAGED === "1";
  const devRoot = resolve(process.cwd(), ".data", app.id);
  const dataDir = process.env.TVSM_DATA_DIR ?? (packaged ? `/var/lib/tvsm/${app.id}` : join(devRoot, "data"));
  const confDir = process.env.TVSM_CONF_DIR ?? (packaged ? `/etc/tvsm/${app.id}` : join(devRoot, "conf"));
  for (const dir of [dataDir, confDir]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  return {
    app,
    version: resolveVersion(),
    packaged,
    dataDir,
    confDir,
    hostname: hostname(),
    port: Number(process.env.TVSM_PORT ?? app.defaultPort),
    host: process.env.TVSM_HOST ?? "0.0.0.0",
  };
}
