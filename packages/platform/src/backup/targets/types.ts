import { z } from "zod";

export interface RemoteFile {
  name: string;
  size: number;
}

export interface BackupTarget {
  /** Connects, ensures the directory exists and checks write access. Returns details for the UI. */
  test(): Promise<{ details: string; hostKeySha256?: string }>;
  upload(localPath: string, remoteName: string): Promise<void>;
  download(remoteName: string, localPath: string): Promise<void>;
  list(): Promise<RemoteFile[]>;
  remove(remoteName: string): Promise<void>;
}

export const ftpConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().default("anonymous"),
  password: z.string().default(""),
  directory: z.string().default("/"),
  /** Only for FTPS: explicit (AUTH TLS on port 21) or implicit (TLS from the start, port 990). */
  tlsMode: z.enum(["explicit", "implicit"]).default("explicit"),
  verifyCertificate: z.boolean().default(true),
});
export type FtpConfig = z.infer<typeof ftpConfigSchema>;

export const scpConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authMethod: z.enum(["password", "key"]).default("key"),
  password: z.string().default(""),
  privateKey: z.string().default(""),
  passphrase: z.string().default(""),
  directory: z.string().default("backups"),
  /** Pinned SHA256 host key fingerprint (base64). Set automatically on the first successful test. */
  hostKeySha256: z.string().default(""),
});
export type ScpConfig = z.infer<typeof scpConfigSchema>;

export const smbConfigSchema = z.object({
  host: z.string().trim().min(1),
  /** Share name only, e.g. "backup" for //nas/backup. */
  share: z
    .string()
    .trim()
    .min(1)
    .transform((v) => v.replace(/^[\\/]+|[\\/]+$/g, "")),
  directory: z.string().trim().default("tvsm-backups"),
  username: z.string().default(""),
  password: z.string().default(""),
  domain: z.string().trim().default(""),
  port: z.number().int().min(1).max(65535).optional(),
  /** Highest protocol to negotiate; SMB3 by default (SMB1 is never used). */
  protocol: z.enum(["SMB3", "SMB2"]).default("SMB3"),
  /** Require SMB3 encryption of the whole connection. */
  encrypt: z.boolean().default(false),
});
export type SmbConfig = z.infer<typeof smbConfigSchema>;

export const onedriveConfigSchema = z.object({
  /** Directory (tenant) ID or "common"/"organizations"/"consumers". */
  tenant: z.string().trim().min(1).default("common"),
  /** Application (client) ID of an Entra app registration with "Allow public client flows" on. */
  clientId: z.string().trim().min(1),
  folder: z.string().trim().default("TVSM-backups"),
  /** Filled by the "Connect to Microsoft" sign-in; rotated automatically. */
  refreshToken: z.string().default(""),
  /** Signed-in account, shown in the UI. */
  account: z.string().default(""),
});
export type OneDriveConfig = z.infer<typeof onedriveConfigSchema>;

/** Lets a target store changed settings (e.g. a rotated OneDrive refresh token). */
export interface TargetHooks {
  saveConfig?(patch: Record<string, unknown>): void;
}

export const SECRET_KEYS = ["password", "privateKey", "passphrase", "refreshToken"] as const;
