import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, cx, del, get, post, put, roleAtLeast, useSession } from "@tvsm/ui";
import { AlertTriangle, ArrowDown, ArrowUp, Clock3, Copy, Film, GripVertical, Plus, Save, Trash2, Tv, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { layoutClock } from "../../server/hourclock";
import { ClockRing } from "../components/ClockRing";
import { indicatorClass, useDrop, useDropList, type DragPayload } from "../components/dnd";
import { WithMediaBin } from "../components/MediaBin";
import { errorText, fmtDuration, parseDuration, useGet, type BlockSummary, type ClockItem, type HourClock } from "../lib";
import { ColorPicker } from "./Categories";

const PROGRAM_COLOR = "var(--color-brand)";
/** Minute and second within the hour: 330000 -> "05:30" */
const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function ClockEditor({ id, onSaved, onInsertRef }: { id: number | "new"; onSaved: () => void; onInsertRef?: { current: ((p: Exclude<DragPayload, { kind: "row" }>) => void) | null } }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const blocks = useGet<{ blocks: BlockSummary[] }>("/api/blocks");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3B6CFF");
  const [items, setItems] = useState<ClockItem[]>([]);
  const [usage, setUsage] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    setMsg(null);
    setDirty(false);
    if (id === "new") {
      setName("");
      setColor("#3B6CFF");
      setUsage(0);
      setItems([
        { kind: "block", blockId: null, durationMs: null, title: null },
        { kind: "program", blockId: null, durationMs: null, title: null },
      ]);
      return;
    }
    void get<HourClock>(`/api/clocks/${id}`).then((c) => {
      setName(c.name);
      setColor(c.color);
      setItems(c.items);
      setUsage(c.usage);
    });
  }, [id]);

  const byId = useMemo(() => new Map((blocks.data?.blocks ?? []).map((b) => [b.id, b])), [blocks.data]);
  const layout = useMemo(() => layoutClock(items.map((i) => ({ kind: i.kind, blockId: i.blockId, durationMs: i.durationMs, title: i.title })), (bid) => byId.get(bid)?.durationMs ?? 0), [items, byId]);
  const change = (next: ClockItem[]) => {
    setItems(next);
    setDirty(true);
  };
  const patch = (i: number, p: Partial<ClockItem>) => change(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => {
    const n = [...items];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x!);
    change(n);
  };

  /** Library drops: a block goes in as a fixed part; clips become a block first (the same clip reuses its block). */
  const insert = async (at: number | null, p: Exclude<DragPayload, { kind: "row" }>) => {
    setMsg(null);
    try {
      let blockId: number;
      if (p.kind === "block") blockId = p.block.id;
      else {
        const r = await post<{ id: number; created: boolean }>("/api/blocks/from-media", { mediaIds: p.media.map((m) => m.id) });
        blockId = r.id;
        await blocks.reload();
        if (r.created) setMsg({ tone: "ok", text: t("mgmt.bin.blockCreated") });
      }
      setItems((cur) => {
        const pos = at ?? cur.length;
        return [...cur.slice(0, pos), { kind: "block", blockId, durationMs: null, title: null }, ...cur.slice(pos)];
      });
      setDirty(true);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const dnd = useDropList({ list: "clock", length: items.length, onInsert: (i, p) => void insert(i, p), onMove: (from, to) => move(from, to - from) });
  const ringDrop = useDrop((p) => p.kind !== "row" && void insert(null, p));
  useEffect(() => {
    if (onInsertRef) onInsertRef.current = (p) => void insert(null, p);
  });

  const save = async () => {
    setMsg(null);
    if (items.some((i) => i.kind === "block" && !i.blockId)) return setMsg({ tone: "danger", text: t("mgmt.clocks.chooseBlocks") });
    const body = { name, color, items: items.map(({ kind, blockId, durationMs, title }) => ({ kind, blockId, durationMs, title })) };
    try {
      const r = id === "new" ? await post<{ id: number }>("/api/clocks", body) : await put<{ id: number }>(`/api/clocks/${id}`, body);
      setDirty(false);
      setMsg({ tone: "ok", text: t("common.saved") });
      onSaved();
      if (id === "new") navigate(`/clocks/${r.id}`);
    } catch (e) {
      setMsg({ tone: "danger", text: errorText(t, e) });
    }
  };
  const remove = async () => {
    if (id === "new" || !confirm(t(usage ? "mgmt.clocks.confirmDeleteUsed" : "mgmt.clocks.confirmDelete", { name, n: usage }))) return;
    await del(`/api/clocks/${id}`);
    onSaved();
    navigate("/clocks");
  };
  const duplicate = async () => {
    if (id === "new") return;
    const r = await post<{ id: number }>(`/api/clocks/${id}/duplicate`);
    onSaved();
    navigate(`/clocks/${r.id}`);
  };
  const segColor = (i: number) => {
    const it = items[i];
    return it?.kind === "program" ? PROGRAM_COLOR : (byId.get(it?.blockId ?? 0)?.color ?? "#64748B");
  };
  const sortedBlocks = [...(blocks.data?.blocks ?? [])].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "commercial" ? 1 : -1));

  return (
    <Card>
      <CardHeader
        icon={<Clock3 className="size-4" />}
        title={id === "new" ? t("mgmt.clocks.new") : name}
        description={t("mgmt.clocks.summary", { fixed: fmtDuration(layout.fixedMs), program: fmtDuration(layout.programMs) })}
        actions={
          <>
            {id !== "new" && <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void duplicate()} title={t("mgmt.blocks.duplicate")} />}
            {id !== "new" && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()} title={t("common.delete")} />}
            <Button size="sm" icon={<Save className="size-3.5" />} onClick={() => void save()} disabled={!name}>
              {t("common.save")}
            </Button>
          </>
        }
      />
      <CardBody className="space-y-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {layout.overbooked && (
          <Alert tone="danger">
            <AlertTriangle className="mr-1 inline size-4" /> {t("mgmt.clocks.overbooked")}
          </Alert>
        )}
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <div {...ringDrop.props} className={cx("flex flex-col items-center gap-3 rounded-full p-1 transition", ringDrop.over && "bg-brand/10 ring-2 ring-brand/40")}>
            <ClockRing layout={layout} colors={segColor} size={200} highlight={hover} />
            {usage > 0 && <Badge tone="brand">{t("mgmt.clocks.usedBy", { n: usage })}</Badge>}
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <Field label={t("common.name")}>{(fid) => <Input id={fid} value={name} placeholder={t("mgmt.clocks.namePlaceholder")} onChange={(e) => (setName(e.target.value), setDirty(true))} />}</Field>
            <div>
              <p className="mb-2 text-[13px] font-medium">{t("mgmt.blocks.color")}</p>
              <ColorPicker value={color} onChange={(c) => (setColor(c), setDirty(true))} />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm font-semibold">{t("mgmt.clocks.layout")}</p>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => change([...items, { kind: "block", blockId: null, durationMs: null, title: null }])}>
              {t("mgmt.clocks.addFixed")}
            </Button>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => change([...items, { kind: "program", blockId: null, durationMs: null, title: null }])}>
              {t("mgmt.clocks.addProgram")}
            </Button>
          </div>
          <ol {...dnd.listProps} className={cx("divide-y divide-line rounded-md border transition", dnd.indicator != null ? "border-brand/60" : "border-line")}>
            {items.map((it, i) => {
              const seg = layout.segments[i];
              const b = it.blockId ? byId.get(it.blockId) : undefined;
              return (
                <li
                  key={i}
                  {...dnd.rowProps(i, it.kind === "program" ? t("mgmt.clocks.program") : (b?.name ?? ""))}
                  className={cx("flex cursor-grab flex-wrap items-center gap-3 px-3 py-2.5 text-sm transition active:cursor-grabbing", hover === i && "bg-surface-2/60", indicatorClass(dnd.indicator, i, items.length))}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <GripVertical className="-mr-1 size-3.5 shrink-0 text-muted/50" />
                  <span className="w-12 font-mono text-xs text-muted">{mmss(seg?.offsetMs ?? 0)}</span>
                  <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", it.kind === "program" ? "bg-brand/10 text-brand" : "text-white")} style={it.kind === "block" ? { background: b?.color ?? "#64748B" } : undefined}>
                    {it.kind === "program" ? <Tv className="size-3.5" /> : <Film className="size-3.5" />}
                  </span>
                  {it.kind === "block" ? (
                    <Select className="h-8 min-w-36 flex-1 text-[13px]" value={it.blockId ?? ""} onChange={(e) => patch(i, { blockId: Number(e.target.value) || null })}>
                      <option value="">{t("mgmt.clocks.chooseBlock")}</option>
                      {sortedBlocks.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.kind === "commercial" ? "📺 " : ""}
                          {x.name} ({fmtDuration(x.durationMs)})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="min-w-36 flex-1">
                      <span className="block font-medium">{t("mgmt.clocks.program")}</span>
                      <span className="block text-xs text-muted">{t("mgmt.clocks.programHint")}</span>
                    </span>
                  )}
                  <span className="flex items-center gap-2">
                    {it.kind === "program" ? (
                      <Select className="h-8 w-auto! text-[13px]" value={it.durationMs == null ? "rest" : "fixed"} onChange={(e) => patch(i, { durationMs: e.target.value === "rest" ? null : (seg?.durationMs ?? 15 * 60_000) })}>
                        <option value="rest">{t("mgmt.clocks.rest")}</option>
                        <option value="fixed">{t("mgmt.clocks.fixedLength")}</option>
                      </Select>
                    ) : (
                      <Select className="h-8 w-auto! text-[13px]" value={it.durationMs == null ? "own" : "reserve"} onChange={(e) => patch(i, { durationMs: e.target.value === "own" ? null : (b?.durationMs ?? 5 * 60_000) })}>
                        <option value="own">{t("mgmt.clocks.ownLength")}</option>
                        <option value="reserve">{t("mgmt.clocks.reserve")}</option>
                      </Select>
                    )}
                    {it.durationMs != null ? (
                      <Input
                        key={`${i}-${it.durationMs}`}
                        className="h-8 w-20! text-right font-mono text-xs"
                        defaultValue={fmtDuration(it.durationMs)}
                        title="m:ss"
                        onBlur={(e) => {
                          const ms = parseDuration(e.target.value);
                          if (ms != null) patch(i, { durationMs: ms });
                        }}
                      />
                    ) : (
                      <span className="w-20 text-right font-mono text-xs text-muted">{fmtDuration(seg?.durationMs ?? 0)}</span>
                    )}
                  </span>
                  <span className="flex shrink-0">
                    <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="up">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="down">
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger" onClick={() => change(items.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
                      <X className="size-3.5" />
                    </button>
                  </span>
                </li>
              );
            })}
            {!items.length && <li className={cx("px-3 py-8 text-center text-sm", dnd.indicator != null ? "bg-brand/5 text-brand" : "text-muted")}>{t("mgmt.clocks.empty")}</li>}
          </ol>
          <p className="mt-2 text-xs text-muted">{t("mgmt.clocks.help")} {t("mgmt.bin.hintClock")}</p>
          {dirty && <p className="mt-1 text-xs text-warn">{t("mgmt.blocks.unsaved")}</p>}
        </div>
      </CardBody>
    </Card>
  );
}

export function ClocksPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const params = useParams();
  const canEdit = roleAtLeast(user?.role, "editor");
  const list = useGet<{ clocks: HourClock[] }>("/api/clocks");
  const sel = params.id === "new" ? "new" : params.id ? Number(params.id) : null;
  const insertRef = useRef<((p: Exclude<DragPayload, { kind: "row" }>) => void) | null>(null);
  const editing = sel != null && canEdit;
  return (
    <>
      <PageHeader
        title={t("mgmt.clocks.title")}
        description={t("mgmt.clocks.intro")}
        actions={
          canEdit && (
            <Link to="/clocks/new">
              <Button icon={<Plus className="size-4" />}>{t("mgmt.clocks.new")}</Button>
            </Link>
          )
        }
      />
      <WithMediaBin onAdd={editing ? (p) => insertRef.current?.(p) : undefined} hint={editing ? t("mgmt.bin.hintClock") : t("mgmt.bin.hintClockSelect")}>
      <div className="grid gap-6 @4xl:grid-cols-[240px_1fr]">
        <Card className="self-start">
          <ul className="max-h-[40vh] divide-y divide-line overflow-y-auto @4xl:max-h-[70vh]">
            {list.data?.clocks.map((c) => (
              <li key={c.id}>
                <Link to={`/clocks/${c.id}`} className={cx("flex items-center gap-3 px-4 py-3 transition", sel === c.id ? "bg-brand/8" : "hover:bg-surface-2/60")}>
                  <ClockRing layout={c.layout} size={40} colors={(i) => (c.items[i]?.kind === "program" ? PROGRAM_COLOR : (c.items[i]?.blockColor ?? undefined))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block text-xs text-muted">{t("mgmt.clocks.summary", { fixed: fmtDuration(c.layout.fixedMs), program: fmtDuration(c.layout.programMs) })}</span>
                  </span>
                  {c.layout.overbooked && <AlertTriangle className="size-4 text-danger" />}
                </Link>
              </li>
            ))}
            {list.data && !list.data.clocks.length && <li className="px-4 py-8 text-center text-sm text-muted">{t("mgmt.clocks.none")}</li>}
          </ul>
        </Card>
        {sel != null && canEdit ? (
          <ClockEditor id={sel} onSaved={() => void list.reload()} onInsertRef={insertRef} />
        ) : (
          <Card>
            <CardBody className="py-16 text-center text-muted">
              <Clock3 className="mx-auto mb-3 size-8" />
              {t("mgmt.clocks.select")}
            </CardBody>
          </Card>
        )}
      </div>
      </WithMediaBin>
    </>
  );
}
