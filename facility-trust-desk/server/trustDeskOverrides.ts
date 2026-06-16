import express, { type Application, type Request, type Response } from 'express';
import { type LakebasePool } from '@databricks/appkit';
import { z } from 'zod';

const OVERRIDE_TIERS = ['strong', 'partial', 'weak_suspicious', 'no_claim'] as const;

const overrideKeySchema = z.object({
  facilityUniqueId: z.string().trim().min(1).max(255),
  capability: z.string().trim().min(1).max(128),
});

const overridePayloadSchema = z.object({
  tier: z.enum(OVERRIDE_TIERS),
  note: z.string().trim().min(1).max(2000),
});

const overrideFilterSchema = z.object({
  capability: z.string().trim().min(1).max(128).optional(),
  facilityUniqueId: z.string().trim().min(1).max(255).optional(),
});

type TrustDeskAppKit = {
  lakebase: {
    pool: LakebasePool;
    query: <TRow extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: TRow[] }>;
  };
  server: {
    extend: (extendFn: (app: Application) => void) => void;
  };
};

type EventInsertRow = {
  event_id: number;
  event_ts: Date | string;
};

type CurrentOverrideRow = {
  facility_unique_id: string;
  capability: string;
  override_tier: string;
  override_note: string;
  actor_email: string | null;
  updated_at: Date | string;
};

type SharedOverrideDto = {
  facilityUniqueId: string;
  capability: string;
  tier: string;
  note: string;
  actorEmail: string | null;
  updatedAt: string;
};

type TransactionClient = Awaited<ReturnType<LakebasePool['connect']>>;

export async function setupTrustDeskOverrides(appkit: TrustDeskAppKit) {
  await ensureTrustDeskOverrideTables(appkit);
  registerTrustDeskOverrideRoutes(appkit);
}

async function ensureTrustDeskOverrideTables(appkit: Pick<TrustDeskAppKit, 'lakebase'>) {
  const statements = [
    'CREATE SCHEMA IF NOT EXISTS silver',
    'CREATE SCHEMA IF NOT EXISTS gold',
    `
      CREATE TABLE IF NOT EXISTS silver.facility_capability_override_events (
        event_id BIGSERIAL PRIMARY KEY,
        facility_unique_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('upsert', 'clear')),
        override_tier TEXT CHECK (override_tier IS NULL OR override_tier IN ('strong', 'partial', 'weak_suspicious', 'no_claim')),
        override_note TEXT,
        actor_email TEXT,
        event_ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (action = 'upsert' AND override_tier IS NOT NULL AND override_note IS NOT NULL AND char_length(btrim(override_note)) > 0)
          OR
          (action = 'clear' AND override_tier IS NULL AND override_note IS NULL)
        )
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_facility_capability_override_events_lookup
      ON silver.facility_capability_override_events (facility_unique_id, capability, event_ts DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS gold.facility_capability_overrides (
        facility_unique_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        override_tier TEXT NOT NULL CHECK (override_tier IN ('strong', 'partial', 'weak_suspicious', 'no_claim')),
        override_note TEXT NOT NULL CHECK (char_length(btrim(override_note)) > 0),
        actor_email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source_event_id BIGINT NOT NULL REFERENCES silver.facility_capability_override_events(event_id) ON DELETE RESTRICT,
        PRIMARY KEY (facility_unique_id, capability)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_facility_capability_overrides_capability
      ON gold.facility_capability_overrides (capability, updated_at DESC)
    `,
  ];

  for (const statement of statements) {
    await appkit.lakebase.query(statement);
  }
}

function registerTrustDeskOverrideRoutes(appkit: TrustDeskAppKit) {
  appkit.server.extend((app) => {
    app.use('/api/trust-desk', express.json({ limit: '100kb' }));

    app.get('/api/trust-desk/overrides', async (req, res) => {
      try {
        const filters = overrideFilterSchema.parse({
          capability: firstQueryValue(req.query.capability),
          facilityUniqueId: firstQueryValue(req.query.facilityUniqueId),
        });

        const whereClauses: string[] = [];
        const values: unknown[] = [];

        if (filters.capability) {
          values.push(filters.capability);
          whereClauses.push(`capability = $${values.length}`);
        }

        if (filters.facilityUniqueId) {
          values.push(filters.facilityUniqueId);
          whereClauses.push(`facility_unique_id = $${values.length}`);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const result = await appkit.lakebase.query<CurrentOverrideRow>(
          `
            SELECT
              facility_unique_id,
              capability,
              override_tier,
              override_note,
              actor_email,
              updated_at
            FROM gold.facility_capability_overrides
            ${whereSql}
            ORDER BY updated_at DESC
          `,
          values
        );

        res.json({ overrides: result.rows.map(toSharedOverrideDto) });
      } catch (error) {
        handleRouteError(res, error, 'Failed to load shared overrides.');
      }
    });

    app.put('/api/trust-desk/overrides/:facilityUniqueId/:capability', async (req, res) => {
      try {
        const key = overrideKeySchema.parse(req.params);
        const payload = overridePayloadSchema.parse(req.body ?? {});
        const override = await upsertOverride(appkit.lakebase.pool, key, payload, getActorEmail(req));
        res.json({ override: toSharedOverrideDto(override) });
      } catch (error) {
        handleRouteError(res, error, 'Failed to save shared override.');
      }
    });

    app.delete('/api/trust-desk/overrides/:facilityUniqueId/:capability', async (req, res) => {
      try {
        const key = overrideKeySchema.parse(req.params);
        await clearOverride(appkit.lakebase.pool, key, getActorEmail(req));
        res.json({ ok: true });
      } catch (error) {
        handleRouteError(res, error, 'Failed to clear shared override.');
      }
    });
  });
}

async function upsertOverride(
  pool: LakebasePool,
  key: z.infer<typeof overrideKeySchema>,
  payload: z.infer<typeof overridePayloadSchema>,
  actorEmail: string
) {
  return withTransaction(pool, async (client) => {
    const eventResult = await client.query<EventInsertRow>(
      `
        INSERT INTO silver.facility_capability_override_events (
          facility_unique_id,
          capability,
          action,
          override_tier,
          override_note,
          actor_email
        )
        VALUES ($1, $2, 'upsert', $3, $4, $5)
        RETURNING event_id, event_ts
      `,
      [key.facilityUniqueId, key.capability, payload.tier, payload.note, actorEmail]
    );

    const event = eventResult.rows[0];
    if (!event) {
      throw new Error('Failed to record override event.');
    }

    const currentResult = await client.query<CurrentOverrideRow>(
      `
        INSERT INTO gold.facility_capability_overrides (
          facility_unique_id,
          capability,
          override_tier,
          override_note,
          actor_email,
          updated_at,
          source_event_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (facility_unique_id, capability)
        DO UPDATE SET
          override_tier = EXCLUDED.override_tier,
          override_note = EXCLUDED.override_note,
          actor_email = EXCLUDED.actor_email,
          updated_at = EXCLUDED.updated_at,
          source_event_id = EXCLUDED.source_event_id
        RETURNING
          facility_unique_id,
          capability,
          override_tier,
          override_note,
          actor_email,
          updated_at
      `,
      [key.facilityUniqueId, key.capability, payload.tier, payload.note, actorEmail, event.event_ts, event.event_id]
    );

    const current = currentResult.rows[0];
    if (!current) {
      throw new Error('Failed to persist current override.');
    }

    return current;
  });
}

async function clearOverride(pool: LakebasePool, key: z.infer<typeof overrideKeySchema>, actorEmail: string) {
  return withTransaction(pool, async (client) => {
    await client.query(
      `
        INSERT INTO silver.facility_capability_override_events (
          facility_unique_id,
          capability,
          action,
          override_tier,
          override_note,
          actor_email
        )
        VALUES ($1, $2, 'clear', NULL, NULL, $3)
      `,
      [key.facilityUniqueId, key.capability, actorEmail]
    );

    return client.query(
      `
        DELETE FROM gold.facility_capability_overrides
        WHERE facility_unique_id = $1
          AND capability = $2
      `,
      [key.facilityUniqueId, key.capability]
    );
  });
}

function toSharedOverrideDto(row: CurrentOverrideRow): SharedOverrideDto {
  return {
    facilityUniqueId: row.facility_unique_id,
    capability: row.capability,
    tier: row.override_tier,
    note: row.override_note,
    actorEmail: row.actor_email,
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function toIsoTimestamp(value: Date | string): string {
  const ts = value instanceof Date ? value : new Date(value);
  return ts.toISOString();
}

function getActorEmail(req: Request): string {
  const forwarded = req.headers['x-forwarded-email'];
  if (Array.isArray(forwarded)) {
    return forwarded.find(Boolean)?.trim() || 'local-dev';
  }
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.trim();
  }
  return 'local-dev';
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function handleRouteError(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: error.issues[0]?.message ?? 'Invalid request.',
    });
    return;
  }

  console.error(fallbackMessage, error);
  res.status(500).json({ error: fallbackMessage });
}

async function withTransaction<T>(pool: LakebasePool, run: (client: TransactionClient) => Promise<T>) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
