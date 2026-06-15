#!/usr/bin/env python3
"""
Read the three hackathon tables through the Databricks CLI.

The script looks up these tables under the hackathon dataset namespace:
- facilities
- india_post_pincode_directory
- nfhs_5_district_health_indicators

For each table it saves:
- schema.json
- sample_rows.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_NAMESPACE_HINT = "databricks_virtue_foundation_dataset_dais_2026"
TABLE_NAMES = [
    "facilities",
    "india_post_pincode_directory",
    "nfhs_5_district_health_indicators",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read the hackathon tables from Databricks."
    )
    parser.add_argument(
        "--profile",
        required=True,
        help="Databricks CLI profile to use, for example `DEFAULT` or `my-workspace`.",
    )
    parser.add_argument(
        "--namespace-hint",
        default=DEFAULT_NAMESPACE_HINT,
        help=(
            "Catalog or schema hint from the Databricks URL. "
            f"Default: {DEFAULT_NAMESPACE_HINT}"
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Number of sample rows to fetch. Default: 10",
    )
    parser.add_argument(
        "--output-dir",
        default="databricks_outputs",
        help="Folder where raw schema and sample outputs are written.",
    )
    return parser.parse_args()


def run_cli(command: list[str]) -> str:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "Unknown CLI error"
        raise RuntimeError(message)
    return completed.stdout


def run_query(profile: str, sql: str) -> Any:
    output = run_cli(
        [
            "databricks",
            "experimental",
            "aitools",
            "tools",
            "query",
            sql,
            "--output",
            "json",
            "--profile",
            profile,
        ]
    )
    return json.loads(output)


def discover_schema(profile: str, full_name: str) -> Any:
    output = run_cli(
        [
            "databricks",
            "experimental",
            "aitools",
            "tools",
            "discover-schema",
            full_name,
            "--output",
            "json",
            "--profile",
            profile,
        ]
    )
    return json.loads(output)


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


def resolve_table_name(profile: str, table_name: str, namespace_hint: str) -> str:
    sql = f"""
    SELECT table_catalog, table_schema, table_name
    FROM system.information_schema.tables
    WHERE lower(table_name) = lower('{table_name}')
      AND (
        lower(table_schema) = lower('{namespace_hint}')
        OR lower(table_catalog) = lower('{namespace_hint}')
      )
    ORDER BY table_catalog, table_schema, table_name
    """
    payload = run_query(profile, " ".join(sql.split()))
    matches = extract_rows(payload, {"table_catalog", "table_schema", "table_name"})

    if not matches:
        fallback_sql = f"""
        SELECT table_catalog, table_schema, table_name
        FROM system.information_schema.tables
        WHERE lower(table_name) = lower('{table_name}')
        ORDER BY table_catalog, table_schema, table_name
        """
        payload = run_query(profile, " ".join(fallback_sql.split()))
        matches = extract_rows(payload, {"table_catalog", "table_schema", "table_name"})

    if not matches:
        raise RuntimeError(
            "No matching table was found. "
            "Try rerunning with --full-name CATALOG.SCHEMA.TABLE if you know it."
        )

    if len(matches) > 1:
        print("More than one matching table was found. Please rerun with --full-name.")
        for match in matches:
            print(
                f"- {match['table_catalog']}.{match['table_schema']}.{match['table_name']}"
            )
        raise SystemExit(2)

    match = matches[0]
    return f"{match['table_catalog']}.{match['table_schema']}.{match['table_name']}"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_table(profile: str, namespace_hint: str, table_name: str, limit: int, output_dir: Path) -> None:
    full_name = resolve_table_name(profile, table_name, namespace_hint)
    print(f"Using table: {full_name}")

    table_dir = output_dir / table_name

    schema_payload = discover_schema(profile, full_name)
    write_json(table_dir / "schema.json", schema_payload)

    sample_sql = f"SELECT * FROM {full_name} LIMIT {int(limit)}"
    sample_payload = run_query(profile, sample_sql)
    write_json(table_dir / "sample_rows.json", sample_payload)

    print(f"Saved outputs to: {table_dir}")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)

    try:
        for table_name in TABLE_NAMES:
            read_table(
                profile=args.profile,
                namespace_hint=args.namespace_hint,
                table_name=table_name,
                limit=args.limit,
                output_dir=output_dir,
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
