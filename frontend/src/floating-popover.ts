type AnchorGetter = () => HTMLElement | undefined;

export function floatingPopover(node: HTMLElement, getAnchor: AnchorGetter) {
  document.body.appendChild(node);

  const position = () => {
    const anchor = getAnchor();
    if (!anchor) return;
    const gap = 8;
    const padding = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = node.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - popoverRect.width - padding,
      Math.max(padding, anchorRect.right - popoverRect.width),
    );
    const above = anchorRect.top - popoverRect.height - gap;
    const below = anchorRect.bottom + gap;
    const top = above >= padding
      ? above
      : Math.min(window.innerHeight - popoverRect.height - padding, Math.max(padding, below));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
  observer?.observe(node);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  requestAnimationFrame(position);

  return {
    destroy() {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      node.remove();
    },
  };
}
