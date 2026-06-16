-- Gold: typed, auditable LLM signals joined back to every deterministic facility x capability row.
-- This table is optional enrichment only. It never assigns the final trust tier.
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.gold.facility_capability_llm_signals AS
WITH current_inputs AS (
  SELECT
    unique_id,
    capability,
    heuristic_tier,
    heuristic_score,
    heuristic_explanation,
    evidence_fingerprint
  FROM virtue_foundation_dataset_cleaned.silver.facility_capability_llm_inputs
),
latest_raw AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      PARTITION BY r.unique_id, r.capability
      ORDER BY r.inference_ts DESC NULLS LAST, r.source_snapshot_ts DESC NULLS LAST, r.prompt_version DESC NULLS LAST
    ) AS rn
  FROM virtue_foundation_dataset_cleaned.silver.facility_capability_llm_outputs_raw r
),
parsed_latest AS (
  SELECT
    unique_id,
    capability,
    evidence_fingerprint,
    prompt_version,
    model_name,
    model_version,
    run_id,
    source_snapshot_ts,
    inference_ts,
    CASE get_json_object(parsed_json, '$.claim_hit')
      WHEN 'true' THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS claim_hit_llm,
    CASE get_json_object(parsed_json, '$.prose_hit')
      WHEN 'true' THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS prose_hit_llm,
    CASE get_json_object(parsed_json, '$.screening_only')
      WHEN 'true' THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS screening_only_llm,
    nullif(get_json_object(parsed_json, '$.capability_scope'), '') AS capability_scope_llm,
    from_json(coalesce(get_json_object(parsed_json, '$.supporting_snippets'), '[]'), 'array<string>') AS supporting_snippets_llm,
    try_cast(get_json_object(parsed_json, '$.confidence') AS double) AS confidence_llm,
    nullif(get_json_object(parsed_json, '$.reasoning'), '') AS reasoning_llm
  FROM latest_raw
  WHERE rn = 1
)
SELECT
  i.unique_id,
  i.capability,
  i.heuristic_tier,
  i.heuristic_score,
  i.heuristic_explanation,
  i.evidence_fingerprint AS current_evidence_fingerprint,
  p.evidence_fingerprint AS reviewed_evidence_fingerprint,
  CASE
    WHEN p.unique_id IS NULL THEN false
    ELSE true
  END AS has_llm_review,
  CASE
    WHEN p.unique_id IS NULL THEN 'missing'
    WHEN p.evidence_fingerprint = i.evidence_fingerprint THEN 'current'
    ELSE 'stale'
  END AS llm_review_status,
  p.claim_hit_llm,
  p.prose_hit_llm,
  p.screening_only_llm,
  p.capability_scope_llm,
  p.supporting_snippets_llm,
  p.confidence_llm,
  p.reasoning_llm,
  p.prompt_version,
  p.model_name,
  p.model_version,
  p.run_id,
  p.source_snapshot_ts,
  p.inference_ts
FROM current_inputs i
LEFT JOIN parsed_latest p
  ON i.unique_id = p.unique_id
 AND i.capability = p.capability;
