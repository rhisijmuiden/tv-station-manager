import { Alert, Button, post, roleAtLeast, useSession } from "@tvsm/ui";
import { Clock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, fmtTime, useGet } from "../lib";

interface PendingChannel {
  channel: { id: number; name: string };
  pending: { from: string } | null;
}

/**
 * Schedule changes to the hour on air wait for the next whole hour, so the playout does not restart in the middle of
 * a programme. This bar says when they go on air; editors can take them on air at once.
 */
export function PendingBar({ channelId, name, from, onApplied, className }: { channelId: number; name?: string; from: string; onApplied?: () => void; className?: string }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const apply = async () => {
    if (!confirm(t("mgmt.pending.confirm"))) return;
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/control/${channelId}/apply-now`, {});
      onApplied?.();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert tone="warn" className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Clock className="size-4 shrink-0" />
        <p className="min-w-0 flex-1">
          {name ? <strong>{name}: </strong> : null}
          {t("mgmt.pending.text", { time: fmtTime(from) })}
        </p>
        {roleAtLeast(user?.role, "editor") && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void apply()}>
            {t("mgmt.pending.applyNow")}
          </Button>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
    </Alert>
  );
}

/** Every channel with changes waiting for the next hour (for the planning pages). */
export function PendingChanges({ className }: { className?: string }) {
  const { data, reload } = useGet<{ channels: PendingChannel[] }>("/api/control", 5000);
  const waiting = data?.channels.filter((c) => c.pending) ?? [];
  if (!waiting.length) return null;
  return (
    <div className={className}>
      {waiting.map((c) => (
        <PendingBar key={c.channel.id} channelId={c.channel.id} name={waiting.length > 1 ? c.channel.name : undefined} from={c.pending!.from} onApplied={() => void reload()} className="mb-2" />
      ))}
    </div>
  );
}
