# Facility Trust Desk - Track 1 (DAIS 2026 Hackathon)

Question:

`Can this facility actually do what it claims?`

This project evaluates Indian healthcare facility claims for six core capabilities:

- ICU
- NICU
- maternity
- emergency
- oncology
- trauma

For each `facility x capability` pair it produces a trust signal:

- `strong`
- `partial`
- `weak_suspicious`
- `no_claim`

The planner can inspect evidence, review citations, and record a local override note in the app.

## Project parts

1. A SQL data pipeline that builds the cleaned serving tables.
2. A Databricks AppKit app for ranking, drill-down, and local planner overrides.
3. Python helpers for analytics queries and LLM-assisted signal review.

## Repo structure

```text
databricks_hackathon/
|-- sql/
|   |-- 01_silver_facilities_clean.sql
|   |-- 02_silver_pincode_district.sql
|   |-- 03_silver_nfhs_clean.sql
|   |-- 04_gold_facility_geo.sql
|   |-- 05_gold_district_need_index.sql
|   |-- 06_gold_facility_capability_assessment.sql
|   |-- 07_silver_facility_capability_llm_inputs.sql
|   |-- 08_silver_facility_capability_llm_outputs_raw.sql
|   |-- 09_gold_facility_capability_llm_signals.sql
|   |-- 10_gold_facility_capability_assessment.sql
|   `-- README.md
|-- prompts/
|   |-- facility_capability_signal_system_v1.txt
|   |-- facility_capability_signal_user_v1.txt
|   `-- facility_capability_signal_user_batch_v2.txt
|-- run_pipeline.ps1
|-- run_llm_capability_review.py
|-- run_llm_capability_review_default.ps1
|-- run_llm_capability_review_openai.ps1
|-- facility_trust_queries.py
|-- track1_dataset_analysis.md
|-- build_pitch_deck.py
|-- facility_trust_desk_pitch.pptx
`-- facility-trust-desk/
    |-- config/queries/*.sql
    `-- client/src/pages/TrustDeskPage.tsx
```

## Data layout

- Raw source catalog:
  `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset`
- Cleaned catalog:
  `virtue_foundation_dataset_cleaned`
  - `silver` = cleaned and staged tables
  - `gold` = serving tables

Full pipeline details live in [sql/README.md](sql/README.md).

## 1. Build the SQL pipeline

Prereqs:

- Databricks CLI authenticated
- a running SQL warehouse
- access to the cleaned catalog

Run the full pipeline:

```powershell
.\run_pipeline.ps1 -Profile default
```

This now runs all 10 scripts in dependency order, including the LLM sidecar tables and the final
LLM-refined serving mart.

Run a single SQL script:

```powershell
databricks experimental aitools tools query --file .\sql\06_gold_facility_capability_assessment.sql --output json --profile default
```

## 2. Run the app

The app is a Databricks AppKit app using:

- the `analytics` plugin for warehouse-backed facility evidence
- browser `localStorage` for planner overrides

Local development:

```powershell
cd facility-trust-desk
npm install
copy .env.example .env
npm run dev
```

What the app does:

- rank facilities by capability and region
- show trust tiers and evidence explanations
- let planners inspect facility-level citation URLs
- let planners record local overrides with notes in the browser

Deployment and workspace-specific app steps are documented in
[facility-trust-desk/README.md](facility-trust-desk/README.md).

## 3. Query serving data from Python

`facility_trust_queries.py` mirrors the app's SQL serving queries as PySpark DataFrame helpers for
use inside a Databricks notebook or job:

```python
from facility_trust_queries import get_states, capability_ranked, facility_detail

get_states().display()
capability_ranked("icu", "Maharashtra").display()
facility_detail("e78e7ba5-ee36-41be-8bd9-b3ab26c4f665", "icu").display()
```

This is for notebooks and jobs. The app still uses the checked-in SQL files in
`facility-trust-desk/config/queries/`.

## 4. Run LLM-assisted sub-signal review from Python

Script `06` builds the heuristic baseline. Script `10` recomputes the final serving tier
deterministically from that baseline plus any current LLM-reviewed sub-signals.

The LLM runner only writes sidecar sub-signals such as:

- `claim_hit_llm`
- `prose_hit_llm`
- `screening_only_llm`
- `capability_scope_llm`
- `supporting_snippets_llm`

The runner now uses Pydantic models plus Databricks JSON-schema response format so the model is
asked for a typed object and the same typed object is validated again locally before write-back.

Prompt files:

- [prompts/facility_capability_signal_system_v1.txt](prompts/facility_capability_signal_system_v1.txt)
- [prompts/facility_capability_signal_user_v1.txt](prompts/facility_capability_signal_user_v1.txt)
- [prompts/facility_capability_signal_user_batch_v2.txt](prompts/facility_capability_signal_user_batch_v2.txt)

Preview the prompt without calling the model:

```powershell
python .\run_llm_capability_review.py --profile default --endpoint YOUR_ENDPOINT --mode facility --limit 1 --dry-run
```

Run a small inference batch for one facility request and refresh the parsed gold signal table:

```powershell
python .\run_llm_capability_review.py --profile default --endpoint YOUR_ENDPOINT --mode facility --limit 25 --refresh-gold
```

Run all pending facilities across the whole dataset. In facility mode, each request returns all
matching capability decisions for that facility and writes the same per-capability raw rows back to
Databricks:

```powershell
python .\run_llm_capability_review.py --profile default --endpoint YOUR_ENDPOINT --mode facility --all-pending --limit 100 --refresh-gold
```

This workspace already has ready Databricks-hosted chat endpoints, so you do not need an OpenAI key
just to get started. A convenience wrapper is included:

```powershell
.\run_llm_capability_review_default.ps1 -AllPending -RefreshGold
```

That wrapper clears stale proxy variables, forces `--mode facility`, and defaults to
`databricks-meta-llama-3-1-8b-instruct`. Override `-Endpoint` if you want to use another ready chat
endpoint. It also defaults to `-Parallelism 12`, `-MaxTokens 420`, and
`-MinStartIntervalSeconds 0.5` to reduce shared-endpoint QPS spikes.

Example faster run:

```powershell
.\run_llm_capability_review_default.ps1 -AllPending -Limit 100 -Parallelism 12 -MaxTokens 420 -RefreshGold
```

If you want to use OpenAI directly for inference instead of Databricks model serving, use the
OpenAI wrapper. It still reads and writes the dataset tables through Databricks SQL, but sends the
LLM calls to the OpenAI Responses API. That wrapper defaults to `-Parallelism 48`:

```powershell
$env:OPENAI_API_KEY="your-key"
.\run_llm_capability_review_openai.ps1 -AllPending -RefreshGold
```

You can also override the model:

```powershell
.\run_llm_capability_review_openai.ps1 -Model gpt-5.4-mini -AllPending -RefreshGold
```

What the Python runner does:

1. Reads prompt-ready rows from `silver.facility_capability_llm_inputs`
2. Groups matching rows by facility in the default fast path
3. Calls the configured LLM provider once per grouped request
4. Splits the response back into per-capability rows and appends them to `silver.facility_capability_llm_outputs_raw`
5. Optionally rebuilds `gold.facility_capability_llm_signals` and the final
   `gold.facility_capability_assessment` serving table

Important notes:

- use a chat-capable serving endpoint
- the table being reviewed is one row per `facility x capability`, so LLM output is also per `facility x capability`, not one row per facility
- `prompt_version` is stored with every write-back row
- the runner skips rows that already have a current review for the same `prompt_version`, unless you pass `--force`
- `--capability` is only an optional filter for controlled runs; omit it and use `--all-pending` to backfill everything pending
- the runner now sends compact JSON and scores rows in parallel, so throughput mainly depends on the endpoint's rate limits and latency
- the runner shows a live per-batch progress bar with request coverage, written rows, and failure count
- citation-quality should usually stay null until snippet-level provenance exists

## Why the final tier is still deterministic

The app's visible trust tier remains deterministic so the system stays:

- repeatable
- auditable
- easy to explain to planners

The LLM layer is there to improve ambiguous sub-signals, not to hide the final decision rule.

## Current status

- [x] Silver and gold pipeline
- [x] Databricks app for ranking and drill-down
- [x] Local planner overrides in the browser
- [x] Python serving-query helpers
- [x] Python LLM review runner and prompt templates
- [x] App UI integration for LLM-derived supporting snippets

Out of scope for this hackathon:

- True external-URL citation-support grading (would require crawling each `source_urls[]` URL,
  extracting per-claim snippets, and grading them). The schema previously carried
  `citation_support_quality` placeholders; those were removed because the dataset only stores
  facility-level URLs, not per-claim snippets, so any score would be misleading.
