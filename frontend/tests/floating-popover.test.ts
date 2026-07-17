import { describe, expect, it, vi } from "vitest";
import { floatingPopover } from "../src/floating-popover";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

describe("floating popover viewport placement", () => {
  it("uses the visual viewport when clamping a bottom-edge popover", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        offsetLeft: 20,
        offsetTop: 30,
        width: 300,
        height: 220,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });

    const anchor = document.createElement("button");
    const node = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", { value: () => rect(230, 210, 40, 20) });
    Object.defineProperty(node, "getBoundingClientRect", { value: () => rect(0, 0, 160, 100) });

    const action = floatingPopover(node, () => anchor);

    expect(node.style.left).toBe("110px");
    expect(node.style.top).toBe("102px");
    action.destroy();
    vi.unstubAllGlobals();
  });
});
