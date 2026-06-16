-- Distinct states for the region filter
SELECT DISTINCT state_name
FROM virtue_foundation_dataset_cleaned.gold.facility_capability_assessment
WHERE state_name IS NOT NULL AND state_name <> ''
ORDER BY state_name;
