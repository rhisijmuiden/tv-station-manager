import { useState, useSyncExternalStore, type DragEvent } from "react";
import { fmtDuration, type BlockSummary, type MediaItem } from "../lib";

/**
 * Drag and drop between the media library and the editors (hour clocks, week, rundowns, blocks).
 * Uses the native HTML5 drag events; the payload is also kept here because browsers only expose
 * the data on drop, while drop targets want to know what is coming while it hovers.
 */
export type DragPayload =
  | { kind: "media"; media: MediaItem[] }
  | { kind: "block"; block: BlockSummary }
  /** A row being reordered inside one list. */
  | { kind: "row"; list: string; index: number };

const MIME = "application/x-tvsm";
let current: DragPayload | null = null;
const listeners = new Set<() => void>();
const set = (p: DragPayload | null) => {
  current = p;
  listeners.forEach((l) => l());
};
if (typeof window !== "undefined") {
  // dragend does not fire when the dragged row is removed from the page, so also clear on drop.
  window.addEventListener("dragend", () => set(null));
  window.addEventListener("drop", () => setTimeout(() => set(null), 0));
}

/** What is being dragged right now (null when nothing). Re-renders when a drag starts or ends. */
export const useDragging = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );

export const payloadDuration = (p: DragPayload) => (p.kind === "media" ? p.media.reduce((s, m) => s + (m.durationMs ?? 0), 0) : p.kind === "block" ? p.block.durationMs : 0);

export function startDrag(e: DragEvent, p: DragPayload, label: string) {
  e.dataTransfer.setData(MIME, p.kind);
  e.dataTransfer.setData("text/plain", label);
  e.dataTransfer.effectAllowed = p.kind === "row" ? "move" : "copy";
  if (p.kind !== "row") {
    // A small card under the pointer: what is dragged and how long it is.
    const ghost = document.createElement("div");
    ghost.className = "fixed -top-96 left-0 flex items-center gap-2 rounded-lg border border-brand bg-surface px-3 py-2 text-sm font-medium text-fg shadow-lg";
    const n = p.kind === "media" ? p.media.length : 1;
    ghost.textContent = `${n > 1 ? `${n} × ` : ""}${label} · ${fmtDuration(payloadDuration(p))}`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    setTimeout(() => ghost.remove(), 0);
  }
  // Let the browser take its drag snapshot first; re-rendering targets right away can cancel the drag.
  setTimeout(() => set(p), 0);
}

/** True when the drag comes from this app (not a file from the desktop). */
const ours = (e: DragEvent) => e.dataTransfer.types.includes(MIME);

/** A drop target. `accept` decides per payload; the hook tracks hovering for highlighting. */
export function useDrop(onDrop: (p: DragPayload, e: DragEvent) => void, accept: (p: DragPayload) => boolean = (p) => p.kind !== "row") {
  const [over, setOver] = useState(false);
  const ok = (e: DragEvent) => ours(e) && !!current && accept(current);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!ok(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = current?.kind === "row" ? "move" : "copy";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!ok(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const p = current!;
        set(null);
        onDrop(p, e);
      },
    },
  };
}

/**
 * A list that takes drops between its rows (from the library) and can be reordered by dragging rows.
 * `indicator` is the index where a drop would land (rows.length = at the end), for drawing a line.
 */
export function useDropList({ list, length, onInsert, onMove, accept = (p) => p.kind !== "row" }: { list: string; length: number; onInsert: (index: number, p: Exclude<DragPayload, { kind: "row" }>) => void; onMove: (from: number, to: number) => void; accept?: (p: DragPayload) => boolean }) {
  const [indicator, setIndicator] = useState<number | null>(null);
  const valid = (p: DragPayload | null): p is DragPayload => !!p && (p.kind === "row" ? p.list === list : accept(p));
  const drop = (e: DragEvent, index: number) => {
    setIndicator(null);
    if (!ours(e) || !valid(current)) return;
    e.preventDefault();
    e.stopPropagation();
    const p = current;
    set(null);
    if (p.kind === "row") {
      const to = index > p.index ? index - 1 : index;
      if (to !== p.index) onMove(p.index, to);
    } else onInsert(index, p);
  };
  const over = (e: DragEvent, index: number) => {
    if (!ours(e) || !valid(current)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = current.kind === "row" ? "move" : "copy";
    if (indicator !== index) setIndicator(index);
  };
  return {
    indicator,
    /** On the list element: dropping on empty space adds at the end. */
    listProps: {
      onDragOver: (e: DragEvent) => over(e, length),
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIndicator(null);
      },
      onDrop: (e: DragEvent) => drop(e, indicator ?? length),
    },
    /** On each row: the upper half drops before the row, the lower half after it. */
    rowProps: (i: number, label: string, draggable = true) => ({
      draggable,
      onDragStart: (e: DragEvent) => {
        if ((e.target as HTMLElement).closest("input,select,textarea")) return e.preventDefault();
        startDrag(e, { kind: "row", list, index: i }, label);
      },
      onDragOver: (e: DragEvent) => {
        const r = e.currentTarget.getBoundingClientRect();
        over(e, e.clientY < r.top + r.height / 2 ? i : i + 1);
      },
      onDrop: (e: DragEvent) => drop(e, indicator ?? i),
    }),
  };
}

/** Classes that draw the insertion line on a row of a `useDropList`. */
export const indicatorClass = (indicator: number | null, i: number, length: number) =>
  indicator === i ? "shadow-[inset_0_2px_0_0_var(--color-brand)]" : indicator === length && i === length - 1 ? "shadow-[inset_0_-2px_0_0_var(--color-brand)]" : "";

export type DropItem = { type: "media"; mediaId: number; media: MediaItem } | { type: "block"; childBlockId: number; block: BlockSummary };
/** Library payload as rundown items. */
export const payloadItems = (p: Exclude<DragPayload, { kind: "row" }>): DropItem[] => (p.kind === "media" ? p.media.map((m) => ({ type: "media" as const, mediaId: m.id, media: m })) : [{ type: "block" as const, childBlockId: p.block.id, block: p.block }]);
