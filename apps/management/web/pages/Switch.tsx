import { Alert, Badge, Button, Card, CardBody, Dialog, Field, Input, PageHeader, Select, cx, del, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ArrowDown, ArrowUp, Camera, CircleDot, Lock, Pencil, Plus, Radio, Repeat, RotateCcw, Satellite, ToggleRight, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ColorPicker } from "./Categories";
import { usePortLabel, useChannelInputs } from "../atemPorts";
import type { PortInput } from "../../server/atemports";
import { errorText, fmtDuration, fmtTime, useChannels, useGet, type LiveSource } from "../lib";

interface RepeatRule {
  dayOffset: number;
  time: string;
  channelId: number | null;
}
interface SwitchButton {
  id: number;
  channelId: number;
  name: string;
  color: string;
  position: number;
  liveSourceId: number;
  source: { id: number; name: string; kind: "atem" | "rtmp"; atemInput: number; state: "pull" | "unknown" | "waiting" | "live" | null; recordDefault: boolean; repeatRules: RepeatRule[] } | null;
  onAir: boolean;
}
interface SwitchChannel {
  channel: { id: number; name: string; color: string };
  automation: boolean;
  atemConnected: boolean;
  atemLock: { name: string; by: string | null; reason: string } | null;
  current: { title: string; programTitle: string; type: string; endAt: string } | null;
  next: { title: string; programTitle: string; startAt: string } | null;
  override: { liveSourceId: number; name: string; since: string } | null;
  recording: { active: boolean; since: string | null; repeat: boolean; record: boolean | null } | null;
  buttons: SwitchButton[];
}

export const SWITCH_COLORS = ["#FF3D57", "#3B6CFF", "#1DB97A", "#F5A524", "#8B5CF6", "#06B6D4", "#EC4899", "#64748B"];

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type T = (k: string, o?: Record<string, unknown>) => string;
const dayWord = (t: T, d: number) => (d === 0 ? t("mgmt.switch.today") : d === 1 ? t("mgmt.switch.tomorrow") : t("mgmt.switch.inDays", { n: d }));

/** What the tile says under its name: a camera, or whether the stream's picture is coming in. */
function SourceLine({ b, inputs }: { b: SwitchButton; inputs?: PortInput[] }) {
  const { t } = useTranslation();
  const port = usePortLabel();
  if (!b.source) return <span>{t("mgmt.switch.sourceGone")}</span>;
  if (b.source.kind === "atem")
    return (
      <span className="flex items-center gap-1.5">
        <Camera className="size-3.5" /> {t("mgmt.switch.camera", { input: port(inputs, b.source.atemInput) })}
      </span>
    );
  const st = b.source.state;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("size-2 rounded-full", st === "live" || st === "pull" ? "bg-white shadow-[0_0_0_3px_rgb(255_255_255/0.3)]" : "bg-white/40")} />
      {t(`mgmt.switch.stream_${st ?? "unknown"}`)}
    </span>
  );
}

/** One big button. */
export function SwitchTile({ b, disabled, onPress, inputs }: { b: SwitchButton; disabled?: boolean; onPress?: () => void; inputs?: PortInput[] }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled || !b.source}
      onClick={onPress}
      className={cx(
        "group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-xl p-4 text-left text-white shadow-sm transition",
        "enabled:cursor-pointer enabled:hover:-translate-y-0.5 enabled:hover:shadow-lg disabled:cursor-not-allowed",
        !b.onAir && "disabled:opacity-50",
        b.onAir && "ring-4 ring-onair ring-offset-2 ring-offset-bg",
      )}
      style={{ background: `linear-gradient(135deg, ${b.color}, color-mix(in srgb, ${b.color} 70%, black))` }}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-lg leading-tight font-semibold">{b.name}</span>
        {b.onAir ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-onair">
            <span className="size-1.5 animate-pulse rounded-full bg-onair" /> {t("mgmt.switch.onAirBadge")}
          </span>
        ) : b.source?.kind === "rtmp" ? (
          <Satellite className="size-5 shrink-0 opacity-80" />
        ) : (
          <Camera className="size-5 shrink-0 opacity-80" />
        )}
      </span>
      <span className="mt-3 text-xs font-medium opacity-90">
        <SourceLine b={b} inputs={inputs} />
      </span>
    </button>
  );
}

/** Two large answer buttons: Yes / No. */
function YesNo({ value, onChange, yes, no }: { value: boolean; onChange: (v: boolean) => void; yes?: ReactNode; no?: ReactNode }) {
  const { t } = useTranslation();
  const opt = (v: boolean, label: ReactNode) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={cx("h-12 flex-1 cursor-pointer rounded-lg border-2 text-sm font-semibold transition", value === v ? (v ? "border-brand bg-brand text-white" : "border-fg/70 bg-surface-2") : "border-line bg-surface text-muted hover:border-fg/30")}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-2">
      {opt(true, yes ?? t("common.yes"))}
      {opt(false, no ?? t("common.no"))}
    </div>
  );
}

/** The question before going live: plain confirm for a camera, record + repeat for a stream. */
function GoLiveDialog({ b, channel, onClose, onDone }: { b: SwitchButton; channel: SwitchChannel; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const src = b.source!;
  const stream = src.kind === "rtmp";
  const [record, setRecord] = useState(src.recordDefault);
  const [repeat, setRepeat] = useState(false);
  const [day, setDay] = useState(1);
  const [time, setTime] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ownRules = src.repeatRules;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/switch/buttons/${b.id}/press`, stream ? { record, repeat: record && repeat, repeatAt: record && repeat && !ownRules.length ? { dayOffset: day, time } : null } : {});
      onDone();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const noPicture = stream && (src.state === "waiting" || src.state === "unknown");
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mgmt.switch.dialogTitle", { name: b.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} icon={<Radio className="size-4" />} onClick={() => void go()}>
            {channel.override ? t("mgmt.switch.switchNow") : t("mgmt.switch.goLive")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {err && <Alert tone="danger">{err}</Alert>}
        <p className="text-sm">{t(stream ? "mgmt.switch.dialogStream" : "mgmt.switch.dialogCamera", { name: b.name, channel: channel.channel.name })}</p>
        {noPicture && <Alert tone="warn">{t(src.state === "waiting" ? "mgmt.switch.noPicture" : "mgmt.switch.unknownPicture")}</Alert>}
        {stream && (
          <>
            <div>
              <p className="mb-2 flex items-center gap-2 font-semibold">
                <span className="grid size-6 place-items-center rounded-full bg-brand text-xs text-white">1</span>
                {t("mgmt.switch.qRecord")}
              </p>
              <YesNo value={record} onChange={setRecord} yes={t("mgmt.switch.recordYes")} no={t("mgmt.switch.recordNo")} />
            </div>
            {record && (
              <div>
                <p className="mb-2 flex items-center gap-2 font-semibold">
                  <span className="grid size-6 place-items-center rounded-full bg-brand text-xs text-white">2</span>
                  {t("mgmt.switch.qRepeat")}
                </p>
                <YesNo value={repeat} onChange={setRepeat} yes={t("mgmt.switch.repeatYes")} no={t("mgmt.switch.repeatNo")} />
                {repeat &&
                  (ownRules.length ? (
                    <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                      <Repeat className="size-4" /> {t("mgmt.switch.repeatOwn", { list: ownRules.map((r) => `${dayWord(t, r.dayOffset)} ${r.time}`).join(", ") })}
                    </p>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <Field label={t("mgmt.switch.repeatDay")}>
                        {(id) => (
                          <Select id={id} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                            {[0, 1, 2, 3, 7].map((d) => (
                              <option key={d} value={d}>
                                {dayWord(t, d)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label={t("mgmt.switch.repeatTime")}>{(id) => <Input id={id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
                    </div>
                  ))}
                <p className="mt-3 text-xs text-muted">{t("mgmt.switch.recordHint")}</p>
              </div>
            )}
          </>
        )}
        {!stream && <p className="text-xs text-muted">{t("mgmt.switch.backHint")}</p>}
      </div>
    </Dialog>
  );
}

function ChannelSwitch({ c, canOperate, isAdmin, reload }: { c: SwitchChannel; canOperate: boolean; isAdmin: boolean; reload: () => void }) {
  const { t } = useTranslation();
  const inputsOf = useChannelInputs();
  const now = useNow();
  const [pressing, setPressing] = useState<SwitchButton | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/switch/${c.channel.id}/back`);
      reload();
    } catch (e) {
      setErr(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const ov = c.override;
  /** Say it in the editors' words: the name of the button that is on air. */
  const liveName = c.buttons.find((b) => b.onAir)?.name ?? ov?.name ?? "";
  const locked = !!c.atemLock;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4" style={{ boxShadow: `inset 4px 0 0 ${c.channel.color}` }}>
        <h2 className="text-lg font-semibold">{c.channel.name}</h2>
        {ov ? (
          <Badge tone="danger">
            <span className="size-1.5 animate-pulse rounded-full bg-current" /> {t("mgmt.switch.liveBadge", { name: liveName })}
          </Badge>
        ) : c.automation ? (
          <Badge tone="ok">{t("mgmt.switch.followsSchedule")}</Badge>
        ) : (
          <Badge>{t("mgmt.switch.manual")}</Badge>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className={cx("size-2 rounded-full", c.atemConnected ? "bg-ok" : "bg-danger")} /> ATEM
        </span>
      </div>
      <CardBody className="space-y-5">
        {locked && (
          <Alert tone="warn">
            <span className="flex items-start gap-2">
              <Lock className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">{t("mgmt.switch.locked", { by: c.atemLock!.by ?? "?" })}</span>
                {c.atemLock!.reason && <span> · {c.atemLock!.reason}</span>}
                <span className="block text-xs opacity-80">{t("mgmt.switch.lockedHint")}</span>
              </span>
            </span>
          </Alert>
        )}
        {!c.automation && !ov && <Alert tone="warn">{t("mgmt.switch.automationOff")}</Alert>}
        {err && <Alert tone="danger">{err}</Alert>}

        {ov ? (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border-2 border-onair/40 bg-onair/5 p-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-onair text-white shadow-md shadow-onair/30">
              <Radio className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{t("mgmt.switch.youAreLive", { name: liveName })}</p>
              <p className="text-sm text-muted">
                {t("mgmt.switch.liveSince", { time: fmtTime(ov.since), length: fmtDuration(now - Date.parse(ov.since)) })}
                {c.recording && (
                  <>
                    {" · "}
                    {c.recording.active ? (
                      <span className="inline-flex items-center gap-1 font-medium text-onair">
                        <CircleDot className="size-3.5" /> {t("mgmt.switch.recording")}
                      </span>
                    ) : c.recording.record === false ? (
                      t("mgmt.switch.notRecording")
                    ) : (
                      t("mgmt.switch.recordWaiting")
                    )}
                    {c.recording.repeat && (
                      <>
                        {" · "}
                        <span className="inline-flex items-center gap-1">
                          <Repeat className="size-3.5" /> {t("mgmt.switch.willRepeat")}
                        </span>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            {canOperate && (
              <Button className="h-12 px-5 text-base" loading={busy} icon={<RotateCcw className="size-5" />} onClick={() => void back()}>
                {t("mgmt.switch.back")}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">
            {c.current ? t("mgmt.switch.nowPlaying", { title: c.current.type === "filler" ? t("mgmt.control.filler") : c.current.programTitle || c.current.title, until: fmtTime(c.current.endAt) }) : t("mgmt.control.nothing")}
          </p>
        )}

        {c.buttons.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {c.buttons.map((b) => (
              <SwitchTile key={b.id} b={b} inputs={inputsOf(c.channel.id)} disabled={!canOperate || locked || b.onAir} onPress={() => setPressing(b)} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
            <ToggleRight className="mx-auto mb-3 size-8 text-muted" />
            <p className="font-medium">{t("mgmt.switch.none")}</p>
            <p className="text-sm text-muted">{t("mgmt.switch.noneIntro")}</p>
            {isAdmin && (
              <Link to="/switch-buttons" className="mt-3 inline-block text-sm font-medium text-brand">
                {t("mgmt.switch.makeButtons")} →
              </Link>
            )}
          </div>
        )}
      </CardBody>
      {pressing && (
        <GoLiveDialog
          b={pressing}
          channel={c}
          onClose={() => setPressing(null)}
          onDone={() => {
            setPressing(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}

/** Editors: big buttons to take an unplanned live feed on air, and back to the schedule. */
export function SwitchPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const { data, reload } = useGet<{ channels: SwitchChannel[] }>("/api/switch", 2000);
  return (
    <>
      <PageHeader
        title={t("mgmt.switch.title")}
        description={t("mgmt.switch.intro")}
        actions={
          roleAtLeast(user?.role, "admin") && (
            <Link to="/switch-buttons">
              <Button variant="secondary" icon={<Pencil className="size-4" />}>
                {t("mgmt.switch.manage")}
              </Button>
            </Link>
          )
        }
      />
      {data && !data.channels.length && <Alert tone="warn">{t("mgmt.control.noChannelsIntro")}</Alert>}
      <div className="space-y-6">
        {data?.channels.map((c) => (
          <ChannelSwitch key={c.channel.id} c={c} canOperate={roleAtLeast(user?.role, "operator")} isAdmin={roleAtLeast(user?.role, "admin")} reload={() => void reload()} />
        ))}
      </div>
    </>
  );
}

// ---- admin: make the buttons ------------------------------------------------------------

/** Admins: the switch buttons per channel (name, colour, which source = which ATEM input). */
export function SwitchButtonsPage() {
  const { t } = useTranslation();
  const { channels } = useChannels();
  const inputsOf = useChannelInputs();
  const port = usePortLabel();
  const { data, reload } = useGet<{ buttons: SwitchButton[] }>("/api/switch/buttons");
  const { data: live } = useGet<{ sources: LiveSource[] }>("/api/live-sources");
  const [form, setForm] = useState<{ id?: number; channelId: number; name: string; color: string; liveSourceId: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sources = live?.sources ?? [];

  const save = async () => {
    if (!form?.name || !form.liveSourceId) return;
    setErr(null);
    try {
      const body = { channelId: form.channelId, name: form.name, color: form.color, liveSourceId: form.liveSourceId };
      if (form.id) await put(`/api/switch/buttons/${form.id}`, body);
      else await post("/api/switch/buttons", body);
      setForm(null);
      void reload();
    } catch (e) {
      setErr(errorText(t, e));
    }
  };
  const remove = async (b: SwitchButton) => {
    if (!confirm(t("mgmt.switch.confirmDelete", { name: b.name }))) return;
    await del(`/api/switch/buttons/${b.id}`);
    void reload();
  };
  const move = async (list: SwitchButton[], i: number, dir: -1 | 1) => {
    const ids = list.map((b) => b.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await post("/api/switch/buttons/order", { ids });
    void reload();
  };
  const newButton = (channelId: number) => setForm({ channelId, name: "", color: SWITCH_COLORS[(data?.buttons.length ?? 0) % SWITCH_COLORS.length]!, liveSourceId: null });
  const preview: SwitchButton | null = form
    ? (() => {
        const s = sources.find((x) => x.id === form.liveSourceId);
        return {
          id: 0,
          channelId: form.channelId,
          name: form.name || t("mgmt.switch.namePlaceholder"),
          color: form.color,
          position: 0,
          liveSourceId: form.liveSourceId ?? 0,
          source: s ? { id: s.id, name: s.name, kind: s.kind, atemInput: s.atemInput, state: s.status?.state ?? (s.kind === "rtmp" ? "unknown" : null), recordDefault: true, repeatRules: [] } : null,
          onAir: false,
        };
      })()
    : null;

  return (
    <>
      <PageHeader title={t("mgmt.switch.setupTitle")} description={t("mgmt.switch.setupIntro")} />
      <Alert className="mb-6">
        {t("mgmt.switch.setupHow")}{" "}
        <Link to="/devices" className="font-medium underline">
          {t("mgmt.nav.devices")}
        </Link>
        {" · "}
        <Link to="/remote" className="font-medium underline">
          {t("mgmt.nav.remote")}
        </Link>
        {" · "}
        <Link to="/recordings" className="font-medium underline">
          {t("mgmt.nav.recordings")}
        </Link>
      </Alert>
      <div className="space-y-6">
        {channels?.map((ch) => {
          const list = (data?.buttons ?? []).filter((b) => b.channelId === ch.id);
          return (
            <Card key={ch.id}>
              <div className="flex items-center gap-3 border-b border-line px-5 py-4" style={{ boxShadow: `inset 4px 0 0 ${ch.color}` }}>
                <h2 className="flex-1 text-lg font-semibold">{ch.name}</h2>
                <Button icon={<Plus className="size-4" />} onClick={() => newButton(ch.id)}>
                  {t("mgmt.switch.newButton")}
                </Button>
              </div>
              <CardBody>
                {list.length ? (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {list.map((b, i) => (
                      <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
                        <span className="size-8 shrink-0 rounded-lg" style={{ background: b.color }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{b.name}</span>
                          <span className="block truncate text-xs text-muted">
                            {b.source ? t(b.source.kind === "rtmp" ? "mgmt.switch.goesToStream" : "mgmt.switch.goesToCamera", { source: b.source.name, input: port(inputsOf(b.channelId), b.source.atemInput) }) : t("mgmt.switch.sourceGone")}
                          </span>
                        </span>
                        <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} disabled={i === 0} onClick={() => void move(list, i, -1)} title={t("mgmt.switch.up")} />
                        <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} disabled={i === list.length - 1} onClick={() => void move(list, i, 1)} title={t("mgmt.switch.down")} />
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setForm({ id: b.id, channelId: b.channelId, name: b.name, color: b.color, liveSourceId: b.liveSourceId })} title={t("common.edit")} />
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(b)} title={t("common.delete")} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-sm text-muted">{t("mgmt.switch.noneForChannel")}</p>
                )}
              </CardBody>
            </Card>
          );
        })}
        {channels && !channels.length && <Alert tone="warn">{t("mgmt.control.noChannelsIntro")}</Alert>}
      </div>

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t("mgmt.switch.editButton") : t("mgmt.switch.newButton")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!form?.name || !form.liveSourceId} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label={t("mgmt.switch.buttonName")} hint={t("mgmt.switch.buttonNameHint")}>
              {(id) => <Input id={id} autoFocus maxLength={60} value={form.name} placeholder={t("mgmt.switch.namePlaceholder")} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </Field>
            <Field label={t("mgmt.switch.source")} hint={t("mgmt.switch.sourceHint")}>
              {(id) => (
                <Select id={id} value={form.liveSourceId ?? ""} onChange={(e) => setForm({ ...form, liveSourceId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t("mgmt.switch.chooseSource")}</option>
                  <optgroup label={t("mgmt.switch.cameras")}>
                    {sources
                      .filter((s) => s.kind === "atem")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {port(inputsOf(form.channelId), s.atemInput, { withName: false })}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label={t("mgmt.switch.streams")}>
                    {sources
                      .filter((s) => s.kind === "rtmp")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {port(inputsOf(form.channelId), s.atemInput, { withName: false })}
                        </option>
                      ))}
                  </optgroup>
                </Select>
              )}
            </Field>
            {channels && channels.length > 1 && (
              <Field label={t("mgmt.switch.channel")}>
                {(id) => (
                  <Select id={id} value={form.channelId} onChange={(e) => setForm({ ...form, channelId: Number(e.target.value) })}>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.blocks.color")}</p>
              <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} colors={SWITCH_COLORS} />
            </div>
            {preview && (
              <div>
                <p className="mb-2 text-[13px] font-medium">{t("mgmt.switch.preview")}</p>
                <div className="max-w-64">
                  <SwitchTile b={preview} inputs={inputsOf(preview.channelId)} />
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
