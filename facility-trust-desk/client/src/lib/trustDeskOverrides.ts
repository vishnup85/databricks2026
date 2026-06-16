import { useEffect, useState } from 'react';

export type Override = { tier: string; note: string; ts: number; actorEmail?: string | null };

const STORAGE_KEY = 'facility-trust-desk-overrides-v1';

export const overrideKey = (id: string, capability: string) => `${id}::${capability}`;

export function usePlannerOverrides() {
  const [overrides, setOverrides] = useState<Record<string, Override>>(() => readStoredOverrideState().overrides);
  const [loadError, setLoadError] = useState<string | null>(() => readStoredOverrideState().loadError);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;

      try {
        setOverrides(readStoredOverrides());
        setLoadError(null);
      } catch (error) {
        setLoadError(getErrorMessage(error, 'Unable to refresh local planner overrides from this browser.'));
      }
    };

    window.addEventListener('storage', syncAcrossTabs);
    return () => window.removeEventListener('storage', syncAcrossTabs);
  }, []);

  const saveOverride = (id: string, capability: string, tier: string, note: string): Promise<void> => {
    const saved: Override = {
      tier,
      note,
      ts: Date.now(),
      actorEmail: null,
    };

    setOverrides((current) => {
      const next = { ...current, [overrideKey(id, capability)]: saved };
      writeStoredOverrides(next);
      return next;
    });
    setLoadError(null);
    return Promise.resolve();
  };

  const clearOverride = (id: string, capability: string): Promise<void> => {
    setOverrides((current) => {
      const next = { ...current };
      delete next[overrideKey(id, capability)];
      writeStoredOverrides(next);
      return next;
    });
    setLoadError(null);
    return Promise.resolve();
  };

  return { overrides, loadError, saveOverride, clearOverride };
}

function readStoredOverrideState() {
  try {
    return {
      overrides: readStoredOverrides(),
      loadError: null,
    };
  } catch (error) {
    return {
      overrides: {},
      loadError: getErrorMessage(error, 'Unable to load local planner overrides from this browser.'),
    };
  }
}

function readStoredOverrides(): Record<string, Override> {
  if (typeof window === 'undefined') return {};

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  return sanitizeOverrides(parsed);
}

function writeStoredOverrides(overrides: Record<string, Override>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

function sanitizeOverrides(value: unknown): Record<string, Override> {
  if (!value || typeof value !== 'object') return {};

  const next: Record<string, Override> = {};

  for (const [key, rawOverride] of Object.entries(value)) {
    const parsed = toOverride(rawOverride);
    if (parsed) {
      next[key] = parsed;
    }
  }

  return next;
}

function toOverride(value: unknown): Override | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if (typeof record.tier !== 'string') return null;
  if (typeof record.note !== 'string') return null;
  if (typeof record.ts !== 'number' || Number.isNaN(record.ts)) return null;

  return {
    tier: record.tier,
    note: record.note,
    ts: record.ts,
    actorEmail: typeof record.actorEmail === 'string' ? record.actorEmail : null,
  };
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
