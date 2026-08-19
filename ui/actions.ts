// Click-safe, always-acknowledged actions (ported from romp's actions.ts).
// A control whose action hangs on a node that a re-render rebuilds gets destroyed
// mid-click (a native `click` needs mousedown AND mouseup on the same element), so:
//   1. delegate the action to a STABLE ancestor keyed off data-act;
//   2. flash every activation immediately, before any server round-trip.

export type ActionHandler = (el: HTMLElement, ev: Event) => void;

export function flash(el: HTMLElement): void {
  el.classList.remove("acted");
  void el.offsetWidth;   // reflow so the animation restarts on a fast second click
  el.classList.add("acted");
  setTimeout(() => el.classList.remove("acted"), 280);
}

export function delegate(root: HTMLElement | Document, handlers: Record<string, ActionHandler>): void {
  root.addEventListener("click", (ev) => {
    const start = ev.target as Element | null;
    const el = start && typeof start.closest === "function"
      ? (start.closest("[data-act]") as HTMLElement | null)
      : null;
    if (!el) return;
    const within = root === document ? document.contains(el) : (root as HTMLElement).contains(el);
    if (!within) return;
    const act = el.dataset.act;
    if (!act) return;
    const h = handlers[act];
    if (!h) return;
    flash(el);
    h(el, ev);
  });
}
