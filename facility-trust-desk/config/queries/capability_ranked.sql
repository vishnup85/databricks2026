-- @param capability STRING
-- @param state STRING
-- Ranked facilities for a capability + region, best evidence first.
-- need_score = district-level NFHS unmet-need signal (only meaningful for
-- maternity / nicu / oncology; null for capabilities NFHS doesn't cover).
SELECT
  a.unique_id,
  a.name,
  a.facility_type,
  a.district_norm,
  a.state_name,
  a.tier,
  a.score,
  a.n_source_urls,
  CASE :capability
    WHEN 'maternity' THEN n.maternity_need
    WHEN 'nicu' THEN n.maternity_need
    WHEN 'oncology' THEN n.oncology_screening_gap
    ELSE NULL
  END AS need_score
FROM virtue_foundation_dataset_cleaned.gold.facility_capability_assessment a
LEFT JOIN (
  -- one row per district to avoid join fan-out
  SELECT district_norm,
         max(maternity_need) AS maternity_need,
         max(oncology_screening_gap) AS oncology_screening_gap
  FROM virtue_foundation_dataset_cleaned.gold.district_need_index
  GROUP BY district_norm
) n ON a.district_norm = n.district_norm
WHERE a.capability = :capability
  AND a.tier <> 'no_claim'
  AND (:state = 'All' OR a.state_name = :state)
ORDER BY
  CASE a.tier WHEN 'strong' THEN 1 WHEN 'partial' THEN 2 WHEN 'weak_suspicious' THEN 3 ELSE 4 END,
  a.score DESC
LIMIT 200;
