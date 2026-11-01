import { Alert, Badge, Button, Card, CardBody, Dialog, Field, Input, PageHeader, Select, Switch, brandColor, del, post, put } from "@tvsm/ui";
import { Pencil, Plus, Trash2, Tv } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MediaPicker } from "../components/MediaPicker";
import { errorText, useChannels, useGet, type AtemStatus, type Channel } from "../lib";

interface Atem {
  id: number;
  name: string;
  status: AtemStatus;
}
interface Studio {
  id: number;
  name: string;
  status: { connected: boolean };
}

function InputSelect({ atem, value, onChange, allowNone }: { atem: Atem | undefined; value: number | null; onChange: (v: number | null) => void; allowNone?: string }) {
  const inputs = atem?.status.inputs ?? [];
  return inputs.length ? (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      {allowNone && <option value="">{allowNone}</option>}
      {inputs.map((i) => (
        <option key={i.id} value={i.id}>
          {i.id}: {i.longName}
        </option>
      ))}
    </Select>
  ) : (
    <Input type="number" min={0} value={value ?? ""} placeholder={allowNone} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
  );
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const { channels, reload } = useChannels();
  const atems = useGet<{ atems: Atem[] }>("/api/atems");
  const studios = useGet<{ studios: Studio[] }>("/api/studios");
  const [edit, setEdit] = useState<Partial<Channel> | null>(null);
  const [fillerName, setFillerName] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const atem = atems.data?.atems.find((a) => a.id === edit?.atemId);

  const save = async () => {
    if (!edit) return;
    setErr(null);
    const body = {
      name: edit.name ?? "",
      color: edit.color ?? brandColor("primary"),
      enabled: edit.enabled ?? true,
      atemId: edit.atemId ?? null,
      atemMe: edit.atemMe ?? 0,
      transition: edit.transition ?? "cut",
      studioId: edit.studioId ?? null,
      casparChannel: edit.casparChannel ?? 1,
      playoutInput: edit.playoutInput ?? null,
      fallbackInput: edit.fallbackInput ?? null,
      fillerMediaId: edit.fillerMediaId ?? null,
    };
    try {
      if (edit.id) await put(`/api/channels/${edit.id}`, body);
      else await post("/api/channels", body);
      setEdit(null);
      void reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async (c: Channel) => {
    if (!confirm(t("mgmt.channels.confirmDelete", { name: c.name }))) return;
    await del(`/api/channels/${c.id}`);
    void reload();
  };
  const name = (list: { id: number; name: string }[] | undefined, id: number | null) => list?.find((x) => x.id === id)?.name ?? "–";

  return (
    <>
      <PageHeader
        title={t("mgmt.channels.title")}
        description={t("mgmt.channels.intro")}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => (setEdit({ casparChannel: (channels?.length ?? 0) * 2 + 1, transition: "cut", enabled: true, color: brandColor("primary") }), setFillerName(null))}>
            {t("mgmt.channels.add")}
          </Button>
        }
      />
      {channels && channels.length >= 2 && <Alert className="mb-4">{t("mgmt.channels.maxHint")}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        {channels?.map((c) => (
          <Card key={c.id}>
            <CardBody className="flex gap-4">
              <div className="grid size-11 shrink-0 place-items-center rounded-lg text-white" style={{ background: c.color }}>
                <Tv className="size-5" />
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-base font-semibold">{c.name}</span>
                  {!c.enabled && <Badge>{t("common.disabled")}</Badge>}
                  {c.automation && <Badge tone="danger">● {t("mgmt.control.onAir")}</Badge>}
                </div>
                <p className="text-muted">
                  ATEM: {name(atems.data?.atems, c.atemId)} · M/E {c.atemMe + 1} · {t("mgmt.channels.playoutInput")} {c.playoutInput ?? "–"}
                </p>
                <p className="text-muted">
                  {t("mgmt.channels.studio")}: {name(studios.data?.studios, c.studioId)} · CasparCG {t("mgmt.channels.channel")} {c.casparChannel}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => (setEdit(c), setFillerName(null))} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(c)} />
              </div>
            </CardBody>
          </Card>
        ))}
        {channels && !channels.length && (
          <Card className="md:col-span-2">
            <CardBody className="py-10 text-center text-muted">{t("mgmt.channels.none")}</CardBody>
          </Card>
        )}
      </div>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        wide
        title={edit?.id ? t("mgmt.channels.edit") : t("mgmt.channels.add")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={!edit?.name}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-5">
            {err && <Alert tone="danger">{err}</Alert>}
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <Field label={t("common.name")}>{(id) => <Input id={id} value={edit.name ?? ""} placeholder="TV Noord" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
              <Field label={t("mgmt.blocks.color")}>{(id) => <Input id={id} type="color" className="p-1" value={edit.color ?? brandColor("primary")} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />}</Field>
            </div>
            <fieldset className="space-y-4 rounded-md border border-line p-4">
              <legend className="px-1 text-sm font-semibold">{t("mgmt.channels.switching")}</legend>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="ATEM">
                  {(id) => (
                    <Select id={id} value={edit.atemId ?? ""} onChange={(e) => setEdit({ ...edit, atemId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">{t("mgmt.channels.none_")}</option>
                      {atems.data?.atems.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="M/E">
                  {(id) => (
                    <Select id={id} value={edit.atemMe ?? 0} onChange={(e) => setEdit({ ...edit, atemMe: Number(e.target.value) })}>
                      {Array.from({ length: Math.max(1, atem?.status.mixEffects ?? 1) }, (_, i) => (
                        <option key={i} value={i}>
                          M/E {i + 1}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t("mgmt.channels.transition")}>
                  {(id) => (
                    <Select id={id} value={edit.transition ?? "cut"} onChange={(e) => setEdit({ ...edit, transition: e.target.value as "cut" | "mix" })}>
                      <option value="cut">{t("mgmt.channels.cut")}</option>
                      <option value="mix">{t("mgmt.channels.mix")}</option>
                    </Select>
                  )}
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mgmt.channels.playoutInput")} hint={t("mgmt.channels.playoutInputHint")}>{() => <InputSelect atem={atem} value={edit.playoutInput ?? null} onChange={(v) => setEdit({ ...edit, playoutInput: v })} allowNone="–" />}</Field>
                <Field label={t("mgmt.channels.fallbackInput")} hint={t("mgmt.channels.fallbackInputHint")}>{() => <InputSelect atem={atem} value={edit.fallbackInput ?? null} onChange={(v) => setEdit({ ...edit, fallbackInput: v })} allowNone={t("mgmt.channels.none_")} />}</Field>
              </div>
            </fieldset>
            <fieldset className="space-y-4 rounded-md border border-line p-4">
              <legend className="px-1 text-sm font-semibold">{t("mgmt.channels.playout")}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mgmt.channels.studio")}>
                  {(id) => (
                    <Select id={id} value={edit.studioId ?? ""} onChange={(e) => setEdit({ ...edit, studioId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">{t("mgmt.channels.none_")}</option>
                      {studios.data?.studios.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t("mgmt.channels.casparChannel")} hint={t("mgmt.channels.casparChannelHint")}>
                  {(id) => <Input id={id} type="number" min={1} max={16} value={edit.casparChannel ?? 1} onChange={(e) => setEdit({ ...edit, casparChannel: Number(e.target.value) || 1 })} />}
                </Field>
              </div>
              <Field label={t("mgmt.channels.filler")} hint={t("mgmt.channels.fillerHint")}>
                {() => (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm">{edit.fillerMediaId ? (fillerName ?? `#${edit.fillerMediaId}`) : t("mgmt.channels.none_")}</span>
                    <Button size="sm" variant="secondary" onClick={() => setPicker(true)}>
                      {t("mgmt.channels.chooseFiller")}
                    </Button>
                    {edit.fillerMediaId && (
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, fillerMediaId: null })}>
                        {t("common.delete")}
                      </Button>
                    )}
                  </div>
                )}
              </Field>
            </fieldset>
            <Switch checked={edit.enabled ?? true} onChange={(v) => setEdit({ ...edit, enabled: v })} label={t("common.enabled")} />
          </div>
        )}
      </Dialog>
      <MediaPicker
        open={picker}
        multiple={false}
        onClose={() => setPicker(false)}
        onPick={(m) => {
          if (edit && m[0]) {
            setEdit({ ...edit, fillerMediaId: m[0].id });
            setFillerName(m[0].title || m[0].name);
          }
        }}
      />
    </>
  );
}
