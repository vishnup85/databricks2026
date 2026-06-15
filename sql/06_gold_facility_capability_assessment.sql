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
    (f.n_source_urls >= 3 AND f.official_website IS NOT NULL AND f.official_website <> '' AND f.staff_present) AS well_corroborated,
    (h.capability IN ('icu', 'nicu', 'trauma', 'oncology') AND f.facility_type IN ('clinic', 'dentist', 'doctor', 'pharmacy')) AS implausible
  FROM hits h
  JOIN virtue_foundation_dataset_cleaned.silver.facilities_clean f
    ON h.unique_id = f.unique_id
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
  FROM enr
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
    + least(coalesce(s.n_source_urls, 0), 10) AS score,
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
    'official_website', s.official_website
  )) AS evidence_json,
  s.source_urls_arr AS citation_urls
FROM scored s
JOIN virtue_foundation_dataset_cleaned.gold.facility_geo g
  ON s.unique_id = g.unique_id;
