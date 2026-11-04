import { inUpdateWindow } from "@tvsm/platform/agent-protocol";
import { compareVersions } from "@tvsm/platform/semver";

const AUTO_RETRY_MS = 60 * 60_000;
/**
 * Self-update decision (pure): a newer release on the channel, automatic updates on, inside the window, no
 * provisioning job running, not a development build, and not retried within the hour.
 */
export function shouldAutoUpdate(o: {
  auto?: { enabled: boolean; windowStart: string; windowEnd: string };
  latest?: string | null;
  current: string;
  now: Date;
  lastAttempt: number;
  busy: boolean;
}) {
  if (!o.auto?.enabled || !o.latest || o.busy) return false;
  if (/-dev$/.test(o.current) || o.current === "0.0.0") return false;
  if (compareVersions(o.latest, o.current) <= 0) return false;
  if (o.now.getTime() - o.lastAttempt < AUTO_RETRY_MS) return false;
  return inUpdateWindow(o.now, o.auto.windowStart, o.auto.windowEnd);
}
