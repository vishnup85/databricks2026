# facility-trust-desk

Facility Trust Desk is the Databricks App for Track 1 of the DAIS 2026 hackathon. It ranks facilities by claimed capability, shows supporting evidence and citations, and lets planners write shared overrides backed by Lakebase.

**Enabled plugins:**
- **Analytics** -- SQL query execution against Databricks SQL Warehouses
- **Server** -- Express HTTP server with custom API endpoints
- **Lakebase** -- shared write-back storage for planner overrides

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI v1.3.0+
- Databricks auth profile `default`
- Access to workspace `https://dbc-7e131722-a0b1.cloud.databricks.com`

## Local development

Install dependencies and start the dev server:

```powershell
npm install
npm run dev
```

The app runs on the URL printed in the console, typically `http://localhost:8000`.

## Shared override storage

Planner overrides are stored in Lakebase and mirrored into two tables created automatically by the server on startup:

- `silver.facility_capability_override_events`
- `gold.facility_capability_overrides`

The app still reads facility evidence from the SQL warehouse, but override writes now go through the Lakebase-backed API in `server/trustDeskOverrides.ts`.

Generated analytics types are committed in `shared/appkit-types/analytics.d.ts`. Local development still refreshes them with `npm run dev`, but the deployed app no longer tries to run warehouse-backed type generation during `npm install`, because the app service principal does not have Unity Catalog access to your authoring catalog.

## Deployment

The `default` bundle target is already configured for this workspace with:

- SQL warehouse id `1b2d6ee9a64f1fca`
- Lakebase branch `projects/facility-trust-desk/branches/production`
- Lakebase database `projects/facility-trust-desk/branches/production/databases/databricks-postgres`

### 1. Clear proxy env vars in PowerShell

If the Databricks CLI is using a stale proxy, clear it first:

```powershell
$env:HTTP_PROXY=''
$env:HTTPS_PROXY=''
$env:ALL_PROXY=''
```

### 2. Create the Lakebase project if it does not exist

PowerShell tends to mangle inline JSON for `databricks postgres create-project`, so use a temp file:

```powershell
$tmp = Join-Path $env:TEMP 'lakebase-project.json'
Set-Content -LiteralPath $tmp -Value '{"spec":{"display_name":"Facility Trust Desk"}}'
databricks postgres create-project facility-trust-desk --json "@$tmp" --profile default -o json
```

### 3. Verify branch and database names

```powershell
databricks postgres list-branches projects/facility-trust-desk --profile default -o json
databricks postgres list-databases projects/facility-trust-desk/branches/production --profile default -o json
```

If those resource names differ in another workspace, update `databricks.yml` before deploying.

### 4. Validate the bundle

```powershell
databricks bundle validate --strict --profile default
```

### 5. Deploy and start the app

```powershell
databricks apps deploy -t default --profile default
```

This applies bundle config, uploads code, and starts the app. The Databricks Apps runtime builds the app at startup via `prestart`, using the committed generated types.

### 6. Grant Unity Catalog read access to the app service principal

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
Grant-UcPrivilege 'TABLE' 'virtue_foundation_dataset_cleaned.gold.district_need_index' 'SELECT'
Grant-UcPrivilege 'TABLE' 'virtue_foundation_dataset_cleaned.silver.facilities_clean' 'SELECT'
```

If your workspace already grants these privileges through a group or a higher-level catalog policy, you can skip this step.

### 7. Verify status

```powershell
databricks apps get facility-trust-desk --profile default -o json
```

Look for `app_status.state` to reach `RUNNING`.

### 8. Read logs if needed

```powershell
databricks apps logs facility-trust-desk --profile default
```

## Useful commands

```powershell
# Type checking
npm run typecheck

# Targeted linting
npx eslint client/src/pages/TrustDeskPage.tsx client/src/lib/trustDeskOverrides.ts server/server.ts server/trustDeskOverrides.ts --no-warn-ignored

# Build
npm run build
```

## Project structure

```text
client/              React frontend
config/queries/      SQL warehouse queries used by the Analytics plugin
server/              AppKit server entrypoint and Lakebase override API
shared/              Shared types
app.yaml             Runtime env wiring for Databricks Apps
databricks.yml       Bundle definition and Databricks resource bindings
```
