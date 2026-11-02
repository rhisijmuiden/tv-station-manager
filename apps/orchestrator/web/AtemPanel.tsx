import { cx } from "@tvsm/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { buttonSources, capLabel, panelFor, type PanelInput } from "./atemLayout";

export interface PanelSnapshot {
  modelKey: string;
  productName: string | null;
  videoMode: string | null;
  mixEffects: number;
  keyers: number[];
  downstreamKeyers: number;
  inputs: PanelInput[];
  program: (number | null)[];
  preview: (number | null)[];
}

// Hardware is dark in both themes: the chassis is the brand's sidebar colour pushed towards black.
const chassis = "bg-[color-mix(in_oklab,var(--tvsm-sidebar)_45%,black)] text-[color-mix(in_oklab,white_70%,transparent)]";
const keyBase =
  "relative grid place-items-center rounded-[5px] border font-mono text-[10px] font-semibold uppercase leading-none tracking-wide transition select-none";
const keyIdle = "border-white/10 bg-[color-mix(in_oklab,var(--tvsm-sidebar)_25%,#3a3a3e)] text-white/55 shadow-[inset_0_-2px_0_rgb(0_0_0/0.35)]";
const keyRed = "border-[var(--tvsm-danger)] bg-[var(--tvsm-danger)] text-white shadow-[0_0_12px_var(--tvsm-danger)]";
const keyGreen = "border-[var(--tvsm-success)] bg-[var(--tvsm-success)] text-white shadow-[0_0_12px_var(--tvsm-success)]";
const keyAmber = "border-[var(--tvsm-warning)]/70 text-[var(--tvsm-warning)]";

/** A decorative key (CUT, AUTO, FTB, ...): drawn for recognition only, never sends anything. */
function Key({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cx(keyBase, keyIdle, "h-7", wide ? "w-14" : "w-9", className)}>{children}</div>;
}

function Group({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {title && <span className="text-[9px] font-semibold tracking-[0.14em] text-white/40 uppercase">{title}</span>}
      {children}
    </div>
  );
}

function SourceRow({
  sources,
  bus,
  program,
  preview,
  onPick,
  labels,
  size = "md",
}: {
  sources: (PanelInput | null)[];
  bus: "program" | "preview" | "source";
  program: number | null;
  preview: number | null;
  onPick?: (i: PanelInput) => void;
  labels: boolean;
  size?: "md" | "lg";
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1.5">
      {sources.map((s, idx) => {
        const lit = s && (bus === "program" || bus === "source") && s.id === program ? keyRed : s && (bus === "preview" || bus === "source") && s.id === preview ? keyGreen : keyIdle;
        return (
          <div key={idx} className="flex flex-col items-center gap-1">
            {labels && (
              <span
                className={cx(
                  "w-full truncate rounded-[3px] bg-black/60 px-1 py-0.5 text-center font-mono text-[9px] leading-tight",
                  s ? "text-[color-mix(in_oklab,var(--tvsm-info)_70%,white)]" : "text-white/15",
                )}
                title={s?.longName}
              >
                {s?.shortName ?? "—"}
              </span>
            )}
            <button
              type="button"
              disabled={!s || !onPick}
              onClick={() => s && onPick?.(s)}
              title={s ? `${s.longName} · ${t("orch.atem.clickToRename")}` : undefined}
              className={cx(keyBase, lit, size === "lg" ? "size-12 text-sm" : "size-9", s && onPick ? "cursor-pointer hover:brightness-125" : "cursor-default opacity-60")}
            >
              {s ? capLabel(s) : ""}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Lcd({ lines }: { lines: string[] }) {
  return (
    <div className="flex h-16 w-28 shrink-0 flex-col justify-center gap-0.5 rounded-md border border-white/10 bg-[color-mix(in_oklab,var(--tvsm-info)_18%,black)] px-2 font-mono text-[9px] leading-tight text-[color-mix(in_oklab,var(--tvsm-info)_60%,white)] shadow-[inset_0_0_10px_rgb(0_0_0/0.8)]">
      {lines.map((l, i) => (
        <span key={i} className="truncate">
          {l}
        </span>
      ))}
    </div>
  );
}

function Tbar() {
  return (
    <div className="flex h-24 w-10 items-start justify-center rounded-md border border-white/10 bg-black/40 p-1.5">
      <div className="relative h-full w-1.5 rounded-full bg-black/70">
        <div className="absolute top-1 left-1/2 h-3 w-7 -translate-x-1/2 rounded-sm bg-white/50 shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />
      </div>
    </div>
  );
}

/** Graphical front view of an ATEM. Clicking a source button calls `onPick` (used for renaming, never for switching). */
export function AtemFrontPanel({ s, onPick }: { s: PanelSnapshot; onPick?: (i: PanelInput) => void }) {
  const { t } = useTranslation();
  const spec = panelFor(s.modelKey, s);
  const sources = buttonSources(spec, s.inputs);
  const program = s.program[0] ?? null;
  const preview = s.preview[0] ?? null;
  const name = (id: number | null) => s.inputs.find((i) => i.id === id)?.shortName ?? "—";
  const keyers = Array.from({ length: Math.min(4, s.keyers[0] ?? 0) }, (_, i) => i + 1);
  const dsks = Array.from({ length: Math.min(2, s.downstreamKeyers) }, (_, i) => i + 1);
  const title = s.productName ?? s.modelKey;
  const transitions = (
    <Group title={t("orch.atem.transition")}>
      <div className="flex gap-1.5">
        {["MIX", "DIP", "WIPE", "DVE", "STING"].slice(0, spec.family === "mini" ? 2 : 5).map((x, i) => (
          <Key key={x} className={i === 0 ? keyAmber : undefined}>
            {x}
          </Key>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Key wide>CUT</Key>
        <Key wide>AUTO</Key>
      </div>
    </Group>
  );
  const keys = (
    <Group title={t("orch.atem.keyers")}>
      <div className="flex gap-1.5">
        {keyers.map((k) => (
          <Key key={k}>KEY {k}</Key>
        ))}
        {dsks.map((k) => (
          <Key key={`d${k}`}>DSK {k}</Key>
        ))}
        <Key className="border-[var(--tvsm-danger)]/50 text-[var(--tvsm-danger)]">FTB</Key>
      </div>
    </Group>
  );
  const brandStrip = (
    <div className="flex items-center justify-between gap-4 text-[10px] tracking-[0.18em] text-white/45 uppercase">
      <span className="font-semibold">{title}</span>
      {s.videoMode && <span className="font-mono">{s.videoMode}</span>}
    </div>
  );

  let body: ReactNode;
  if (spec.family === "mini" || spec.family === "extreme") {
    const audioTargets = ["MIC 1", "MIC 2", ...sources.map((x, i) => x?.shortName ?? String(i + 1))];
    body = (
      <div className="flex flex-wrap items-end gap-6">
        <Group title={t("orch.atem.audio")}>
          <div className="flex gap-1.5">
            {audioTargets.map((a) => (
              <div key={a} className="flex w-9 flex-col gap-1">
                <Key className="h-5 w-9 text-[8px]">ON</Key>
                <Key className="h-5 w-9 text-[8px]">OFF</Key>
                <Key className="h-5 w-9 text-[8px]">AFV</Key>
                <span className="truncate text-center font-mono text-[8px] text-white/40">{a}</span>
              </div>
            ))}
          </div>
        </Group>
        <Group title={t("orch.atem.inputs")}>
          <SourceRow sources={sources} bus="source" program={program} preview={preview} onPick={onPick} labels size="lg" />
        </Group>
        {transitions}
        {keys}
        {spec.streaming && (
          <Group title={t("orch.atem.output")}>
            <div className="flex gap-1.5">
              <Key>REC</Key>
              <Key>STRM</Key>
              <Key className="border-[var(--tvsm-on-air)]/60 text-[var(--tvsm-on-air)]">AIR</Key>
            </div>
            {spec.outputSelect && (
              <div className="flex gap-1.5">
                <Key>PGM</Key>
                <Key>MV</Key>
              </div>
            )}
          </Group>
        )}
      </div>
    );
  } else if (spec.family === "rack") {
    body = (
      <div className={cx("flex items-center gap-6", spec.rackUnits > 1 ? "py-3" : "py-0.5")}>
        <Lcd lines={[title, `PGM ${name(program)}`, `PVW ${name(preview)}`, s.videoMode ?? ""]} />
        <Group title={t("orch.atem.sources")}>
          {/* Larger rack units have two rows of source buttons. */}
          {(sources.length > 10 ? [sources.slice(0, Math.ceil(sources.length / 2)), sources.slice(Math.ceil(sources.length / 2))] : [sources]).map((row, i) => (
            <SourceRow key={i} sources={row} bus="source" program={program} preview={preview} onPick={onPick} labels />
          ))}
        </Group>
        <Group title={t("orch.atem.menu")}>
          <div className="flex gap-1.5">
            <Key>MENU</Key>
            <Key>SET</Key>
            <div className="size-7 rounded-full border border-white/15 bg-black/50 shadow-[inset_0_-2px_4px_rgb(255_255_255/0.08)]" />
          </div>
        </Group>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-end gap-6">
        {spec.lcd && <Lcd lines={[title, `PGM ${name(program)}`, `PVW ${name(preview)}`, s.videoMode ?? ""]} />}
        <div className="flex flex-col gap-2">
          <Group title={t("orch.atem.program")}>
            <SourceRow sources={sources} bus="program" program={program} preview={preview} onPick={onPick} labels />
          </Group>
          <Group title={t("orch.atem.preview")}>
            <SourceRow sources={sources} bus="preview" program={program} preview={preview} onPick={onPick} labels={false} />
          </Group>
        </div>
        <div className="flex flex-col gap-3">
          {keys}
          {transitions}
        </div>
        {spec.tbar && <Tbar />}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-1">
      <div
        className={cx(
          "inline-flex min-w-full flex-col gap-4 rounded-xl border border-black/40 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_10px_30px_rgb(0_0_0/0.35)]",
          chassis,
          spec.family === "rack" && "rounded-sm border-x-[14px] border-x-black/50",
        )}
      >
        {spec.family !== "rack" && brandStrip}
        {body}
      </div>
    </div>
  );
}
