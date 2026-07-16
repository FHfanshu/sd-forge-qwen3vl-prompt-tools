import { afterEach, describe, expect, it } from "vitest";
import { mountSvelteUi, unmountSvelteUi, UI_READY } from "../src/bootstrap";

describe("Svelte cutover shell", () => {
  afterEach(async () => {
    await unmountSvelteUi();
  });

  it("publishes and mounts the released atomic cutover UI once", () => {
    expect(UI_READY).toBe(true);
    expect(mountSvelteUi()).not.toBeNull();
    expect(mountSvelteUi()).not.toBeNull();
    expect(document.querySelectorAll("#kohaku-loom-svelte-mount")).toHaveLength(1);
    expect(document.querySelector('[data-kohaku-loom-surface="true"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Open Kohaku Loom"]')).not.toBeNull();
  });
});
