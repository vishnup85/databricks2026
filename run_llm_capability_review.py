#!/usr/bin/env python3
"""
Run prompt-based LLM review for facility capability rows and append results to the raw silver table.

This script intentionally keeps the final trust tier deterministic. It fills the LLM sidecar
tables introduced in scripts 07-09 and can refresh the final serving mart in script 10.

It uses Databricks SQL for the read/write path:
1. Read prompt-ready rows from silver.facility_capability_llm_inputs
2. Call a configured LLM provider (Databricks serving endpoint or OpenAI Responses API)
3. Append normalized output rows into silver.facility_capability_llm_outputs_raw

Example:
    python run_llm_capability_review.py \
        --profile default \
        --endpoint my-chat-endpoint \
        --capability icu \
        --limit 25 \
        --refresh-gold

    python run_llm_capability_review.py \
        --profile default \
        --endpoint my-chat-endpoint \
        --all-pending \
        --limit 100 \
        --refresh-gold
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from pydantic import BaseModel, ConfigDict, Field
from string import Template
from typing import Any, Literal


INPUT_TABLE = "virtue_foundation_dataset_cleaned.silver.facility_capability_llm_inputs"
OUTPUT_TABLE = "virtue_foundation_dataset_cleaned.silver.facility_capability_llm_outputs_raw"
REFRESH_SQL_FILES = [
    Path("sql/09_gold_facility_capability_llm_signals.sql"),
    Path("sql/10_gold_facility_capability_assessment.sql"),
]
DEFAULT_SYSTEM_PROMPT = Path("prompts/facility_capability_signal_system_v1.txt")
DEFAULT_ROW_USER_PROMPT = Path("prompts/facility_capability_signal_user_v1.txt")
DEFAULT_FACILITY_USER_PROMPT = Path("prompts/facility_capability_signal_user_batch_v2.txt")
DEFAULT_PROMPT_VERSION = "facility_capability_signal_batch_v2"
DEFAULT_FAILURE_LOG = Path("llm_review_failures.jsonl")
TRANSIENT_HTTP_STATUS_CODES = {429, 500, 502, 503, 504, 520}
JSON_REPAIR_SYSTEM_PROMPT = (
    "You convert model output into one valid JSON object. "
    "Return json only, with no markdown and no extra text."
)
JSON_REPAIR_USER_PROMPT = """The previous model output was not valid JSON for the required schema.

Return exactly one JSON object with these keys:
{
  "claim_hit": true,
  "prose_hit": false,
  "screening_only": false,
  "capability_scope": "full_capability",
  "supporting_snippets": [],
  "confidence": 0.94,
  "reasoning": "Short audit-friendly explanation."
}

Use only the information already present in this prior output. If the prior output is insufficient,
set fields to false or null rather than guessing.

Prior output:
$prior_output
"""
BATCH_JSON_REPAIR_USER_PROMPT = """The previous model output was not valid JSON for the required schema.

Return exactly one JSON object with this structure:
{
  "results": [
    {
      "capability": "icu",
      "claim_hit": true,
      "prose_hit": false,
      "screening_only": false,
      "capability_scope": "full_capability",
      "supporting_snippets": [],
      "confidence": 0.94,
      "reasoning": "Short audit-friendly explanation."
    }
  ]
}

Return exactly one result object for each capability in this list:
$capabilities_json

Use only the information already present in this prior output. If the prior output is insufficient,
set fields to false or null rather than guessing. Do not omit requested capabilities.

Prior output:
$prior_output
"""


@dataclass
class InputRow:
    unique_id: str
    capability: str
    facility_name: str
    evidence_fingerprint: str
    source_snapshot_ts: str | None
    llm_input_json: str


@dataclass
class OutputRow:
    unique_id: str
    capability: str
    evidence_fingerprint: str
    prompt_version: str
    model_name: str
    model_version: str | None
    run_id: str
    source_snapshot_ts: str | None
    inference_ts: str
    raw_response_json: str
    parsed_json: str


@dataclass
class DatabricksAuthContext:
    host: str
    access_token: str


@dataclass
class OpenAIAuthContext:
    api_key: str
    base_url: str


class CapabilitySignalModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_hit: bool | None = None
    prose_hit: bool | None = None
    screening_only: bool | None = None
    capability_scope: Literal[
        "full_capability",
        "adjacent_service",
        "screening_or_diagnostics_only",
        "unclear",
    ] | None = None
    supporting_snippets: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    reasoning: str | None = None


class CapabilityBatchItemModel(CapabilitySignalModel):
    capability: str


class CapabilityBatchResponseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[CapabilityBatchItemModel]


class RequestPacer:
    def __init__(self, min_interval_seconds: float) -> None:
        self.min_interval_seconds = max(min_interval_seconds, 0.0)
        self._lock = threading.Lock()
        self._next_start_monotonic = 0.0

    def wait_for_turn(self) -> None:
        if self.min_interval_seconds <= 0:
            return

        with self._lock:
            now = time.monotonic()
            start_at = max(now, self._next_start_monotonic)
            self._next_start_monotonic = start_at + self.min_interval_seconds

        delay = start_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)


@dataclass
class FacilityBatch:
    unique_id: str
    facility_name: str
    rows: list[InputRow]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run LLM review for facility capability input rows."
    )
    parser.add_argument(
        "--profile",
        default="default",
        help="Databricks CLI profile to use. Default: default",
    )
    parser.add_argument(
        "--provider",
        choices=("databricks", "openai"),
        default="databricks",
        help="LLM provider to call. Default: databricks",
    )
    parser.add_argument(
        "--endpoint",
        help="Chat-capable Databricks serving endpoint name. Required when --provider databricks.",
    )
    parser.add_argument(
        "--openai-model",
        default="gpt-5.4-mini",
        help="OpenAI model name used when --provider openai. Default: gpt-5.4-mini",
    )
    parser.add_argument(
        "--openai-api-key-env",
        default="OPENAI_API_KEY",
        help="Environment variable holding the OpenAI API key. Default: OPENAI_API_KEY",
    )
    parser.add_argument(
        "--openai-base-url",
        help=(
            "Optional OpenAI API base URL override. Defaults to OPENAI_BASE_URL or "
            "https://api.openai.com/v1"
        ),
    )
    parser.add_argument(
        "--openai-reasoning-effort",
        choices=("low", "medium", "high", "xhigh"),
        default="low",
        help="Reasoning effort for OpenAI Responses API. Default: low",
    )
    parser.add_argument(
        "--openai-text-verbosity",
        choices=("low", "medium", "high"),
        default="low",
        help="Text verbosity for OpenAI Responses API. Default: low",
    )
    parser.add_argument(
        "--mode",
        choices=("facility", "row"),
        default="facility",
        help=(
            "Review mode. `facility` sends one LLM request per facility and returns all matching "
            "capabilities together. `row` keeps one request per facility-capability row. "
            "Default: facility"
        ),
    )
    parser.add_argument(
        "--capability",
        help="Optional capability filter, for example icu or oncology.",
    )
    parser.add_argument(
        "--unique-id",
        help="Optional facility unique_id filter.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=25,
        help=(
            "Maximum facilities per batch in `facility` mode, or rows per batch in `row` mode. "
            "Default: 25. With --all-pending, this is the batch size."
        ),
    )
    parser.add_argument(
        "--all-pending",
        action="store_true",
        help=(
            "Keep fetching and processing pending rows until none remain. "
            "Without this flag, the script processes only one batch."
        ),
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Model temperature for Databricks serving only. Default: 0.0",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=420,
        help="Maximum output tokens. Default: 420",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.0,
        help="Optional pause between endpoint calls. Default: 0",
    )
    parser.add_argument(
        "--min-start-interval-seconds",
        type=float,
        default=0.5,
        help=(
            "Minimum delay between starting provider requests across all threads. "
            "Helps avoid QPS spikes. Default: 0.5"
        ),
    )
    parser.add_argument(
        "--write-batch-size",
        type=int,
        default=120,
        help="How many output rows to append per INSERT. Default: 120",
    )
    parser.add_argument(
        "--parallelism",
        type=int,
        default=8,
        help=(
            "How many LLM requests to run concurrently per batch. In `facility` mode this is "
            "facility requests, not individual capability rows. Default: 8"
        ),
    )
    parser.add_argument(
        "--prompt-version",
        default=DEFAULT_PROMPT_VERSION,
        help=f"Version string recorded in output rows. Default: {DEFAULT_PROMPT_VERSION}",
    )
    parser.add_argument(
        "--system-prompt-file",
        default=str(DEFAULT_SYSTEM_PROMPT),
        help=f"System prompt path. Default: {DEFAULT_SYSTEM_PROMPT.as_posix()}",
    )
    parser.add_argument(
        "--user-prompt-file",
        help=(
            "Optional user prompt path. Defaults depend on mode: "
            f"`{DEFAULT_FACILITY_USER_PROMPT.as_posix()}` for facility mode and "
            f"`{DEFAULT_ROW_USER_PROMPT.as_posix()}` for row mode."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Process matching rows even if this prompt_version already has a current review.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Render the first prompt and exit without calling the model or writing results.",
    )
    parser.add_argument(
        "--refresh-gold",
        action="store_true",
        help="Rebuild gold.facility_capability_llm_signals and gold.facility_capability_assessment after writing output rows.",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop the run immediately on the first row-level failure.",
    )
    parser.add_argument(
        "--failure-log-file",
        default=str(DEFAULT_FAILURE_LOG),
        help=f"JSONL file for row-level failures. Default: {DEFAULT_FAILURE_LOG.as_posix()}",
    )
    return parser.parse_args()


def run_cli(command: list[str]) -> str:
    env = os.environ.copy()
    # Local Databricks CLI calls in this workspace can fail if stale proxy variables are set.
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        env[key] = ""

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "Unknown CLI error"
        raise RuntimeError(message)
    return completed.stdout


def validate_args(args: argparse.Namespace) -> None:
    if args.provider == "databricks" and not args.endpoint:
        raise RuntimeError("--endpoint is required when --provider databricks.")


def run_sql(profile: str, sql: str) -> Any:
    sql_path = _write_temp_text(sql, suffix=".sql")
    try:
        output = run_cli(
            [
                "databricks",
                "experimental",
                "aitools",
                "tools",
                "query",
                "--file",
                sql_path,
                "--output",
                "json",
                "--profile",
                profile,
            ]
        )
    finally:
        Path(sql_path).unlink(missing_ok=True)

    return json.loads(output) if output.strip() else {}


def run_serving_query(
    auth: DatabricksAuthContext,
    endpoint: str,
    body: dict[str, Any],
    *,
    temperature: float,
    max_tokens: int,
    client_request_id: str,
) -> dict[str, Any]:
    request_body = dict(body)
    request_body["client_request_id"] = client_request_id
    request_body["temperature"] = temperature
    request_body["max_tokens"] = max_tokens

    url = (
        auth.host.rstrip("/")
        + "/serving-endpoints/"
        + urllib.parse.quote(endpoint, safe="")
        + "/invocations"
    )
    payload = json.dumps(request_body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {auth.access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    max_attempts = 6
    attempt = 0
    last_error: Exception | None = None

    while attempt < max_attempts:
        attempt += 1
        try:
            with opener.open(request, timeout=120) as response:
                response_text = response.read().decode("utf-8", errors="replace")
            return json.loads(response_text)
        except urllib.error.HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"Serving endpoint HTTP {exc.code}: {error_text}")
            if exc.code not in TRANSIENT_HTTP_STATUS_CODES or attempt >= max_attempts:
                raise last_error from exc

            retry_after = exc.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                sleep_seconds = max(int(retry_after), 1)
            else:
                sleep_seconds = min(30, 2 ** (attempt - 1))
            print(
                f"Serving endpoint transient HTTP {exc.code}; retrying in {sleep_seconds}s "
                f"(attempt {attempt}/{max_attempts})...",
                file=sys.stderr,
            )
            time.sleep(sleep_seconds)
        except urllib.error.URLError as exc:
            last_error = RuntimeError(f"Serving endpoint request failed: {exc.reason}")
            if attempt >= max_attempts:
                raise last_error from exc
            sleep_seconds = min(30, 2 ** (attempt - 1))
            print(
                f"Serving endpoint transport error; retrying in {sleep_seconds}s "
                f"(attempt {attempt}/{max_attempts})...",
                file=sys.stderr,
            )
            time.sleep(sleep_seconds)

    if last_error is not None:
        raise last_error
    raise RuntimeError("Serving endpoint request failed without a response.")


def run_openai_responses_query(
    auth: OpenAIAuthContext,
    model: str,
    body: dict[str, Any],
    *,
    temperature: float,
    max_tokens: int,
    client_request_id: str,
    reasoning_effort: str,
    text_verbosity: str,
) -> dict[str, Any]:
    request_body = dict(body)
    request_body["model"] = model
    request_body["max_output_tokens"] = max_tokens
    request_body["reasoning"] = {"effort": reasoning_effort}
    request_body["text"] = dict(request_body.get("text", {}))
    request_body["text"]["verbosity"] = text_verbosity

    url = auth.base_url + "/responses"
    payload = json.dumps(request_body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {auth.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Stainless-Client-Request-Id": client_request_id,
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    max_attempts = 6
    attempt = 0
    last_error: Exception | None = None

    while attempt < max_attempts:
        attempt += 1
        try:
            with opener.open(request, timeout=120) as response:
                response_text = response.read().decode("utf-8", errors="replace")
            return json.loads(response_text)
        except urllib.error.HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"OpenAI Responses API HTTP {exc.code}: {error_text}")
            retryable = exc.code in TRANSIENT_HTTP_STATUS_CODES
            body_retry_after: int | None = None
            try:
                error_payload = json.loads(error_text)
                if isinstance(error_payload, dict):
                    if isinstance(error_payload.get("retryable"), bool):
                        retryable = retryable or error_payload["retryable"]
                    retry_after_value = error_payload.get("retry_after")
                    if isinstance(retry_after_value, (int, float)):
                        body_retry_after = max(int(retry_after_value), 1)
            except json.JSONDecodeError:
                pass

            if not retryable or attempt >= max_attempts:
                raise last_error from exc

            retry_after = exc.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                sleep_seconds = max(int(retry_after), 1)
            elif body_retry_after is not None:
                sleep_seconds = body_retry_after
            else:
                sleep_seconds = min(30, 2 ** (attempt - 1))
            print(
                f"OpenAI transient HTTP {exc.code}; retrying in {sleep_seconds}s "
                f"(attempt {attempt}/{max_attempts})...",
                file=sys.stderr,
            )
            time.sleep(sleep_seconds)
        except urllib.error.URLError as exc:
            last_error = RuntimeError(f"OpenAI request failed: {exc.reason}")
            if attempt >= max_attempts:
                raise last_error from exc
            sleep_seconds = min(30, 2 ** (attempt - 1))
            print(
                f"OpenAI transport error; retrying in {sleep_seconds}s "
                f"(attempt {attempt}/{max_attempts})...",
                file=sys.stderr,
            )
            time.sleep(sleep_seconds)

    if last_error is not None:
        raise last_error
    raise RuntimeError("OpenAI request failed without a response.")


def _write_temp_text(content: str, *, suffix: str) -> str:
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        errors="replace",
        suffix=suffix,
        delete=False,
    )
    try:
        handle.write(content)
        return handle.name
    finally:
        handle.close()


def extract_rows(payload: Any, required_fields: set[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if required_fields.issubset(node.keys()):
                rows.append(node)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    return rows


def sql_quote(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def sql_timestamp(value: str | None) -> str:
    if not value:
        return "NULL"
    return f"to_timestamp({sql_quote(value)})"


def build_input_query(args: argparse.Namespace) -> str:
    filters = ["1 = 1"]
    if args.capability:
        filters.append(f"capability = {sql_quote(args.capability)}")
    if args.unique_id:
        filters.append(f"unique_id = {sql_quote(args.unique_id)}")

    base_where = " AND ".join(filters)
    limit = max(args.limit, 1)

    latest_for_prompt_cte = f"""
    latest_for_prompt AS (
      SELECT
        unique_id,
        capability,
        evidence_fingerprint,
        ROW_NUMBER() OVER (
          PARTITION BY unique_id, capability
          ORDER BY inference_ts DESC NULLS LAST, source_snapshot_ts DESC NULLS LAST
        ) AS rn
      FROM {OUTPUT_TABLE}
      WHERE prompt_version = {sql_quote(args.prompt_version)}
    )
    """

    row_select = """
      SELECT
        unique_id,
        capability,
        name AS facility_name,
        evidence_fingerprint,
        date_format(input_snapshot_ts, 'yyyy-MM-dd HH:mm:ss') AS source_snapshot_ts,
        llm_input_json
      FROM {input_table}
      WHERE {base_where}
    """.format(input_table=INPUT_TABLE, base_where=base_where)

    if args.force:
        filtered_rows_cte = f"""
        filtered_rows AS (
          {row_select}
        )
        """
    else:
        filtered_rows_cte = f"""
        filtered_rows AS (
          SELECT
            i.unique_id,
            i.capability,
            i.facility_name,
            i.evidence_fingerprint,
            i.source_snapshot_ts,
            i.llm_input_json
          FROM (
            {row_select}
          ) i
          LEFT JOIN latest_for_prompt r
            ON i.unique_id = r.unique_id
           AND i.capability = r.capability
           AND r.rn = 1
          WHERE r.evidence_fingerprint IS NULL OR r.evidence_fingerprint <> i.evidence_fingerprint
        )
        """

    if args.mode == "row":
        ctes = [filtered_rows_cte] if args.force else [latest_for_prompt_cte, filtered_rows_cte]
        cte_sql = ",\n".join(ctes)
        return f"""
        WITH
        {cte_sql}
        SELECT
          unique_id,
          capability,
          facility_name,
          evidence_fingerprint,
          source_snapshot_ts,
          llm_input_json
        FROM filtered_rows
        ORDER BY capability, unique_id
        LIMIT {limit}
        """

    ctes = [filtered_rows_cte] if args.force else [latest_for_prompt_cte, filtered_rows_cte]
    ctes.append(
        f"""
        selected_facilities AS (
          SELECT unique_id
          FROM filtered_rows
          GROUP BY unique_id
          ORDER BY unique_id
          LIMIT {limit}
        )
        """
    )
    cte_sql = ",\n".join(ctes)
    return f"""
    WITH
    {cte_sql}
    SELECT
      r.unique_id,
      r.capability,
      r.facility_name,
      r.evidence_fingerprint,
      r.source_snapshot_ts,
      r.llm_input_json
    FROM filtered_rows r
    INNER JOIN selected_facilities s
      ON r.unique_id = s.unique_id
    ORDER BY r.unique_id, r.capability
    """


def load_input_rows(profile: str, args: argparse.Namespace) -> list[InputRow]:
    payload = run_sql(profile, build_input_query(args))
    rows = extract_rows(
        payload,
        {
            "unique_id",
            "capability",
            "facility_name",
            "evidence_fingerprint",
            "source_snapshot_ts",
            "llm_input_json",
        },
    )

    return [
        InputRow(
            unique_id=str(row["unique_id"]),
            capability=str(row["capability"]),
            facility_name=str(row["facility_name"]),
            evidence_fingerprint=str(row["evidence_fingerprint"]),
            source_snapshot_ts=(
                None if row.get("source_snapshot_ts") in (None, "", "null") else str(row["source_snapshot_ts"])
            ),
            llm_input_json=str(row["llm_input_json"]),
        )
        for row in rows
    ]


def load_prompt_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def build_response_format(name: str, model_type: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "schema": model_type.model_json_schema(),
        },
    }


def normalize_schema_for_openai_strict(schema: Any) -> Any:
    if isinstance(schema, dict):
        # Defaults are not needed for generation and can make strict schemas noisier.
        schema.pop("default", None)

        if "$defs" in schema and isinstance(schema["$defs"], dict):
            for key, value in list(schema["$defs"].items()):
                schema["$defs"][key] = normalize_schema_for_openai_strict(value)

        if "definitions" in schema and isinstance(schema["definitions"], dict):
            for key, value in list(schema["definitions"].items()):
                schema["definitions"][key] = normalize_schema_for_openai_strict(value)

        if "properties" in schema and isinstance(schema["properties"], dict):
            normalized_properties: dict[str, Any] = {}
            for key, value in schema["properties"].items():
                normalized_properties[key] = normalize_schema_for_openai_strict(value)
            schema["properties"] = normalized_properties
            schema["required"] = list(normalized_properties.keys())
            schema["additionalProperties"] = False

        if "items" in schema:
            schema["items"] = normalize_schema_for_openai_strict(schema["items"])

        for key in ("anyOf", "oneOf", "allOf"):
            if key in schema and isinstance(schema[key], list):
                schema[key] = [normalize_schema_for_openai_strict(item) for item in schema[key]]

    elif isinstance(schema, list):
        return [normalize_schema_for_openai_strict(item) for item in schema]

    return schema


def build_openai_text_format(name: str, model_type: type[BaseModel]) -> dict[str, Any]:
    strict_schema = normalize_schema_for_openai_strict(model_type.model_json_schema())
    return {
        "type": "json_schema",
        "name": name,
        "schema": strict_schema,
        "strict": True,
    }


def resolve_user_prompt_path(args: argparse.Namespace) -> str:
    if args.user_prompt_file:
        return args.user_prompt_file
    if args.mode == "facility":
        return str(DEFAULT_FACILITY_USER_PROMPT)
    return str(DEFAULT_ROW_USER_PROMPT)


def get_databricks_auth_context(profile: str) -> DatabricksAuthContext:
    describe_payload = json.loads(
        run_cli(
            [
                "databricks",
                "auth",
                "describe",
                "--profile",
                profile,
                "-o",
                "json",
            ]
        )
    )
    token_payload = json.loads(
        run_cli(
            [
                "databricks",
                "auth",
                "token",
                profile,
                "-o",
                "json",
            ]
        )
    )

    host = (
        describe_payload.get("details", {})
        .get("configuration", {})
        .get("host", {})
        .get("value")
    )
    token = token_payload.get("access_token")
    if not host or not token:
        raise RuntimeError("Could not resolve Databricks host or access token for serving call.")

    return DatabricksAuthContext(host=host, access_token=token)


def get_openai_auth_context(args: argparse.Namespace) -> OpenAIAuthContext:
    api_key = os.environ.get(args.openai_api_key_env)
    if not api_key:
        raise RuntimeError(
            f"OpenAI API key not found in environment variable {args.openai_api_key_env}."
        )

    base_url = (
        args.openai_base_url
        or os.environ.get("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    )
    return OpenAIAuthContext(api_key=api_key, base_url=base_url.rstrip("/"))


def resolve_provider_target(args: argparse.Namespace) -> str:
    if args.provider == "openai":
        return args.openai_model
    if not args.endpoint:
        raise RuntimeError("Databricks endpoint was not provided.")
    return args.endpoint


def render_user_prompt(template_text: str, row: InputRow, *, pretty_json: bool = False) -> str:
    try:
        parsed_input = json.loads(row.llm_input_json)
        if pretty_json:
            prompt_input = json.dumps(parsed_input, indent=2, ensure_ascii=False)
        else:
            prompt_input = json.dumps(parsed_input, ensure_ascii=False, separators=(",", ":"))
    except json.JSONDecodeError:
        prompt_input = row.llm_input_json

    return Template(template_text).substitute(
        facility_name=row.facility_name,
        unique_id=row.unique_id,
        capability=row.capability,
        llm_input_json=prompt_input,
    )


def compact_mapping(source: Any, allowed_keys: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(source, dict):
        return {}

    compact: dict[str, Any] = {}
    for key in allowed_keys:
        if key not in source:
            continue
        value = source[key]
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        compact[key] = value
    return compact


def group_rows_by_facility(rows: list[InputRow]) -> list[FacilityBatch]:
    grouped: dict[str, FacilityBatch] = {}
    ordered_ids: list[str] = []

    for row in rows:
        batch = grouped.get(row.unique_id)
        if batch is None:
            batch = FacilityBatch(
                unique_id=row.unique_id,
                facility_name=row.facility_name,
                rows=[],
            )
            grouped[row.unique_id] = batch
            ordered_ids.append(row.unique_id)
        batch.rows.append(row)

    for unique_id in ordered_ids:
        grouped[unique_id].rows.sort(key=lambda item: item.capability)

    return [grouped[unique_id] for unique_id in ordered_ids]


def build_facility_batch_payload(batch: FacilityBatch) -> dict[str, Any]:
    first_payload = json.loads(batch.rows[0].llm_input_json)
    if not isinstance(first_payload, dict):
        first_row = batch.rows[0]
        raise RuntimeError(
            f"Input JSON for {first_row.unique_id}/{first_row.capability} was not a JSON object."
        )

    facility = compact_mapping(
        first_payload.get("facility"),
        (
            "unique_id",
            "name",
            "facility_type",
            "operator_type",
            "district_norm",
            "state_name",
            "address_city",
            "pincode",
            "num_doctors",
            "capacity_beds",
        ),
    )
    shared_evidence = compact_mapping(
        first_payload.get("source_evidence"),
        (
            "capability_claims",
            "specialties",
            "procedures",
            "equipment",
            "description",
            "source_types",
            "n_source_urls",
            "official_website",
            "staff_present",
        ),
    )

    return {
        "facility": facility,
        "requested_capabilities": [row.capability for row in batch.rows],
        "shared_source_evidence": shared_evidence,
    }


def render_facility_batch_prompt(
    template_text: str,
    batch: FacilityBatch,
    *,
    pretty_json: bool = False,
) -> str:
    payload = build_facility_batch_payload(batch)
    if pretty_json:
        prompt_input = json.dumps(payload, indent=2, ensure_ascii=False)
    else:
        prompt_input = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    capabilities = ", ".join(row.capability for row in batch.rows)
    return Template(template_text).substitute(
        facility_name=batch.facility_name,
        unique_id=batch.unique_id,
        capability_count=str(len(batch.rows)),
        capabilities=capabilities,
        llm_input_json=prompt_input,
    )


def call_provider_json(
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    *,
    system_prompt: str,
    user_prompt: str,
    schema_name: str,
    schema_model: type[BaseModel],
    client_request_id: str,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    target = resolve_provider_target(args)
    request_temperature = args.temperature if temperature is None else temperature
    request_max_tokens = args.max_tokens if max_tokens is None else max_tokens
    if args.provider == "openai":
        return run_openai_responses_query(
            auth,
            target,
            {
                "instructions": system_prompt,
                "input": user_prompt,
                "text": {
                    "format": build_openai_text_format(schema_name, schema_model),
                },
            },
            temperature=request_temperature,
            max_tokens=request_max_tokens,
            client_request_id=client_request_id,
            reasoning_effort=args.openai_reasoning_effort,
            text_verbosity=args.openai_text_verbosity,
        )

    return run_serving_query(
        auth,
        target,
        {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": build_response_format(schema_name, schema_model),
        },
        temperature=request_temperature,
        max_tokens=request_max_tokens,
        client_request_id=client_request_id,
    )


def extract_assistant_text(payload: Any) -> str:
    def content_to_text(content: Any) -> str | None:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts: list[str] = []
            fallback_parts: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                if isinstance(item.get("text"), str):
                    if item.get("type") == "text":
                        text_parts.append(item["text"])
                    else:
                        fallback_parts.append(item["text"])
                summaries = item.get("summary")
                if isinstance(summaries, list):
                    for summary in summaries:
                        if isinstance(summary, dict) and isinstance(summary.get("text"), str):
                            fallback_parts.append(summary["text"])
            combined = "".join(text_parts) or "\n".join(fallback_parts)
            return combined or None
        return None

    if isinstance(payload, dict):
        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            first_choice = choices[0]
            if isinstance(first_choice, dict):
                message = first_choice.get("message")
                if isinstance(message, dict):
                    content_text = content_to_text(message.get("content"))
                    if content_text:
                        return content_text
                if isinstance(first_choice.get("text"), str):
                    return first_choice["text"]

        outputs = payload.get("output")
        if isinstance(outputs, list):
            for item in outputs:
                if not isinstance(item, dict):
                    continue
                content_text = content_to_text(item.get("content"))
                if content_text:
                    return content_text
                if isinstance(item.get("text"), str):
                    return item["text"]

        predictions = payload.get("predictions")
        if isinstance(predictions, list) and predictions:
            first_prediction = predictions[0]
            if isinstance(first_prediction, str):
                return first_prediction
            if isinstance(first_prediction, dict):
                if isinstance(first_prediction.get("content"), str):
                    return first_prediction["content"]
                if isinstance(first_prediction.get("text"), str):
                    return first_prediction["text"]

        for key in ("output_text", "response", "result", "text", "content"):
            value = payload.get(key)
            if isinstance(value, str):
                return value

    raise RuntimeError("Could not find assistant text in serving endpoint response.")


def strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return stripped


def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = strip_code_fences(text)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise RuntimeError("Model response did not contain a JSON object.") from None
        payload = json.loads(cleaned[start : end + 1])

    if not isinstance(payload, dict):
        raise RuntimeError("Model response JSON must be an object.")
    return payload


def coerce_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def coerce_snippets(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    snippets: list[str] = []
    for item in value:
        text = coerce_str(item)
        if text:
            snippets.append(text)
    return snippets[:5]


def normalize_parsed_json(payload: dict[str, Any]) -> dict[str, Any]:
    model = CapabilitySignalModel.model_validate(payload)
    normalized = model.model_dump(mode="json")
    normalized["supporting_snippets"] = coerce_snippets(normalized.get("supporting_snippets"))
    return normalized


def repair_json_response(
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    prior_output: str,
    *,
    client_request_id: str,
) -> dict[str, Any]:
    repair_prompt = Template(JSON_REPAIR_USER_PROMPT).substitute(prior_output=prior_output)
    raw_response = call_provider_json(
        args,
        auth,
        system_prompt=JSON_REPAIR_SYSTEM_PROMPT,
        user_prompt=repair_prompt,
        schema_name="facility_capability_signal_single_repair",
        schema_model=CapabilitySignalModel,
        client_request_id=client_request_id,
        temperature=0.0,
        max_tokens=300,
    )
    assistant_text = extract_assistant_text(raw_response)
    return extract_json_object(assistant_text)


def parse_llm_payload_with_repair(
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    raw_response: dict[str, Any],
    *,
    client_request_id: str,
) -> dict[str, Any]:
    repair_source = json.dumps(raw_response, ensure_ascii=False)
    try:
        assistant_text = extract_assistant_text(raw_response)
        repair_source = assistant_text
        return extract_json_object(assistant_text)
    except Exception:
        return repair_json_response(
            args,
            auth,
            repair_source,
            client_request_id=f"{client_request_id}:repair",
        )


def normalize_batch_parsed_json(
    payload: dict[str, Any],
    expected_capabilities: list[str],
) -> dict[str, dict[str, Any]]:
    batch_model = CapabilityBatchResponseModel.model_validate(payload)
    results = batch_model.results
    normalized: dict[str, dict[str, Any]] = {}
    for item in results:
        capability = coerce_str(item.capability)
        if not capability:
            continue
        item_payload = item.model_dump(mode="json")
        item_payload.pop("capability", None)
        normalized[capability.lower()] = normalize_parsed_json(item_payload)

    expected = {capability.lower() for capability in expected_capabilities}
    missing = sorted(expected.difference(normalized))
    if missing:
        raise RuntimeError(
            "Batch response omitted requested capabilities: " + ", ".join(missing)
        )

    return normalized


def repair_batch_json_response(
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    prior_output: str,
    *,
    expected_capabilities: list[str],
    client_request_id: str,
) -> dict[str, Any]:
    repair_prompt = Template(BATCH_JSON_REPAIR_USER_PROMPT).substitute(
        capabilities_json=json.dumps(expected_capabilities, ensure_ascii=False),
        prior_output=prior_output,
    )
    raw_response = call_provider_json(
        args,
        auth,
        system_prompt=JSON_REPAIR_SYSTEM_PROMPT,
        user_prompt=repair_prompt,
        schema_name="facility_capability_signal_batch_repair",
        schema_model=CapabilityBatchResponseModel,
        client_request_id=client_request_id,
        temperature=0.0,
        max_tokens=600,
    )
    assistant_text = extract_assistant_text(raw_response)
    return extract_json_object(assistant_text)


def parse_batch_llm_payload_with_repair(
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    raw_response: dict[str, Any],
    *,
    expected_capabilities: list[str],
    client_request_id: str,
) -> dict[str, dict[str, Any]]:
    repair_source = json.dumps(raw_response, ensure_ascii=False)
    try:
        assistant_text = extract_assistant_text(raw_response)
        repair_source = assistant_text
        payload = extract_json_object(assistant_text)
        return normalize_batch_parsed_json(payload, expected_capabilities)
    except Exception:
        repaired_payload = repair_batch_json_response(
            args,
            auth,
            repair_source,
            expected_capabilities=expected_capabilities,
            client_request_id=f"{client_request_id}:repair",
        )
        return normalize_batch_parsed_json(repaired_payload, expected_capabilities)


def find_first_by_key(node: Any, keys: tuple[str, ...]) -> str | None:
    if isinstance(node, dict):
        for key in keys:
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in node.values():
            found = find_first_by_key(value, keys)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = find_first_by_key(item, keys)
            if found:
                return found
    return None


def build_output_row(
    row: InputRow,
    *,
    endpoint: str,
    prompt_version: str,
    run_id: str,
    raw_response: dict[str, Any],
    parsed_response: dict[str, Any],
) -> OutputRow:
    inference_ts = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
    model_name = find_first_by_key(
        raw_response,
        ("model", "served_model_name", "served_entity_name"),
    ) or endpoint
    model_version = find_first_by_key(
        raw_response,
        ("model_version", "served_model_version", "served_entity_version"),
    )

    return OutputRow(
        unique_id=row.unique_id,
        capability=row.capability,
        evidence_fingerprint=row.evidence_fingerprint,
        prompt_version=prompt_version,
        model_name=model_name,
        model_version=model_version,
        run_id=run_id,
        source_snapshot_ts=row.source_snapshot_ts,
        inference_ts=inference_ts,
        raw_response_json=json.dumps(raw_response, ensure_ascii=False),
        parsed_json=json.dumps(parsed_response, ensure_ascii=False),
    )


def append_output_rows(profile: str, rows: list[OutputRow]) -> None:
    if not rows:
        return

    values_sql = ",\n".join(
        f"""(
{sql_quote(row.unique_id)},
{sql_quote(row.capability)},
{sql_quote(row.evidence_fingerprint)},
{sql_quote(row.prompt_version)},
{sql_quote(row.model_name)},
{sql_quote(row.model_version)},
{sql_quote(row.run_id)},
{sql_timestamp(row.source_snapshot_ts)},
{sql_timestamp(row.inference_ts)},
{sql_quote(row.raw_response_json)},
{sql_quote(row.parsed_json)}
)"""
        for row in rows
    )

    sql = f"""
    INSERT INTO {OUTPUT_TABLE} (
      unique_id,
      capability,
      evidence_fingerprint,
      prompt_version,
      model_name,
      model_version,
      run_id,
      source_snapshot_ts,
      inference_ts,
      raw_response_json,
      parsed_json
    )
    VALUES
    {values_sql}
    """
    run_sql(profile, sql)


def append_failure_log(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def process_row(
    row: InputRow,
    *,
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    pacer: RequestPacer,
    system_prompt: str,
    user_prompt_template: str,
    prompt_version: str,
    run_id: str,
    sleep_seconds: float,
) -> OutputRow:
    user_prompt = render_user_prompt(user_prompt_template, row, pretty_json=False)
    target = resolve_provider_target(args)
    client_request_id = f"{run_id}:{row.capability}:{row.unique_id}"

    parse_retry_attempts = 3
    parsed_response: dict[str, Any] | None = None
    raw_response: dict[str, Any] | None = None
    for attempt in range(1, parse_retry_attempts + 1):
        pacer.wait_for_turn()
        raw_response = call_provider_json(
            args,
            auth,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema_name="facility_capability_signal_single",
            schema_model=CapabilitySignalModel,
            client_request_id=f"{client_request_id}:attempt{attempt}",
        )
        try:
            parsed_payload = parse_llm_payload_with_repair(
                args,
                auth,
                raw_response,
                client_request_id=f"{client_request_id}:attempt{attempt}",
            )
            parsed_response = normalize_parsed_json(parsed_payload)
            break
        except Exception:
            if attempt >= parse_retry_attempts:
                raise
            time.sleep(min(8, 2 ** (attempt - 1)))

    if sleep_seconds > 0:
        time.sleep(sleep_seconds)

    if raw_response is None or parsed_response is None:
        raise RuntimeError("Row request completed without a parsed response.")

    return build_output_row(
        row,
        endpoint=target,
        prompt_version=prompt_version,
        run_id=run_id,
        raw_response=raw_response,
        parsed_response=parsed_response,
    )


def process_facility_batch(
    batch: FacilityBatch,
    *,
    args: argparse.Namespace,
    auth: DatabricksAuthContext | OpenAIAuthContext,
    pacer: RequestPacer,
    system_prompt: str,
    user_prompt_template: str,
    prompt_version: str,
    run_id: str,
    sleep_seconds: float,
) -> list[OutputRow]:
    user_prompt = render_facility_batch_prompt(
        user_prompt_template,
        batch,
        pretty_json=False,
    )
    target = resolve_provider_target(args)
    client_request_id = f"{run_id}:facility:{batch.unique_id}"

    expected_capabilities = [row.capability for row in batch.rows]
    parse_retry_attempts = 3
    parsed_by_capability: dict[str, dict[str, Any]] | None = None
    raw_response: dict[str, Any] | None = None
    for attempt in range(1, parse_retry_attempts + 1):
        pacer.wait_for_turn()
        raw_response = call_provider_json(
            args,
            auth,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema_name="facility_capability_signal_batch",
            schema_model=CapabilityBatchResponseModel,
            client_request_id=f"{client_request_id}:attempt{attempt}",
        )
        try:
            parsed_by_capability = parse_batch_llm_payload_with_repair(
                args,
                auth,
                raw_response,
                expected_capabilities=expected_capabilities,
                client_request_id=f"{client_request_id}:attempt{attempt}",
            )
            break
        except Exception:
            if attempt >= parse_retry_attempts:
                raise
            time.sleep(min(8, 2 ** (attempt - 1)))

    if sleep_seconds > 0:
        time.sleep(sleep_seconds)

    if raw_response is None or parsed_by_capability is None:
        raise RuntimeError("Facility batch completed without parsed results.")

    output_rows: list[OutputRow] = []
    for row in batch.rows:
        parsed_response = parsed_by_capability[row.capability.lower()]
        output_rows.append(
            build_output_row(
                row,
                endpoint=target,
                prompt_version=prompt_version,
                run_id=run_id,
                raw_response=raw_response,
                parsed_response=parsed_response,
            )
        )

    return output_rows


def refresh_gold_signals(profile: str) -> None:
    for sql_path in REFRESH_SQL_FILES:
        sql = sql_path.read_text(encoding="utf-8")
        run_sql(profile, sql)


def count_work_item_rows(item: InputRow | FacilityBatch) -> int:
    if isinstance(item, FacilityBatch):
        return len(item.rows)
    return 1


def render_progress_bar(completed: int, total: int, *, width: int = 28) -> str:
    if total <= 0:
        total = 1
    ratio = min(max(completed / total, 0.0), 1.0)
    filled = min(width, int(ratio * width))
    if completed > 0 and filled == 0:
        filled = 1
    return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"


def print_batch_progress(
    *,
    batch_number: int,
    completed_requests: int,
    total_requests: int,
    covered_rows: int,
    total_rows: int,
    written_rows: int,
    failed_requests: int,
    final: bool = False,
) -> None:
    progress_bar = render_progress_bar(completed_requests, total_requests)
    line = (
        f"{progress_bar} batch {batch_number} | requests {completed_requests}/{total_requests} | "
        f"covered {covered_rows}/{total_rows} rows | written {written_rows} | failed {failed_requests}"
    )
    terminal_width = max(shutil.get_terminal_size((120, 20)).columns - 1, 40)
    output = line[:terminal_width].ljust(terminal_width)
    print(output, end="\n" if final else "\r", flush=True)


def main() -> int:
    args = parse_args()

    try:
        validate_args(args)
        if args.all_pending and args.force:
            raise RuntimeError("--all-pending cannot be combined with --force.")

        system_prompt = load_prompt_text(args.system_prompt_file)
        user_prompt_template = load_prompt_text(resolve_user_prompt_path(args))
        failure_log_path = Path(args.failure_log_file)
        pacer = RequestPacer(args.min_start_interval_seconds)
        auth: DatabricksAuthContext | OpenAIAuthContext | None = None

        run_id = str(uuid.uuid4())

        total_processed = 0
        total_failed = 0
        batch_number = 0

        while True:
            input_rows = load_input_rows(args.profile, args)
            if not input_rows:
                if total_processed == 0:
                    print("No matching input rows need review for this prompt version.")
                else:
                    print(f"No more pending rows. Total processed: {total_processed}.")
                break

            work_items: list[InputRow] | list[FacilityBatch]
            if args.mode == "facility":
                work_items = group_rows_by_facility(input_rows)
            else:
                work_items = input_rows

            batch_number += 1
            provider_target = resolve_provider_target(args)
            print(
                f"Selected {len(input_rows)} row(s) across {len(work_items)} {args.mode} request(s) "
                f"for {args.provider} target {provider_target} "
                f"with prompt_version={args.prompt_version} "
                f"(batch {batch_number}{', continuing until empty' if args.all_pending else ''})."
            )

            if args.dry_run:
                if args.mode == "facility":
                    preview = render_facility_batch_prompt(
                        user_prompt_template,
                        work_items[0],
                        pretty_json=True,
                    )
                else:
                    preview = render_user_prompt(user_prompt_template, input_rows[0], pretty_json=True)
                print("\n--- SYSTEM PROMPT ---\n")
                print(system_prompt)
                print("\n--- USER PROMPT ---\n")
                print(preview)
                return 0

            pending_writes: list[OutputRow] = []
            max_workers = max(1, args.parallelism)
            completed_requests = 0
            written_rows_in_batch = 0
            covered_rows_in_batch = 0
            failed_requests_in_batch = 0
            batch_total_rows = len(input_rows)

            if auth is None:
                if args.provider == "openai":
                    auth = get_openai_auth_context(args)
                else:
                    auth = get_databricks_auth_context(args.profile)

            print_batch_progress(
                batch_number=batch_number,
                completed_requests=0,
                total_requests=len(work_items),
                covered_rows=0,
                total_rows=batch_total_rows,
                written_rows=0,
                failed_requests=0,
            )

            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                if args.mode == "facility":
                    future_to_item = {
                        executor.submit(
                            process_facility_batch,
                            batch,
                            args=args,
                            auth=auth,
                            pacer=pacer,
                            system_prompt=system_prompt,
                            user_prompt_template=user_prompt_template,
                            prompt_version=args.prompt_version,
                            run_id=run_id,
                            sleep_seconds=args.sleep_seconds,
                        ): batch
                        for batch in work_items
                    }
                else:
                    future_to_item = {
                        executor.submit(
                            process_row,
                            row,
                            args=args,
                            auth=auth,
                            pacer=pacer,
                            system_prompt=system_prompt,
                            user_prompt_template=user_prompt_template,
                            prompt_version=args.prompt_version,
                            run_id=run_id,
                            sleep_seconds=args.sleep_seconds,
                        ): row
                        for row in work_items
                    }

                for future in as_completed(future_to_item):
                    item = future_to_item[future]
                    completed_requests += 1
                    try:
                        result = future.result()
                        output_rows = result if isinstance(result, list) else [result]
                        pending_writes.extend(output_rows)

                        total_processed += len(output_rows)
                        written_rows_in_batch += len(output_rows)
                        covered_rows_in_batch += len(output_rows)
                        print_batch_progress(
                            batch_number=batch_number,
                            completed_requests=completed_requests,
                            total_requests=len(work_items),
                            covered_rows=covered_rows_in_batch,
                            total_rows=batch_total_rows,
                            written_rows=written_rows_in_batch,
                            failed_requests=failed_requests_in_batch,
                        )

                        if len(pending_writes) >= max(args.write_batch_size, 1):
                            append_output_rows(args.profile, pending_writes)
                            pending_writes.clear()
                    except Exception as row_exc:
                        total_failed += 1
                        failed_requests_in_batch += 1
                        covered_rows_in_batch += count_work_item_rows(item)
                        if args.mode == "facility":
                            batch = item
                            failure_payload = {
                                "run_id": run_id,
                                "batch_number": batch_number,
                                "request_index": completed_requests,
                                "unique_id": batch.unique_id,
                                "facility_name": batch.facility_name,
                                "capabilities": [row.capability for row in batch.rows],
                                "prompt_version": args.prompt_version,
                                "provider": args.provider,
                                "target": provider_target,
                                "error": str(row_exc),
                                "timestamp_utc": datetime.now(UTC).isoformat(),
                            }
                            failure_message = (
                                f"[batch {batch_number} {completed_requests}/{len(work_items)}] "
                                f"FAILED facility batch for {batch.facility_name} ({batch.unique_id}): {row_exc}"
                            )
                        else:
                            row = item
                            failure_payload = {
                                "run_id": run_id,
                                "batch_number": batch_number,
                                "request_index": completed_requests,
                                "unique_id": row.unique_id,
                                "capability": row.capability,
                                "facility_name": row.facility_name,
                                "prompt_version": args.prompt_version,
                                "provider": args.provider,
                                "target": provider_target,
                                "error": str(row_exc),
                                "timestamp_utc": datetime.now(UTC).isoformat(),
                            }
                            failure_message = (
                                f"[batch {batch_number} {completed_requests}/{len(work_items)}] "
                                f"FAILED {row.capability} for {row.facility_name} ({row.unique_id}): {row_exc}"
                            )

                        append_failure_log(failure_log_path, failure_payload)
                        print(failure_message, file=sys.stderr)
                        print_batch_progress(
                            batch_number=batch_number,
                            completed_requests=completed_requests,
                            total_requests=len(work_items),
                            covered_rows=covered_rows_in_batch,
                            total_rows=batch_total_rows,
                            written_rows=written_rows_in_batch,
                            failed_requests=failed_requests_in_batch,
                        )
                        if args.fail_fast:
                            raise

            if pending_writes:
                append_output_rows(args.profile, pending_writes)

            print_batch_progress(
                batch_number=batch_number,
                completed_requests=completed_requests,
                total_requests=len(work_items),
                covered_rows=covered_rows_in_batch,
                total_rows=batch_total_rows,
                written_rows=written_rows_in_batch,
                failed_requests=failed_requests_in_batch,
                final=True,
            )
            print(
                f"Batch {batch_number} complete: wrote {written_rows_in_batch}/{batch_total_rows} row(s) "
                f"across {completed_requests} request(s) with {failed_requests_in_batch} failure(s)."
            )

            if not args.all_pending:
                break

        if total_processed > 0:
            print(f"Wrote raw LLM output rows with run_id={run_id}. Total processed: {total_processed}.")
        if total_failed > 0:
            print(
                f"Encountered {total_failed} request-level failure(s). "
                f"See {failure_log_path} for details."
            )

        if args.refresh_gold:
            refresh_gold_signals(args.profile)
            print(
                "Refreshed gold.facility_capability_llm_signals and "
                "gold.facility_capability_assessment."
            )

        return 0
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:  # pragma: no cover
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
