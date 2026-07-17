import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import ProfileSettings from "../src/components/ProfileSettings.svelte";
import { useI18nStore } from "../src/stores/i18n";
import { useProfileStore } from "../src/stores/profiles";
import { useUiStore } from "../src/stores/ui";

beforeEach(() => {
  document.body.removeAttribute("style");
  useProfileStore.getState().reset();
  useUiStore.getState().reset();
  useI18nStore.getState().clearManualLocale();
  useI18nStore.getState().reset();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

describe("Svelte profile settings", () => {
  it("shows the flat model summary and direct settings tabs", () => {
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("dialog", { name: "Model profiles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
    ["Model", "Connection", "Generation", "Routes"].forEach((name) => expect(screen.getByRole("tab", { name })).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Local" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Interface" })).not.toBeInTheDocument();
  });

  it("puts the enabled switch in the model summary", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const toggle = screen.getByRole("button", { name: "Toggle model availability" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(useProfileStore.getState().profiles.find((profile) => profile.id === useProfileStore.getState().selectedProfileId)?.enabled).toBe(false);
  });

  it("switches language from the shadcn dropdown", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));
    expect(useI18nStore.getState().manualLocale).toBe("zh-CN");
  });

  it("shows local runtime controls without the irrelevant connection tab", () => {
    const local = useProfileStore.getState().profiles.find((profile) => profile.runtime === "llama-once");
    expect(local).toBeDefined();
    useProfileStore.getState().selectProfile(local!.id);
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("tab", { name: "Local" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Connection" })).not.toBeInTheDocument();
  });

  it("requires alert-dialog confirmation before deletion", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const count = useProfileStore.getState().profiles.length;
    const profile = useProfileStore.getState().profiles[0];
    await user.click(screen.getByRole("button", { name: `${profile.displayName} actions` }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(useProfileStore.getState().profiles).toHaveLength(count);
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(useProfileStore.getState().profiles).toHaveLength(count - 1);
  });

  it("exposes active, teacher, session, and naming route controls", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByRole("combobox", { name: /Active profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Teacher profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Session model/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Naming model/ })).toBeInTheDocument();
  });
});
