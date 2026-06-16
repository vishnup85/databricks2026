-- Gold: the trust mart. One row per (facility x capability) with a deterministic trust tier.
-- Tiers: strong | partial | weak_suspicious | no_claim
-- Evidence weighting:
--   structured_hit (coded specialties / equipment) > claim_hit (capability prose) > prose_hit (description/procedure)
--   corroboration: >=3 source URLs + official website + affiliated staff
--   plausibility: high-acuity capability (icu/nicu/trauma/oncology) at a clinic/dentist/doctor/pharmacy is downgraded
--   oncology screening-only language (no treatment terms) is capped at weak_suspicious
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.gold.facility_capability_assessment AS
WITH hits AS (
  -- ICU
  SELECT unique_id, 'icu' AS capability,
    (spec_eq_text LIKE '%intensive care%' OR spec_eq_text LIKE '%critical care%' OR spec_eq_text LIKE '%criticalcare%' OR spec_eq_text LIKE '% icu%' OR spec_eq_text LIKE 'icu%' OR spec_eq_text LIKE '%ventilator%') AS structured_hit,
    (claim_text LIKE '%icu%' OR claim_text LIKE '%intensive care%' OR claim_text LIKE '%critical care%') AS claim_hit,
    (prose_text LIKE '%icu%' OR prose_text LIKE '%intensive care%' OR prose_text LIKE '%critical care%') AS prose_hit,
    false AS screening_only
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
  UNION ALL
  -- NICU
  SELECT unique_id, 'nicu',
    (spec_eq_text LIKE '%nicu%' OR spec_eq_text LIKE '%neonat%' OR spec_eq_text LIKE '%incubator%' OR spec_eq_text LIKE '%infant warmer%'),
    (claim_text LIKE '%nicu%' OR claim_text LIKE '%neonat%' OR claim_text LIKE '%newborn intensive%'),
    (prose_text LIKE '%nicu%' OR prose_text LIKE '%neonat%' OR prose_text LIKE '%newborn intensive%'),
    false
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
  UNION ALL
  -- maternity
  SELECT unique_id, 'maternity',
    (spec_eq_text LIKE '%obstetr%' OR spec_eq_text LIKE '%gynec%' OR spec_eq_text LIKE '%maternit%' OR spec_eq_text LIKE '%neonatologyperinatal%' OR spec_eq_text LIKE '%reproductiveendo%'),
    (claim_text LIKE '%maternit%' OR claim_text LIKE '%obstetr%' OR claim_text LIKE '%delivery%' OR claim_text LIKE '%labour%' OR claim_text LIKE '%labor room%' OR claim_text LIKE '%antenatal%' OR claim_text LIKE '%birthing%'),
    (prose_text LIKE '%maternit%' OR prose_text LIKE '%obstetr%' OR prose_text LIKE '%delivery%' OR prose_text LIKE '%antenatal%' OR prose_text LIKE '%childbirth%'),
    false
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
  UNION ALL
  -- emergency
  SELECT unique_id, 'emergency',
    (spec_eq_text LIKE '%emergencymedicine%' OR spec_eq_text LIKE '%emergency%' OR spec_eq_text LIKE '%ambulance%' OR spec_eq_text LIKE '%casualty%'),
    (claim_text LIKE '%emergency%' OR claim_text LIKE '%casualty%' OR claim_text LIKE '%24/7%' OR claim_text LIKE '%24 hour%' OR claim_text LIKE '%24 hrs%' OR claim_text LIKE '%24x7%'),
    (prose_text LIKE '%emergency%' OR prose_text LIKE '%casualty%' OR prose_text LIKE '%24/7%' OR prose_text LIKE '%24 hour%'),
    false
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
  UNION ALL
  -- oncology
  SELECT unique_id, 'oncology',
    (spec_eq_text LIKE '%oncolog%' OR spec_eq_text LIKE '%chemotherap%' OR spec_eq_text LIKE '%radiotherap%' OR spec_eq_text LIKE '%linear accelerator%' OR spec_eq_text LIKE '%radiation oncolog%'),
    (claim_text LIKE '%oncolog%' OR claim_text LIKE '%chemotherap%' OR claim_text LIKE '%radiotherap%' OR claim_text LIKE '%cancer treatment%' OR claim_text LIKE '%cancer care%' OR claim_text LIKE '%tumor board%'),
    (prose_text LIKE '%oncolog%' OR prose_text LIKE '%chemotherap%' OR prose_text LIKE '%cancer treatment%'),
    ((full_text LIKE '%cancer%' OR full_text LIKE '%tumour%' OR full_text LIKE '%tumor%')
      AND NOT (full_text LIKE '%oncolog%' OR full_text LIKE '%chemotherap%' OR full_text LIKE '%radiotherap%' OR full_text LIKE '%cancer treatment%' OR full_text LIKE '%tumor board%'))
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
  UNION ALL
  -- trauma
  SELECT unique_id, 'trauma',
    (spec_eq_text LIKE '%trauma%' OR spec_eq_text LIKE '%traumasurgery%'),
    (claim_text LIKE '%trauma%' OR claim_text LIKE '%polytrauma%' OR claim_text LIKE '%poly trauma%'),
    (prose_text LIKE '%trauma%' OR prose_text LIKE '%accident and emergency%'),
    false
  FROM virtue_foundation_dataset_cleaned.silver.facilities_clean
),
enr AS (
  SELECT
    h.unique_id,
    h.capability,
    h.structured_hit,
    h.claim_hit,
    h.prose_hit,
    h.screening_only,
    f.facility_type,
    f.n_source_urls,
    f.official_website,
    f.staff_present,
    f.source_urls_arr,
    try_cast(f.recency_of_page_update AS date) AS page_updated,
    -- outlier-guarded capacity: ignore junk (e.g. 200000 beds, 15000 doctors) by keeping
    -- only sane ranges; everything else (incl. NULL) is treated as "unknown" / neutral.
    CASE WHEN f.capacity_beds BETWEEN 1 AND 5000 THEN f.capacity_beds END AS beds_sane,
    CASE WHEN f.num_doctors BETWEEN 1 AND 2000 THEN f.num_doctors END AS docs_sane,
    -- hospital-scale capacity that plausibly backs a high-acuity / inpatient claim
    coalesce(
      CASE WHEN f.capacity_beds BETWEEN 1 AND 5000 THEN f.capacity_beds END >= 20
        OR CASE WHEN f.num_doctors BETWEEN 1 AND 2000 THEN f.num_doctors END >= 10
    , false) AS capacity_supported,
    -- known, tiny capacity that directly contradicts an inpatient claim (beds known < 5 and not enough doctors)
    coalesce(
      CASE WHEN f.capacity_beds BETWEEN 0 AND 5000 THEN f.capacity_beds END < 5
        AND coalesce(CASE WHEN f.num_doctors BETWEEN 1 AND 2000 THEN f.num_doctors END, 0) < 2
    , false) AS capacity_contradicts,
    (f.n_source_urls >= 3 AND f.official_website IS NOT NULL AND f.official_website <> '' AND lower(f.official_website) <> 'null' AND f.staff_present) AS well_corroborated
  FROM hits h
  JOIN virtue_foundation_dataset_cleaned.silver.facilities_clean f
    ON h.unique_id = f.unique_id
),
flagged AS (
  SELECT
    *,
    -- plausibility considers capacity/doctors, not just facility type:
    --   * a non-hospital type is implausible UNLESS it shows hospital-scale capacity (rescue)
    --   * any facility is implausible if a known, tiny capacity contradicts the claim
    ((structured_hit OR claim_hit OR prose_hit) AND capability IN ('icu', 'nicu', 'trauma', 'oncology') AND (
        (facility_type IN ('clinic', 'dentist', 'doctor', 'pharmacy') AND NOT capacity_supported)
        OR capacity_contradicts
      )) AS implausible
  FROM enr
),
scored AS (
  SELECT
    *,
    CASE
      WHEN NOT (structured_hit OR claim_hit OR prose_hit) THEN 'no_claim'
      WHEN capability = 'oncology' AND screening_only AND NOT structured_hit THEN 'weak_suspicious'
      WHEN implausible THEN 'weak_suspicious'
      WHEN structured_hit AND well_corroborated THEN 'strong'
      WHEN structured_hit OR claim_hit THEN 'partial'
      WHEN prose_hit THEN 'weak_suspicious'
      ELSE 'no_claim'
    END AS tier
  FROM flagged
)
SELECT
  s.unique_id,
  s.capability,
  g.name,
  g.facility_type,
  g.operator_type,
  g.district_norm,
  g.state_name,
  g.latitude,
  g.longitude,
  s.tier,
  CASE s.tier WHEN 'strong' THEN 90 WHEN 'partial' THEN 60 WHEN 'weak_suspicious' THEN 30 ELSE 0 END
    + least(coalesce(s.n_source_urls, 0), 10)
    -- recency is a positive booster only: a page refreshed in the last 12 months ranks
    -- higher within its tier. Stale or missing dates are neutral (no penalty). The +10
    -- bonus stays below the 30-point tier gap, so it never pushes a row across tiers.
    + CASE WHEN s.page_updated IS NOT NULL AND s.page_updated >= add_months(current_date(), -12) THEN 10 ELSE 0 END AS score,
  -- plain-language "why this tier" sentence for the drill-down
  CASE
    WHEN s.tier = 'no_claim' AND s.well_corroborated AND s.page_updated IS NOT NULL AND s.page_updated >= add_months(current_date(), -12)
      THEN 'No evidence of this capability in the facility data. The facility profile itself is well-sourced and recently updated, but none of those sources mention this capability.'
    WHEN s.tier = 'no_claim' AND s.well_corroborated
      THEN 'No evidence of this capability in the facility data. The facility profile itself is well-sourced, but none of those sources mention this capability.'
    WHEN s.tier = 'no_claim' AND s.page_updated IS NOT NULL AND s.page_updated >= add_months(current_date(), -12)
      THEN 'No evidence of this capability in the facility data. The facility has a recent public update, but that update still does not mention this capability.'
    WHEN s.tier = 'no_claim' THEN 'No evidence of this capability in the facility data.'
    WHEN s.capability = 'oncology' AND s.screening_only AND NOT s.structured_hit
      THEN 'Only cancer-screening language found, with no treatment evidence — capped as weak/suspicious.'
    WHEN s.implausible AND s.capacity_contradicts
      THEN concat('Claims ', s.capability, ' but its reported capacity (beds/doctors) is too small to plausibly provide it — flagged weak/suspicious.')
    WHEN s.implausible
      THEN concat('A ', g.facility_type, ' claiming ', s.capability, ' is implausible without hospital-level support (no hospital-scale capacity reported), so this is flagged weak/suspicious.')
    WHEN s.structured_hit AND s.well_corroborated
      THEN concat('Listed in structured specialties/equipment and well-corroborated (', cast(s.n_source_urls AS string), ' sources, official website, affiliated staff).')
    WHEN s.structured_hit OR s.claim_hit
      THEN concat('Found in ', concat_ws(' and ',
                    CASE WHEN s.structured_hit THEN 'structured specialties/equipment' END,
                    CASE WHEN s.claim_hit THEN 'the facility''s own capability claims' END),
                  ', but corroboration is limited.')
    WHEN s.prose_hit
      THEN 'Mentioned only in free-text description, with no structured backing.'
    ELSE 'No reliable evidence.'
  END AS explanation,
  s.structured_hit,
  s.claim_hit,
  s.prose_hit,
  s.screening_only,
  s.well_corroborated,
  s.implausible,
  s.n_source_urls,
  s.official_website,
  s.staff_present,
  to_json(named_struct(
    'structured_hit', s.structured_hit,
    'claim_hit', s.claim_hit,
    'prose_hit', s.prose_hit,
    'screening_only', s.screening_only,
    'well_corroborated', s.well_corroborated,
    'implausible', s.implausible,
    'n_source_urls', s.n_source_urls,
    'official_website', CASE WHEN lower(coalesce(s.official_website, '')) IN ('', 'null') THEN NULL ELSE s.official_website END,
    'recent_update', (s.page_updated IS NOT NULL AND s.page_updated >= add_months(current_date(), -12)),
    'page_updated', cast(s.page_updated AS string),
    'capacity_supported', s.capacity_supported,
    'beds', s.beds_sane,
    'num_doctors', s.docs_sane
  )) AS evidence_json,
  s.source_urls_arr AS citation_urls
FROM scored s
JOIN virtue_foundation_dataset_cleaned.gold.facility_geo g
  ON s.unique_id = g.unique_id;
