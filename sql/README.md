# Facility Trust Desk - Data Pipeline

This folder holds the SQL that turns the raw hackathon data into clean, ready-to-use
tables for the Track 1 "Facility Trust Desk" app.

- Raw data lives in `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset`
  and is read-only.
- Cleaned data lives in catalog `virtue_foundation_dataset_cleaned`.
- We use two schemas:
  - `silver` = cleaned and staged tables
  - `gold` = serving tables the app and analysts read

Think of it as:

`raw -> silver (clean it) -> gold (serve it)`

Run any script with:

```powershell
databricks experimental aitools tools query --file .\sql\<file>.sql --output json --profile DEFAULT
```

Run scripts in numeric order.

Note: scripts `07` and `08` live in the `silver` schema, but `07` intentionally depends on the
gold heuristic baseline from script `06`, and script `10` rebuilds the final serving table after
script `09`, so dependency order matters more than schema name.

## Important design rule

The final trust tier remains fully deterministic.

- `06_gold_facility_capability_assessment.sql` builds the heuristic baseline.
- `10_gold_facility_capability_assessment.sql` rebuilds the final serving table from that
  baseline plus any current LLM-reviewed sub-signals.

Scripts `07` to `10` add an optional LLM review layer for sub-signals such as:

- `claim_hit`
- `prose_hit`
- `screening_only`
- `capability_scope`
- `supporting_snippets`

That LLM layer is auditable, versioned, and separate. It never writes the final trust tier
directly; the final tier is still recomputed by deterministic SQL.

## Script-by-script overview

### 1. `silver.facilities_clean` (`01_silver_facilities_clean.sql`)

This cleans the raw `facilities` table.

What it does:

- Parses JSON-like list columns such as `specialties`, `procedure`, `equipment`, `capability`,
  `source_urls`, and `source_types`.
- Casts numeric-looking fields such as `capacity` and `numberDoctors`.
- Converts yes/no strings to booleans.
- Repairs state names and parses `pincode`.
- Drops obviously broken rows.
- Deduplicates by `cluster_id`, keeping the richest-evidence row.
- Builds helper text columns such as `claim_text`, `prose_text`, and `full_text`.

Result:

- about 9,932 clean, unique facilities from 10,088 raw rows

### 2. `silver.pincode_district` (`02_silver_pincode_district.sql`)

This turns the raw post-office directory into a clean pincode-to-district bridge.

What it does:

- keeps one district per pincode
- standardizes district and state names

Result:

- one clean row per pincode

### 3. `silver.nfhs_clean` (`03_silver_nfhs_clean.sql`)

This cleans the NFHS-5 district health indicators.

What it does:

- selects the subset of indicators needed for Track 1
- strips dirty numeric characters such as `(`, `)`, `*`, and extra spaces
- casts usable indicators to decimals
- standardizes district names

Result:

- 706 clean district-level rows

### 4. `gold.facility_geo` (`04_gold_facility_geo.sql`)

This attaches cleaned geography to each facility.

What it does:

- joins facilities to the pincode bridge
- adds canonical `district_norm` and `state_name`
- falls back to the facility's own normalized state when pincode lookup is missing

Result:

- almost every facility gets reliable state data, and most get district data

### 5. `gold.district_need_index` (`05_gold_district_need_index.sql`)

This creates district-level demand context.

What it does:

- builds maternity need from institutional-birth related indicators
- builds oncology screening gap from cancer screening indicators
- keeps disease-burden context such as hypertension, diabetes, and anaemia

Result:

- 706 districts with planner-facing need scores

### 6. `gold.facility_capability_assessment_heuristic` (`06_gold_facility_capability_assessment.sql`)

This is the heuristic baseline mart.

It answers:

`Can this facility actually do what it claims?`

for each of the six Track 1 capabilities:

- ICU
- NICU
- maternity
- emergency
- oncology
- trauma

What it does:

- creates one row per `facility x capability`
- looks for evidence in three channels:
  - `structured_hit` from specialties and equipment
  - `claim_hit` from the facility's own capability claims
  - `prose_hit` from description and procedure text
- checks corroboration using source count, official website, and staff presence
- applies plausibility rules for high-acuity capabilities
- treats oncology screening-only language as weaker than actual treatment capability
- assigns:
  - a deterministic `tier`
  - a deterministic `score`
  - a plain-language `explanation`
  - facility-level citation URLs

Result:

- about 59,592 rows (9,932 facilities x 6 capabilities)

### 7. `silver.facility_capability_llm_inputs` (`07_silver_facility_capability_llm_inputs.sql`)

This is the prompt-ready handoff table for LLM review.

What it does:

- keeps the same one-row-per-`facility x capability` shape as the deterministic table
- carries forward the deterministic baseline as:
  - `heuristic_tier`
  - `heuristic_score`
  - `heuristic_explanation`
  - `heuristic_*` evidence flags
- packages the raw evidence the model should inspect:
  - `capability`
  - `specialties`
  - `procedure`
  - `equipment`
  - `description`
  - citation URLs and source types
- computes `evidence_fingerprint`, a hash of the evidence snapshot
- builds `llm_input_json`, a single export-friendly payload

Why the fingerprint matters:

- if the evidence stays the same, the fingerprint stays the same
- model output can be tied to the exact evidence snapshot it reviewed
- downstream tables can tell whether an LLM review is still current or has gone stale

Note on citation quality:

- Today we have facility-level URLs, but we do not store source-linked snippets or quote spans.
- True external-URL citation grading is out of scope for this hackathon. The previous
  `citation_support_quality` placeholders were removed so the schema does not carry fields the
  data cannot honestly support.
- LLM-derived `supporting_snippets` (quotes from the facility's own description / procedure text)
  are still produced and surfaced in the app.

### 8. `silver.facility_capability_llm_outputs_raw` (`08_silver_facility_capability_llm_outputs_raw.sql`)

This is the append-only landing table for normalized LLM output.

What it stores:

- the row key: `unique_id`, `capability`
- the `evidence_fingerprint` from script `07`
- `prompt_version`
- `model_name`
- `model_version`
- `run_id`
- timestamps for source snapshot and inference
- `raw_response_json`
- `parsed_json`

Expected `parsed_json` contract:

```json
{
  "claim_hit": true,
  "prose_hit": false,
  "screening_only": false,
  "capability_scope": "full_capability",
  "supporting_snippets": [],
  "confidence": 0.94,
  "reasoning": "Short audit-friendly explanation."
}
```

Why this is `CREATE TABLE IF NOT EXISTS`:

- model output is write-back data
- we do not want the pipeline to wipe historical runs every time it is rebuilt

### 9. `gold.facility_capability_llm_signals` (`09_gold_facility_capability_llm_signals.sql`)

This is the typed serving table for LLM-reviewed sub-signals.

What it does:

- takes the latest normalized LLM output for each `facility x capability`
- parses `parsed_json` into typed columns
- joins the result back to every current row from script `07`

What it adds:

- `claim_hit_llm`
- `prose_hit_llm`
- `screening_only_llm`
- `capability_scope_llm`
- `supporting_snippets_llm`
- `confidence_llm`
- `reasoning_llm`

Audit fields:

- `has_llm_review`
- `llm_review_status`
  - `missing` = no review written back yet
  - `current` = review matches the latest evidence fingerprint
  - `stale` = review exists, but the facility evidence changed afterward
- `current_evidence_fingerprint`
- `reviewed_evidence_fingerprint`

The deterministic baseline is kept alongside the LLM output:

- `heuristic_tier`
- `heuristic_score`
- `heuristic_explanation`

That makes comparison simple without ever letting the model overwrite the deterministic trust tier.

### 10. `gold.facility_capability_assessment` (`10_gold_facility_capability_assessment.sql`)

This is the final serving mart that the app reads.

What it does:

- starts from the heuristic baseline in script `06`
- joins the latest parsed LLM sub-signals from script `09`
- uses current LLM-reviewed `claim_hit`, `prose_hit`, `screening_only`, and `capability_scope`
  when available
- falls back to the heuristic flags when no current LLM review exists
- deterministically recomputes:
  - the final `tier`
  - the final `score`
  - the final plain-language `explanation`
- preserves both heuristic and LLM audit columns side by side

Important behavior:

- `adjacent_service` caps a row at `weak_suspicious`
- `screening_or_diagnostics_only` caps a row at `weak_suspicious`
- the model still never assigns the tier directly; SQL does

## How the deterministic trust score works

The deterministic system has two layers:

- a `tier` bucket
- a numeric `score` used only for ranking within the bucket

### Evidence flags

- `structured_hit` = capability term found in specialties or equipment
- `claim_hit` = found in the facility's own capability claims
- `prose_hit` = found only in description or procedure free text
- `well_corroborated` = at least 3 source URLs, a real official website, and affiliated staff
- `capacity_supported` = hospital-scale capacity is reported
- `implausible` = a high-acuity capability is not plausibly supported by facility scale
- `screening_only` = oncology mention looks like screening, not treatment
- `recent_update` = the facility page appears updated within the last 12 months

### Tier rules

Checked top-down:

1. no evidence at all -> `no_claim`
2. LLM scope says `screening_or_diagnostics_only` -> `weak_suspicious`
3. LLM scope says `adjacent_service` -> `weak_suspicious`
4. oncology screening-only without structured support -> `weak_suspicious`
5. implausible high-acuity claim -> `weak_suspicious`
6. structured evidence and strong corroboration -> `strong`
7. structured evidence or direct claim -> `partial`
8. prose-only mention -> `weak_suspicious`
9. otherwise -> `no_claim`

### Score rules

```text
score = tier_base + min(n_source_urls, 10) + recent_update_bonus
```

Tier bases:

- `strong` = 90
- `partial` = 60
- `weak_suspicious` = 30
- `no_claim` = 0

Bonuses:

- up to +10 for citation count
- +10 for a recent page update

Those bonuses stay below the 30-point tier gap, so they only reorder rows within a tier.

## Citation-quality note

The deterministic score uses citation count, not external-URL citation quality, and that is by
design for this hackathon: the dataset stores facility-level URLs but no per-claim snippets, so any
"this URL supports this capability" score would be guesswork. We surface LLM-derived
`supporting_snippets` (quotes from the facility's own description / procedure text) instead, which
are real evidence rather than a manufactured citation grade.

## Using the LLM layer

1. Run scripts `01` through `08` to rebuild the deterministic tables, the prompt-ready inputs, and
   the append-only raw output table (`08` is `CREATE TABLE IF NOT EXISTS`, so it is a no-op after the
   first run but the table must exist before step 2).
2. Batch the rows from `silver.facility_capability_llm_inputs` through your model of choice and
   append normalized results into `silver.facility_capability_llm_outputs_raw`.
3. Run scripts `09` and `10` to refresh the parsed LLM signals and the final serving table.

If the facility evidence changes, rerun `07` before refreshing `09`. The fingerprint and
`llm_review_status` fields will tell you whether an older model review is still current.

There is a checked-in Python helper for step 2:

- `run_llm_capability_review.py`

It reads from the input table and writes normalized rows into
`silver.facility_capability_llm_outputs_raw` using the Databricks CLI profile you pass in. By
default it POSTs to a Databricks Model Serving endpoint at
`/serving-endpoints/<endpoint>/invocations`; pass `--provider openai` to call the OpenAI Responses
API instead (the runner still reads from and writes to Databricks SQL via the CLI either way).
Use `--all-pending` to sweep every pending `facility x capability` row, or `--capability` for a
smaller targeted batch.

Two PowerShell wrappers are checked in alongside it for the common cases:

- `run_llm_capability_review_default.ps1` -- Databricks-hosted endpoint
  (`databricks-meta-llama-3-1-8b-instruct` by default), with batched facility mode and shared-endpoint
  QPS-friendly defaults.
- `run_llm_capability_review_openai.ps1` -- OpenAI Responses API, reading `OPENAI_API_KEY` from the
  environment, with higher default parallelism.

## How the tables connect

```text
raw.facilities
  -> silver.facilities_clean
    -> gold.facility_geo
    -> gold.facility_capability_assessment_heuristic
      -> silver.facility_capability_llm_inputs
        -> gold.facility_capability_llm_signals
          -> gold.facility_capability_assessment

raw.pincode
  -> silver.pincode_district
    -> gold.facility_geo

raw.nfhs
  -> silver.nfhs_clean
    -> gold.district_need_index

silver.facility_capability_llm_outputs_raw
  -> gold.facility_capability_llm_signals
    -> gold.facility_capability_assessment
```

## Editing guide

- Change heuristic capability matching / baseline scoring in `06`.
- Change prompt packaging or the evidence fingerprint in `07`.
- Change the write-back JSON contract in `08`.
- Change typed parsing of LLM output in `09`.
- Change how current LLM sub-signals feed the final deterministic serving tier in `10`.
- Change facility cleaning in `01`.
- Change district need indicators in `03` and `05`.

After edits, rerun the changed script and any downstream scripts that depend on it.
