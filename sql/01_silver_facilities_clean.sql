-- Silver: cleaned, parsed, deduped facilities
-- Source: databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
-- Notes:
--   * JSON-array string columns are parsed to arrays
--   * pincode cast to bigint; state names normalized
--   * column-drift / blank rows filtered via valid facility_type
--   * deduped by cluster_id keeping the richest-source row
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.silver.facilities_clean AS
WITH base AS (
  SELECT
    unique_id,
    source_content_id,
    cluster_id,
    name,
    CASE WHEN facilityTypeId = 'farmacy' THEN 'pharmacy' ELSE facilityTypeId END AS facility_type,
    operatorTypeId AS operator_type,
    try_cast(numberDoctors AS int) AS num_doctors,
    try_cast(capacity AS int) AS capacity_beds,
    capability,
    specialties,
    procedure,
    equipment,
    description,
    from_json(capability, 'array<string>') AS capability_arr,
    from_json(specialties, 'array<string>') AS specialties_arr,
    from_json(procedure, 'array<string>') AS procedure_arr,
    from_json(equipment, 'array<string>') AS equipment_arr,
    officialWebsite AS official_website,
    from_json(websites, 'array<string>') AS websites_arr,
    facebookLink AS facebook_link,
    source,
    from_json(source_urls, 'array<string>') AS source_urls_arr,
    from_json(source_types, 'array<string>') AS source_types_arr,
    CASE WHEN source_urls IS NULL THEN 0 ELSE size(from_json(source_urls, 'array<string>')) END AS n_source_urls,
    (affiliated_staff_presence = 'true') AS staff_present,
    (custom_logo_presence = 'true') AS logo_present,
    try_cast(distinct_social_media_presence_count AS int) AS social_presence_count,
    recency_of_page_update,
    address_line1,
    address_line2,
    address_line3,
    address_city,
    address_stateOrRegion AS state_raw,
    CASE
      WHEN lower(trim(address_stateOrRegion)) IN ('tamilnadu', 'tamil nadu', 'chennai') THEN 'Tamil Nadu'
      WHEN lower(trim(address_stateOrRegion)) IN ('orissa', 'odisha') THEN 'Odisha'
      WHEN lower(trim(address_stateOrRegion)) IN ('thane', 'mumbai', 'navi mumbai', 'pune') THEN 'Maharashtra'
      WHEN lower(trim(address_stateOrRegion)) IN ('hyderabad') THEN 'Telangana'
      WHEN lower(trim(address_stateOrRegion)) IN ('thiruvananthapuram', 'malappuram') THEN 'Kerala'
      WHEN trim(address_stateOrRegion) IN ('', 'null') THEN NULL
      ELSE initcap(trim(address_stateOrRegion))
    END AS state_norm,
    try_cast(address_zipOrPostcode AS bigint) AS pincode,
    address_country,
    address_countryCode,
    latitude,
    longitude,
    lower(concat_ws(' ', coalesce(specialties, ''), coalesce(equipment, ''))) AS spec_eq_text,
    lower(coalesce(capability, '')) AS claim_text,
    lower(concat_ws(' ', coalesce(description, ''), coalesce(procedure, ''))) AS prose_text,
    lower(concat_ws(' ', coalesce(capability, ''), coalesce(specialties, ''), coalesce(procedure, ''), coalesce(equipment, ''), coalesce(description, ''))) AS full_text
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
  WHERE name IS NOT NULL
    AND facilityTypeId IN ('hospital', 'clinic', 'dentist', 'doctor', 'pharmacy', 'farmacy', 'nursing_home')
)
SELECT *
FROM base
QUALIFY ROW_NUMBER() OVER (PARTITION BY coalesce(cluster_id, unique_id) ORDER BY n_source_urls DESC NULLS LAST) = 1;
