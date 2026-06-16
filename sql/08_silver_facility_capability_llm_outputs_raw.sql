-- Silver: raw landing table for normalized LLM review output.
-- Keep this append-only so every model/prompt run remains auditable.
-- Expected `parsed_json` shape:
-- {
--   "claim_hit": true,
--   "prose_hit": false,
--   "screening_only": false,
--   "capability_scope": "full_capability",
--   "supporting_snippets": [],
--   "confidence": 0.94,
--   "reasoning": "Short audit-friendly explanation."
-- }
CREATE TABLE IF NOT EXISTS virtue_foundation_dataset_cleaned.silver.facility_capability_llm_outputs_raw (
  unique_id STRING,
  capability STRING,
  evidence_fingerprint STRING,
  prompt_version STRING,
  model_name STRING,
  model_version STRING,
  run_id STRING,
  source_snapshot_ts TIMESTAMP,
  inference_ts TIMESTAMP,
  raw_response_json STRING,
  parsed_json STRING
)
USING DELTA;
