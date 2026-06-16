# facility-trust-desk

Facility Trust Desk is the Databricks App for Track 1 of the DAIS 2026 hackathon. It ranks facilities by claimed capability, shows supporting evidence and citations, and lets planners record local overrides stored in the browser.

**Enabled plugins:**

- **Analytics** -- SQL query execution against Databricks SQL Warehouses
- **Server** -- AppKit server runtime for local development and deployment

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI v1.3.0+
- Databricks auth profile `default`
- Access to workspace `https://dbc-7e131722-a0b1.cloud.databricks.com`

## Local development

Install dependencies, configure `.env`, and start the dev server:

```powershell
npm install
copy .env.example .env   # first time only — then set DATABRICKS_WAREHOUSE_ID
npm run dev
```

The app runs on the URL printed in the console, typically `http://localhost:8000`.

If local dev stops with `Databricks authentication failed`, run `databricks auth login` for this workspace or set `DATABRICKS_HOST` and `DATABRICKS_TOKEN` in `.env`.

> Note: `npm run dev` uses plain `tsx` (not `tsx watch`) because `tsx watch` deadlocks AppKit's Vite dev startup on Windows. The client still hot-reloads via Vite HMR; after editing `server/*.ts`, stop and re-run `npm run dev` to pick up server changes.

The only required local config is `DATABRICKS_WAREHOUSE_ID` (the SQL warehouse the Analytics plugin queries) plus your Databricks auth profile.

## Planner overrides (local storage)

Planner overrides are stored in the browser via `localStorage` (key `facility-trust-desk-overrides-v1`), handled entirely client-side in `client/src/lib/trustDeskOverrides.ts`. They are per-user and per-browser — they persist across reloads and sync across tabs of the same browser, but are not shared across users. No database/backend is required.

The app reads facility evidence from the SQL warehouse via the Analytics plugin.

Generated analytics types are committed in `shared/appkit-types/analytics.d.ts`. Local development still refreshes them with `npm run dev`, but the deployed app no longer tries to run warehouse-backed type generation during `npm install`, because the app service principal does not have Unity Catalog access to your authoring catalog.

## Deployment

The `default` bundle target is already configured for this workspace with:

- SQL warehouse id `1b2d6ee9a64f1fca`

### 1. Clear proxy env vars in PowerShell

If the Databricks CLI is using a stale proxy, clear it first:

```powershell
$env:HTTP_PROXY=''
$env:HTTPS_PROXY=''
$env:ALL_PROXY=''
```

### 2. Validate the bundle

```powershell
databricks bundle validate --strict --profile default
```

### 3. Deploy and start the app

```powershell
databricks apps deploy -t default --profile default
```

This applies bundle config, uploads code, and starts the app. The Databricks Apps runtime builds the app at startup via `prestart`, using the committed generated types.

### 4. Grant Unity Catalog read access to the app service principal

This is a one-time workspace step for the analytics queries. If the app shows `INSUFFICIENT_PERMISSIONS` on catalog `virtue_foundation_dataset_cleaned`, grant the app's service principal the minimum required read privileges:

```powershell
$app = databricks apps get facility-trust-desk --profile default -o json | ConvertFrom-Json
$sp = $app.service_principal_client_id
$tmp = Join-Path $env:TEMP 'uc-grant.json'

function Grant-UcPrivilege($securableType, $fullName, $privilege) {
  $payload = '{"changes":[{"principal":"' + $sp + '","add":["' + $privilege + '"]}]}'
  Set-Content -LiteralPath $tmp -Value $payload
  databricks grants update $securableType $fullName --json "@$tmp" --profile default -o json
}

Grant-UcPrivilege 'CATALOG' 'virtue_foundation_dataset_cleaned' 'USE_CATALOG'
Grant-UcPrivilege 'SCHEMA' 'virtue_foundation_dataset_cleaned.gold' 'USE_SCHEMA'
Grant-UcPrivilege 'SCHEMA' 'virtue_foundation_dataset_cleaned.silver' 'USE_SCHEMA'
Grant-UcPrivilege 'TABLE' 'virtue_foundation_dataset_cleaned.gold.facility_capability_assessment' 'SELECT'
Grant-UcPrivilege 'TABLE' 'virtue_foundation_dataset_cleaned.silver.facilities_clean' 'SELECT'
```

If your workspace already grants these privileges through a group or a higher-level catalog policy, you can skip this step.

### 5. Verify status

```powershell
databricks apps get facility-trust-desk --profile default -o json
```

Look for `app_status.state` to reach `RUNNING`.

### 6. Read logs if needed

```powershell
databricks apps logs facility-trust-desk --profile default
```

## Useful commands

```powershell
# Type checking
npm run typecheck

# Targeted linting
npx eslint client/src/pages/TrustDeskPage.tsx client/src/lib/trustDeskOverrides.ts server/server.ts --no-warn-ignored

# Build
npm run build
```

## Project structure

```text
client/              React frontend (planner overrides stored in localStorage)
config/queries/      SQL warehouse queries used by the Analytics plugin
server/              AppKit server entrypoint (Analytics + Server plugins)
shared/              Shared types
app.yaml             Runtime env wiring for Databricks Apps
databricks.yml       Bundle definition and Databricks resource bindings
```
