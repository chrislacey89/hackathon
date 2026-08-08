---
date: 2026-08-08
category: patterns
problem_type: error taxonomy / classifier default direction
components: [pipeline-errors, retry-policy, sweep]
technologies: [typescript, effect, ai-sdk]
severity: high
volatility: evergreen
---

# A fail-safe default at one layer is not inherited by the layer above it

## Problem

Slice #4's retry policy lists retryable tags *positively* — `RETRYABLE_TAGS = {RateLimited, Transient}` — with a comment explaining that a fourth tag "must opt **in** to spending our rate limit." One layer up, the function that decides which tag a thrown error gets ends with an unconditional `return new Transient({ status: 0 })`. Every error shape the classifier does not recognise opts itself *in*, silently, which is precisely what the layer below was designed to prevent.

## Context

The slice classifies 384 survey responses through Gemini under bounded concurrency. Its entire reason for existing is conditional retry: `RateLimited` and `Transient` back off and retry, `SchemaInvalid` fails through, because retrying a deterministic failure burns quota against a rate limit nobody has measured for a guaranteed-identical result.

`classifyCause(responseId, cause)` maps a thrown value into that taxonomy. It handled three shapes explicitly — `NoObjectGeneratedError`, `TypeValidationError`, and `APICallError` (delegating the retryable question to the SDK's own `isRetryable`) — and defaulted everything else to `Transient`.

A missing `GOOGLE_GENERATIVE_AI_API_KEY` throws `LoadAPIKeyError`. It is **not** an `APICallError`, because the request never reached the provider. So it missed the one branch that asks "is this worth retrying," fell to the default, and became retryable.

## Symptoms

- The most common operator mistake produces the most expensive possible run.
- A run with a missing or invalid key takes ~11 minutes and ~1,536 attempts (384 rows × 4 attempts at 1s/2s/4s jittered backoff) before completing.
- The final report names the wrong cause: `PARTIAL RUN — lost 384 Transient` — a transport-layer story for a configuration mistake.
- Nothing fails. Exit code is 0, `run.json` is well-formed, `partial: true` is technically accurate.
- A typo'd model id (`NoSuchModelError`) behaves identically.

## Root Cause

Two distinct causes, and the second is the durable one.

**1. The taxonomy's membership is open, but the classifier was written as if it were closed.** The three handled shapes were the ones the happy path and the tests surfaced. The AI SDK exports more than thirty error classes; the ones that arise from *misconfiguration* rather than *from a request* never reach an `APICallError` check, and that whole family was unrepresented.

**2. The fail-safe reasoning was applied at the tag layer and not at the classification layer.** The `RETRYABLE_TAGS` set is a positive list specifically so that an unenumerated tag defaults to *not* spending quota. One function above it, an unenumerated *error shape* defaults to a tag that does. The same author, in the same file, in the same sitting, wrote the guard correctly at one level and inverted at the adjacent one — because "what happens to something I did not think of?" was asked about tags and not about causes.

**A test made this look verified.** `errors.test.ts` covered the catch-all with `new TypeError("fetch failed")` and asserted `Transient` — and that assertion is *correct*: a socket reset genuinely does succeed on a second attempt. The catch-all had a passing test demonstrating the case where its optimism is right, which is exactly the evidence that stops anyone asking what else lands there. Coverage of a default branch is not coverage of the default *decision*.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The failure is invisible in every environment where the config is correct — which is every environment anyone develops in. It surfaces only on a fresh machine, a new contributor's clone, a CI runner without secrets, or the first unattended cron run: exactly the moments with the least attention available. And it surfaces as slowness plus a misleading label rather than as an error, so the feedback that does arrive points away from the cause.

## Rule Scope

- **Applies when:** a function maps *open-set* inputs (thrown values from a third-party library, untyped external payloads, string enums off the wire) into a *closed* internal taxonomy, **and** a downstream branch on that taxonomy has asymmetric cost between its arms — retry vs. fail, allow vs. deny, charge vs. skip. The asymmetry is what makes the default direction load-bearing; without it the catch-all is a labelling choice, not a safety one.
- **Inverts or does not apply when:**
  - **The expensive arm is "give up" rather than "act."** A parser deciding whether to attempt recovery on unrecognised input should default *optimistic* — dropping a volunteer's response is worse than one wasted parse. Direction follows which error you can afford, not a general preference for caution.
  - **The input set is genuinely closed** — your own tagged errors, a sealed union — where an exhaustiveness check (`never` in TypeScript) turns the omission into a compile error and no runtime default is reachable.
  - **The catch-all's arm is free.** If both branches cost the same, this is a naming problem.
- **Sibling docs:** [`inferred-config-guesses-the-axis-not-the-values-2026-08-08.md`](./inferred-config-guesses-the-axis-not-the-values-2026-08-08.md) — the adjacent shape. There, an `inferred: true` flag guarded row *values* while the wrong thing was the *schema*; here, a positive tag list guarded *tags* while the wrong thing was the *classifier*. Both are a safety mechanism operating one level below the level where the mistake was made, and in both cases the mechanism's presence is what made the gap hard to see.

## Solution

Match every *known* deterministic shape before the catch-all, and keep the catch-all narrow enough that its optimism is defensible.

**Before:**

```ts
export function classifyCause(responseId: string, cause: unknown): ClassifyError {
  if (NoObjectGeneratedError.isInstance(cause) || TypeValidationError.isInstance(cause)) {
    return new SchemaInvalid({ responseId });
  }
  if (APICallError.isInstance(cause)) { /* … isRetryable branch … */ }

  return new Transient({ status: 0 });   // ← every unrecognised shape opts in to retry
}
```

**After:**

```ts
/** Misconfigured rather than unlucky. Neither is an APICallError — the request never left. */
const DETERMINISTIC_SDK_ERRORS = [LoadAPIKeyError, NoSuchModelError] as const;

export function classifyCause(responseId: string, cause: unknown): ClassifyError {
  if (NoObjectGeneratedError.isInstance(cause) || TypeValidationError.isInstance(cause)) {
    return new SchemaInvalid({ responseId });
  }
  if (DETERMINISTIC_SDK_ERRORS.some((sdkError) => sdkError.isInstance(cause))) {
    return new SchemaInvalid({ responseId });
  }
  if (APICallError.isInstance(cause)) { /* … isRetryable branch … */ }

  return new Transient({ status: 0 });   // now reached only by genuinely unidentifiable causes
}
```

The catch-all is *kept*, deliberately. Flipping it to fail-closed would misclassify the socket resets and DNS blips it was written for — those really are transient. The fix is to shrink what reaches it, not to invert it.

Paired with a fail-fast precondition, because the classifier fix alone still produces a report blaming the data:

```ts
if ((process.env[API_KEY_VAR] ?? "") === "") {
  return yield* Effect.dieMessage(`${API_KEY_VAR} is not set — see .env.example`);
}
```

Without it the run completes "successfully" claiming 384 deterministic failures, when the truth is one unset variable.

## Prevention

**Code-level:**

- **Test the catch-all with a case that must *not* land there**, not only one that should. The existing `TypeError → Transient` test is a fine under-claim guard; it needed an over-claim sibling (`LoadAPIKeyError → not retryable`). This is the same both-failure-directions discipline `classify.ts`'s `partitionByCitation` tests already follow — it just had not been applied to the error classifier.
- When a classifier's input comes from a library, **enumerate that library's error exports once** (`Object.keys(require('ai')).filter(k => /Error$/.test(k))` returned 30+ here) and decide the arm for each family, rather than for the three you have seen.
- Assert the *decision*, not just the tag: `expect(isRetryable(error)).toBe(false)` reads as the thing that costs money.

**Process-level:**

- When `/research` characterises a third-party SDK that this project will branch on, capture its **error taxonomy** in the archive alongside the API surface. Slice #4's research artifact pinned `Retry.Options` and `Schedule` signatures precisely, and said nothing about which error classes `@ai-sdk/google` can throw — so the implementation classified the shapes it happened to meet.
- At `/pre-merge`, for any diff introducing a classifier with a default branch, ask directly: *what is the cheapest input that reaches the default, and is the default the arm you would choose for it?*

## Planning / Calibration Notes

- **What widened the work:** nothing at implementation time — the defect cost one commit to fix once named. It widened *review*: it was found in the architectural pass, not by the 100-test suite, and only because Dimension 8's "silent env-var fallback" prompt made the missing-key path worth tracing by hand.
- **What tightened the work:** mutation-testing the guards (deleting `while: isRetryable`, dropping `{ concurrency }`, swapping id-pairing for index-pairing) proved those three tests could actually fail. That discipline confirmed the paths that *were* tested and is silent about paths that are not — worth knowing about its limits, not a reason to stop.
- **Future planning adjustment:** treat "which errors can this dependency throw" as a first-class `/research` question wherever the answer drives a cost-asymmetric branch, at the same level as "which functions does it export."

## Defect Classification

**Origin phase:** Design error — the taxonomy and its default direction were chosen at design time; the code implemented that design faithfully.
**Fix type:** Correction. The defect (unrecognised shapes reaching the optimistic arm) is removed for the known families, and the fail-fast guard removes the misattribution. The residual risk is honest and bounded: a *future* SDK error class not in `DETERMINISTIC_SDK_ERRORS` still reaches the catch-all. That is the open-set property, not a workaround — it is why the process-level prevention above matters more than the code-level one.

## Key Decision

**Decision:** Keep an optimistic catch-all and shrink its reachable input set, rather than inverting the default to fail-closed.
**Rationale:** The two arms have asymmetric cost in *both* directions. Retrying a deterministic failure wastes quota; refusing to retry a genuine blip drops a volunteer's response, which is the loss this project exists to prevent. An unidentifiable cause is more likely a transport blip than a config error once the known config errors are matched explicitly.
**Alternatives considered:** (a) fail-closed default — rejected, it would misclassify socket resets and DNS failures, the exact case the branch was written for; (b) a fourth `Rejected` tag separating misconfiguration from malformed output — deferred, `FailureCounts` is declared as exactly three tags in #4's boundary map and #20's run summary is the consumer that would justify widening it.
**Revisable:** Yes — if #20 needs to distinguish "the model produced garbage" from "the run was misconfigured" in the summary UI, the fourth tag is the clean answer and this entry's `SchemaInvalid`-for-401s compromise goes away with it.

## Related

- PR #26 — Full sweep: bounded concurrency, conditional retry, failure taxonomy
- Issue #4 — slice; boundary map declares the three-tag taxonomy
- PRD #1 §Rabbit Holes — "retrying a schema-validation failure"
- [`inferred-config-guesses-the-axis-not-the-values-2026-08-08.md`](./inferred-config-guesses-the-axis-not-the-values-2026-08-08.md)

## Shelf Life

Evergreen as a principle — the layer-inheritance point holds for any open-set classifier feeding a cost-asymmetric branch.

The specific `LoadAPIKeyError` instance expires if `@ai-sdk/google` ever routes configuration failures through `APICallError` with `isRetryable: false`, at which point the explicit list becomes redundant. Re-check on any AI SDK major bump.
