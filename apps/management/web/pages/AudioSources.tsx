import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AudioLines, Cable, Globe, Mic, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAudioSources, type AudioSource } from "../components/AudioSelect";
import { errorText, useGet } from "../lib";

type Kind = AudioSource["kind"];
const KINDS: { kind: Kind; icon: typeof Globe }[] = [
  { kind: "stream", icon: Globe },
  { kind: "soundcard", icon: Mic },
  { kind: "decklink", icon: Cable },
];
const kindIcon = (k: Kind) => KINDS.find((x) => x.kind === k)!.icon;

/** Listen in the browser (only plain http(s) streams such as Icecast MP3/AAC; HLS plays in Safari only). */
function Listen({ url }: { url: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!/^https?:\/\//i.test(url)) return null;
  const toggle = () => {
    if (on) {
      ref.current?.pause();
      ref.current = null;
      return setOn(false);
    }
    setFailed(false);
    const a = new Audio(url);
    a.onerror = () => (setFailed(true), setOn(false));
    ref.current = a;
    void a.play().then(() => setOn(true), () => (setFailed(true), setOn(false)));
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" icon={on ? <Square className="size-3.5" /> : <Play className="size-3.5" />} onClick={toggle}>
        {on ? t("mgmt.audio.stopListen") : t("mgmt.audio.listen")}
      </Button>
      {failed && <span className="text-xs text-warn">{t("mgmt.audio.listenFailed")}</span>}
    </span>
  );
}

export function AudioSourcesPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const canEdit = roleAtLeast(user?.role, "editor");
  const { sources, reload } = useAudioSources();
  const studios = useGet<{ studios: { id: number; name: string; host: string }[] }>("/api/studios");
  const [form, setForm] = useState<Partial<AudioSource> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const studioName = (id: number | null) => studios.data?.studios.find((s) => s.id === id)?.name ?? "–";

  const save = async () => {
    if (!form?.name || !form.kind) return;
    setErr(null);
    try {
      const body = { name: form.name, kind: form.kind, address: form.address ?? "", studioId: form.kind === "stream" ? null : (form.studioId ?? null), volume: form.volume ?? 70 };
      if (form.id) await put(`/api/audio-sources/${form.id}`, body);
      else await post("/api/audio-sources", body);
      setForm(null);
      void reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async (s: AudioSource) => {
    const used = s.usage.blocks + s.usage.items + s.usage.beeldkranten;
    if (!confirm(used ? t("mgmt.audio.confirmDeleteUsed", { name: s.name, n: used }) : t("mgmt.audio.confirmDelete", { name: s.name }))) return;
    await del(`/api/audio-sources/${s.id}`);
    void reload();
  };
  const newForm = (): Partial<AudioSource> => ({ kind: "stream", volume: 70, studioId: studios.data?.studios[0]?.id ?? null });

  return (
    <>
      <PageHeader
        title={t("mgmt.audio.title")}
        description={t("mgmt.audio.intro")}
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setForm(newForm())}>
              {t("mgmt.audio.new")}
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sources?.map((s) => {
          const Icon = kindIcon(s.kind);
          return (
            <Card key={s.id}>
              <div className="flex items-start gap-4 p-5">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{s.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge tone="brand">{t(`mgmt.audio.kinds.${s.kind}`)}</Badge>
                    <span>{t("mgmt.audio.volumeShort", { v: s.volume })}</span>
                  </p>
                  {s.kind !== "stream" && <p className="mt-1 truncate text-xs text-muted">{studioName(s.studioId)}</p>}
                  <p className="mt-1 truncate font-mono text-[12px] text-muted" title={s.address}>
                    {s.kind === "decklink" ? t("mgmt.audio.decklinkN", { n: s.address }) : s.address}
                  </p>
                  <p className="mt-1 text-xs text-muted">{t("mgmt.audio.usage", { blocks: s.usage.blocks + s.usage.items, beeldkranten: s.usage.beeldkranten })}</p>
                  {s.kind === "stream" && (
                    <div className="mt-3">
                      <Listen url={s.address} />
                    </div>
                  )}
                </div>
                {canEdit && (
                  <span className="flex shrink-0">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setForm(s)} title={t("common.edit")} />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(s)} title={t("common.delete")} />
                  </span>
                )}
              </div>
            </Card>
          );
        })}
        {sources && !sources.length && (
          <Card className="sm:col-span-2 xl:col-span-3">
            <div className="px-5 py-12 text-center">
              <AudioLines className="mx-auto mb-3 size-8 text-muted" />
              <p className="font-medium">{t("mgmt.audio.none")}</p>
              <p className="mx-auto max-w-xl text-sm text-muted">{t("mgmt.audio.noneIntro")}</p>
            </div>
          </Card>
        )}
      </div>
      {sources && sources.length > 0 && <p className="mt-4 text-sm text-muted">{t("mgmt.audio.tip")}</p>}

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t("mgmt.audio.edit") : t("mgmt.audio.new")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!form?.name || !form?.address} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("common.name")}>{(id) => <Input id={id} autoFocus value={form.name ?? ""} placeholder={t("mgmt.audio.namePlaceholder")} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.audio.kind")}</p>
              <div className="grid grid-cols-3 gap-2">
                {KINDS.map(({ kind, icon: Icon }) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setForm({ ...form, kind, address: form.kind === kind ? form.address : kind === "decklink" ? "1" : "" })}
                    className={cx("rounded-lg border p-3 text-left transition", form.kind === kind ? "border-brand bg-brand/6 ring-2 ring-brand/30" : "border-line hover:border-brand/50")}
                  >
                    <Icon className={cx("mb-1.5 size-4", form.kind === kind ? "text-brand" : "text-muted")} />
                    <span className="block text-[13px] leading-tight font-medium">{t(`mgmt.audio.kinds.${kind}`)}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{t(`mgmt.audio.kindHints.${kind}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <Field label={t(`mgmt.audio.address_${form.kind}`)} hint={t(`mgmt.audio.addressHint_${form.kind}`)}>
              {(id) =>
                form.kind === "decklink" ? (
                  <Select id={id} value={form.address ?? "1"} onChange={(e) => setForm({ ...form, address: e.target.value })}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={String(n)}>
                        {t("mgmt.audio.decklinkN", { n })}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input id={id} className={form.kind === "stream" ? "font-mono text-[13px]" : undefined} value={form.address ?? ""} placeholder={t(`mgmt.audio.addressPlaceholder_${form.kind}`)} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                )
              }
            </Field>
            {form.kind === "stream" && form.address && <Listen url={form.address} />}
            {form.kind !== "stream" && (
              <Field label={t("mgmt.audio.studio")} hint={t("mgmt.audio.studioHint")}>
                {(id) => (
                  <Select id={id} value={form.studioId ?? ""} onChange={(e) => setForm({ ...form, studioId: Number(e.target.value) || null })}>
                    <option value="">–</option>
                    {studios.data?.studios.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.host})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label={t("mgmt.audio.volume", { v: form.volume ?? 70 })} hint={t("mgmt.audio.volumeHint")}>
              {(id) => <input id={id} type="range" min={0} max={150} step={5} value={form.volume ?? 70} onChange={(e) => setForm({ ...form, volume: Number(e.target.value) })} className="w-full accent-brand" />}
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
