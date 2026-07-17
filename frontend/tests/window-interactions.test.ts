import { describe, expect, it } from "vitest";
import { clampWindowLayout, minimumForViewport, readViewportRect } from "../src/window-interactions";

describe("window viewport boundaries", () => {
  it("shrinks below the logical minimum when the viewport is narrower", () => {
    const layout = clampWindowLayout(
      { left: 12, top: 8, width: 396, height: 620 },
      { left: 0, top: 0, width: 320, height: 568 },
    );

    expect(layout.width).toBe(304);
    expect(layout.left).toBe(8);
    expect(layout.left + layout.width).toBe(312);
    expect(layout.top + layout.height).toBeLessThanOrEqual(560);
  });

  it("keeps mobile layouts inside a very small visual viewport", () => {
    const minimum = minimumForViewport("mobilePortrait");
    const layout = clampWindowLayout(
      { left: 500, top: 500, width: 360, height: 560 },
      { left: 12, top: 24, width: 280, height: 340 },
      minimum,
    );

    expect(layout.left).toBeGreaterThanOrEqual(20);
    expect(layout.top).toBeGreaterThanOrEqual(32);
    expect(layout.left + layout.width).toBeLessThanOrEqual(284);
    expect(layout.top + layout.height).toBeLessThanOrEqual(356);
  });

  it("reads the visual viewport offset and dimensions when available", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 14, offsetTop: 22, width: 300, height: 420 },
    });

    expect(readViewportRect()).toEqual({ left: 14, top: 22, width: 300, height: 420 });
  });
});
