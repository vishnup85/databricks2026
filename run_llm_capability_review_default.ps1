<#
.SYNOPSIS
  Runs LLM capability review with a workspace-ready Databricks chat endpoint.

.DESCRIPTION
  Convenience wrapper around run_llm_capability_review.py that:
  - clears stale proxy environment variables
  - defaults to a ready chat endpoint in this workspace
  - passes through common review options

  Override -Endpoint if you want a different serving endpoint.
#>

param(
    [string]$Profile = "default",
    [string]$Endpoint = "databricks-meta-llama-3-1-8b-instruct",
    [string]$Capability,
    [string]$UniqueId,
    [int]$Limit = 100,
    [int]$MaxTokens = 420,
    [int]$Parallelism = 12,
    [double]$MinStartIntervalSeconds = 0.5,
    [switch]$AllPending,
    [switch]$RefreshGold,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:ALL_PROXY = ""

$args = @(
    ".\run_llm_capability_review.py",
    "--profile", $Profile,
    "--endpoint", $Endpoint,
    "--mode", "facility",
    "--limit", $Limit,
    "--max-tokens", $MaxTokens,
    "--parallelism", $Parallelism,
    "--min-start-interval-seconds", $MinStartIntervalSeconds
)

if ($Capability) {
    $args += @("--capability", $Capability)
}

if ($UniqueId) {
    $args += @("--unique-id", $UniqueId)
}

if ($AllPending) {
    $args += "--all-pending"
}

if ($RefreshGold) {
    $args += "--refresh-gold"
}

if ($Force) {
    $args += "--force"
}

if ($DryRun) {
    $args += "--dry-run"
}

python @args
