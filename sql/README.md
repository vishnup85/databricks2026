# Facility Trust Desk — Data Pipeline (Silver & Gold)

This folder holds the SQL that turns the **raw hackathon data** into clean, ready-to-use
tables for the Track 1 "Facility Trust Desk" app.

- **Raw data** lives in `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset` (read-only).
- **Our cleaned data** lives in the catalog `virtue_foundation_dataset_cleaned`, split into two schemas:
  - `silver` = cleaned-up versions of the raw tables
  - `gold` = final tables the app reads

Think of it as: **raw → silver (clean it) → gold (make it useful)**.

Run any script with:

```powershell
databricks experimental aitools tools query --file .\sql\<file>.sql --output json --profile DEFAULT
```

Always run Silver before Gold (Gold reads from Silver).

---

## SILVER — "clean the raw data"

### 1. `silver.facilities_clean`  (script `01`)
The raw `facilities` table is messy: everything is text, lists are stored as text, and some
rows are broken. This script fixes that.

**What it changes:**
- **Unpacks lists** — columns like `specialties`, `procedure`, `equipment`, `capability`, and
  `source_urls` were stored as text like `["a","b"]`. We turn them into real lists.
- **Fixes the pincode** — `address_zipOrPostcode` (text) becomes a real number `pincode`.
- **Cleans up state names** — e.g. `Tamilnadu` → `Tamil Nadu`, `Orissa` → `Odisha`, and cities
  used as states (`Mumbai`, `Pune`, `Chennai`…) are mapped to their real state.
- **Counts the evidence** — adds `n_source_urls` (how many source links each facility has).
- **Converts yes/no text to true/false** — `affiliated_staff_presence`, `custom_logo_presence`.
- **Throws away broken rows** — keeps only real facility types (hospital, clinic, dentist, etc.);
  drops ~150 blank or scrambled rows.
- **Removes duplicates** — when the same facility appears twice (same `cluster_id`), keeps the
  one with the most evidence.
- **Pre-builds search text** — adds helper text columns (`spec_eq_text`, `claim_text`,
  `prose_text`, `full_text`) so the scoring step later is simpler and faster.

**Result:** ~9,932 clean, unique facilities (from 10,088 raw rows).

### 2. `silver.pincode_district`  (script `02`)
The raw post-office table has many rows per pincode (one per local post office). The app only
needs to know **which district a pincode is in**.

**What it changes:**
- Groups by pincode and keeps **one district per pincode** (the most common one).
- Standardizes district names (UPPERCASE, trimmed) and state names (Title Case).

**Result:** one clean row per pincode — used to find each facility's district.

### 3. `silver.nfhs_clean`  (script `03`)
The raw NFHS-5 health survey has 100+ columns, and many numbers are "dirty" (e.g. `(29.5)`,
`927 `, `*`). The app only needs a handful of them.

**What it changes:**
- Picks a **focused set of useful indicators** (maternity, screening, insurance, chronic disease).
- **Cleans the numbers** — removes footnote marks like `*`, `(`, `)` and extra spaces, then
  converts them to real decimals.
- Renames long column names to short, readable ones (e.g. `breast_exam_pct`).
- Standardizes the district name so it can be matched to facilities.

**Result:** 706 districts with clean, ready-to-use health numbers.

---

## GOLD — "make it useful for the app"

### 4. `gold.facility_geo`  (script `04`)
Connects each facility to its **district and state** using the pincode bridge.

**What it changes:**
- Joins `facilities_clean` to `pincode_district` on pincode.
- Adds `district_norm` and `state_name` to every facility.
- If a pincode has no match, falls back to the facility's own cleaned state.

**Result:** every facility now has reliable location info (~96% get a district).

### 5. `gold.district_need_index`  (script `05`)
Turns the NFHS health numbers into a simple **"how much is this capability needed here?"** signal,
so the app can prioritize districts with greater need.

**What it changes:**
- **Maternity need** — higher when fewer births happen in hospitals.
- **Oncology screening gap** — higher when fewer women get cancer screenings.
- **Disease burden** — hypertension, diabetes, and anaemia rates for context.
- Keeps the raw numbers too, for drill-down.

**Result:** 706 districts with easy-to-read need scores. The app attaches these to the ranked list
as a `need_score` (see "Extra signals the app uses" below) so a planner can sort by where a
capability is most needed.

### 6. `gold.facility_capability_assessment`  (script `06`) — the main table
This is the heart of the app. It answers: **"Can this facility actually do what it claims?"**
for each of the six capabilities: **ICU, NICU, maternity, emergency, oncology, trauma.**

**What it does:**
- Creates **one row per facility per capability** (so 6 rows per facility).
- Looks for evidence of each capability in three places, strongest first:
  1. **Structured** — coded specialties / equipment (strongest)
  2. **Claim** — the facility's own capability statements (medium)
  3. **Prose** — mentions in the description text (weakest)
- Checks **corroboration** — does it have 3+ source links, an official website, and listed staff?
- Applies **common-sense rules:**
  - A small clinic or dentist claiming ICU / NICU / trauma / oncology is treated as suspicious.
  - "Cancer **screening**" wording (without real cancer **treatment**) is not counted as oncology.
- Gives each one a **trust signal**:
  - **strong** — solid, well-supported evidence
  - **partial** — some evidence, but not fully backed
  - **weak_suspicious** — thin, prose-only, or implausible
  - **no_claim** — no evidence of this capability
- Adds a **score** (for ranking), a plain-language **explanation** of the rating, an **evidence
  summary**, and the **citation links** so the app can show *why* a facility got its rating.

**Result:** ~59,592 rows (9,932 facilities × 6 capabilities) — this is what the app ranks,
filters, and shows citations for.

---

## How the trust score works

The score has two layers: first a **tier** (the bucket), then a **number** for ranking.

### The evidence flags (the ingredients)
- **structured_hit** — capability term found in `specialties` + `equipment` (strongest channel)
- **claim_hit** — found in the facility's own `capability` claims (medium)
- **prose_hit** — found only in `description` / `procedure` free text (weakest)
- **well_corroborated** — `n_source_urls >= 3` AND a real official website (non-empty and **not** the literal string `"null"`) AND affiliated staff present
- **capacity_supported** — facility reports hospital-scale capacity (≥20 beds **or** ≥10 doctors, after outlier guards); surfaced as a signal badge
- **implausible** — high-acuity capability (ICU/NICU/trauma/oncology) that is **not plausibly supported by capacity** (see plausibility note below)
- **screening_only** — oncology special case: cancer mentioned, but no chemo / radio / treatment words
- **recent_update** — `recency_of_page_update` parses to a date within the last 12 months (surfaced as a signal badge in the drill-down)

**Plausibility from capacity / doctors.** `implausible` no longer relies on facility *type* alone — it now reads `capacity_beds` and `num_doctors` (with outlier guards: beds kept only in 1–5000, doctors in 1–2000, so junk like 200,000 beds / 15,000 doctors is ignored). Coverage is sparse (~25% have beds, ~36% have doctors), so **missing values are neutral** — never a penalty. A high-acuity claim (ICU/NICU/trauma/oncology) is implausible when:
- it's a non-hospital type (clinic/dentist/doctor/pharmacy) **and** shows no hospital-scale capacity — *unless* it reports real hospital-scale capacity, which **rescues** it from the flag; or
- any facility (even a "hospital") has a **known, tiny** capacity (<5 beds and <2 doctors) that directly **contradicts** the claim.

The drill-down also exposes the sanitized `beds` and `num_doctors` inside `evidence_json` for inspection.

**Recency as a positive booster.** Only ~35% of facilities have a usable `recency_of_page_update` date (the rest are `"null"`/empty). Recency never affects the **tier**; it only nudges the numeric `score`: a page refreshed in the last 12 months earns **+10**, ranking it higher *within* its tier. Stale or missing dates are fully neutral (no penalty). The +10 bonus stays below the 30-point gap between tiers, so it can never push a facility across a tier boundary.

### Tier (checked top-down, first match wins)
Penalty/safety rules are checked **before** the positive rules:

1. No evidence at all → **no_claim**
2. Oncology screening-only (and no structured hit) → **weak_suspicious**
3. Implausible (high-acuity at clinic/dentist/etc.) → **weak_suspicious**
4. structured_hit **and** well_corroborated → **strong**
5. structured_hit **or** claim_hit → **partial**
6. prose_hit only → **weak_suspicious**
7. otherwise → **no_claim**

### Score (for ranking within a tier)

```
score = tier_base + min(n_source_urls, 10) + (recent_update ? 10 : 0)
```

| Tier | Base | + citations (0–10) | + recency (0 or 10) | Range |
| --- | ---: | ---: | ---: | ---: |
| strong | 90 | up to +10 | +10 if fresh | 90–110 |
| partial | 60 | up to +10 | +10 if fresh | 60–80 |
| weak_suspicious | 30 | up to +10 | +10 if fresh | 30–50 |
| no_claim | 0 | up to +10 | +10 if fresh | 0–20 |

The tier dominates ordering; within a tier, more source URLs and a recently-updated page rank higher.
Both bonuses stay below the 30-point tier gap, so they only re-rank within a tier.

> Note: the citation bonus counts URLs but not their **quality** (a Facebook link counts the same as
> an official site). Weighting by `source_types` is a planned improvement.

> Data-quality guard: a facility whose `official_website` is blank or the literal string `"null"`
> no longer counts as having a website, so it can't be pushed to **strong** on a fake corroboration.

### Extra signals the app uses
- **explanation** — a one-line, plain-language reason for the tier, stored on each row of
  `facility_capability_assessment` (e.g. *"Listed in structured specialties/equipment and
  well-corroborated (12 sources, official website, affiliated staff)."*). Shown in the drill-down.
- **need_score** — the district NFHS need from `district_need_index`, attached at query time:
  maternity / nicu use `maternity_need`, oncology uses `oncology_screening_gap`, and other
  capabilities have no need signal (NFHS doesn't meaningfully cover them). Lets the planner sort the
  ranked list by *where the capability is most needed*.

---

## How the tables connect

```
raw.facilities ─┐
                ├─► silver.facilities_clean ─► gold.facility_geo ─┐
raw.pincode  ───┘            │                                   ├─► gold.facility_capability_assessment
                             └───────────────────────────────────┘
raw.nfhs ───────► silver.nfhs_clean ─► gold.district_need_index
raw.pincode ────► silver.pincode_district
```

## Editing the pipeline
- **Add/remove a capability or change scoring:** edit `06`.
- **Add/remove a cleaned field or fix state names:** edit `01`.
- **Add a health indicator:** edit `03`, then `05`.
- After editing, re-run that script (and any Gold script that depends on it).
