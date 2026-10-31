import { FtpTarget } from "./ftp.js";
import { ScpTarget } from "./scp.js";
import { ftpConfigSchema, scpConfigSchema, type BackupTarget } from "./types.js";

export type Protocol = "ftp" | "ftps" | "scp";

export function createTarget(protocol: Protocol, config: unknown): BackupTarget {
  switch (protocol) {
    case "ftp":
      return new FtpTarget(ftpConfigSchema.parse(config), false);
    case "ftps":
      return new FtpTarget(ftpConfigSchema.parse(config), true);
    case "scp":
      return new ScpTarget(scpConfigSchema.parse(config));
  }
}

export * from "./types.js";
