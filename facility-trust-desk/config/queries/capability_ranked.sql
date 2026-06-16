-- @param capability STRING
-- @param state STRING
-- @param tier STRING
-- Ranked facilities for a capability + region + trust tier, best evidence first.
SELECT
  a.unique_id,
  a.name,
  a.facility_type,
  a.district_norm,
  a.state_name,
  a.tier,
  a.score,
  a.n_source_urls
FROM virtue_foundation_dataset_cleaned.gold.facility_capability_assessment a
WHERE a.capability = :capability
  AND (:state = 'All' OR a.state_name = :state)
  AND (
    (:tier = 'All' AND a.tier <> 'no_claim')
    OR (:tier <> 'All' AND a.tier = :tier)
  )
ORDER BY
  CASE a.tier WHEN 'strong' THEN 1 WHEN 'partial' THEN 2 WHEN 'weak_suspicious' THEN 3 ELSE 4 END,
  a.score DESC
LIMIT 200;
