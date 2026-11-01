import { Badge, Card, CardBody, CardHeader, PageHeader, cx, roleAtLeast, useSession } from "@tvsm/ui";
import { CalendarRange, CheckCircle2, Circle, ClipboardList, FolderOpen, Radio, Tv, WandSparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { fmtTime, useGet } from "../lib";

interface Overview {
  channels: number;
  atems: { name: string; connected: boolean; model: string | null; productName: string | null }[];
  studios: { name: string; host: string; connected: boolean; version: string | null }[];
  mediaSources: number;
  mediaFiles: number;
  blocks: number;
  upcomingEntries: number;
  mailConfigured: boolean;
  backupTargets: number;
}
interface ControlStatus {
  channels: { channel: { id: number; name: string; color: string }; automation: boolean; current: { title: string; programTitle: string; endAt: string; type: string } | null; lastError: string | null }[];
}

function Stat({ label, value, icon, tone }: { label: string; value: ReactNode; icon: ReactNode; tone: string }) {
  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        <div className={cx("grid size-11 place-items-center rounded-lg", tone)}>{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="truncate text-2xl font-semibold tracking-tight">{value}</p>
        </div>
      </CardBody>
    </Card>
  );
}

export const Dot = ({ on }: { on: boolean }) => <span className={cx("inline-block size-2.5 shrink-0 rounded-full", on ? "bg-ok" : "bg-danger")} />;

export function Dashboard() {
  const { t } = useTranslation();
  const { data: o } = useGet<Overview>("/api/management/overview", 5000);
  const { data: live } = useGet<ControlStatus>("/api/control", 3000);
  const { user } = useSession();
  if (!o) return null;
  const editorial = [
    { to: "/new-hour", icon: WandSparkles, label: t("mgmt.dashboard.ed1"), hint: t("mgmt.dashboard.ed1Hint") },
    { to: "/week", icon: CalendarRange, label: t("mgmt.dashboard.ed2"), hint: t("mgmt.dashboard.ed2Hint") },
    { to: "/rundowns", icon: ClipboardList, label: t("mgmt.dashboard.ed3"), hint: t("mgmt.dashboard.ed3Hint") },
  ];
  const steps = [
    { done: o.atems.length > 0, label: t("mgmt.dashboard.stepAtem"), to: "/devices" },
    { done: o.studios.length > 0, label: t("mgmt.dashboard.stepStudio"), to: "/devices" },
    { done: o.mediaSources > 0, label: t("mgmt.dashboard.stepMedia"), to: "/media" },
    { done: o.channels > 0, label: t("mgmt.dashboard.stepChannel"), to: "/channels" },
    { done: o.blocks > 0, label: t("mgmt.dashboard.stepBlocks"), to: "/blocks" },
    { done: o.upcomingEntries > 0, label: t("mgmt.dashboard.stepSchedule"), to: "/schedule" },
    { done: o.mailConfigured, label: t("mgmt.dashboard.stepMail"), to: "/system/mail" },
    { done: o.backupTargets > 0, label: t("mgmt.dashboard.stepBackup"), to: "/system/backup" },
  ];
  const onAir = live?.channels.filter((c) => c.automation).length ?? 0;
  return (
    <>
      <PageHeader title={t("mgmt.dashboard.title")} description={t("mgmt.dashboard.intro")} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label={t("mgmt.dashboard.channels")} value={`${onAir} / ${o.channels}`} icon={<Tv className="size-5" />} tone="bg-onair/12 text-onair" />
        <Stat label={t("mgmt.dashboard.media")} value={o.mediaFiles} icon={<FolderOpen className="size-5" />} tone="bg-brand/10 text-brand" />
        <Stat label={t("mgmt.dashboard.upcoming")} value={o.upcomingEntries} icon={<Radio className="size-5" />} tone="bg-ok/12 text-ok" />
      </div>

      {roleAtLeast(user?.role, "editor") && (
        <Card className="mb-6">
          <CardHeader title={t("mgmt.dashboard.editorialTitle")} description={t("mgmt.dashboard.editorialIntro")} />
          <ol className="grid gap-3 p-5 pt-0 md:grid-cols-3">
            {editorial.map((e, i) => (
              <li key={e.to}>
                <Link to={e.to} className="group flex h-full items-center gap-3 rounded-xl border border-line p-4 transition hover:border-brand/60 hover:bg-brand/5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand group-hover:bg-brand group-hover:text-white">
                    <e.icon className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      {i + 1}. {e.label}
                    </span>
                    <span className="block text-xs text-muted">{e.hint}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {!!live?.channels.length && (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          {live.channels.map((c) => (
            <Link key={c.channel.id} to="/control">
              <Card className="transition hover:border-brand/50">
                <CardBody className="flex items-center gap-4">
                  <div className="h-12 w-1.5 rounded-full" style={{ background: c.channel.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.channel.name}</span>
                      {c.automation ? <Badge tone="danger">● {t("mgmt.control.onAir")}</Badge> : <Badge>{t("mgmt.control.manual")}</Badge>}
                    </div>
                    <p className="truncate text-sm text-muted">
                      {c.current ? `${c.current.programTitle || c.current.title || t("mgmt.control.filler")} · ${t("mgmt.control.until")} ${fmtTime(c.current.endAt)}` : t("mgmt.control.nothing")}
                    </p>
                    {c.lastError && <p className="truncate text-xs text-danger">{c.lastError}</p>}
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("mgmt.dashboard.setup")} description={t("mgmt.dashboard.setupIntro")} actions={<Badge tone="brand">{steps.filter((s) => s.done).length} / {steps.length}</Badge>} />
          <ul className="divide-y divide-line">
            {steps.map((s) => (
              <li key={s.label}>
                <Link to={s.to} className="flex items-center gap-3 px-5 py-3 transition hover:bg-surface-2/60">
                  {s.done ? <CheckCircle2 className="size-5 text-ok" /> : <Circle className="size-5 text-line" />}
                  <span className={cx("flex-1 text-sm", s.done && "text-muted line-through")}>{s.label}</span>
                  <span className="text-xs font-medium text-brand">{t("mgmt.open")} →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={t("mgmt.dashboard.devices")} description={t("mgmt.dashboard.devicesIntro")} />
          <ul className="divide-y divide-line text-sm">
            {o.atems.map((a) => (
              <li key={`a${a.name}`} className="flex items-center gap-3 px-5 py-3">
                <Dot on={a.connected} />
                <span className="flex-1 font-medium">{a.name}</span>
                <span className="text-muted">{a.productName ?? t("mgmt.devices.atem")}</span>
              </li>
            ))}
            {o.studios.map((s) => (
              <li key={`s${s.name}`} className="flex items-center gap-3 px-5 py-3">
                <Dot on={s.connected} />
                <span className="flex-1 font-medium">{s.name}</span>
                <span className="text-muted">{s.version ? `CasparCG ${s.version}` : s.host}</span>
              </li>
            ))}
            {!o.atems.length && !o.studios.length && <li className="px-5 py-6 text-center text-muted">{t("mgmt.dashboard.noDevices")}</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
