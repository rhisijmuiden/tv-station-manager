import { FtpTarget } from "./ftp.js";
import { OneDriveTarget } from "./onedrive.js";
import { ScpTarget } from "./scp.js";
import { SmbTarget } from "./smb.js";
import { ftpConfigSchema, onedriveConfigSchema, scpConfigSchema, smbConfigSchema, type BackupTarget, type TargetHooks } from "./types.js";

export const PROTOCOLS = ["ftp", "ftps", "scp", "smb", "onedrive"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export function createTarget(protocol: Protocol, config: unknown, hooks: TargetHooks = {}): BackupTarget {
  switch (protocol) {
    case "ftp":
      return new FtpTarget(ftpConfigSchema.parse(config), false);
    case "ftps":
      return new FtpTarget(ftpConfigSchema.parse(config), true);
    case "scp":
      return new ScpTarget(scpConfigSchema.parse(config));
    case "smb":
      return new SmbTarget(smbConfigSchema.parse(config));
    case "onedrive":
      return new OneDriveTarget(onedriveConfigSchema.parse(config), hooks);
  }
}

export * from "./types.js";
