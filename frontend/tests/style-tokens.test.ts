import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("surface design tokens", () => {
  it("keeps every CSS variable consumed by the Tailwind theme", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    for (const token of [
      "--pa-background",
      "--pa-foreground",
      "--pa-border",
      "--pa-input",
      "--pa-ring",
      "--pa-primary",
      "--pa-primary-foreground",
      "--pa-secondary",
      "--pa-secondary-foreground",
      "--pa-destructive",
      "--pa-destructive-foreground",
      "--pa-muted",
      "--pa-muted-foreground",
      "--pa-accent",
      "--pa-accent-foreground",
      "--pa-popover",
      "--pa-popover-foreground",
      "--pa-radius-lg",
      "--pa-radius-md",
      "--pa-radius-sm",
    ]) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("keeps the profile settings window floating on mobile viewports", () => {
    const css = readFileSync("src/styles.css", "utf-8");
    expect(css).not.toMatch(/\.pa-profile-window \{ inset: 0 !important/);
  });
});
