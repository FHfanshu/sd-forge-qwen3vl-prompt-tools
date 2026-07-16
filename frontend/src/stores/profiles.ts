import { createStore } from "./store";
import { profilePatchSchema, type Profile, type ProfilePatch, type ProfileState, type ProfileStoreActionContracts } from "../contracts";
import { getHostApi } from "../bridge";
import {
  createDefaultProfileState,
  normalizeProfile,
  normalizeProfileState,
  toHostProfileInput,
  toHostProfilePatch,
} from "../profile-adapter";

function readHostState(): unknown {
  if (typeof window === "undefined") return null;
  const host = getHostApi(window.kohakuLoom);
  return host?.profileStore.load() ?? null;
}

function initialState(): ProfileState {
  const hostState = readHostState();
  return hostState ? normalizeProfileState(hostState) : createDefaultProfileState();
}

function hostCall(method: keyof NonNullable<ReturnType<typeof getHostApi>>["profileStore"], ...args: unknown[]): unknown {
  if (typeof window === "undefined") return null;
  const host = getHostApi(window.kohakuLoom);
  const action = host?.profileStore[method] as ((...values: unknown[]) => unknown) | undefined;
  return action && host ? action.apply(host.profileStore, args) : null;
}

function nextId(prefix: string, profiles: Profile[]): string {
  const used = new Set(profiles.map((profile) => profile.id));
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) id = `${prefix}-${++index}`;
  return id;
}

export interface ProfileStore extends ProfileStoreActionContracts {
  profiles: Profile[];
  activeProfileId: string;
  teacherProfileId: string;
  sessionProfileId: string;
  namingProfileId: string;
  selectedProfileId: string;
  loaded: boolean;
}

function stateSlice(state: ProfileState): Pick<ProfileStore, "profiles" | "activeProfileId" | "teacherProfileId" | "sessionProfileId" | "namingProfileId"> {
  return {
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    teacherProfileId: state.teacherProfileId,
    sessionProfileId: state.sessionProfileId,
    namingProfileId: state.namingProfileId,
  };
}

export const useProfileStore = createStore<ProfileStore>((set, get) => {
  const initial = initialState();
  const apply = (raw: unknown, selectedProfileId = get().selectedProfileId): void => {
    const state = normalizeProfileState(raw);
    const selected = state.profiles.some((profile) => profile.id === selectedProfileId)
      ? selectedProfileId
      : state.activeProfileId;
    set({ ...stateSlice(state), selectedProfileId: selected, loaded: true });
  };
  const reload = (): void => {
    const raw = readHostState();
    if (raw) apply(raw);
  };

  const hasHostStore = (): boolean => {
    if (typeof window === "undefined") return false;
    return Boolean(getHostApi(window.kohakuLoom)?.profileStore);
  };

  return {
    ...stateSlice(initial),
    selectedProfileId: initial.activeProfileId,
    loaded: false,
    reload,
    setState: apply,
    setProfiles(profiles) {
      const current = get();
      apply({
        version: 2,
        activeProfileId: current.activeProfileId,
        teacherProfileId: current.teacherProfileId,
        sessionProfileId: current.sessionProfileId,
        namingProfileId: current.namingProfileId,
        profiles,
      });
    },
    upsertProfile(profile) {
      const current = get();
      const normalized = normalizeProfile(profile);
      apply({ ...current, profiles: current.profiles.some((item) => item.id === normalized.id)
        ? current.profiles.map((item) => item.id === normalized.id ? normalized : item)
        : [...current.profiles, normalized] }, normalized.id);
    },
    selectProfile(profileId) {
      if (get().profiles.some((profile) => profile.id === profileId)) set({ selectedProfileId: profileId });
    },
    addProfile(seed = {}) {
      const current = get();
      const local = normalizeProfile({
        ...seed,
        id: seed.id ?? nextId("profile", current.profiles),
        displayName: seed.displayName ?? "New profile",
        modelId: seed.modelId ?? "model",
      });
      const hostResult = hostCall("add", toHostProfileInput(local));
      const added = hostResult ? normalizeProfile(hostResult, local) : local;
      if (hasHostStore()) reload();
      else apply({ ...current, profiles: [...current.profiles, added] }, added.id);
      set({ selectedProfileId: added.id });
      return added;
    },
    duplicateProfile(profileId) {
      const current = get();
      const source = current.profiles.find((profile) => profile.id === profileId);
      if (!source) return null;
      const hostResult = hostCall("duplicate", profileId);
      const copy = hostResult
        ? normalizeProfile(hostResult, { ...source, id: nextId(source.id, current.profiles), displayName: `${source.displayName} copy` })
        : normalizeProfile({ ...source, id: nextId(source.id, current.profiles), displayName: `${source.displayName} copy` });
      if (hasHostStore()) reload();
      else apply({ ...current, profiles: [...current.profiles, copy] }, copy.id);
      set({ selectedProfileId: copy.id });
      return copy;
    },
    updateProfile(profileId, patch) {
      const current = get();
      const source = current.profiles.find((profile) => profile.id === profileId);
      if (!source) return null;
      const normalizedPatch = profilePatchSchema.parse(patch);
      const hostResult = hostCall("update", profileId, toHostProfilePatch(normalizedPatch));
      const updated = hostResult ? normalizeProfile(hostResult, source) : normalizeProfile({ ...source, ...patch, capabilities: { ...source.capabilities, ...patch.capabilities }, parameters: { ...source.parameters, ...patch.parameters }, modelInfo: { ...source.modelInfo, ...patch.modelInfo } });
      if (hasHostStore()) reload();
      else apply({ ...current, profiles: current.profiles.map((profile) => profile.id === profileId ? updated : profile) });
      return updated;
    },
    deleteProfile(profileId) {
      const source = get().profiles.find((profile) => profile.id === profileId);
      if (!source) return false;
      const hostResult = hostCall("delete", profileId);
      if (hasHostStore()) reload();
      else {
        const current = get();
        apply({ ...current, profiles: current.profiles.filter((profile) => profile.id !== profileId) });
      }
      return true;
    },
    activateProfile(profileId) {
      if (!get().profiles.some((profile) => profile.id === profileId && profile.enabled)) return;
      hostCall("setActive", profileId);
      if (hasHostStore()) reload();
      else set({ activeProfileId: profileId });
    },
    setTeacherProfile(profileId) {
      if (!get().profiles.some((profile) => profile.id === profileId && profile.enabled)) return;
      hostCall("setTeacher", profileId);
      if (hasHostStore()) reload();
      else set({ teacherProfileId: profileId });
    },
    setSessionProfile(profileId) {
      if (!get().profiles.some((profile) => ["llama-endpoint", "llama-once"].includes(profile.runtime) && profile.id === profileId && profile.enabled)) return;
      hostCall("setSession", profileId);
      if (hasHostStore()) reload();
      else set({ sessionProfileId: profileId });
    },
    setNamingProfile(profileId) {
      if (!get().profiles.some((profile) => profile.runtime === "llama-once" && profile.id === profileId && profile.enabled)) return;
      hostCall("setNaming", profileId);
      if (hasHostStore()) reload();
      else set({ namingProfileId: profileId });
    },
    restoreDefaults() {
      const hostResult = hostCall("restoreDefaults");
      if (hasHostStore()) reload();
      else apply(hostResult ?? createDefaultProfileState(), get().activeProfileId);
    },
    reset() {
      const defaults = createDefaultProfileState();
      set({ ...stateSlice(defaults), selectedProfileId: defaults.activeProfileId, loaded: false });
    },
  };
});
