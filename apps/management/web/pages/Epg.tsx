import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, put, roleAtLeast, useSession } from "@tvsm/ui";
import { ChevronLeft, ChevronRight, Copy, Link2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { addDays, fmtDate, fmtTime, startOfDay, useGet } from "../lib";

interface Epg {
  channels: { id: number; name: string; color: string }[];
  programmes: { channelId: number; startAt: string; endAt: string; title: string; description: string | null; genre: string | null }[];
}
interface Settings {
  publicUrl: string;
  effectivePublicUrl: string;
  epgToken: string;
  epgDays: number;
}

export function EpgPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const epg = useGet<Epg>(`/api/epg?from=${encodeURIComponent(day.toISOString())}&to=${encodeURIComponent(addDays(day, 1).toISOString())}`);
  const settings = useGet<Settings>("/api/management/settings");
  const [form, setForm] = useState<{ publicUrl: string; epgDays: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const s = settings.data;
  const f = form ?? (s ? { publicUrl: s.publicUrl, epgDays: s.epgDays } : null);
  const url = s ? `${s.effectivePublicUrl}/epg/xmltv.xml?token=${s.epgToken}` : "";
  const isAdmin = roleAtLeast(user?.role, "admin");
  const save = async (regenerateToken = false) => {
    if (!f) return;
    await put("/api/management/settings", { ...f, regenerateToken });
    setForm(null);
    void settings.reload();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const from = day.getTime();
  const span = 86400_000;

  return (
    <>
      <PageHeader title={t("mgmt.epg.title")} description={t("mgmt.epg.intro")} />
      <Card className="mb-6">
        <CardHeader icon={<Link2 className="size-4" />} title={t("mgmt.epg.feed")} description={t("mgmt.epg.feedIntro")} />
        <CardBody className="space-y-4">
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => void copy()}>
              {copied ? t("mgmt.epg.copied") : t("mgmt.epg.copy")}
            </Button>
          </div>
          {isAdmin && f && (
            <div className="grid items-end gap-4 sm:grid-cols-[1fr_140px_auto_auto]">
              <Field label={t("mgmt.epg.publicUrl")} hint={t("mgmt.epg.publicUrlHint")}>{(id) => <Input id={id} value={f.publicUrl} placeholder={s?.effectivePublicUrl} onChange={(e) => setForm({ ...f, publicUrl: e.target.value })} />}</Field>
              <Field label={t("mgmt.epg.days")}>{(id) => <Input id={id} type="number" min={1} max={21} value={f.epgDays} onChange={(e) => setForm({ ...f, epgDays: Number(e.target.value) || 7 })} />}</Field>
              <Button onClick={() => void save()}>{t("common.save")}</Button>
              <Button variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => confirm(t("mgmt.epg.regenerateConfirm")) && void save(true)}>
                {t("mgmt.epg.regenerate")}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setDay(addDays(day, -1))} />
          <span className="font-semibold first-letter:uppercase">{fmtDate(day)}</span>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => setDay(addDays(day, 1))} />
        </div>
        {epg.data && !epg.data.channels.length && <Alert className="m-5">{t("mgmt.control.noChannelsIntro")}</Alert>}
        <div className="overflow-x-auto">
          <div className="min-w-[900px] p-5">
            <div className="mb-2 ml-32 flex justify-between font-mono text-[10px] text-muted">
              {Array.from({ length: 13 }, (_, i) => (
                <span key={i}>{String(i * 2).padStart(2, "0")}:00</span>
              ))}
            </div>
            {epg.data?.channels.map((c) => (
              <div key={c.id} className="mb-2 flex items-stretch gap-2">
                <div className="flex w-30 shrink-0 items-center gap-2 text-sm font-semibold">
                  <span className="size-2.5 rounded-full" style={{ background: c.color }} />
                  {c.name}
                </div>
                <div className="relative h-16 flex-1 rounded-md border border-line bg-surface-2">
                  {epg.data!.programmes
                    .filter((p) => p.channelId === c.id)
                    .map((p, i) => {
                      const s0 = Math.max(0, Date.parse(p.startAt) - from);
                      const e0 = Math.min(span, Date.parse(p.endAt) - from);
                      return (
                        <div
                          key={i}
                          title={`${fmtTime(p.startAt)}–${fmtTime(p.endAt)} ${p.title}${p.description ? `\n${p.description}` : ""}`}
                          className="absolute top-1 bottom-1 overflow-hidden rounded border border-brand/30 bg-surface px-1.5 py-1 text-[11px] leading-tight shadow-sm"
                          style={{ left: `${(s0 / span) * 100}%`, width: `calc(${((e0 - s0) / span) * 100}% - 2px)` }}
                        >
                          <p className="truncate font-mono text-[10px] text-muted">{fmtTime(p.startAt)}</p>
                          <p className="truncate font-medium">{p.title}</p>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
