<script lang="ts">
  import { onMount } from "svelte";
  import { Check, ChevronDown, Clock3, GripVertical, Plus, Search, Sparkles, Star } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import type { Profile } from "../contracts";
  import { useProfileStore } from "../stores/profiles";
  import { useUiStore } from "../stores/ui";

  const FAVORITES_KEY = "kohaku-loom.model-picker.favorites";
  const RECENTS_KEY = "kohaku-loom.model-picker.recents";

  let open = $state(false);
  let search = $state("");
  let anchor = $state<HTMLDivElement>();
  let favoriteIds = $state<string[]>([]);
  let recentIds = $state<string[]>([]);

  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId));
  const enabledProfiles = $derived($useProfileStore.profiles.filter((profile) => profile.enabled));
  const filteredProfiles = $derived(enabledProfiles.filter((profile) => matches(profile, search)));
  const favoriteProfiles = $derived(filteredProfiles.filter((profile) => favoriteIds.includes(profile.id)));
  const recentProfiles = $derived(filteredProfiles.filter((profile) => recentIds.includes(profile.id) && !favoriteIds.includes(profile.id)));
  const providerGroups = $derived.by(() => {
    const groups = new Map<string, Profile[]>();
    for (const profile of filteredProfiles.filter((item) => !favoriteIds.includes(item.id) && !recentIds.includes(item.id))) {
      const provider = providerLabel(profile);
      groups.set(provider, [...(groups.get(provider) ?? []), profile]);
    }
    return [...groups.entries()];
  });

  function matches(profile: Profile, query: string): boolean {
    const normalized = query.trim().toLowerCase();
    return !normalized || `${profile.displayName} ${profile.modelId} ${providerLabel(profile)}`.toLowerCase().includes(normalized);
  }

  function providerLabel(profile: Profile): string {
    if (profile.modelInfo.providerId) return profile.modelInfo.providerId.toUpperCase();
    if (profile.runtime !== "remote-http") return "LOCAL";
    try {
      return new URL(profile.endpoint).hostname.split(".")[0]?.toUpperCase() || "CUSTOM";
    } catch {
      return "CUSTOM";
    }
  }

  function contextLabel(profile: Profile): string {
    const limit = profile.modelInfo.contextLimit;
    if (!limit) return profile.runtime === "remote-http" ? "Remote" : "Local";
    if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(1)}m ctx`;
    if (limit >= 1_000) return `${Math.round(limit / 1_000)}k ctx`;
    return `${limit} ctx`;
  }

  function reasoningLabel(profile: Profile): string {
    const value = profile.parameters.reasoningEffort;
    return value === "none" ? "Off" : value[0].toUpperCase() + value.slice(1);
  }

  function readIds(key: string): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveIds(key: string, values: string[]): void {
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Storage can be unavailable in private contexts. */ }
  }

  function toggleFavorite(profileId: string): void {
    favoriteIds = favoriteIds.includes(profileId)
      ? favoriteIds.filter((id) => id !== profileId)
      : [...favoriteIds, profileId];
    saveIds(FAVORITES_KEY, favoriteIds);
  }

  function selectProfile(profileId: string): void {
    $useProfileStore.activateProfile(profileId);
    recentIds = [profileId, ...recentIds.filter((id) => id !== profileId)].slice(0, 8);
    saveIds(RECENTS_KEY, recentIds);
    open = false;
    search = "";
  }

  function openProfiles(): void {
    open = false;
    $useUiStore.setProfileSettingsOpen(true);
    $useUiStore.bringToFront("profiles");
  }

  onMount(() => {
    const available = new Set(enabledProfiles.map((profile) => profile.id));
    favoriteIds = readIds(FAVORITES_KEY).filter((id) => available.has(id));
    recentIds = readIds(RECENTS_KEY).filter((id) => available.has(id));
    if (!favoriteIds.length && activeProfile) favoriteIds = [activeProfile.id];

    const close = (event: PointerEvent) => {
      if (anchor && !anchor.contains(event.target as Node)) open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  });
</script>

<div class="kl-model-picker" bind:this={anchor}>
  <Button
    variant="ghost"
    class="kl-model-picker-trigger kl-h-8 kl-max-w-44 kl-rounded-md kl-px-1.5"
    aria-label="Active model"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => open = !open}
  >
    <Sparkles size={15} />
    <span>{activeProfile?.displayName ?? "Select model"}</span>
    <ChevronDown size={13} aria-hidden="true" />
  </Button>
  <select class="kl-sr-only" tabindex="-1" aria-hidden="true" aria-label="Active model" value={$useProfileStore.activeProfileId} onchange={(event) => selectProfile(event.currentTarget.value)}>
    {#each enabledProfiles as profile}<option value={profile.id}>{profile.displayName}</option>{/each}
  </select>

  {#if open}
    <div class="kl-model-picker-popover" role="dialog" tabindex="-1" aria-label="Select model">
      <button type="button" class="kl-model-picker-add" onclick={openProfiles}><Plus size={15} /> Add provider</button>
      <label class="kl-model-picker-search">
        <Search size={16} aria-hidden="true" />
        <Input bind:value={search} placeholder="Search models" aria-label="Search models" />
      </label>

      {#if favoriteProfiles.length}
        <section class="kl-model-picker-section">
          <div class="kl-model-picker-section-heading"><span><Star size={15} /> Favorites</span><ChevronDown size={14} aria-hidden="true" /></div>
          <div class="kl-model-picker-list" role="listbox" aria-label="Favorite models">
            {#each favoriteProfiles as profile (profile.id)}{@render modelRow(profile)}{/each}
          </div>
        </section>
      {/if}

      {#if recentProfiles.length}
        <section class="kl-model-picker-section">
          <div class="kl-model-picker-section-heading"><span><Clock3 size={15} /> Recent</span><ChevronDown size={14} aria-hidden="true" /></div>
          <div class="kl-model-picker-list" role="listbox" aria-label="Recent models">
            {#each recentProfiles as profile (profile.id)}{@render modelRow(profile)}{/each}
          </div>
        </section>
      {/if}

      {#if providerGroups.length}
        {#each providerGroups as [provider, profiles] (provider)}
          <section class="kl-model-picker-section">
            <div class="kl-model-picker-section-heading"><span class="kl-model-picker-provider"><i>{provider.slice(0, 1)}</i>{provider}</span><ChevronDown size={14} aria-hidden="true" /></div>
            <div class="kl-model-picker-list" role="listbox" aria-label={`${provider} models`}>
              {#each profiles as profile (profile.id)}{@render modelRow(profile)}{/each}
            </div>
          </section>
        {/each}
      {:else if !favoriteProfiles.length && !recentProfiles.length}
        <p class="kl-model-picker-empty">No models match this search.</p>
      {/if}
    </div>
  {/if}
</div>

{#snippet modelRow(profile: Profile)}
  <div class:is-active={profile.id === $useProfileStore.activeProfileId} class="kl-model-picker-row" role="option" aria-selected={profile.id === $useProfileStore.activeProfileId}>
    <button type="button" class="kl-model-picker-row-main" onclick={() => selectProfile(profile.id)}>
      <GripVertical size={14} class="kl-model-picker-grip" aria-hidden="true" />
      <Sparkles size={15} aria-hidden="true" />
      <span class="kl-model-picker-row-copy"><strong>{profile.displayName}</strong><small>{contextLabel(profile)}</small></span>
      {#if profile.id === $useProfileStore.activeProfileId && profile.capabilities.reasoning}<span class="kl-model-picker-thinking">Thinking: {reasoningLabel(profile)}</span>{/if}
    </button>
    <button type="button" class:is-favorite={favoriteIds.includes(profile.id)} class="kl-model-picker-star" aria-label={`${favoriteIds.includes(profile.id) ? "Remove" : "Add"} ${profile.displayName} favorite`} onclick={(event) => { event.stopPropagation(); toggleFavorite(profile.id); }}>
      {#if profile.id === $useProfileStore.activeProfileId}<Check size={15} class="kl-model-picker-check" aria-hidden="true" />{/if}
      <Star size={16} fill={favoriteIds.includes(profile.id) ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  </div>
{/snippet}
