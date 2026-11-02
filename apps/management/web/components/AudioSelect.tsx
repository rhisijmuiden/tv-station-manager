import { Select, cx } from "@tvsm/ui";
import { useTranslation } from "react-i18next";
import { useGet } from "../lib";

export interface AudioSource {
  id: number;
  name: string;
  kind: "stream" | "soundcard" | "decklink";
  address: string;
  studioId: number | null;
  volume: number;
  usage: { blocks: number; items: number; beeldkranten: number };
}

export function useAudioSources() {
  const r = useGet<{ sources: AudioSource[] }>("/api/audio-sources");
  return { sources: r.data?.sources ?? null, reload: r.reload };
}

/**
 * Picks the audio under a block, an item or a beeldkrant.
 * `scope` decides what "empty" means: block = default (the beeldkrant's own audio, otherwise only the item's own sound),
 * item = like the block, beeldkrant = no audio.
 */
export function AudioSelect({
  id,
  value,
  onChange,
  sources,
  scope,
  compact,
}: {
  id?: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  sources: AudioSource[] | null;
  scope: "block" | "item" | "beeldkrant";
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const v = value ?? "";
  return (
    <Select
      id={id}
      className={cx(compact && "h-8 w-44! text-[12.5px]", compact && v && "border-brand/60 text-brand")}
      value={v}
      title={t("mgmt.audio.pickTitle")}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{t(`mgmt.audio.follow_${scope}`)}</option>
      {scope !== "beeldkrant" && <option value="none">{t("mgmt.audio.none")}</option>}
      {sources?.map((s) => (
        <option key={s.id} value={String(s.id)}>
          🔊 {s.name}
        </option>
      ))}
    </Select>
  );
}
