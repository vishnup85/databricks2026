-- Gold: facility with resolved district/state via the pincode bridge
-- Falls back to the facility's own normalized state when pincode has no match.
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.gold.facility_geo AS
SELECT
  f.unique_id,
  f.name,
  f.facility_type,
  f.operator_type,
  f.num_doctors,
  f.capacity_beds,
  f.address_city,
  f.pincode,
  p.district_norm,
  coalesce(p.state_name, f.state_norm) AS state_name,
  f.state_norm AS facility_state_norm,
  f.latitude,
  f.longitude
FROM virtue_foundation_dataset_cleaned.silver.facilities_clean f
LEFT JOIN virtue_foundation_dataset_cleaned.silver.pincode_district p
  ON f.pincode = p.pincode;
