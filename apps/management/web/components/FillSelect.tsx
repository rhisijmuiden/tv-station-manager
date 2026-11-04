import { Select } from "@tvsm/ui";
import { useTranslation } from "react-i18next";
import { useGet } from "../lib";

/** What can fill the rest of the hour after a block's material: the beeldkranten and webcams. */
export function useFillChoices() {
  const bk = useGet<{ beeldkranten: { id: number; name: string }[] }>("/api/beeldkranten");
  const cams = useGet<{ webcams: { id: number; name: string }[] }>("/api/webcams");
  const beeldkranten = bk.data?.beeldkranten ?? [];
  const webcams = cams.data?.webcams ?? [];
  /** Display name of a stored choice ("beeldkrant:<id>" / "webcam:<id>"), null for the channel filler. */
  const nameOf = (fill: string | null | undefined) => {
    const [type, raw] = (fill ?? "").split(":");
    const id = Number(raw);
    return (type === "beeldkrant" ? beeldkranten.find((b) => b.id === id)?.name : type === "webcam" ? webcams.find((w) => w.id === id)?.name : undefined) ?? null;
  };
  return { beeldkranten, webcams, nameOf, loaded: !!bk.data && !!cams.data };
}

/** Picks what plays when the hour is not full: the channel filler (empty), a beeldkrant or a webcam. */
export function FillSelect({ id, value, onChange, choices }: { id?: string; value: string | null | undefined; onChange: (v: string | null) => void; choices: ReturnType<typeof useFillChoices> }) {
  const { t } = useTranslation();
  const known = !value || choices.nameOf(value) != null || !choices.loaded;
  return (
    <Select id={id} value={known ? (value ?? "") : ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t("mgmt.fill.channel")}</option>
      {!!choices.beeldkranten.length && (
        <optgroup label={t("mgmt.blocks.groups.beeldkrant")}>
          {choices.beeldkranten.map((b) => (
            <option key={b.id} value={`beeldkrant:${b.id}`}>
              {b.name}
            </option>
          ))}
        </optgroup>
      )}
      {!!choices.webcams.length && (
        <optgroup label={t("mgmt.blocks.groups.webcam")}>
          {choices.webcams.map((w) => (
            <option key={w.id} value={`webcam:${w.id}`}>
              {w.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
