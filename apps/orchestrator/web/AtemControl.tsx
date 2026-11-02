import { Alert, ApiError, Badge, Button, Dialog, Field, Input, Select, cx, post, put } from "@tvsm/ui";
import { Bot, Lock, LockOpen, Scissors, Shuffle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface ControlState {
  mode: "automation" | "locked";
  by: string | null;
  at: string | null;
  reason: string;
}
export interface ControlInput {
  id: number;
  longName: string;
  shortName: string;
  kind: string;
}
export interface ControlSwitcher {
  id: string;
  online: boolean;
  control: ControlState;
  snapshot: { mixEffects: number; auxes: number; inputs: ControlInput[]; program: (number | null)[]; preview: (number | null)[]; auxSources?: (number | null)[] } | null;
}

/** Sources that make sense on a bus: physical inputs, black, bars, colours, media players, SuperSource. */
const busInputs = (inputs: ControlInput[]) => inputs.filter((i) => ["external", "black", "bars", "color", "mediaplayer", "supersource"].includes(i.kind));

/** Per browser tab: the operator said "switch without locking" once, do not ask again. */
let skipAsk = false;

/** Lock / release for the automation and manual switching (program, preview, cut, auto, aux) of one ATEM. */
export function AtemControl({ sw, onChanged, compact }: { sw: ControlSwitcher; onChanged: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const [me, setMe] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);
  const [reason, setReason] = useState("");
  const [ask, setAsk] = useState<{ action: string; input?: number; bus?: number } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const s = sw.snapshot;
  const locked = sw.control.mode === "locked";
  const err = (e: unknown) => setError(e instanceof ApiError ? t(`orch.atem.err_${e.code}`, { defaultValue: e.message }) : String(e));

  const send = async (action: string, input?: number, bus?: number, lock?: boolean) => {
    setBusy(`${action}${input ?? ""}`);
    setError(null);
    try {
      await post(`/api/atem/${sw.id}/switch`, { action, input, me: bus ?? me, lock });
      onChanged();
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
    }
  };
  /** Switching while the automation is in charge: offer to lock first (preview never changes the picture on air). */
  const act = (action: string, input?: number, bus?: number) => {
    if (!locked && action !== "preview" && !skipAsk) setAsk({ action, input, bus });
    else void send(action, input, bus);
  };
  const setMode = async (mode: ControlState["mode"], why = "") => {
    setBusy("mode");
    setError(null);
    try {
      await put(`/api/atem/${sw.id}/control`, { mode, reason: why });
      setLocking(false);
      setReason("");
      onChanged();
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
    }
  };

  const inputs = s ? busInputs(s.inputs) : [];
  const program = s?.program[me] ?? null;
  const preview = s?.preview[me] ?? null;
  const btn = (on: "pgm" | "pvw" | null) =>
    cx(
      "min-w-12 rounded-md border px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40",
      on === "pgm" ? "border-danger bg-danger text-white shadow-[0_0_10px_var(--tvsm-danger)]" : on === "pvw" ? "border-ok bg-ok text-white shadow-[0_0_10px_var(--tvsm-success)]" : "border-line bg-surface-2 text-fg hover:border-brand",
    );

  return (
    <div className="space-y-4">
      {/* Who is in charge */}
      <div className={cx("rounded-lg border p-3", locked ? "border-warn/60 bg-warn/10" : "border-brand/30 bg-brand/5")}>
        <div className={cx("flex gap-3", compact ? "flex-col" : "flex-wrap items-center justify-between")}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cx("grid size-8 shrink-0 place-items-center rounded-full", locked ? "bg-warn text-white" : "bg-brand text-white")}>{locked ? <Lock className="size-4" /> : <Bot className="size-4" />}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{locked ? t("orch.control.locked") : t("orch.control.automation")}</p>
              <p className="text-xs text-muted">
                {locked
                  ? t("orch.control.lockedBy", { by: sw.control.by ?? "?", at: sw.control.at ? new Date(sw.control.at).toLocaleString() : "" }) + (sw.control.reason ? ` · ${sw.control.reason}` : "")
                  : t("orch.control.automationHint")}
              </p>
            </div>
          </div>
          {locked ? (
            <Button size="sm" className={compact ? "w-full" : undefined} icon={<LockOpen className="size-3.5" />} loading={busy === "mode"} onClick={() => void setMode("automation")}>
              {t("orch.control.release")}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className={compact ? "w-full" : undefined} icon={<Lock className="size-3.5" />} onClick={() => setLocking(true)}>
              {t("orch.control.lock")}
            </Button>
          )}
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!sw.online && <Alert tone="warn">{t("orch.control.offline")}</Alert>}

      {s && (
        <>
          {s.mixEffects > 1 && (
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: s.mixEffects }, (_, i) => (
                <button key={i} type="button" onClick={() => setMe(i)} className={cx("rounded-md px-2.5 py-1 text-xs font-semibold", me === i ? "bg-brand text-white" : "bg-surface-2 text-muted hover:text-fg")}>
                  M/E {i + 1}
                </button>
              ))}
            </div>
          )}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-danger uppercase">{t("orch.atem.program")}</p>
            <div className={cx("flex flex-wrap gap-1.5", compact && "gap-1")}>
              {inputs.map((i) => (
                <button key={i.id} type="button" title={i.longName} disabled={!sw.online || !!busy} className={btn(program === i.id ? "pgm" : null)} onClick={() => act("program", i.id)}>
                  {i.shortName}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-ok uppercase">{t("orch.atem.preview")}</p>
            <div className={cx("flex flex-wrap gap-1.5", compact && "gap-1")}>
              {inputs.map((i) => (
                <button key={i.id} type="button" title={i.longName} disabled={!sw.online || !!busy} className={btn(preview === i.id ? "pvw" : null)} onClick={() => act("preview", i.id)}>
                  {i.shortName}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Scissors className="size-4" />} disabled={!sw.online} loading={busy === "cut"} onClick={() => act("cut")}>
              CUT
            </Button>
            <Button variant="secondary" icon={<Shuffle className="size-4" />} disabled={!sw.online} loading={busy === "auto"} onClick={() => act("auto")}>
              AUTO
            </Button>
          </div>
          {s.auxes > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t("orch.control.aux")}</p>
              {Array.from({ length: s.auxes }, (_, n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-xs text-muted">Aux {n + 1}</span>
                  <Select className="h-9" disabled={!sw.online} value={String(s.auxSources?.[n] ?? "")} onChange={(e) => act("aux", Number(e.target.value), n)}>
                    {s.auxSources?.[n] == null && <option value="">–</option>}
                    {Array.from({ length: s.mixEffects }, (_, m) => [
                      <option key={`p${m}`} value={10010 + m * 10}>{`M/E ${m + 1} ${t("orch.atem.program")}`}</option>,
                      <option key={`v${m}`} value={10011 + m * 10}>{`M/E ${m + 1} ${t("orch.atem.preview")}`}</option>,
                    ])}
                    {inputs.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.longName}
                      </option>
                    ))}
                    {s.auxSources?.[n] != null && s.auxSources[n]! < 10010 && !inputs.some((i) => i.id === s.auxSources![n]) && <option value={s.auxSources[n]!}>{`#${s.auxSources[n]}`}</option>}
                  </Select>
                </div>
              ))}
            </div>
          )}
          {!locked && (
            <p className="text-xs text-muted">
              <Badge tone="brand">
                <Bot className="size-3" /> {t("orch.control.automation")}
              </Badge>{" "}
              {t("orch.control.mayOverride")}
            </p>
          )}
        </>
      )}

      <Dialog
        open={locking}
        onClose={() => setLocking(false)}
        title={t("orch.control.lockTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setLocking(false)}>
              {t("common.cancel")}
            </Button>
            <Button icon={<Lock className="size-4" />} loading={busy === "mode"} onClick={() => void setMode("locked", reason)}>
              {t("orch.control.lock")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm">{t("orch.control.lockText")}</p>
          <Field label={`${t("orch.control.reason")} (${t("common.optional")})`}>
            {(id) => <Input id={id} maxLength={200} value={reason} placeholder={t("orch.control.reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title={t("orch.control.askTitle")}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                if (dontAsk) skipAsk = true;
                const a = ask!;
                setAsk(null);
                void send(a.action, a.input, a.bus);
              }}
            >
              {t("orch.control.switchOnly")}
            </Button>
            <Button
              icon={<Lock className="size-4" />}
              onClick={() => {
                const a = ask!;
                setAsk(null);
                void send(a.action, a.input, a.bus, true);
              }}
            >
              {t("orch.control.lockAndSwitch")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm">{t("orch.control.askText")}</p>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> {t("orch.control.dontAsk")}
          </label>
        </div>
      </Dialog>
    </div>
  );
}
