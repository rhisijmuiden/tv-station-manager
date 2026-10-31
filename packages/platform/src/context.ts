import type { FastifyBaseLogger } from "fastify";
import type { RuntimeConfig } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { Db, Settings } from "./db.js";

export interface PlatformContext {
  config: RuntimeConfig;
  db: Db;
  settings: Settings;
  secrets: SecretBox;
  log: FastifyBaseLogger;
  /** Directories (absolute) included in backups in addition to the database. */
  backupPaths: string[];
}

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message?: string) {
    super(message ?? code);
  }
}
