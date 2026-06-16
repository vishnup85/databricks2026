# Facility Trust Desk — Track 1 (DAIS 2026 Hackathon)

**Question:** *Can this facility actually do what it claims?*

This project evaluates Indian healthcare facility claims for six capabilities —
**ICU, NICU, maternity, emergency, oncology, trauma** — and produces a trust signal for each
(`strong` / `partial` / `weak_suspicious` / `no_claim`), with citations a planner can inspect
and override with a shared planner note.

It has three parts:

1. A **SQL data pipeline** (Silver → Gold) that turns the raw dataset into a trust mart.
2. A **Databricks App** (AppKit) that lets a planner rank facilities by capability + region,
  drill into the evidence, and save shared overrides through Lakebase.
3. A **PySpark module** with the same serving queries, for notebooks / jobs.

---

## Repo structure

```
databricks_hackathon/
├── sql/                          # Silver/Gold data pipeline (see sql/README.md)
│   ├── 01_silver_facilities_clean.sql
│   ├── 02_silver_pincode_district.sql
│   ├── 03_silver_nfhs_clean.sql
│   ├── 04_gold_facility_geo.sql
│   ├── 05_gold_district_need_index.sql
│   ├── 06_gold_facility_capability_assessment.sql   # the trust mart
│   └── README.md                 # plain-language pipeline docs
├── run_pipeline.ps1              # runs all 6 SQL scripts in order
├── facility-trust-desk/          # the AppKit app (deployed + local dev source)
│   ├── config/queries/*.sql      # serving queries (states, ranked, detail)
│   └── client/src/pages/TrustDeskPage.tsx
├── facility_trust_queries.py     # PySpark versions of the serving queries (notebooks/jobs)
├── read_hackathon_dataset.py     # helper to inspect the raw tables
└── track1_dataset_analysis.md    # deep-dive analysis of the dataset
```

---

## Data layout (Unity Catalog)

- **Raw (read-only):** `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset`
- **Our cleaned data:** catalog `virtue_foundation_dataset_cleaned`
  - `silver` — cleaned versions of the raw tables
  - `gold` — final tables the app reads (key one: `gold.facility_capability_assessment`, ~59,592 rows)

Flow: **raw → silver (clean) → gold (serve)**. Full details in `[sql/README.md](sql/README.md)`.

---

## 1. Build the data pipeline

Prereqs: Databricks CLI authenticated with a `DEFAULT` profile and a running SQL warehouse.

Run the whole pipeline (Silver before Gold):

```powershell
.\run_pipeline.ps1
```

Or run a single script:

```powershell
databricks experimental aitools tools query --file .\sql\06_gold_facility_capability_assessment.sql --output json --profile DEFAULT
```

---

## 2. Run the app

The app is a [Databricks AppKit](https://www.databricks.com/devhub/docs/appkit/v0/) (React + TypeScript)
app using the **analytics** plugin for facility evidence and **Lakebase** for shared override write-back.

```powershell
cd facility-trust-desk
npm install        # first time only
npm run dev        # http://localhost:8000
```

What it does:

- **Ranked list** — pick a capability + region → facilities sorted strongest-evidence first.
- **Drill-down** — click a facility → per-capability trust badges, evidence signals, and citation links.
- **Communicates uncertainty** — graded tiers (never a binary yes/no), a legend + "heuristic, not a
  certification — verify before relying" caveat, plain-language explanations of *why* each tier was
  assigned, and a `rank` number explicitly labelled as ordering-only (not a quality score). "No claim"
  reads as **"No evidence found"** so absence of data is never shown as fact.
- **Planner override** — any assessment can be overridden with a required note (human-in-the-loop). The
  override shows alongside the original (struck-through) tier and is stored in shared Lakebase tables
  instead of browser local state.

Config lives in `.env` (warehouse id, `DEFAULT` profile). Serving queries are the `.sql` files in
`facility-trust-desk/config/queries/`; `npm run typegen` regenerates their TypeScript types.

> Windows note: the `dev`/`start` scripts use `cross-env`, so `NODE_ENV` works in PowerShell.

### Deploy the Databricks app

The app is deployed in Databricks Apps and currently running at [Facility Trust Desk](https://facility-trust-desk-7474653146879851.aws.databricksapps.com).

For the exact Lakebase creation, bundle validation, and `databricks apps deploy` steps, see [facility-trust-desk/README.md](facility-trust-desk/README.md).

---

## 3. Query the data from Python (notebooks / jobs)

`facility_trust_queries.py` mirrors the app's serving queries as reusable PySpark functions
(returning DataFrames). Use it inside a Databricks notebook where `spark` already exists:

```python
from facility_trust_queries import get_states, capability_ranked, facility_detail

get_states().display()
capability_ranked("icu", "Maharashtra").display()
facility_detail("e78e7ba5-ee36-41be-8bd9-b3ab26c4f665").display()
```

The app keeps its `.sql` files — this module is a **separate** data-access layer for analysis,
not a replacement (AppKit's analytics plugin only executes SQL files).

---

## Why SQL in the app vs. PySpark elsewhere?


| Layer                                        | Language                              | Why                                                                      |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| App serving queries (`config/queries/*.sql`) | SQL                                   | Native to AppKit — typed results, SSE streaming, warehouse auth for free |
| Pipeline transforms (`sql/01..06`)           | SQL                                   | Simple, runnable via CLI; easy to diff/review                            |
| Notebooks / jobs / ad-hoc                    | PySpark (`facility_trust_queries.py`) | Idiomatic for exploration and scheduled work                             |


---

## Status & next steps

- [x] Silver + Gold pipeline (built & validated)
- [x] App: ranked list + citation drill-down (validated end-to-end against the warehouse)
- [x] Uncertainty communication: tiers + legend + caveat + "No evidence found" wording + rank-only label
- [x] Planner **overrides** with required note (shared Lakebase write-back)
- [x] PySpark query module for notebooks/jobs
- [x] Persist overrides to a shared store (Lakebase silver/gold tables)
- [x] Deploy to Databricks Apps
- [ ] LLM-assisted refinement of trust scoring (`ai_query()` writing back to Gold)

```

```
