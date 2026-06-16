import { useEffect, useState } from 'react';

export type Override = { tier: string; note: string; ts: number; actorEmail?: string | null };

type SharedOverrideRecord = {
  facilityUniqueId: string;
  capability: string;
  tier: string;
  note: string;
  updatedAt: string;
  actorEmail: string | null;
};

export const overrideKey = (id: string, capability: string) => `${id}::${capability}`;

export function useSharedOverrides() {
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const syncOverrides = async () => {
      try {
        const next = await fetchSharedOverrides();
        if (!active) return;
        setOverrides(next);
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        setLoadError(getErrorMessage(error, 'Unable to sync shared planner overrides right now.'));
      }
    };

    void syncOverrides();
    const timerId = window.setInterval(() => {
      void syncOverrides();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(timerId);
    };
  }, []);

  const saveOverride = async (id: string, capability: string, tier: string, note: string) => {
    const saved = await putSharedOverride(id, capability, tier, note);
    setOverrides((current) => ({ ...current, [overrideKey(id, capability)]: saved }));
    setLoadError(null);
  };

  const clearOverride = async (id: string, capability: string) => {
    await deleteSharedOverride(id, capability);
    setOverrides((current) => {
      const next = { ...current };
      delete next[overrideKey(id, capability)];
      return next;
    });
    setLoadError(null);
  };

  return { overrides, loadError, saveOverride, clearOverride };
}

async function fetchSharedOverrides() {
  const response = await fetch('/api/trust-desk/overrides');
  const payload = await readApiPayload(response);

  if (!response.ok) {
    throw new Error(getApiError(payload, 'Unable to load shared planner overrides.'));
  }

  const next: Record<string, Override> = {};
  const rawOverrides = asRecord(payload)?.overrides;

  if (Array.isArray(rawOverrides)) {
    for (const item of rawOverrides) {
      const parsed = toSharedOverrideRecord(item);
      if (parsed) {
        next[overrideKey(parsed.facilityUniqueId, parsed.capability)] = {
          tier: parsed.tier,
          note: parsed.note,
          ts: Date.parse(parsed.updatedAt),
          actorEmail: parsed.actorEmail,
        };
      }
    }
  }

  return next;
}

async function putSharedOverride(id: string, capability: string, tier: string, note: string) {
  const response = await fetch(
    `/api/trust-desk/overrides/${encodeURIComponent(id)}/${encodeURIComponent(capability)}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tier, note }),
    }
  );

  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(getApiError(payload, 'Unable to save shared planner override.'));
  }

  const override = toSharedOverrideRecord(asRecord(payload)?.override);
  if (!override) {
    throw new Error('Shared override response was malformed.');
  }

  return {
    tier: override.tier,
    note: override.note,
    ts: Date.parse(override.updatedAt),
    actorEmail: override.actorEmail,
  };
}

async function deleteSharedOverride(id: string, capability: string) {
  const response = await fetch(
    `/api/trust-desk/overrides/${encodeURIComponent(id)}/${encodeURIComponent(capability)}`,
    {
      method: 'DELETE',
    }
  );

  const payload = await readApiPayload(response);
  if (!response.ok) {
    throw new Error(getApiError(payload, 'Unable to clear shared planner override.'));
  }
}

async function readApiPayload(response: Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toSharedOverrideRecord(value: unknown): SharedOverrideRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.facilityUniqueId !== 'string') return null;
  if (typeof record.capability !== 'string') return null;
  if (typeof record.tier !== 'string') return null;
  if (typeof record.note !== 'string') return null;
  if (typeof record.updatedAt !== 'string') return null;

  const ts = Date.parse(record.updatedAt);
  if (Number.isNaN(ts)) return null;

  return {
    facilityUniqueId: record.facilityUniqueId,
    capability: record.capability,
    tier: record.tier,
    note: record.note,
    updatedAt: record.updatedAt,
    actorEmail: typeof record.actorEmail === 'string' ? record.actorEmail : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function getApiError(payload: unknown, fallback: string) {
  const record = asRecord(payload);
  return typeof record?.error === 'string' && record.error.trim() ? record.error : fallback;
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
