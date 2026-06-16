<#
.SYNOPSIS
  Rebuilds the Facility Trust Desk data pipeline in dependency order.

.DESCRIPTION
  Runs every SQL script in the sql/ folder against Databricks via the CLI,
  in dependency order. Stops on the first failure.

.PARAMETER Profile
  Databricks CLI profile to use. Defaults to DEFAULT.

.EXAMPLE
  .\run_pipeline.ps1
  .\run_pipeline.ps1 -Profile my-workspace
#>

param(
    [string]$Profile = "DEFAULT"
)

$ErrorActionPreference = "Stop"

# Run scripts in dependency order.
# Note: script 07 is a silver-stage LLM input table that depends on the gold
# heuristic baseline from script 06. Script 10 rebuilds the final serving mart
# after the LLM sidecar is parsed in script 09.
$scripts = @(
    "01_silver_facilities_clean.sql",
    "02_silver_pincode_district.sql",
    "03_silver_nfhs_clean.sql",
    "04_gold_facility_geo.sql",
    "05_gold_district_need_index.sql",
    "06_gold_facility_capability_assessment.sql",
    "07_silver_facility_capability_llm_inputs.sql",
    "08_silver_facility_capability_llm_outputs_raw.sql",
    "09_gold_facility_capability_llm_signals.sql",
    "10_gold_facility_capability_assessment.sql"
)

$sqlDir = Join-Path $PSScriptRoot "sql"
$total = $scripts.Count
$step = 0

Write-Host "Running Facility Trust Desk pipeline (profile: $Profile)" -ForegroundColor Cyan
Write-Host "SQL folder: $sqlDir`n"

foreach ($script in $scripts) {
    $step++
    $path = Join-Path $sqlDir $script

    if (-not (Test-Path $path)) {
        Write-Host "[$step/$total] MISSING: $script" -ForegroundColor Red
        exit 1
    }

    Write-Host "[$step/$total] Running $script ..." -ForegroundColor Yellow
    $start = Get-Date

    databricks experimental aitools tools query --file $path --output json --profile $Profile

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$step/$total] FAILED: $script (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }

    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Write-Host "[$step/$total] OK: $script (${elapsed}s)`n" -ForegroundColor Green
}

Write-Host "Pipeline complete. All $total scripts ran successfully." -ForegroundColor Cyan
