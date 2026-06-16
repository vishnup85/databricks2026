-- Gold serving mart: recompute the final deterministic tier/score using the heuristic baseline
-- plus any current LLM-reviewed sub-signals. The model never writes the final tier directly.
CREATE OR REPLACE TABLE virtue_foundation_dataset_cleaned.gold.facility_capability_assessment AS
WITH heuristic AS (
  SELECT
    a.*,
    CASE lower(coalesce(get_json_object(a.evidence_json, '$.recent_update'), 'false'))
      WHEN 'true' THEN true
      ELSE false
    END AS recent_update,
    nullif(get_json_object(a.evidence_json, '$.page_updated'), '') AS page_updated,
    CASE lower(coalesce(get_json_object(a.evidence_json, '$.capacity_supported'), ''))
      WHEN 'true' THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS capacity_supported,
    try_cast(get_json_object(a.evidence_json, '$.beds') AS int) AS beds_sane,
    try_cast(get_json_object(a.evidence_json, '$.num_doctors') AS int) AS docs_sane
  FROM virtue_foundation_dataset_cleaned.gold.facility_capability_assessment_heuristic a
),
effective AS (
  SELECT
    h.unique_id,
    h.capability,
    h.name,
    h.facility_type,
    h.operator_type,
    h.district_norm,
    h.state_name,
    h.latitude,
    h.longitude,
    h.structured_hit,
    h.well_corroborated,
    h.implausible,
    h.n_source_urls,
    h.official_website,
    h.staff_present,
    h.citation_urls,
    h.recent_update,
    h.page_updated,
    h.capacity_supported,
    h.beds_sane,
    h.docs_sane,
    h.tier AS heuristic_tier,
    h.score AS heuristic_score,
    h.explanation AS heuristic_explanation,
    h.evidence_json AS heuristic_evidence_json,
    h.claim_hit AS heuristic_claim_hit,
    h.prose_hit AS heuristic_prose_hit,
    h.screening_only AS heuristic_screening_only,
    coalesce(l.llm_review_status = 'current', false) AS current_llm_review,
    l.has_llm_review,
    l.llm_review_status,
    l.claim_hit_llm,
    l.prose_hit_llm,
    l.screening_only_llm,
    l.capability_scope_llm,
    l.supporting_snippets_llm,
    l.confidence_llm,
    l.reasoning_llm,
    l.prompt_version,
    l.model_name,
    l.model_version,
    l.run_id,
    l.source_snapshot_ts,
    l.inference_ts,
    CASE
      WHEN coalesce(l.llm_review_status = 'current', false) AND l.claim_hit_llm IS NOT NULL THEN l.claim_hit_llm
      ELSE h.claim_hit
    END AS claim_hit,
    CASE
      WHEN coalesce(l.llm_review_status = 'current', false) AND l.prose_hit_llm IS NOT NULL THEN l.prose_hit_llm
      ELSE h.prose_hit
    END AS prose_hit,
    CASE
      WHEN coalesce(l.llm_review_status = 'current', false)
           AND l.capability_scope_llm = 'screening_or_diagnostics_only' THEN true
      WHEN coalesce(l.llm_review_status = 'current', false) AND l.screening_only_llm IS NOT NULL THEN l.screening_only_llm
      ELSE h.screening_only
    END AS screening_only,
    CASE
      WHEN coalesce(l.llm_review_status = 'current', false) THEN l.capability_scope_llm
      ELSE NULL
    END AS capability_scope
  FROM heuristic h
  LEFT JOIN virtue_foundation_dataset_cleaned.gold.facility_capability_llm_signals l
    ON h.unique_id = l.unique_id
   AND h.capability = l.capability
),
rescored AS (
  SELECT
    *,
    CASE
      WHEN NOT (structured_hit OR claim_hit OR prose_hit) THEN 'no_claim'
      WHEN capability_scope = 'screening_or_diagnostics_only' THEN 'weak_suspicious'
      WHEN capability_scope = 'adjacent_service' THEN 'weak_suspicious'
      WHEN capability = 'oncology' AND screening_only AND NOT structured_hit THEN 'weak_suspicious'
      WHEN implausible THEN 'weak_suspicious'
      WHEN structured_hit AND well_corroborated THEN 'strong'
      WHEN structured_hit OR claim_hit THEN 'partial'
      WHEN prose_hit THEN 'weak_suspicious'
      ELSE 'no_claim'
    END AS tier
  FROM effective
)
SELECT
  r.unique_id,
  r.capability,
  r.name,
  r.facility_type,
  r.operator_type,
  r.district_norm,
  r.state_name,
  r.latitude,
  r.longitude,
  r.tier,
  CASE r.tier WHEN 'strong' THEN 90 WHEN 'partial' THEN 60 WHEN 'weak_suspicious' THEN 30 ELSE 0 END
    + least(coalesce(r.n_source_urls, 0), 10)
    + CASE WHEN r.recent_update THEN 10 ELSE 0 END AS score,
  CASE
    WHEN r.tier = 'no_claim' AND r.well_corroborated AND r.recent_update
      THEN 'No evidence of this capability in the facility data. The facility profile itself is well-sourced and recently updated, but none of those sources mention this capability.'
    WHEN r.tier = 'no_claim' AND r.well_corroborated
      THEN 'No evidence of this capability in the facility data. The facility profile itself is well-sourced, but none of those sources mention this capability.'
    WHEN r.tier = 'no_claim' AND r.recent_update
      THEN 'No evidence of this capability in the facility data. The facility has a recent public update, but that update still does not mention this capability.'
    WHEN r.tier = 'no_claim'
      THEN 'No evidence of this capability in the facility data.'
    WHEN r.capability_scope = 'screening_or_diagnostics_only'
      THEN concat('LLM review found only screening or diagnostic evidence for ', r.capability, ', so this is capped as weak/suspicious.')
    WHEN r.capability_scope = 'adjacent_service'
      THEN concat('LLM review found only adjacent-service evidence for ', r.capability, ', not the full capability, so this is capped as weak/suspicious.')
    WHEN r.capability = 'oncology' AND r.screening_only AND NOT r.structured_hit
      THEN 'Only cancer-screening language found, with no treatment evidence - capped as weak/suspicious.'
    WHEN r.implausible
      THEN concat('A ', r.facility_type, ' claiming ', r.capability, ' is implausible without hospital-level support, so this is flagged weak/suspicious.')
    WHEN r.structured_hit AND r.well_corroborated
      THEN concat('Listed in structured specialties/equipment and well-corroborated (', cast(r.n_source_urls AS string), ' sources, official website, affiliated staff).')
    WHEN r.structured_hit OR r.claim_hit
      THEN concat(
        'Found in ',
        concat_ws(
          ' and ',
          CASE WHEN r.structured_hit THEN 'structured specialties/equipment' END,
          CASE WHEN r.claim_hit THEN 'the facility''s own capability claims' END
        ),
        ', but corroboration is limited.'
      )
    WHEN r.prose_hit
      THEN 'Mentioned only in free-text description, with no structured backing.'
    ELSE 'No reliable evidence.'
  END AS explanation,
  r.structured_hit,
  r.claim_hit,
  r.prose_hit,
  r.screening_only,
  r.well_corroborated,
  r.implausible,
  r.n_source_urls,
  r.official_website,
  r.staff_present,
  to_json(named_struct(
    'structured_hit', r.structured_hit,
    'claim_hit', r.claim_hit,
    'prose_hit', r.prose_hit,
    'screening_only', r.screening_only,
    'well_corroborated', r.well_corroborated,
    'implausible', r.implausible,
    'n_source_urls', r.n_source_urls,
    'official_website', CASE WHEN lower(coalesce(r.official_website, '')) IN ('', 'null') THEN NULL ELSE r.official_website END,
    'recent_update', r.recent_update,
    'page_updated', r.page_updated,
    'capacity_supported', r.capacity_supported,
    'beds', r.beds_sane,
    'num_doctors', r.docs_sane,
    'capability_scope', r.capability_scope,
    'has_current_llm_review', r.current_llm_review,
    'llm_review_status', r.llm_review_status,
    'claim_hit_llm', r.claim_hit_llm,
    'prose_hit_llm', r.prose_hit_llm,
    'screening_only_llm', r.screening_only_llm,
    'supporting_snippets_llm', r.supporting_snippets_llm,
    'confidence_llm', r.confidence_llm,
    'reasoning_llm', r.reasoning_llm
  )) AS evidence_json,
  r.citation_urls,
  r.heuristic_tier,
  r.heuristic_score,
  r.heuristic_explanation,
  r.heuristic_evidence_json,
  r.heuristic_claim_hit,
  r.heuristic_prose_hit,
  r.heuristic_screening_only,
  r.current_llm_review,
  r.has_llm_review,
  r.llm_review_status,
  r.capability_scope,
  r.claim_hit_llm,
  r.prose_hit_llm,
  r.screening_only_llm,
  r.capability_scope_llm,
  r.supporting_snippets_llm,
  r.confidence_llm,
  r.reasoning_llm,
  r.prompt_version,
  r.model_name,
  r.model_version,
  r.run_id,
  r.source_snapshot_ts,
  r.inference_ts
FROM rescored r;
