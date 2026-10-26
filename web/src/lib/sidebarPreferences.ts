export interface SidebarDisclosureState {
  projects: boolean;
  groups: boolean;
  shortcuts: boolean;
}

export const SIDEBAR_DISCLOSURES_KEY = 'scatter.sidebar.disclosures.v1';
export const DEFAULT_SIDEBAR_DISCLOSURES: SidebarDisclosureState = {
  projects: true,
  groups: true,
  shortcuts: true,
};

export function normalizeSidebarDisclosures(value: unknown): SidebarDisclosureState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SIDEBAR_DISCLOSURES;
  }
  const raw = value as Partial<Record<keyof SidebarDisclosureState, unknown>>;
  return {
    projects: typeof raw.projects === 'boolean' ? raw.projects : true,
    groups: typeof raw.groups === 'boolean' ? raw.groups : true,
    shortcuts: typeof raw.shortcuts === 'boolean' ? raw.shortcuts : true,
  };
}

export function readSidebarDisclosures(
  storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage,
): SidebarDisclosureState {
  if (!storage) return DEFAULT_SIDEBAR_DISCLOSURES;
  try {
    const raw = storage.getItem(SIDEBAR_DISCLOSURES_KEY);
    return raw ? normalizeSidebarDisclosures(JSON.parse(raw)) : DEFAULT_SIDEBAR_DISCLOSURES;
  } catch {
    return DEFAULT_SIDEBAR_DISCLOSURES;
  }
}

export function writeSidebarDisclosures(
  value: SidebarDisclosureState,
  storage: Storage | null = typeof window === 'undefined' ? null : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_DISCLOSURES_KEY, JSON.stringify(value));
  } catch {
    // Private browsing may make storage unavailable; runtime state still works.
  }
}
