// _shared/verifyStatus.ts — pure verdict → status logic for the lease-abstract
// verifier. NO imports (Deno OR Node): this file is imported by the Deno edge
// function `abstract-verify` AND by a Vitest unit test in src/, so it must stay
// runtime-agnostic. Keep it dependency-free.
//
// The whole point of this module is to stand between "the model returned junk"
// and a green "Verified" badge. It fails CLOSED.

// A verdict is only trustworthy if the verifier came back as an object carrying
// at least one field_check — i.e. it actually examined the abstract. An empty
// {}, null, a non-object, a malformed parse, or a run that examined nothing must
// NEVER read as clean. The forced-tool schema is permissive (additionalProperties)
// and the OpenAI fallback JSON.parse can yield anything, so this guard is load-bearing.
//
// Phase 1 replaces this coverage FLOOR with a required field-coverage manifest
// that proves each high-value field was examined, not merely that one row exists.
export function hasFieldEvidence(qa: any): boolean {
  return !!qa && typeof qa === 'object' && !Array.isArray(qa)
    && Array.isArray(qa.field_checks) && qa.field_checks.length > 0
}

// verdict → row status. 'issues' = something a human must fix (or a verdict we
// can't trust) before relying on the abstract; 'review' = softer flags worth a
// look; 'verified' = clean AND backed by real field evidence.
export function deriveStatus(qa: any): string {
  // FAIL CLOSED: no usable field evidence → not verified. This is the fix for
  // the false-green path (empty/malformed QA previously fell through to 'verified').
  if (!hasFieldEvidence(qa)) return 'issues'
  const checks = Array.isArray(qa?.field_checks) ? qa.field_checks : []
  const arith = Array.isArray(qa?.arithmetic) ? qa.arithmetic : []
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
  const fabrication = Array.isArray(qa?.fabrication_risk) && qa.fabrication_risk.length > 0
  if (softFlag || fabrication) return 'review'
  return 'verified'
}
