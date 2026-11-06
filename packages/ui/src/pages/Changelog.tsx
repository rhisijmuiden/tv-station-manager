import { CircleMinus, FlaskConical, Pencil, Plus, Sparkles, Wrench } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { baseVersion, changesByKind, type ChangeApp, type ChangeKind } from "../changelog";
import { releases } from "../changelogData";
import { Badge, Card, CardBody, PageHeader, cx } from "../components/ui";
import { useSession } from "../session";

const KIND_ICON: Record<ChangeKind, ReactNode> = {
  added: <Plus className="size-3.5" />,
  changed: <Pencil className="size-3.5" />,
  improved: <Sparkles className="size-3.5" />,
  fixed: <Wrench className="size-3.5" />,
  removed: <CircleMinus className="size-3.5" />,
};
const KIND_TONE: Record<ChangeKind, string> = {
  added: "bg-ok/15 text-ok",
  changed: "bg-brand/15 text-brand",
  improved: "bg-brand/15 text-brand",
  fixed: "bg-warn/15 text-warn",
  removed: "bg-danger/15 text-danger",
};

export function ChangelogPage() {
  const { t, i18n } = useTranslation();
  const { info } = useSession();
  const lang = i18n.language?.startsWith("nl") ? "nl" : "en";
  const appId = info?.app.id as ChangeApp | undefined;
  const [onlyThisApp, setOnlyThisApp] = useState(true);
  const current = info ? baseVersion(info.version) : undefined;
  const isTestBuild = !!info && info.version !== current;

  const shown = useMemo(
    () =>
      releases
        .map((r) => ({
          ...r,
          changes: onlyThisApp && appId ? r.changes.filter((c) => c.apps.some((a) => a === appId || a === "platform" || a === "studio")) : r.changes,
        }))
        .filter((r) => r.changes.length),
    [onlyThisApp, appId],
  );
  const date = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <PageHeader
        title={t("changelog.title")}
        description={t("changelog.intro")}
        actions={
          appId && (
            <div className="inline-flex rounded-md border border-line p-0.5 text-sm">
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setOnlyThisApp(v)}
                  className={cx("rounded px-3 py-1.5", onlyThisApp === v ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
                >
                  {v ? t("changelog.thisApp", { app: info?.app.name }) : t("changelog.allApps")}
                </button>
              ))}
            </div>
          )
        }
      />
      <ol className="relative space-y-6 border-l border-line pl-6 sm:ml-2">
        {shown.map((r) => {
          const isCurrent = r.version === current;
          return (
            <li key={r.version} id={`v${r.version}`} className="relative">
              <span className={cx("absolute -left-[31px] top-5 size-3 rounded-full border-2 border-surface", r.date ? "bg-brand" : "bg-warn")} />
              <Card>
                <CardBody className="space-y-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="font-mono text-xl font-semibold">v{r.version}</h2>
                    {r.date ? (
                      <span className="text-sm text-muted">{date(r.date)}</span>
                    ) : (
                      <Badge tone="warn">
                        <span className="inline-flex items-center gap-1">
                          <FlaskConical className="size-3" /> {t("changelog.inTest")}
                        </span>
                      </Badge>
                    )}
                    {isCurrent && <Badge tone="ok">{isTestBuild ? t("changelog.yourTestBuild", { version: info?.version }) : t("changelog.yourVersion")}</Badge>}
                  </div>
                  {r.summary && <p className="text-sm text-muted">{r.summary[lang]}</p>}
                  {changesByKind(r.changes).map((g) => (
                    <section key={g.kind}>
                      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <span className={cx("inline-grid size-6 place-items-center rounded-full", KIND_TONE[g.kind])}>{KIND_ICON[g.kind]}</span>
                        {t(`changelog.kind.${g.kind}`)}
                        <span className="font-normal text-muted">{g.changes.length}</span>
                      </h3>
                      <ul className="space-y-1.5 pl-8 text-sm">
                        {g.changes.map((c, i) => (
                          <li key={`${c.feature}-${i}`} className="list-disc marker:text-muted">
                            {c[lang]}
                            {!onlyThisApp && (
                              <span className="ml-2 inline-flex gap-1 align-middle">
                                {c.apps.map((a) => (
                                  <span key={a} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                                    {t(`changelog.app.${a}`)}
                                  </span>
                                ))}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ol>
    </>
  );
}
