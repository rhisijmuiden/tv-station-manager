/**
 * Drag and drop with a finger. The editors (blocks, week planning, clocks) use the browser's own drag events
 * (see dnd.tsx), which phones do not fire for a touch. This turns a long press followed by a move into those same
 * events, so every drop target keeps working unchanged:
 *
 * - hold a draggable row for LONG_PRESS_MS without moving: it lifts (a copy follows the finger, the phone buzzes);
 * - moving before that is a normal scroll;
 * - while dragging, the page scrolls when the finger nears the top or bottom edge;
 * - lifting the finger drops it where the last target accepted it, otherwise nothing happens.
 *
 * Mouse and pen keep using the browser's own drag and drop.
 */
const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 10;
const EDGE = 70;

/** The small part of DataTransfer that dnd.tsx uses, for browsers that cannot construct a real one. */
class TouchDataTransfer {
  dropEffect = "move";
  effectAllowed = "all";
  private data = new Map<string, string>();
  get types() {
    return [...this.data.keys()];
  }
  setData(type: string, value: string) {
    this.data.set(type, value);
  }
  getData(type: string) {
    return this.data.get(type) ?? "";
  }
  clearData() {
    this.data.clear();
  }
  setDragImage() {
    /* the finger carries a copy of the row instead */
  }
  get files() {
    return [] as unknown as FileList;
  }
  get items() {
    return [] as unknown as DataTransferItemList;
  }
}

function fire(target: EventTarget, type: string, dt: TouchDataTransfer, x: number, y: number, related: EventTarget | null = null) {
  const e = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperties(e, {
    dataTransfer: { value: dt },
    clientX: { value: x },
    clientY: { value: y },
    pageX: { value: x + window.scrollX },
    pageY: { value: y + window.scrollY },
    screenX: { value: x },
    screenY: { value: y },
    relatedTarget: { value: related },
    button: { value: 0 },
    buttons: { value: 1 },
  });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

/** The nearest element that scrolls vertically, else the page itself. */
function scroller(el: Element | null): Element {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement ?? document.documentElement;
}

let installed = false;

export function installTouchDrag() {
  if (installed || typeof window === "undefined" || !("ontouchstart" in window)) return;
  installed = true;

  let source: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  let last = { x: 0, y: 0 };
  let dragging = false;
  let dt: TouchDataTransfer | null = null;
  let ghost: HTMLElement | null = null;
  let offset = { x: 0, y: 0 };
  let over: Element | null = null;
  let accepted = false;
  let raf = 0;

  const cancelWait = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const reset = () => {
    cancelWait();
    cancelAnimationFrame(raf);
    ghost?.remove();
    source?.classList.remove("touch-drag-source");
    document.documentElement.classList.remove("touch-dragging");
    source = null;
    ghost = null;
    dt = null;
    over = null;
    accepted = false;
    dragging = false;
  };

  const moveGhost = () => {
    if (ghost) ghost.style.transform = `translate(${last.x - offset.x}px, ${last.y - offset.y}px) rotate(-1.5deg)`;
  };

  const hover = () => {
    if (!dt) return;
    const el = document.elementFromPoint(last.x, last.y);
    if (el !== over) {
      if (over) fire(over, "dragleave", dt, last.x, last.y, el);
      if (el) fire(el, "dragenter", dt, last.x, last.y, over);
      over = el;
    }
    accepted = el ? fire(el, "dragover", dt, last.x, last.y) : false;
  };

  // Near the top or bottom edge the list scrolls, a little faster the closer the finger is.
  const autoScroll = () => {
    if (!dragging) return;
    const box = scroller(over);
    const r = box === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : box.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const d = last.y < top + EDGE ? -(top + EDGE - last.y) : last.y > bottom - EDGE ? last.y - (bottom - EDGE) : 0;
    if (d) {
      box.scrollTop += Math.round(d / 4);
      hover();
    }
    raf = requestAnimationFrame(autoScroll);
  };

  const begin = () => {
    timer = null;
    if (!source) return;
    dt = new TouchDataTransfer();
    if (fire(source, "dragstart", dt, start.x, start.y)) return reset(); // the row said no (e.g. a text field)
    dragging = true;
    navigator.vibrate?.(25);
    const r = source.getBoundingClientRect();
    offset = { x: start.x - r.left, y: start.y - r.top };
    ghost = source.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("id");
    Object.assign(ghost.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${r.width}px`,
      margin: "0",
      zIndex: "9999",
      pointerEvents: "none",
      opacity: "0.95",
      background: "var(--color-surface, #fff)",
      border: "2px solid var(--color-brand, #713C80)",
      borderRadius: "12px",
      boxShadow: "0 14px 28px -10px rgb(0 0 0 / 0.45)",
      listStyle: "none",
    });
    document.body.appendChild(ghost);
    moveGhost();
    source.classList.add("touch-drag-source");
    document.documentElement.classList.add("touch-dragging");
    hover();
    raf = requestAnimationFrame(autoScroll);
  };

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return reset();
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[draggable="true"]');
      if (!el || (e.target as Element).closest("input,select,textarea,button,a[href]")) return;
      reset();
      source = el;
      const t = e.touches[0]!;
      start = last = { x: t.clientX, y: t.clientY };
      timer = setTimeout(begin, LONG_PRESS_MS);
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!source) return;
      const t = e.touches[0]!;
      last = { x: t.clientX, y: t.clientY };
      if (!dragging) {
        // Moved before the long press: this is a scroll, not a drag.
        if (Math.hypot(last.x - start.x, last.y - start.y) > MOVE_TOLERANCE) reset();
        return;
      }
      e.preventDefault();
      moveGhost();
      hover();
    },
    { passive: false },
  );

  const end = (e: TouchEvent) => {
    if (!source) return;
    if (!dragging) return reset();
    e.preventDefault(); // no click on whatever is under the finger
    const src = source;
    const d = dt!;
    hover();
    if (accepted && over) fire(over, "drop", d, last.x, last.y);
    else if (over) fire(over, "dragleave", d, last.x, last.y, null);
    reset();
    fire(src, "dragend", d, last.x, last.y);
  };
  document.addEventListener("touchend", end, { passive: false });
  document.addEventListener("touchcancel", () => {
    if (dragging && source && dt) fire(source, "dragend", dt, last.x, last.y);
    reset();
  });

  // Where the browser has its own touch drag, let it take over instead of doing it twice.
  document.addEventListener(
    "dragstart",
    (e) => {
      if (e.isTrusted && source && !dragging) reset();
    },
    true,
  );
  // A long press would otherwise open the phone's copy/share menu on the row.
  document.addEventListener("contextmenu", (e) => {
    if (source || dragging) e.preventDefault();
  });
}
