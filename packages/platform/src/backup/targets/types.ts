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

export const SECRET_KEYS = ["password", "privateKey", "passphrase"] as const;
