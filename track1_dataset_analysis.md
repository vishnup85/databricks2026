# Track 1 Dataset Analysis

## Scope

Profile used: `default`

Core tables:

- `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory`
- `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.nfhs_5_district_health_indicators`

## What Each Table Is Good For

### `facilities`

Primary Track 1 table. It already contains extracted claims and supporting evidence for each facility:

- identity and location: `name`, `address_*`, `latitude`, `longitude`, `cluster_id`
- facility metadata: `facilityTypeId`, `operatorTypeId`, `numberDoctors`, `capacity`
- claim/evidence text: `specialties`, `procedure`, `equipment`, `capability`, `description`
- contact and web presence: `officialWebsite`, `officialPhone`, `email`, `websites`, `facebookLink`
- citation trail: `source_urls`, `source_types`, `source_ids`, `source_content_id`
- weak trust proxies: `distinct_social_media_presence_count`, `affiliated_staff_presence`, `custom_logo_presence`

This is the table that should drive ranking and facility drill-down.

### `india_post_pincode_directory`

Reference table for canonical geography:

- maps `pincode` to `state`, `district`, postal office, and sometimes lat/lon
- best way to repair bad state labels in `facilities`
- best bridge from facility to district-level NFHS indicators

### `nfhs_5_district_health_indicators`

District-level demand/context table. It does not prove a facility can perform a capability, but it helps prioritize where capability gaps matter.

Most relevant columns by capability:

- maternity / NICU: ANC coverage, institutional birth, public-facility birth, C-section rate, neonatal tetanus protection
- oncology: cervical screening, breast exam, oral cancer exam
- emergency / ICU / trauma: only indirect context; NFHS is weak for these compared with maternity and oncology

## High-Level Facility Profile

Raw row count: `10,088`

Key coverage:

- `10,077` distinct `unique_id` values
- `9,959` distinct `cluster_id` values
- `11` duplicated `unique_id` pairs (`22` rows total)
- `5,637` hospitals
- `3,782` clinics
- `490` dentists
- `9,964` rows have coordinates inside an India bounding box
- `6` rows have obvious coordinate outliers
- `9,572` facilities match a 6-digit pincode to the postal reference table
- `6,174` facilities can be joined through pincode to NFHS district indicators

Top states by row count:

- Maharashtra `1,575`
- Gujarat `981`
- Uttar Pradesh `919`
- Tamil Nadu `780`
- Karnataka `529`

## Important Data Quality Findings

### 1. Many fields are strings, not clean typed columns

The following are stored as strings and need parsing/normalization:

- `specialties`, `procedure`, `equipment`, `capability`, `source_urls`
- booleans such as `affiliated_staff_presence`, `custom_logo_presence`
- numeric-looking fields such as `capacity` and `numberDoctors`

Examples:

- `numberDoctors` has `3,630` numeric values but `6,342` literal `"null"` strings
- `capacity` has `2,517` numeric values but `7,454` literal `"null"` strings
- `officialWebsite` has `1,609` literal `"null"` strings

Recommendation: convert JSON-like array strings to arrays, normalize `"null"` to SQL null, and cast numeric fields with `try_cast`.

### 2. `address_stateOrRegion` is not reliable enough to use directly

`COUNT(DISTINCT address_stateOrRegion)` returns `254`, which is impossible for Indian state-level geography.

Observed problems:

- state field sometimes contains district names, for example `Alappuzha` or `Kollam`
- state field sometimes contains verbose text like `Satara District, Maharashtra`
- a few rows contain numbers, JSON, URLs, or clearly shifted content

Recommendation: use pincode lookup as the canonical state/district source whenever a valid 6-digit pincode exists.

### 3. There are corrupted rows with shifted columns

Counts:

- `19` rows have invalid `facilityTypeId` values
- `14` rows have invalid `operatorTypeId` values

Sample corruption patterns:

- `facilityTypeId` contains a JSON coordinate object
- `officialWebsite` contains capability text
- `unique_id` contains long narrative text instead of a UUID

Recommendation: quarantine rows failing basic sanity checks before ranking.

### 4. Coordinates are mostly good, but not perfect

Outliers include facilities in India with coordinates like:

- `Sanjivani Multi Speciality Hospital` -> `59.95, -38.26`
- `Krishna Hospital Multispeciality` -> `-81.71, 26.95`

Recommendation: if lat/lon fall outside India, replace from pincode centroid when available, otherwise hide on map.

### 5. Pincode join is strong enough to become part of the cleaning pipeline

Join stats:

- `9,791` facilities have a parseable 6-digit pincode
- `9,572` match the postal reference table
- `9,079` have exact state agreement after canonicalization
- `493` have state mismatches

Some mismatches are spelling or old-state issues, but many are true data problems such as wrong state, wrong pincode, or district name stored in the state field.

## Capability Coverage

Simple capability matching across `name`, `description`, `specialties`, `procedure`, `equipment`, and `capability` gives:

| Capability | Any Match | Hospital Matches | Clinic Matches |
| --- | ---: | ---: | ---: |
| Maternity | 5,066 | 3,848 | 1,108 |
| Emergency | 4,077 | 3,422 | 570 |
| Oncology | 2,849 | 2,298 | 498 |
| ICU | 2,398 | 2,253 | 141 |
| Trauma | 1,922 | 1,644 | 253 |
| NICU | 1,568 | 1,422 | 142 |

Important nuance: raw keyword counts overstate true capability. Many clinic and dental rows mention emergency, oncology, or trauma in a narrow outpatient sense.

## Beyond The Six Track 1 Capabilities

The raw `capability` field should not be exposed directly as a user-facing filter.

Why:

- it contains `165,150` normalized free-text phrases
- only `17,070` of those phrases match at least one of the 6 Track 1 buckets
- many frequent phrases are not capabilities at all, for example:
  - `nabh accredited`
  - `operates 24/7`
  - `private hospital`
  - `has 1 doctor on staff`
  - `located in ahmedabad, gujarat, india`

### Better Source For A Broader Capability Picker

Use `specialties` as the backbone of the taxonomy.

Observed structured vocabulary sizes:

- `2,701` distinct normalized specialty values
- `82,712` distinct normalized procedure values
- `33,885` distinct normalized equipment values

But after applying a minimum-support threshold, `specialties` is much more usable:

- `213` specialty values appear at least `25` times
- `161` specialty values appear at least `50` times
- `126` specialty values appear at least `100` times
- `85` specialty values appear at least `250` times

This makes `specialties` the safest source for an extended capability catalog.

### What To Expose In The App

Recommended model:

1. expose canonical specialty capabilities from `specialties`
2. add a curated set of service/infrastructure capabilities from `procedure`, `equipment`, and `capability`
3. keep generic attributes separate as metadata filters, not capabilities

Examples of high-confidence specialty capabilities:

- gynecology and obstetrics
- ophthalmology
- orthopedic surgery
- pediatrics
- cardiology
- general surgery
- radiology
- pathology
- otolaryngology / ENT
- urology
- dermatology
- gastroenterology
- nephrology
- neurology
- emergency medicine
- critical care medicine
- neurosurgery
- medical oncology
- pulmonology
- plastic surgery
- psychiatry
- neonatology / perinatal medicine
- reproductive endocrinology and infertility

Examples of service or infrastructure capabilities worth exposing separately:

- ICU
- NICU
- maternity
- trauma
- emergency department
- IVF / IUI / ICSI
- dialysis
- CT scan
- MRI
- PET-CT
- cath lab
- blood bank
- endoscopy
- laparoscopy
- joint replacement
- cataract surgery

Examples that should usually be filters or badges instead of capabilities:

- NABH / NABL accreditation
- 24/7 operations
- bed count
- insurance acceptance
- wheelchair accessibility
- inpatient / outpatient
- private / public

### Practical Recommendation

If the product goal is “as many capabilities as possible provided there is minimum data,” the safest initial launch set is:

- all canonical specialty capabilities with at least `50` mentions, plus
- a curated list of non-specialty service capabilities with direct procedure/equipment support

That would give a user-facing catalog that is broad, but still grounded in repeated evidence rather than one-off free-text claims.

## Recommended Trust Buckets

### Strong Evidence

Use when at least two structured evidence channels agree, ideally including a direct capability claim plus supporting procedures/equipment/specialties.

Examples:

- ICU: `ICU`, `critical care`, ventilators, central oxygen, monitors
- NICU: `NICU`, `neonatology`, incubators, radiant warmers, phototherapy
- Oncology: oncology plus chemotherapy, radiotherapy, PET-CT, linear accelerator
- Maternity: obstetrics plus deliveries, labor room, C-section, fetal/newborn support

### Partial Evidence

Use when there is one structured signal but not enough corroboration.

Examples:

- gynecology or fertility present but no delivery/labor/C-section evidence
- emergency claim with website but no ambulance or ER-specific support
- oncology mention without chemotherapy/radiation/surgery support

### Weak Or Suspicious

Use when the claim is narrow, poorly supported, or contradictory.

Examples:

- advanced capabilities claimed by `clinic` or `dentist` rows
- claim appears only in `description` or name text
- row has corrupted columns or impossible coordinates
- pincode/state mismatch
- official website/contact fields are malformed or literal `"null"`

### No Claim

No reliable match across evidence fields.

## Capability-Specific Cautions

### Maternity

This is the easiest capability to overcall.

A gynecology clinic, IVF center, or fertility specialist is not automatically a maternity or delivery-capable facility. Require evidence like:

- obstetrics
- labor room
- delivery
- C-section
- newborn/NICU support

### Emergency

Emergency dental care and small outpatient urgent care often match the keyword search. Treat true hospital emergency departments separately from narrow clinic urgent care.

### Oncology

Dental or ENT clinics may mention oral cancer screening. That should not rank as full oncology capability unless treatment evidence exists.

### Trauma

Maxillofacial trauma and fracture treatment at specialty clinics should not be treated as a full trauma-capable hospital unless broader emergency/operative support is present.

### ICU / NICU

These are the cleanest advanced-capability signals in this dataset because equipment and structured capability text often co-occur.

## Suggested Ranking Features For The App

For each facility x capability pair, build features from:

1. structured claim matches
   - direct capability text
   - specialty match
   - procedure match
   - equipment match
2. facility plausibility
   - hospital vs clinic/dentist
   - numeric `capacity`
   - numeric `numberDoctors`
3. citation quality
   - official domain present
   - multiple `source_urls`
   - official site > government page > directory > social page
4. consistency checks
   - valid state/pincode relationship
   - valid coordinates
   - non-corrupt row
   - deduped `unique_id` / `cluster_id`

Suggested output categories:

- `strong_evidence`
- `partial_evidence`
- `weak_or_suspicious`
- `no_claim`

## Suggested UI/Data Model

Planner workflow can be implemented from this dataset directly:

1. planner selects `capability` and `region`
2. backend normalizes region using pincode lookup
3. backend scores each facility-capability pair
4. UI shows ranked facilities with:
   - facility name
   - canonical city/state/district
   - trust signal
   - short explanation
5. expand row to show:
   - matched evidence snippets from `capability`, `procedure`, `equipment`, `specialties`
   - citation URLs from `source_urls`
   - data quality warnings
6. planner can override with:
   - manual label
   - note
   - reviewer identity / timestamp

## Practical Next Step

Before building the app, create a cleaned facility-capability table with:

- one canonical row per `unique_id`
- parsed array fields
- canonical district/state from pincode
- cleaned numeric and boolean columns
- capability-specific evidence features
- trust bucket and explanation text

That cleaned table should be the serving layer for Track 1.
