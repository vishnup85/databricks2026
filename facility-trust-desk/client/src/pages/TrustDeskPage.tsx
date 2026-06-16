import { useMemo, useState } from 'react';
import {
  useAnalyticsQuery,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import {
  BedDouble,
  Building2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  MapPin,
  MousePointerClick,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { getErrorMessage, overrideKey, type Override, usePlannerOverrides } from '../lib/trustDeskOverrides';

const CAPABILITIES = ['icu', 'nicu', 'maternity', 'emergency', 'oncology', 'trauma'];
const TABLE_SKELETON_KEYS = ['table-row-1', 'table-row-2', 'table-row-3', 'table-row-4', 'table-row-5'];
const DETAIL_SKELETON_KEYS = ['detail-card-1', 'detail-card-2', 'detail-card-3', 'detail-card-4'];

// Trust tier -> human label + badge colour. `short` is used in the dense table,
// `label` in the roomier drill-down cards.
const TIER: Record<string, { label: string; short: string; cls: string }> = {
  strong: { label: 'Strong evidence', short: 'Strong', cls: 'bg-green-600 text-white border-transparent' },
  partial: { label: 'Partial evidence', short: 'Partial', cls: 'bg-amber-500 text-white border-transparent' },
  weak_suspicious: { label: 'Weak / suspicious', short: 'Weak', cls: 'bg-red-500 text-white border-transparent' },
  // "no evidence found" (not a factual "they don't do this") — we found nothing either way.
  no_claim: {
    label: 'No evidence found',
    short: 'No evidence',
    cls: 'bg-muted text-muted-foreground border-transparent',
  },
};

// One-line meaning for the legend, so a tier badge is never mistaken for a verified fact.
const TIER_HELP: Record<string, string> = {
  strong: 'structured + well corroborated',
  partial: 'some evidence, limited corroboration',
  weak_suspicious: 'thin, contradicted, or implausible',
  no_claim: 'nothing found either way',
};

const TIER_ORDER = ['strong', 'partial', 'weak_suspicious', 'no_claim'];

const EVIDENCE_SIGNAL_LABELS: Record<string, string> = {
  structured_hit: 'structured evidence matched',
  claim_hit: 'capability claim matched',
  prose_hit: 'free-text mention matched',
};

const CONTEXT_SIGNAL_LABELS: Record<string, string> = {
  screening_only: 'screening-only language',
  well_corroborated: 'facility well corroborated',
  implausible: 'implausible for facility type/scale',
  recent_update: 'recent facility page update',
  capacity_supported: 'hospital-scale capacity reported',
};

const EVIDENCE_SIGNAL_ORDER = ['structured_hit', 'claim_hit', 'prose_hit'];
const CONTEXT_SIGNAL_ORDER = [
  'screening_only',
  'well_corroborated',
  'implausible',
  'recent_update',
  'capacity_supported',
];

function TierBadge({ tier, compact }: { tier: string; compact?: boolean }) {
  const t = TIER[tier] ?? TIER.no_claim;
  return <Badge className={t.cls}>{compact ? t.short : t.label}</Badge>;
}

type SortKey = 'name' | 'facility_type' | 'district_norm' | 'tier' | 'n_source_urls';
type SortDir = 'asc' | 'desc';
type RankedRow = {
  unique_id: string;
  name: string;
  facility_type: string;
  district_norm: string;
  state_name: string;
  tier: string;
  score: number;
  n_source_urls: number;
};

// Tier rank for sorting: strong evidence > partial > weak > no claim.
const TIER_RANK: Record<string, number> = {
  strong: 0,
  partial: 1,
  weak_suspicious: 2,
  no_claim: 3,
};

function compareRows(a: RankedRow, b: RankedRow, key: SortKey, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1;
  if (key === 'tier') {
    // Trust column sorts by tier rank, breaking ties with score (always strongest first within a tier).
    const tierDiff = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99);
    if (tierDiff !== 0) return tierDiff * mul;
    return (b.score - a.score) * mul;
  }
  if (key === 'n_source_urls') {
    return (a.n_source_urls - b.n_source_urls) * mul;
  }
  const av = String((a as Record<string, unknown>)[key] ?? '').toLowerCase();
  const bv = String((b as Record<string, unknown>)[key] ?? '').toLowerCase();
  return av.localeCompare(bv) * mul;
}

export function TrustDeskPage() {
  const [capability, setCapability] = useState('maternity');
  const [state, setState] = useState('All');
  const [trustTier, setTrustTier] = useState('All');
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('tier');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const { overrides, loadError, saveOverride, clearOverride } = usePlannerOverrides();

  const states = useAnalyticsQuery('states', {});
  const ranked = useAnalyticsQuery('capability_ranked', {
    capability: sql.string(capability),
    state: sql.string(state),
    tier: sql.string(trustTier),
  });

  const rows = useMemo<RankedRow[]>(() => {
    const data = (ranked.data ?? []) as RankedRow[];
    return [...data].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [ranked.data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d: SortDir) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Default direction per column type — text sorts A→Z, numeric/tier sorts best-first.
      setSortDir(key === 'name' || key === 'facility_type' || key === 'district_norm' ? 'asc' : key === 'tier' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Find facilities by capability</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6">
          <div className="space-y-2 w-48">
            <Label>Capability</Label>
            <Select value={capability} onValueChange={setCapability}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPABILITIES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 w-64">
            <Label>Region (state)</Label>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All states</SelectItem>
                {states.data?.map((s) => (
                  <SelectItem key={s.state_name} value={s.state_name}>
                    {s.state_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 w-64">
            <Label>Trust</Label>
            <Select value={trustTier} onValueChange={setTrustTier}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All with evidence</SelectItem>
                {TIER_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIER[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="capitalize">
            {capability} facilities {state !== 'All' ? `in ${state}` : ''}
            {trustTier !== 'All' ? ` · ${TIER[trustTier]?.label ?? trustTier}` : ''}
            {ranked.data ? ` (${ranked.data.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Legend />
          {loadError && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {loadError}
            </div>
          )}
          {ranked.loading && (
            <div className="space-y-2">
              {TABLE_SKELETON_KEYS.map((key) => (
                <Skeleton key={key} className="h-8 w-full" />
              ))}
            </div>
          )}
          {ranked.error && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md">Error: {ranked.error}</div>
          )}
          {ranked.data && rows.length === 0 && (
            <div className="text-muted-foreground">
              No facilities match this capability, region, and trust filter.
            </div>
          )}
          {rows.length > 0 && (
            <>
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
                Click any row to view evidence, citations, and override controls.
              </p>
              <Table className="w-full table-fixed">
                <TableHeader>
                  <TableRow>
                    <SortableHead
                      width="w-[36%]"
                      label="Facility"
                      sortKey="name"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      width="w-[12%]"
                      label="Type"
                      sortKey="facility_type"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      width="w-[22%]"
                      label="District"
                      sortKey="district_norm"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      width="w-[16%]"
                      label="Trust"
                      sortKey="tier"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      width="w-[10%]"
                      label="Sources"
                      sortKey="n_source_urls"
                      activeKey={sortKey}
                      activeDir={sortDir}
                      onSort={toggleSort}
                      align="right"
                    />
                    <TableHead className="w-[4%]" aria-label="Open details" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((f: RankedRow) => (
                    <TableRow
                      key={f.unique_id}
                      className="group cursor-pointer hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                      onClick={() => setSelected({ id: f.unique_id, name: f.name })}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected({ id: f.unique_id, name: f.name });
                        }
                      }}
                      aria-label={`View evidence for ${f.name}`}
                    >
                      <TableCell className="font-medium whitespace-normal break-words">{f.name}</TableCell>
                      <TableCell className="text-muted-foreground whitespace-normal break-words capitalize">
                        {f.facility_type}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-normal break-words">
                        {f.district_norm}
                      </TableCell>
                      <TableCell>
                        <TierBadge tier={f.tier} compact />
                        {overrides[overrideKey(f.unique_id, capability)] && (
                          <span className="mt-0.5 block text-[10px] font-medium text-amber-600">local override</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{f.n_source_urls}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        <ChevronRight
                          className="ml-auto h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                          aria-hidden="true"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="shrink-0 space-y-1 border-b px-6 py-5 pr-12 text-left">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Facility evidence</p>
            <SheetTitle className="text-lg leading-snug">{selected?.name}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {selected && (
              <FacilityDetail
                uniqueId={selected.id}
                focusCapability={capability}
                overrides={overrides}
                onSaveOverride={saveOverride}
                onClearOverride={clearOverride}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FacilityDetail({
  uniqueId,
  focusCapability,
  overrides,
  onSaveOverride,
  onClearOverride,
}: {
  uniqueId: string;
  focusCapability: string;
  overrides: Record<string, Override>;
  onSaveOverride: (id: string, cap: string, tier: string, note: string) => Promise<void>;
  onClearOverride: (id: string, cap: string) => Promise<void>;
}) {
  const { data, loading, error } = useAnalyticsQuery('facility_detail', {
    unique_id: sql.string(uniqueId),
    capability: sql.string(focusCapability),
  });

  if (loading)
    return (
      <div className="space-y-3">
        {DETAIL_SKELETON_KEYS.map((key) => (
          <Skeleton key={key} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  if (error) return <div className="text-destructive text-sm">Error: {error}</div>;
  if (!data || data.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        No assessment data for <span className="capitalize">{focusCapability}</span> at this facility.
      </div>
    );
  }

  const head = data[0];
  const assessment = head;
  const specialties = asJson<string[]>(head.specialties_json) ?? [];
  const capabilities = asJson<string[]>(head.capabilities_json) ?? [];
  const equipment = asJson<string[]>(head.equipment_json) ?? [];
  const hasProfileBadges = capabilities.length > 0 || specialties.length > 0 || equipment.length > 0;
  const trustSummary = buildTrustSummary(assessment, uniqueId, overrides);

  return (
    <div className="space-y-6">
      <FacilityMeta
        facilityType={head.facility_type}
        district={head.district_norm}
        state={head.state_name}
        numDoctors={head.num_doctors}
        capacityBeds={head.capacity_beds}
      />

      <TrustSummaryCard summary={trustSummary} />

      {hasProfileBadges && (
        <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold">Facility profile</h3>
          <div className="space-y-3">
            <BadgeList title="Stated capabilities" items={capabilities} compact />
            <BadgeList title="Specialties" items={specialties} compact />
            <BadgeList title="Equipment" items={equipment} compact />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold capitalize">{focusCapability} evidence</h3>
          <p className="text-xs text-muted-foreground">
            Matched signals, supporting snippets, source links, and override controls.
          </p>
        </div>
        <CapabilityCard
          row={assessment}
          override={overrides[overrideKey(uniqueId, focusCapability)]}
          onSave={(tier, note) => onSaveOverride(uniqueId, focusCapability, tier, note)}
          onClear={() => onClearOverride(uniqueId, focusCapability)}
        />
      </section>
    </div>
  );
}

type DetailRow = {
  capability: string;
  tier: string;
  explanation: string;
  evidence_json: string;
  citation_urls_json: string;
};

type TrustSummary = {
  focusCapability: string;
  focusTier: string;
  hasLocalOverride: boolean;
  detail: string;
  source: 'llm' | 'heuristic' | 'none';
};

function effectiveTier(
  uniqueId: string,
  capability: string,
  tier: string,
  overrides: Record<string, Override>,
): string {
  return overrides[overrideKey(uniqueId, capability)]?.tier ?? tier;
}

function buildTrustSummary(
  row: DetailRow,
  uniqueId: string,
  overrides: Record<string, Override>,
): TrustSummary {
  const focusTier = effectiveTier(uniqueId, row.capability, row.tier, overrides);
  const hasLocalOverride = Boolean(overrides[overrideKey(uniqueId, row.capability)]);
  const evidence = asJson<Record<string, unknown>>(row.evidence_json) ?? {};
  const reasoningLlm = typeof evidence.reasoning_llm === 'string' ? evidence.reasoning_llm.trim() : '';

  let source: 'llm' | 'heuristic' | 'none' = 'none';
  let detail = '';
  if (reasoningLlm) {
    source = 'llm';
    detail = reasoningLlm;
  } else if (row.explanation) {
    source = 'heuristic';
    detail = row.explanation;
  }

  return {
    focusCapability: row.capability,
    focusTier,
    hasLocalOverride,
    detail,
    source,
  };
}

function TrustSummaryCard({ summary }: { summary: TrustSummary }) {
  if (summary.source === 'none') return null;

  const isLlm = summary.source === 'llm';
  const heading = isLlm ? 'AI summary' : 'Rule-based summary';

  return (
    <section className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {isLlm && <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
          <h3 className="text-sm font-semibold">{heading}</h3>
          <span className="text-xs text-muted-foreground capitalize">— {summary.focusCapability}</span>
        </div>
        <TierBadge tier={summary.focusTier} compact />
      </div>

      <p className="text-sm leading-relaxed">{summary.detail}</p>

      {summary.hasLocalOverride && (
        <p className="text-xs font-medium text-amber-700">
          A local override is applied for this capability — see the evidence section below for your note.
        </p>
      )}
    </section>
  );
}

function CapabilityCard({
  row,
  override,
  onSave,
  onClear,
}: {
  row: DetailRow;
  override?: Override;
  onSave: (tier: string, note: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const evidence = asJson<Record<string, unknown>>(row.evidence_json) ?? {};
  const citations = asJson<string[]>(row.citation_urls_json) ?? [];
  const evidenceSignals = pickSignals(evidence, EVIDENCE_SIGNAL_LABELS, EVIDENCE_SIGNAL_ORDER);
  const contextSignals = pickSignals(evidence, CONTEXT_SIGNAL_LABELS, CONTEXT_SIGNAL_ORDER);
  const hasMatchedEvidence = evidenceSignals.length > 0;
  const noClaimContextNote = !hasMatchedEvidence ? buildNoClaimContextNote(contextSignals) : null;
  const supportingSnippets = pickSnippets(evidence['supporting_snippets_llm']);

  const [editing, setEditing] = useState(false);
  const [draftTier, setDraftTier] = useState(override?.tier ?? row.tier);
  const [draftNote, setDraftNote] = useState(override?.note ?? '');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    if (!draftNote.trim()) return; // a note is required so overrides stay accountable
    setIsSaving(true);
    setActionError(null);
    try {
      await onSave(draftTier, draftNote.trim());
      setEditing(false);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Unable to save the local override.'));
    } finally {
      setIsSaving(false);
    }
  };

  const clear = async () => {
    setIsSaving(true);
    setActionError(null);
    try {
      await onClear();
    } catch (error) {
      setActionError(getErrorMessage(error, 'Unable to clear the local override.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b bg-muted/30 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base capitalize leading-tight">{row.capability}</CardTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            {override && (
              <span className="text-xs text-muted-foreground line-through">{TIER[row.tier]?.short}</span>
            )}
            <TierBadge tier={override ? override.tier : row.tier} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4 text-sm">
        {row.explanation && (
          <p className="leading-relaxed text-muted-foreground">{row.explanation}</p>
        )}

        {!hasMatchedEvidence && noClaimContextNote && (
          <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {noClaimContextNote}
          </div>
        )}

        {supportingSnippets.length > 0 ? (
          <SnippetList snippets={supportingSnippets} />
        ) : (
          evidenceSignals.length > 0 && (
            <div className="rounded-md border bg-background p-3">
              <SignalGroup title="Matched evidence" items={evidenceSignals} variant="secondary" />
            </div>
          )
        )}

        {hasMatchedEvidence && contextSignals.length > 0 && (
          <div className="rounded-md border bg-background p-3">
            <SignalGroup title="Facility context" items={contextSignals} variant="outline" />
          </div>
        )}

        {citations.length > 0 && (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Source URLs
                <span className="ml-1.5 font-normal normal-case">({citations.length})</span>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Facility-level public URLs from the dataset — not all may support this capability.
              </p>
            </div>
            <ul className="space-y-2">
              {citations.slice(0, 10).map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-primary transition-colors hover:bg-muted/40"
                  >
                    <ExternalLink
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary"
                      aria-hidden="true"
                    />
                    <span className="break-all leading-relaxed underline-offset-2 group-hover:underline">
                      {url}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-3 border-t pt-4">
          {override && !editing && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
              <p className="text-xs font-medium text-amber-800">
                Local override — {TIER[override.tier]?.label ?? override.tier}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-amber-900">{override.note}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-amber-700">
                {override.actorEmail && <span>Saved by {override.actorEmail}</span>}
                <span>{new Date(override.ts).toLocaleString()}</span>
              </div>
            </div>
          )}

          {actionError && (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {actionError}
            </div>
          )}

          {editing ? (
            <div className="space-y-3 rounded-md border bg-muted/10 p-3">
              <p className="text-xs text-muted-foreground">Stored only in this browser.</p>
              <div className="space-y-1.5">
                <Label className="text-xs">Override assessment</Label>
                <Select value={draftTier} onValueChange={setDraftTier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIER_ORDER.map((t) => (
                      <SelectItem key={t} value={t}>
                        {TIER[t].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <textarea
                className="w-full rounded-md border bg-background p-2.5 text-sm"
                rows={3}
                placeholder="Reason for override (required) — e.g. confirmed by site visit / phone call"
                value={draftNote}
                onChange={(e) => setDraftNote(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!draftNote.trim() || isSaving}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={isSaving}
                  className="rounded-md border bg-background px-3 py-1.5 text-xs font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftTier(override?.tier ?? row.tier);
                  setDraftNote(override?.note ?? '');
                  setActionError(null);
                  setEditing(true);
                }}
                className="rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
              >
                {override ? 'Edit override' : 'Override assessment'}
              </button>
              {override && (
                <button
                  type="button"
                  onClick={() => void clear()}
                  disabled={isSaving}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5"
                >
                  {isSaving ? 'Clearing...' : 'Clear'}
                </button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FacilityMeta({
  facilityType,
  district,
  state,
  numDoctors,
  capacityBeds,
}: {
  facilityType: string;
  district: string;
  state: string;
  numDoctors?: number | null;
  capacityBeds?: number | null;
}) {
  const items = [
    {
      icon: Building2,
      label: 'Type',
      value: facilityType,
      className: 'capitalize',
    },
    {
      icon: MapPin,
      label: 'Location',
      value: `${district}, ${state}`,
    },
    ...(numDoctors
      ? [{ icon: Stethoscope, label: 'Doctors', value: String(numDoctors), className: undefined }]
      : []),
    ...(capacityBeds
      ? [{ icon: BedDouble, label: 'Beds', value: String(capacityBeds), className: undefined }]
      : []),
  ];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map(({ icon: Icon, label, value, className }) => (
        <div
          key={label}
          className="flex items-start gap-2.5 rounded-lg border bg-muted/20 px-3 py-2.5"
        >
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className={`text-sm leading-snug ${className ?? ''}`}>{value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function SortableHead({
  width,
  label,
  sortKey,
  activeKey,
  activeDir,
  onSort,
  align = 'left',
}: {
  width: string;
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = activeKey === sortKey;
  const Icon = isActive ? (activeDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  const justify = align === 'right' ? 'justify-end' : 'justify-start';
  const ariaSort = isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <TableHead className={`${width} ${align === 'right' ? 'text-right' : ''}`} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`-mx-2 inline-flex w-[calc(100%+1rem)] items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none ${justify}`}
        aria-label={`Sort by ${label}${isActive ? ` (${activeDir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
      >
        <span>{label}</span>
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground/60'}`}
          aria-hidden="true"
        />
      </button>
    </TableHead>
  );
}

function SignalGroup({ title, items, variant }: { title: string; items: string[]; variant: 'secondary' | 'outline' }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} variant={variant}>
            {item}
          </Badge>
        ))}
      </div>
    </div>
  );
}

const MAX_SNIPPETS_SHOWN = 5;

function SnippetList({ snippets }: { snippets: string[] }) {
  const shown = snippets.slice(0, MAX_SNIPPETS_SHOWN);
  return (
    <div className="space-y-2">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why we think so</p>
        <p className="mt-0.5 text-xs text-muted-foreground/80">
          LLM-extracted quotes from this facility&apos;s profile text
        </p>
      </div>
      <ul className="space-y-2">
        {shown.map((snippet) => (
          <li
            key={snippet}
            className="rounded-md border-l-2 border-primary/50 bg-muted/30 px-3 py-2 text-xs italic leading-relaxed text-muted-foreground"
          >
            &ldquo;{snippet}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {TIER_ORDER.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <Badge className={TIER[k].cls}>{TIER[k].short}</Badge>
            <span className="text-muted-foreground">{TIER_HELP[k]}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Automated signals from public or scraped facility data are heuristic assessments, not certifications.
        Facilities are ordered strongest-evidence first. Open a facility to review the evidence, supporting
        snippets, and citations, and verify before relying. Planner overrides are stored in this browser only.
      </p>
    </div>
  );
}

function BadgeList({
  title,
  items,
  max = 24,
  compact = false,
}: {
  title: string;
  items: string[];
  max?: number;
  compact?: boolean;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className="space-y-1.5">
      <p className={`font-medium ${compact ? 'text-xs text-muted-foreground' : 'text-sm'}`}>{title}</p>
      <div className="flex flex-wrap gap-1">
        {shown.map((it) => (
          <Badge key={it} variant="outline" className="font-normal text-xs">
            {it}
          </Badge>
        ))}
        {extra > 0 && <span className="self-center text-xs text-muted-foreground">+{extra} more</span>}
      </div>
    </div>
  );
}

// JSON columns are typed as string, but the analytics transport may deliver them
// already parsed (object / array). Handle both.
function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function pickSignals(evidence: Record<string, unknown>, labels: Record<string, string>, order: string[]): string[] {
  return order.filter((key) => evidence[key] === true).map((key) => labels[key]);
}

function pickSnippets(raw: unknown): string[] {
  const parsed = asJson<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildNoClaimContextNote(contextSignals: string[]): string | null {
  if (contextSignals.length === 0) return null;

  if (contextSignals.includes('facility well corroborated') && contextSignals.includes('recent facility page update')) {
    return 'The facility itself looks well-sourced and recently updated, but none of those sources mention this capability.';
  }

  if (contextSignals.includes('facility well corroborated')) {
    return 'The facility itself looks well-sourced, but those sources do not mention this capability.';
  }

  if (contextSignals.includes('recent facility page update')) {
    return 'The facility has a recent public update, but that update still does not mention this capability.';
  }

  return 'We found no direct evidence for this capability.';
}
