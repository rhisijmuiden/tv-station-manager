import { Badge, Button, Card, CardBody, CardHeader, Select, Switch, cx, get, post } from "@tvsm/ui";
import { CalendarClock, Clapperboard, Layers as LayersIcon, Newspaper, Pencil, Plus, Radio, Sparkles, Tv, Webcam as WebcamIcon, Film } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { fmtDuration, LAYER_KINDS, useGet, type BlockSummary, type Graphics, type LayerKind, type Layers } from "../lib";

const KIND_ICON: Record<LayerKind, typeof Clapperboard> = { media: Clapperboard, beeldkrant: Newspaper, webcam: WebcamIcon, live: Radio, lineup: CalendarClock, commercial: Film, filler: Tv };
export const kindIcon = (k: LayerKind) => KIND_ICON[k];

/** A switch without its own label, for a table cell. */
export function MiniSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} onClick={(e) => (e.stopPropagation(), onChange(!checked))} className={cx("relative h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-ok" : "bg-line")}>
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-4.5" : "left-0.5")} />
    </button>
  );
}

/**
 * The channel as a stack of layers: content at the bottom, the base layer (logo, clock, ticker) on top.
 * Per kind of content one row of switches decides what of the base layer stays on air.
 */
export function LayersCard({ g, layers, onChange }: { g: Graphics; layers: Layers; onChange: (l: Layers) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LayerKind>("beeldkrant");
  const rule = layers[kind];
  const parts = (["logo", "clock", "ticker"] as const).filter((p) => rule[p] && g[p].enabled);
  return (
    <Card className="mt-6">
      <CardHeader icon={<LayersIcon className="size-4" />} title={t("mgmt.plan.layers.title")} description={t("mgmt.plan.layers.intro")} />
      <CardBody className="grid gap-6 xl:grid-cols-[1fr_1.3fr]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1">
            {LAYER_KINDS.map((k) => (
              <button key={k} onClick={() => setKind(k)} className={cx("rounded-md px-2.5 py-1 text-xs font-semibold transition", k === kind ? "bg-surface shadow-sm" : "text-muted hover:text-fg")}>
                {t(`mgmt.plan.kinds.${k}`)}
              </button>
            ))}
          </div>
          <ol className="space-y-1.5">
            <li className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
              <span className="w-14 font-mono text-xs text-muted">{t("mgmt.plan.layers.layer", { n: 3 })}</span>
              {t("mgmt.plan.layers.subtitles")}
            </li>
            <li className={cx("flex items-center gap-3 rounded-md border px-3 py-2 text-sm", parts.length ? "border-brand/40 bg-brand/5" : "border-line opacity-55")}>
              <span className="w-14 font-mono text-xs text-muted">{t("mgmt.plan.layers.layer", { n: 2 })}</span>
              <span className="font-semibold">{t("mgmt.plan.layers.base")}</span>
              <span className="ml-auto text-xs text-muted">{parts.length ? parts.map((p) => t(`mgmt.plan.layers.${p}`)).join(", ") : t("mgmt.plan.layers.hidden")}</span>
            </li>
            <li className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
              <span className="w-14 font-mono text-xs text-muted">{t("mgmt.plan.layers.layer", { n: 1 })}</span>
              <span className="font-semibold">{t("mgmt.plan.layers.content")}</span>
              <span className="ml-auto text-xs text-muted">{t(`mgmt.plan.kinds.${kind}`)}</span>
            </li>
          </ol>
          <p className="text-xs text-muted">{t(`mgmt.plan.layers.note.${kind === "beeldkrant" ? "beeldkrant" : "other"}`)}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="py-2 font-semibold">{t("mgmt.plan.layers.kind")}</th>
                {(["logo", "clock", "ticker"] as const).map((p) => (
                  <th key={p} className="py-2 text-center font-semibold">
                    {t(`mgmt.plan.layers.${p}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {LAYER_KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <tr key={k} className={cx(k === kind && "bg-brand/5")} onClick={() => setKind(k)}>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <Icon className="size-3.5 text-muted" />
                        {t(`mgmt.plan.kinds.${k}`)}
                      </span>
                    </td>
                    {(["logo", "clock", "ticker"] as const).map((p) => (
                      <td key={p} className="py-2">
                        <span className="flex justify-center">
                          <MiniSwitch checked={layers[k][p]} onChange={(v) => onChange({ ...layers, [k]: { ...layers[k], [p]: v } })} label={`${t(`mgmt.plan.kinds.${k}`)}: ${t(`mgmt.plan.layers.${p}`)}`} />
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">{t("mgmt.plan.layers.tableHint")}</p>
        </div>
      </CardBody>
    </Card>
  );
}

interface StartItem {
  type: string;
  title: string | null;
  mediaTitle?: string | null;
  mediaName?: string | null;
  childName?: string | null;
  beeldkrantName?: string | null;
  webcamName?: string | null;
  autoSourceName?: string | null;
  effectiveDurationMs?: number | null;
}
/** The items of the block every hour begins with, with a label and length, for the hour start card and the block editor. */
export function useHourStartItems(blockId: number | null | undefined) {
  const { t } = useTranslation();
  const [items, setItems] = useState<{ label: string; type: string; durationMs: number }[] | null>(null);
  useEffect(() => {
    if (!blockId) return setItems(null);
    let live = true;
    void get<{ items: StartItem[] }>(`/api/blocks/${blockId}`)
      .then((d) => {
        if (!live) return;
        setItems(
          d.items.map((i) => ({
            type: i.type,
            durationMs: i.effectiveDurationMs ?? 0,
            label: i.title || (i.type === "lineup" ? t("mgmt.lineup.item") : i.mediaTitle || i.mediaName || i.childName || i.beeldkrantName || i.webcamName || i.autoSourceName || t(`mgmt.blocks.types.${i.type}`, i.type)),
          })),
        );
      })
      .catch(() => live && setItems(null));
    return () => {
      live = false;
    };
  }, [blockId, t]);
  return items;
}

/** "Every hour begins with": one block (e.g. the coming-up slide and a tune) in front of every hour block. */
export function HourStartCard({ value, onChange }: { value: { enabled: boolean; blockId: number | null }; onChange: (v: { enabled: boolean; blockId: number | null }) => void }) {
  const { t } = useTranslation();
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks?kind=program");
  const items = useHourStartItems(value.blockId);
  const total = items?.reduce((s, i) => s + i.durationMs, 0) ?? 0;
  const make = async () => {
    const r = await post<{ id: number }>("/api/blocks", { name: t("mgmt.plan.hourStart.defaultName"), kind: "program", hourStart: false, items: [{ type: "lineup" }] });
    await blocks.reload();
    onChange({ enabled: true, blockId: r.id });
  };
  return (
    <Card className="mt-6">
      <CardHeader icon={<Sparkles className="size-4" />} title={t("mgmt.plan.hourStart.title")} description={t("mgmt.plan.hourStart.intro")} />
      <CardBody className="space-y-4">
        <Switch checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} label={t("mgmt.plan.hourStart.enabled")} description={t("mgmt.plan.hourStart.enabledHint")} />
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-auto! min-w-60" value={value.blockId ?? ""} onChange={(e) => onChange({ ...value, blockId: Number(e.target.value) || null })} aria-label={t("mgmt.plan.hourStart.block")}>
            <option value="">{t("mgmt.plan.hourStart.pick")}</option>
            {blocks.data?.blocks
              .filter((b) => !b.hourStart || b.id === value.blockId)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({fmtDuration(b.durationMs)})
                </option>
              ))}
          </Select>
          {value.blockId ? (
            <Link to={`/blocks/${value.blockId}`}>
              <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />}>
                {t("mgmt.plan.hourStart.edit")}
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => void make()}>
              {t("mgmt.plan.hourStart.make")}
            </Button>
          )}
        </div>
        {items && (
          <ol className="divide-y divide-line rounded-md border border-line">
            {items.map((i, n) => (
              <li key={n} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted">{n + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{i.label}</span>
                <span className="font-mono text-xs text-muted">{fmtDuration(i.durationMs)}</span>
              </li>
            ))}
            {!items.length && <li className="px-3 py-4 text-center text-sm text-muted">{t("mgmt.plan.hourStart.empty")}</li>}
          </ol>
        )}
        {items && (
          <p className="text-xs text-muted">
            <Badge tone="brand">{fmtDuration(total)}</Badge> {t("mgmt.plan.hourStart.total")}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
