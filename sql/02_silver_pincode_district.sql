-- Silver: one district per pincode (avoids join fan-out)
-- Source: india_post_pincode_directory (many post offices per pincode)
-- Picks the most common district for each pincode.
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.silver.pincode_district AS
WITH ranked AS (
  SELECT
    pincode,
    upper(trim(district)) AS district_norm,
    initcap(trim(statename)) AS state_name,
    COUNT(*) AS office_count
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory
  GROUP BY pincode, upper(trim(district)), initcap(trim(statename))
)
SELECT pincode, district_norm, state_name
FROM ranked
QUALIFY ROW_NUMBER() OVER (PARTITION BY pincode ORDER BY office_count DESC) = 1;
