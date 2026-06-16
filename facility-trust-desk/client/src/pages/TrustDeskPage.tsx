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
import { getErrorMessage, overrideKey, type Override, useSharedOverrides } from '../lib/trustDeskOverrides';

const CAPABILITIES = ['icu', 'nicu', 'maternity', 'emergency', 'oncology', 'trauma'];
const TABLE_SKELETON_KEYS = ['table-row-1', 'table-row-2', 'table-row-3', 'table-row-4', 'table-row-5'];
const DETAIL_SKELETON_KEYS = ['detail-card-1', 'detail-card-2', 'detail-card-3', 'detail-card-4'];

// Capabilities NFHS-5 meaningfully covers (others have no district "need" signal).
const NEED_CAPS = new Set(['maternity', 'nicu', 'oncology']);

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

export function TrustDeskPage() {
  const [capability, setCapability] = useState('maternity');
  const [state, setState] = useState('All');
  const [sortBy, setSortBy] = useState<'trust' | 'need'>('trust');
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const { overrides, loadError, saveOverride, clearOverride } = useSharedOverrides();

  const states = useAnalyticsQuery('states', {});
  const ranked = useAnalyticsQuery('capability_ranked', {
    capability: sql.string(capability),
    state: sql.string(state),
  });

  const hasNeed = NEED_CAPS.has(capability);

  // Server returns trust order (tier, then score). Re-sort client-side for "need".
  const rows = useMemo(() => {
    const data = ranked.data ?? [];
    if (sortBy === 'need' && hasNeed) {
      return [...data].sort((a, b) => (b.need_score ?? -1) - (a.need_score ?? -1) || b.score - a.score);
    }
    return data;
  }, [ranked.data, sortBy, hasNeed]);

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
          {hasNeed && (
            <div className="space-y-2 w-48">
              <Label>Sort by</Label>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as 'trust' | 'need')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trust">Trust (default)</SelectItem>
                  <SelectItem value="need">District need</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="capitalize">
            {capability} facilities {state !== 'All' ? `in ${state}` : ''}
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
            <div className="text-muted-foreground">No facilities claim this capability here.</div>
          )}
          {rows.length > 0 && (
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className={hasNeed ? 'w-[30%]' : 'w-[36%]'}>Facility</TableHead>
                  <TableHead className="w-[12%]">Type</TableHead>
                  <TableHead className="w-[18%]">District</TableHead>
                  <TableHead className="w-[14%]">Trust</TableHead>
                  <TableHead
                    className="w-[8%] text-right"
                    title="Ranking heuristic used to order facilities within a tier — not a quality rating"
                  >
                    Rank
                  </TableHead>
                  {hasNeed && <TableHead className="w-[8%] text-right">Need</TableHead>}
                  <TableHead className="w-[10%] text-right">Sources</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow
                    key={f.unique_id}
                    className="cursor-pointer"
                    onClick={() => setSelected({ id: f.unique_id, name: f.name })}
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
                        <span className="mt-0.5 block text-[10px] font-medium text-amber-600">planner override</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{f.score}</TableCell>
                    {hasNeed && (
                      <TableCell className="text-right">
                        {f.need_score != null ? Math.round(f.need_score) : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-right">{f.n_source_urls}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.name}</SheetTitle>
          </SheetHeader>
          {selected && (
            <FacilityDetail
              uniqueId={selected.id}
              overrides={overrides}
              onSaveOverride={saveOverride}
              onClearOverride={clearOverride}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FacilityDetail({
  uniqueId,
  overrides,
  onSaveOverride,
  onClearOverride,
}: {
  uniqueId: string;
  overrides: Record<string, Override>;
  onSaveOverride: (id: string, cap: string, tier: string, note: string) => Promise<void>;
  onClearOverride: (id: string, cap: string) => Promise<void>;
}) {
  const { data, loading, error } = useAnalyticsQuery('facility_detail', {
    unique_id: sql.string(uniqueId),
  });

  if (loading)
    return (
      <div className="mt-4 space-y-2">
        {DETAIL_SKELETON_KEYS.map((key) => (
          <Skeleton key={key} className="h-16 w-full" />
        ))}
      </div>
    );
  if (error) return <div className="mt-4 text-destructive">Error: {error}</div>;
  if (!data || data.length === 0) return <div className="mt-4 text-muted-foreground">No data.</div>;

  const head = data[0];
  const specialties = asJson<string[]>(head.specialties_json) ?? [];
  const capabilities = asJson<string[]>(head.capabilities_json) ?? [];
  const equipment = asJson<string[]>(head.equipment_json) ?? [];

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        {head.facility_type} · {head.district_norm}, {head.state_name}
        {head.num_doctors ? ` · ${head.num_doctors} doctors` : ''}
        {head.capacity_beds ? ` · ${head.capacity_beds} beds` : ''}
      </p>

      <BadgeList title="Stated capabilities" items={capabilities} />
      <BadgeList title="Specialties" items={specialties} />
      <BadgeList title="Equipment" items={equipment} />

      <div className="border-t pt-3 space-y-4">
        {data.map((row) => (
          <CapabilityCard
            key={row.capability}
            row={row}
            override={overrides[overrideKey(uniqueId, row.capability)]}
            onSave={(tier, note) => onSaveOverride(uniqueId, row.capability, tier, note)}
            onClear={() => onClearOverride(uniqueId, row.capability)}
          />
        ))}
      </div>
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
      setActionError(getErrorMessage(error, 'Unable to save the shared override.'));
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
      setActionError(getErrorMessage(error, 'Unable to clear the shared override.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base capitalize">{row.capability}</CardTitle>
          <div className="flex items-center gap-1">
            {override && <span className="text-xs text-muted-foreground line-through">{TIER[row.tier]?.short}</span>}
            <TierBadge tier={override ? override.tier : row.tier} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {row.explanation && <p className="text-muted-foreground">{row.explanation}</p>}
        {!hasMatchedEvidence && noClaimContextNote && (
          <div className="rounded-md border border-muted bg-muted/20 p-3 text-xs text-muted-foreground">
            {noClaimContextNote}
          </div>
        )}
        {evidenceSignals.length > 0 && (
          <SignalGroup title="Matched evidence" items={evidenceSignals} variant="secondary" />
        )}
        {hasMatchedEvidence && contextSignals.length > 0 && (
          <SignalGroup title="Facility context" items={contextSignals} variant="outline" />
        )}
        {citations.length > 0 && (
          <div>
            <p className="font-medium mb-1">Facility source URLs ({citations.length})</p>
            <p className="mb-1 text-xs text-muted-foreground">
              These are facility-level public URLs from the dataset and may not all support this specific capability.
            </p>
            <ul className="space-y-1">
              {citations.slice(0, 10).map((url) => (
                <li key={url} className="truncate">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {override && !editing && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-800">
              Planner override → {TIER[override.tier]?.label ?? override.tier}
            </p>
            <p className="mt-0.5 text-xs text-amber-900">{override.note}</p>
            {override.actorEmail && <p className="mt-0.5 text-[10px] text-amber-700">Saved by {override.actorEmail}</p>}
            <p className="mt-0.5 text-[10px] text-amber-700">{new Date(override.ts).toLocaleString()}</p>
          </div>
        )}

        {actionError && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
            {actionError}
          </div>
        )}

        {editing ? (
          <div className="space-y-2 rounded-md border p-2">
            <div className="space-y-1">
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
              className="w-full rounded-md border bg-background p-2 text-sm"
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
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={isSaving}
                className="rounded-md border px-3 py-1 text-xs font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDraftTier(override?.tier ?? row.tier);
                setDraftNote(override?.note ?? '');
                setActionError(null);
                setEditing(true);
              }}
              className="rounded-md border px-3 py-1 text-xs font-medium"
            >
              {override ? 'Edit override' : 'Override assessment'}
            </button>
            {override && (
              <button
                type="button"
                onClick={() => void clear()}
                disabled={isSaving}
                className="rounded-md border px-3 py-1 text-xs font-medium text-destructive"
              >
                {isSaving ? 'Clearing...' : 'Clear'}
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
        Automated signals from public / scraped facility data — heuristic assessments, not certifications. The rank
        number only orders facilities within a tier; it is not a quality score. Open a facility to review the evidence
        and citations, and verify before relying. Planner overrides are shared through Lakebase and sync across users
        about every 30 seconds.
      </p>
    </div>
  );
}

function BadgeList({ title, items, max = 24 }: { title: string; items: string[]; max?: number }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <div className="flex flex-wrap gap-1">
        {shown.map((it) => (
          <Badge key={it} variant="outline" className="font-normal">
            {it}
          </Badge>
        ))}
        {extra > 0 && <span className="text-xs text-muted-foreground self-center">+{extra} more</span>}
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
