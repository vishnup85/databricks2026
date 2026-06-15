-- Silver: cleaned NFHS-5 district indicators (curated subset for Track 1)
-- Footnote markers in string columns ( * (..) trailing spaces ) are stripped and cast to double.
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.silver.nfhs_clean AS
SELECT
  upper(trim(district_name)) AS district_norm,
  trim(state_ut) AS state_ut,
  -- maternity / newborn
  institutional_birth_5y_pct,
  institutional_birth_in_public_facility_5y_pct,
  births_delivered_by_csection_5y_pct,
  try_cast(regexp_replace(trim(mothers_who_had_at_least_4_anc_visits_lb5y_pct), '[()*]', '') AS double) AS anc_4plus_visits_pct,
  -- access / coverage
  hh_member_covered_health_insurance_pct AS health_insurance_pct,
  -- oncology screening coverage
  women_age_30_49_years_ever_undergone_a_breast_exam_pct AS breast_exam_pct,
  women_age_30_49_years_ever_undergone_a_cervical_screen_pct AS cervical_screen_pct,
  women_age_30_49_years_ever_undergone_an_oral_cancer_exam_pct AS oral_cancer_exam_pct,
  -- chronic disease burden
  all_w15_49_who_are_anaemic_pct AS anaemia_women_pct,
  w15_plus_with_high_bp_sys_gte_140_mmhg_and_or_dia_gte_90_mm_pct AS hypertension_women_pct,
  w15_plus_with_high_or_very_high_gt_140_mg_dl_blood_sugar_or_pct AS high_bloodsugar_women_pct
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.nfhs_5_district_health_indicators;
