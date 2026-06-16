-- @param unique_id STRING
-- All capability assessments + citations for one facility (drill-down view).
-- Joins silver for the raw evidence content (specialties / capabilities / equipment).
SELECT
  a.capability,
  a.tier,
  a.explanation,
  a.evidence_json,
  to_json(a.citation_urls) AS citation_urls_json,
  a.name,
  a.facility_type,
  a.district_norm,
  a.state_name,
  f.num_doctors,
  f.capacity_beds,
  to_json(f.specialties_arr) AS specialties_json,
  to_json(f.capability_arr) AS capabilities_json,
  to_json(f.equipment_arr) AS equipment_json
FROM virtue_foundation_dataset_cleaned.gold.facility_capability_assessment a
LEFT JOIN virtue_foundation_dataset_cleaned.silver.facilities_clean f
  ON a.unique_id = f.unique_id
WHERE a.unique_id = :unique_id
ORDER BY CASE a.tier WHEN 'strong' THEN 1 WHEN 'partial' THEN 2 WHEN 'weak_suspicious' THEN 3 ELSE 4 END;
