// _shared/verifyStatus.ts — pure verdict → status logic for the lease-abstract
// verifier. NO imports (Deno OR Node): this file is imported by the Deno edge
// function `abstract-verify` AND by a Vitest unit test in src/, so it must stay
// runtime-agnostic. Keep it dependency-free.
//
// The whole point of this module is to stand between "the model returned junk"
// and a green "Verified" badge. It fails CLOSED.

// The verdict vocabulary the QA prompt instructs the model to use. A field_check
// whose verdict is outside this set is an uninterpretable row — treat it as a
// malformed run, never as clean.
const KNOWN_VERDICTS = new Set(['confirmed', 'discrepancy', 'unsupported', 'needs_source'])

// A verdict is only trustworthy if the verifier came back as an object with at
// least one field_check that carries a RECOGNIZED verdict — i.e. it actually
// rendered a judgment. An empty {}, null, a non-object, a malformed parse, a run
// that examined nothing, OR a truncated row like [{field:'rent'}] with no verdict
// must NEVER read as clean. The forced-tool schema is permissive
// (additionalProperties) and the OpenAI fallback JSON.parse can yield anything,
// so this guard is load-bearing.
//
// Phase 1 replaces this coverage FLOOR with a required field-coverage manifest
// that proves each high-value field was examined, not merely that one row exists.
export function hasFieldEvidence(qa: any): boolean {
  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) return false
  const checks = qa.field_checks
  return Array.isArray(checks) && checks.some((c: any) => KNOWN_VERDICTS.has(c?.verdict))
}

// verdict → row status. 'issues' = something a human must fix (or a verdict we
// can't trust) before relying on the abstract; 'review' = softer flags worth a
// look; 'verified' = clean AND backed by real, interpretable field evidence.
export function deriveStatus(qa: any): string {
  // FAIL CLOSED: no usable field evidence → not verified. This is the fix for
  // the false-green path (empty/malformed QA previously fell through to 'verified').
  if (!hasFieldEvidence(qa)) return 'issues'
  const checks = qa.field_checks as any[]   // guaranteed a non-empty array by hasFieldEvidence
  // Any row we cannot interpret (missing/off-vocabulary verdict) means the run is
  // malformed — a clean verdict cannot be trusted, so fail closed.
  if (checks.some((c: any) => !KNOWN_VERDICTS.has(c?.verdict))) return 'issues'
  const arith = Array.isArray(qa.arithmetic) ? qa.arithmetic : []
  const badVerdict = (v: string) => v === 'discrepancy' || v === 'unsupported'
  // ISSUES = something a human must fix before relying on the abstract: a
  // HIGH-severity discrepancy/unsupported claim, failed arithmetic, or a stale
  // (superseded-amendment) term.
  const highIssue = checks.some((c: any) => badVerdict(c?.verdict) && c?.severity === 'high')
  const arithFail = arith.some((a: any) => a?.ok === false)
  const stale = qa?.amendment_currency?.current === false
  if (highIssue || arithFail || stale) return 'issues'
  // REVIEW = softer flags worth a look: medium/low discrepancies, needs-source,
  // or derived-value disclosures. fabrication_risk is NOT an issues trigger — post
  // grounding-fix it mostly holds "computed, not quoted verbatim" notes, and a
  // genuinely invented fact also surfaces as a HIGH 'unsupported' field_check above.
  const softFlag = checks.some((c: any) => badVerdict(c?.verdict) || c?.verdict === 'needs_source')
  const fabrication = Array.isArray(qa.fabrication_risk) && qa.fabrication_risk.length > 0
  if (softFlag || fabrication) return 'review'
  return 'verified'
}
