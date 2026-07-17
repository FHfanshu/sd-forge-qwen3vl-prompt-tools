import { readViewportRect } from "./window-interactions";

type AnchorGetter = () => HTMLElement | undefined;

export function floatingPopover(node: HTMLElement, getAnchor: AnchorGetter) {
  document.body.appendChild(node);

  const position = () => {
    const anchor = getAnchor();
    if (!anchor) return;
    const gap = 8;
    const padding = 10;
    const viewport = readViewportRect();
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = node.getBoundingClientRect();
    const minLeft = viewport.left + padding;
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - popoverRect.width - padding);
    const left = Math.min(
      maxLeft,
      Math.max(minLeft, anchorRect.right - popoverRect.width),
    );
    const above = anchorRect.top - popoverRect.height - gap;
    const below = anchorRect.bottom + gap;
    const minTop = viewport.top + padding;
    const maxTop = Math.max(minTop, viewport.top + viewport.height - popoverRect.height - padding);
    const top = above >= minTop
      ? above
      : Math.min(maxTop, Math.max(minTop, below));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
  observer?.observe(node);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  requestAnimationFrame(position);

  return {
    destroy() {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      node.remove();
    },
  };
}
