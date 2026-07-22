import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clampWindowLayout, minimumForViewport, readLayoutViewportRect, readViewportRect, resolveViewportAfterKeyboard, viewportKind } from "../src/window-interactions";

describe("window viewport boundaries", () => {
  it.each([
    [390, 844, "mobilePortrait"],
    [767, 390, "mobileLandscape"],
    [844, 390, "mobileLandscape"],
    [768, 1024, "desktop"],
    [820, 1180, "desktop"],
    [1180, 820, "desktop"],
  ] as const)("classifies %sx%s touch viewports as %s", (width, height, expected) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });

    expect(viewportKind()).toBe(expected);
  });

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

  it("allows a stable floating window to exceed only the keyboard-reduced height", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).toMatch(/\.pa-window\.pa-keyboard-overflow, \.pa-profile-window\.pa-keyboard-overflow \{ max-height: none; \}/);
  });

  it("reads the visual viewport offset and dimensions when available", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 14, offsetTop: 22, width: 300, height: 420 },
    });

    expect(readViewportRect()).toEqual({ left: 14, top: 22, width: 300, height: 420 });
    expect(readViewportRect(false)).toEqual(readLayoutViewportRect());
    expect(readLayoutViewportRect()).toEqual({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
  });

  it("freezes the last stable viewport while the virtual keyboard opens and closes", () => {
    const stable = { left: 0, top: 0, width: 1024, height: 768 };
    const keyboard = { ...stable, height: 260 };
    expect(resolveViewportAfterKeyboard(stable, keyboard, true, false)).toEqual({ viewport: stable, stable, recovering: true });
    expect(resolveViewportAfterKeyboard(stable, keyboard, false, true)).toEqual({ viewport: stable, stable, recovering: true });
    expect(resolveViewportAfterKeyboard(stable, stable, true, false)).toEqual({ viewport: stable, stable, recovering: false });
    const rotated = { left: 0, top: 0, width: 768, height: 1024 };
    expect(resolveViewportAfterKeyboard(stable, rotated, false, true)).toEqual({ viewport: rotated, stable: rotated, recovering: false });
  });

  it("keeps message copy actions visible on coarse touch pointers", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.pa-message-heading, \.pa-message-footer \{ position: static; opacity: 1; pointer-events: auto; \}/);
    expect(css).toMatch(/\.pa-message-tool > :is\(\.pa-message-heading, \.pa-message-footer\) \{ display: none; \}/);
  });

  it("keeps pointer hit areas connected between messages and hover actions", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).toMatch(/\.pa-message-heading \{[^}]*bottom: 100%;[^}]*padding-bottom: \.2rem;/);
    expect(css).toMatch(/\.pa-message-footer \{[^}]*top: 100%;[^}]*padding-top: \.15rem;/);
    expect(css).toMatch(/\.pa-message-card:hover :is\(\.pa-message-heading, \.pa-message-footer\)[^{}]*\{ pointer-events: auto; \}/);
  });

  it("lets hover actions outgrow short user message bubbles without wrapping", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).toMatch(/\.pa-message-actions \{[^}]*flex-wrap: nowrap;/);
    expect(css).toMatch(/\.pa-message-action \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.pa-message-user \.pa-message-footer \{[^}]*left: auto;[^}]*width: max-content;/);
  });
});
