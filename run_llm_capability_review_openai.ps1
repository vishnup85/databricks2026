<#
.SYNOPSIS
  Runs LLM capability review using the OpenAI Responses API for inference and Databricks SQL for
  data read/write.

.DESCRIPTION
  Convenience wrapper around run_llm_capability_review.py that:
  - uses provider=openai
  - defaults to facility-batch mode
  - expects an API key in OPENAI_API_KEY by default

  Override -Model if you want a different OpenAI model.
#>

param(
    [string]$Profile = "default",
    [string]$Model = "gpt-5.4-mini",
    [string]$Capability,
    [string]$UniqueId,
    [int]$Limit = 100,
    [int]$MaxTokens = 420,
    [int]$Parallelism = 48,
    [double]$MinStartIntervalSeconds = 0.1,
    [string]$OpenAIApiKeyEnv = "OPENAI_API_KEY",
    [string]$OpenAIBaseUrl,
    [ValidateSet("low", "medium", "high", "xhigh")]
    [string]$OpenAIReasoningEffort = "low",
    [ValidateSet("low", "medium", "high")]
    [string]$OpenAITextVerbosity = "low",
    [string]$PromptVersion = "facility_capability_signal_openai_batch_v1",
    [switch]$AllPending,
    [switch]$RefreshGold,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $DryRun) {
    $apiKey = [Environment]::GetEnvironmentVariable($OpenAIApiKeyEnv)
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw "OpenAI API key not found in environment variable '$OpenAIApiKeyEnv'."
    }
}

$args = @(
    ".\run_llm_capability_review.py",
    "--profile", $Profile,
    "--provider", "openai",
    "--openai-model", $Model,
    "--openai-api-key-env", $OpenAIApiKeyEnv,
    "--openai-reasoning-effort", $OpenAIReasoningEffort,
    "--openai-text-verbosity", $OpenAITextVerbosity,
    "--mode", "facility",
    "--limit", $Limit,
    "--max-tokens", $MaxTokens,
    "--parallelism", $Parallelism,
    "--min-start-interval-seconds", $MinStartIntervalSeconds,
    "--prompt-version", $PromptVersion
)

if ($OpenAIBaseUrl) {
    $args += @("--openai-base-url", $OpenAIBaseUrl)
}

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
