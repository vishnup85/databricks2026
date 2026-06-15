-- Gold: per-district demand/need signal from NFHS-5, per capability theme
-- Higher value = higher unmet need (used to prioritize the ranked list).
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.gold.district_need_index AS
SELECT
  district_norm,
  state_ut,
  -- maternity: lower institutional birth coverage => higher need
  round(greatest(0, 100 - coalesce(institutional_birth_5y_pct, 50)), 1) AS maternity_need,
  -- oncology: lower average screening coverage => higher unmet need
  round(100 - coalesce((coalesce(breast_exam_pct, 0) + coalesce(cervical_screen_pct, 0) + coalesce(oral_cancer_exam_pct, 0)) / 3, 0), 1) AS oncology_screening_gap,
  -- chronic-disease burden (context)
  round(coalesce(hypertension_women_pct, 0), 1) AS hypertension_burden,
  round(coalesce(high_bloodsugar_women_pct, 0), 1) AS diabetes_burden,
  round(coalesce(anaemia_women_pct, 0), 1) AS anaemia_burden,
  -- raw indicators for drill-down
  institutional_birth_5y_pct,
  births_delivered_by_csection_5y_pct,
  breast_exam_pct,
  cervical_screen_pct,
  oral_cancer_exam_pct,
  health_insurance_pct
FROM virtue_foundation_dataset_cleaned.silver.nfhs_clean;
