"""PySpark equivalents of the Facility Trust Desk serving queries.

These mirror the app's SQL files in `facility-trust-desk/config/queries/`
(`states.sql`, `capability_ranked.sql`, `facility_detail.sql`) but as reusable
DataFrame functions for use in a Databricks notebook or job.

Usage (in a Databricks notebook, where `spark` already exists):

    from facility_trust_queries import capability_ranked, facility_detail, get_states

    get_states().display()
    capability_ranked("icu", "Maharashtra").display()
    facility_detail("e78e7ba5-ee36-41be-8bd9-b3ab26c4f665", "icu").display()
"""

from __future__ import annotations

from pyspark.sql import Column, DataFrame, SparkSession
from pyspark.sql import functions as F

TABLE = "virtue_foundation_dataset_cleaned.gold.facility_capability_assessment"


def _spark() -> SparkSession:
    spark = SparkSession.getActiveSession()
    if spark is None:
        raise RuntimeError("No active SparkSession. Run inside Databricks or create one first.")
    return spark


def _tier_rank(col: str = "tier") -> Column:
    """Order tiers strongest-first, matching the SQL CASE expression."""
    return (
        F.when(F.col(col) == "strong", 1)
        .when(F.col(col) == "partial", 2)
        .when(F.col(col) == "weak_suspicious", 3)
        .otherwise(4)
    )


def get_states(spark: SparkSession | None = None) -> DataFrame:
    """Distinct, non-empty states for the region filter (states.sql)."""
    spark = spark or _spark()
    return (
        spark.table(TABLE)
        .where(F.col("state_name").isNotNull() & (F.col("state_name") != ""))
        .select("state_name")
        .distinct()
        .orderBy("state_name")
    )


def capability_ranked(
    capability: str,
    state: str = "All",
    tier: str = "All",
    spark: SparkSession | None = None,
) -> DataFrame:
    """Facilities for a capability + region + trust tier (capability_ranked.sql).

    Pass state="All" or tier="All" to skip those filters.
    tier="All" excludes no_claim rows; pass tier="no_claim" to list those only.
    """
    spark = spark or _spark()
    df = spark.table(TABLE).where(F.col("capability") == capability)
    if state != "All":
        df = df.where(F.col("state_name") == state)
    if tier == "All":
        df = df.where(F.col("tier") != "no_claim")
    else:
        df = df.where(F.col("tier") == tier)

    return (
        df.select(
            "unique_id",
            "name",
            "facility_type",
            "district_norm",
            "state_name",
            "tier",
            "score",
            "n_source_urls",
        )
        .orderBy(_tier_rank().asc(), F.col("score").desc())
        .limit(200)
    )


def facility_detail(unique_id: str, capability: str, spark: SparkSession | None = None) -> DataFrame:
    """One capability assessment + citations for a facility (matches facility_detail.sql)."""
    spark = spark or _spark()
    return (
        spark.table(TABLE)
        .where((F.col("unique_id") == unique_id) & (F.col("capability") == capability))
        .select(
            "capability",
            "tier",
            "score",
            "evidence_json",
            F.to_json(F.col("citation_urls")).alias("citation_urls_json"),
            "name",
            "facility_type",
            "district_norm",
            "state_name",
        )
    )
