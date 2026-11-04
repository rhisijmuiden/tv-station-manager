import { cx } from "@tvsm/ui";
import {
  Cable,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Scan,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import type { Health } from "../server/monitorlogic";
import {
  LAYERS,
  ROOM_LINKS,
  boxSize,
  fitZoom,
  project,
  roomLayout,
  slot,
  worstHealth,
  type Camera,
  type LayerId,
  type MonItem,
} from "./monitorView";

const BASE_ANGLE = -38;
const BASE_TILT = 56;
const PERSPECTIVE = 2400;
const ORIGIN_Y = 0.3;

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases the camera to its target, so the floor and the name labels (drawn flat on top) move together. */
function useTween(target: Camera, instant: boolean): Camera {
  const [cur, setCur] = useState(target);
  const last = useRef(target);
  useEffect(() => {
    if (instant || reducedMotion()) {
      last.current = target;
      setCur(target);
      return;
    }
    const from = last.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 450);
      const e = 1 - (1 - k) ** 3;
      const c = {
        angle: from.angle + (target.angle - from.angle) * e,
        tilt: from.tilt + (target.tilt - from.tilt) * e,
        zoom: from.zoom + (target.zoom - from.zoom) * e,
      };
      last.current = c;
      setCur(c);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.angle, target.tilt, target.zoom, instant]);
  return cur;
}

/**
 * 3D room: one platform per layer, one block per monitored item, coloured by health. Plain CSS 3D transforms
 * (no WebGL), so it runs on any browser and scales with the number of items. Drag to rotate and tilt.
 */
export function MonitoringRoom({
  items,
  visible,
  selected,
  onSelect,
  many,
}: {
  items: MonItem[];
  visible: Set<string>;
  selected: string | null;
  onSelect: (key: string) => void;
  many: boolean;
}) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [rot, setRot] = useState(0);
  const [tilt, setTilt] = useState(BASE_TILT);
  const [zoom, setZoom] = useState(1);
  const [cables, setCables] = useState(true);
  const [problems, setProblems] = useState(false);
  const drag = useRef<{
    x: number;
    y: number;
    rot: number;
    tilt: number;
    moved: boolean;
    id: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byLayer = useMemo(() => {
    const m = Object.fromEntries(
      LAYERS.map((l) => [l, [] as MonItem[]]),
    ) as Record<LayerId, MonItem[]>;
    for (const i of items) m[i.layer].push(i);
    return m;
  }, [items]);
  const countsKey = LAYERS.map((l) => byLayer[l].length).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const room = useMemo(
    () =>
      roomLayout(
        Object.fromEntries(LAYERS.map((l) => [l, byLayer[l].length])) as Record<
          LayerId,
          number
        >,
      ),
    [countsKey],
  );
  const target: Camera = {
    angle: BASE_ANGLE + rot,
    tilt,
    zoom: fitZoom(room, size.w, size.h, BASE_ANGLE + rot, tilt) * zoom,
  };
  const cam = useTween(target, dragging);
  const stageBox = { w: size.w, h: size.h, d: PERSPECTIVE, oy: ORIGIN_Y };

  const centre = (l: LayerId) => {
    const p = room.platforms[l];
    return [p.x + p.w / 2, p.y + p.h / 2] as const;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      rot,
      tilt,
      moved: false,
      id: e.pointerId,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 4) {
      d.moved = true;
      setDragging(true);
      stage.current?.setPointerCapture(d.id);
    }
    if (d.moved) {
      setRot(d.rot + dx * 0.35);
      setTilt(Math.max(28, Math.min(78, d.tilt - dy * 0.25)));
    }
  };
  const onPointerUp = () => {
    // After a drag the entry stays until the click that follows, so that click does not select a block.
    if (drag.current?.moved) setDragging(false);
    else drag.current = null;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
    drag.current = null;
  };

  const legend: Health[] = ["ok", "warn", "down", "unknown"];
  const ctl =
    "inline-grid size-10 place-items-center rounded-lg border border-line bg-surface text-brand-dark transition hover:border-brand-light hover:text-brand";
  const toggle = (on: boolean) =>
    cx(
      "inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition",
      on
        ? "border-brand-light bg-brand/10 text-brand-dark"
        : "border-line bg-surface text-fg hover:border-brand-light",
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ctl}
          onClick={() => setRot((r) => r - 45)}
          aria-label={t("orch.mon.rotateLeft")}
          title={t("orch.mon.rotateLeft")}
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          className={ctl}
          onClick={() => setRot((r) => r + 45)}
          aria-label={t("orch.mon.rotateRight")}
          title={t("orch.mon.rotateRight")}
        >
          <RotateCw className="size-4" />
        </button>
        <button
          type="button"
          className={ctl}
          onClick={() => setZoom((v) => Math.max(0.5, v / 1.2))}
          aria-label={t("orch.mon.zoomOut")}
          title={t("orch.mon.zoomOut")}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          className={ctl}
          onClick={() => setZoom((v) => Math.min(2.5, v * 1.2))}
          aria-label={t("orch.mon.zoomIn")}
          title={t("orch.mon.zoomIn")}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          className={toggle(false)}
          onClick={() => {
            setRot(0);
            setTilt(BASE_TILT);
            setZoom(1);
          }}
        >
          <Scan className="size-4" />
          {t("orch.mon.resetView")}
        </button>
        <span className="mx-1 h-6 w-px bg-line" />
        <button
          type="button"
          className={toggle(cables)}
          aria-pressed={cables}
          onClick={() => setCables(!cables)}
        >
          <Cable className="size-4" />
          {t("orch.mon.cables")}
        </button>
        <button
          type="button"
          className={toggle(problems)}
          aria-pressed={problems}
          onClick={() => setProblems(!problems)}
        >
          <TriangleAlert className="size-4" />
          {t("orch.mon.onlyProblems")}
        </button>
        <span className="ml-auto text-xs text-muted">
          {t("orch.mon.hint3d")}
        </span>
      </div>

      <div
        ref={stage}
        className={cx(
          "tvsm-room relative h-[420px] touch-none overflow-hidden rounded-xl border border-line select-none sm:h-[600px]",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <div
          className="tvsm-room-scene"
          style={{
            transform: `scale(${cam.zoom.toFixed(4)}) rotateX(${cam.tilt.toFixed(2)}deg) rotateZ(${cam.angle.toFixed(2)}deg)`,
          }}
        >
          <div
            className="tvsm-room-floor"
            style={{
              left: -room.width / 2,
              top: -room.height / 2,
              width: room.width,
              height: room.height,
            }}
          >
            {cables &&
              ROOM_LINKS.map(([a, b]) => {
                const [x1, y1] = centre(a);
                const [x2, y2] = centre(b);
                const len = Math.hypot(x2 - x1, y2 - y1);
                const h = worstHealth(byLayer[b]);
                return (
                  <div
                    key={`${a}-${b}`}
                    className={cx(
                      "tvsm-room-cable",
                      b === "infrastructure" && "tvsm-room-cable-support",
                    )}
                    data-h={h}
                    style={{
                      left: x1,
                      top: y1,
                      width: len,
                      transform: `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`,
                    }}
                  />
                );
              })}
            {LAYERS.map((l) => {
              const p = room.platforms[l];
              const list = byLayer[l];
              return (
                <div
                  key={l}
                  className={cx(
                    "tvsm-room-platform",
                    !list.length && "opacity-50",
                  )}
                  style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
                >
                  <span className="tvsm-room-dot" data-h={worstHealth(list)} />
                  <span>{t(`orch.mon.layer_${l}`).toUpperCase()}</span>
                  <span className="font-medium opacity-70">{list.length}</span>
                </div>
              );
            })}
            {LAYERS.flatMap((l) =>
              byLayer[l].map((i, n) => {
                const p = room.platforms[l];
                const c = slot(p, n);
                const [w, d, h] = boxSize(i);
                const off =
                  !visible.has(i.key) || (problems && i.health === "ok");
                const sel = i.key === selected;
                const face = (s: CSSProperties): CSSProperties => ({
                  ...s,
                  opacity: off ? 0.16 : 1,
                });
                return (
                  <div
                    key={i.key}
                    className="tvsm-room-box"
                    data-h={i.health}
                    style={{
                      left: c.x - w / 2,
                      top: c.y - d / 2,
                      width: w,
                      height: d,
                    }}
                  >
                    <div
                      className="tvsm-room-face tvsm-room-s2"
                      style={face({
                        left: 0,
                        top: 0,
                        width: w,
                        height: h,
                        transformOrigin: "top",
                        transform: "rotateX(90deg)",
                      })}
                    />
                    <div
                      className="tvsm-room-face tvsm-room-s1"
                      style={face({
                        left: 0,
                        top: 0,
                        width: h,
                        height: d,
                        transformOrigin: "left",
                        transform: "rotateY(-90deg)",
                      })}
                    />
                    <div
                      className={cx(
                        "tvsm-room-face tvsm-room-s1 tvsm-room-front",
                        i.health === "down" && !off && "tvsm-room-pulse",
                      )}
                      style={face({
                        left: 0,
                        top: d,
                        width: w,
                        height: h,
                        transformOrigin: "top",
                        transform: "rotateX(90deg)",
                      })}
                    />
                    <div
                      className={cx(
                        "tvsm-room-face tvsm-room-s2",
                        i.health === "down" && !off && "tvsm-room-pulse",
                      )}
                      style={face({
                        left: w,
                        top: 0,
                        width: h,
                        height: d,
                        transformOrigin: "left",
                        transform: "rotateY(-90deg)",
                      })}
                    />
                    <button
                      type="button"
                      aria-label={`${i.name}, ${t(`orch.mon.health.${i.health}`)}`}
                      className={cx(
                        "tvsm-room-face tvsm-room-top",
                        sel && "tvsm-room-selected",
                        i.health === "down" && !off && "tvsm-room-pulse",
                      )}
                      style={face({
                        left: 0,
                        top: 0,
                        width: w,
                        height: d,
                        transform: `translateZ(${h}px)`,
                      })}
                      onClick={() => onSelect(i.key)}
                    >
                      <span className="tvsm-room-led" />
                    </button>
                  </div>
                );
              }),
            )}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-0">
          {LAYERS.flatMap((l) =>
            byLayer[l].map((i, n) => {
              const off =
                !visible.has(i.key) || (problems && i.health === "ok");
              const sel = i.key === selected;
              if (off || (many && i.health === "ok" && !sel)) return null;
              const c = slot(room.platforms[l], n);
              const at = project(
                room,
                cam,
                stageBox,
                c.x,
                c.y,
                boxSize(i)[2] + 10,
              );
              if (at.x < 0 || at.y < 0 || at.x > size.w || at.y > size.h)
                return null;
              return (
                <button
                  key={i.key}
                  type="button"
                  tabIndex={-1}
                  className={cx(
                    "tvsm-room-pill pointer-events-auto",
                    sel && "tvsm-room-pill-selected",
                  )}
                  style={{ left: at.x, top: at.y }}
                  onClick={() => onSelect(i.key)}
                >
                  <span className="tvsm-room-dot" data-h={i.health} />
                  {i.name}
                </button>
              );
            }),
          )}
        </div>
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-sidebar/85 px-3 py-2 text-xs text-sidebar-fg">
          {legend.map((h) => (
            <span key={h} className="inline-flex items-center gap-1.5">
              <span className="tvsm-room-swatch" data-h={h} />
              {t(`orch.mon.health.${h}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
