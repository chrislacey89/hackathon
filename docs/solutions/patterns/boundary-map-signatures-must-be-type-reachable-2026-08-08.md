---
date: 2026-08-08
category: patterns
problem_type: slice decomposition / contract declaration
components: [boundary-maps, pipeline-modules]
technologies: [typescript]
severity: medium
volatility: stable
---

# A declared signature can be unimplementable against the PRD's own locked types

## Problem

Slice #2's boundary map declared `route(rv: ResponseVerdict, c: Config): RoutedLead`. The same PRD locked `RoutedLead = ResponseVerdict & { …, name, email, employer, program }`. Those four fields exist only on `SurveyResponse`, which reaches neither parameter — so the declared signature could not construct its own declared return type. Two of slice #2's seven declared signatures had this defect.

## Context

`/write-a-prd` locks contract *shapes* in §Implementation Decisions. `/prd-to-issues` later writes *function signatures* into each slice's Produces section. The two artifacts are authored at different times, by different steps, and nothing checks them against each other. A signature is judged for plausibility, not for whether its return type is reachable from its arguments.

The defect is invisible until implementation, when it presents as "the boundary map is wrong" at exactly the moment the implementer is least inclined to stop and correct upstream.

## Symptoms

- A declared function returns a type whose fields trace back to an entity that appears in no parameter.
- The implementer adds a parameter and calls it a minor deviation.
- A downstream slice declares `Consumes: <module> → <Type>` and the type is fine, so nothing downstream complains — the drift stays local and unrecorded.

## Root Cause

Type reachability is a mechanical property that nobody was assigned to check. For a declaration `f(a: A, b: B): T`, every field of `T` must be derivable from `A`, `B`, or a constant. When the return type is defined by intersection in a *different document* from the signature, the two halves are never in one reader's view at once.

The instances here:

| Declared | Unreachable field | Lives on |
|---|---|---|
| `aggregate(vs: SentenceVerdict[]): ResponseVerdict` | `responseId` | `SurveyResponse` |
| `route(rv: ResponseVerdict, c: Config): RoutedLead` | `name`, `email`, `employer`, `program` | `SurveyResponse` |
| `evaluate(preds: ResponseVerdict[], truth: GroundTruth[]): EvalReport` (slice #3) | `split`, `baseline` | the caller; `SurveyResponse[]` |

The first two are the same shape: the return type carries volunteer *identity*, and identity never entered the pipeline stage that was asked to produce it.

**Second occurrence, 2026-08-08 (slice #3, PR #25).** The third row is the same defect in a different slice, and it is worth separating because its two unreachable fields fail in *different* ways. `split` is a fact about the caller's intent that no argument carries — the classic missing-parameter case, and the easy one to see. `baseline` is subtler: producing it requires `keywordBaseline(rows: SurveyResponse[])`, but the declared signature receives `ResponseVerdict[]` — a *different stage's* type. That kind resists eyeballing, because the field's name matches a symbol the slice genuinely produces; only tracing what that symbol needs as **input** exposes the gap.

So the enumeration in Prevention is not just "list `T`'s fields and look for a parameter that has them" — for any field produced by another declared function, follow that function's *arguments* too. One hop is enough; the defect lives exactly there.

Evidence now spans two slices at three defective signatures in seven (#2) and one in three (#3).

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The check is cheap at decomposition (one pass over the Produces list) and expensive at implementation (the implementer must either widen the signature and record a drift, or backtrack to `/correct-course`). Nothing surfaces the defect in between, so it is always discovered at the expensive end.

## Rule Scope

- **Applies when:** a slice's Produces declares a function signature *and* the PRD separately locks the return type's shape — the two-document split is what makes the defect invisible. Strongest for pipeline stages where types accrete across stages (`A → B → C`, each adding fields).
- **Inverts or does not apply when:** the return type is declared inline in the same Produces entry (both halves in one view — a reader catches it), or when the function's return is a primitive, a boolean, or a type the function fully constructs from literals. Also does not apply to signatures that intentionally take a context/env object, since anything is reachable through it.
- **Sibling docs:** [`inferred-config-guesses-the-axis-not-the-values-2026-08-08.md`](./inferred-config-guesses-the-axis-not-the-values-2026-08-08.md) — the adjacent case where a config artifact is unvalidated rather than unimplementable. [`prd-revised-after-decomposition-leaves-slices-silently-stale-2026-08-08.md`](./prd-revised-after-decomposition-leaves-slices-silently-stale-2026-08-08.md) — the adjacent case where a declaration was *correct when written* and later made stale by a PRD revision, rather than defective at authoring time. The two are distinguishable by timestamp: a defective declaration is wrong against the PRD it was decomposed from; a stale one is wrong only against a later revision.

## Solution

Correct the **declaration**, not the code — the code was right, and the shipped signatures are what downstream slices should trust:

```ts
// declared            →  shipped
aggregate(vs)          →  aggregate(responseId: string, vs: SentenceVerdict[])
route(rv, c)           →  route(rv, response: SurveyResponse, c: Config)
writeRun(leads)        →  writeRun(leads, options: { generatedAt, config, … })
```

The third is a different animal and is worth separating: `writeRun(leads)` *was* implementable — it would read the clock and re-load config internally. It was widened by choice (an injected `generatedAt` keeps `run.json` diffable; passing `config` keeps an Effect load out of `emit`). Recording it alongside the two impossibilities, clearly labelled as a choice, keeps the correction honest — otherwise a future reader learns "boundary maps are routinely wrong" instead of "boundary maps have one specific checkable defect."

The corrections were filed as a comment on the slice issue rather than an edit to its body: the original declaration and the reason it moved are both worth reading later.

## Prevention

**Code-level:** None applicable — this is a document defect, and the compiler catches it only after someone has written code against the wrong shape.

**Process-level:** Add a type-reachability pass to `/prd-to-issues` when writing Produces. For each declared `f(args): T`, enumerate `T`'s fields (following intersections into the PRD's locked shapes) and confirm each is derivable from `args`. Any field that is not means either the signature needs a parameter or `T` needs splitting across stages. It is mechanical, takes seconds per signature, and is the only point where both documents are in view at once.

Mirror check at `/execute` Step 0: the Consumes gate already verifies upstream symbols exist and match their declared *shape*. Extend the same scepticism to this slice's own Produces before implementing — a signature that cannot construct its return type is knowable before the first test is written.

**Prevention validated, 2026-08-08 (slice #3, PR #25).** The mirror check above was run as prescribed and caught `evaluate`'s defect *before the first test was written*. Cost and benefit both measured this time:

- **Detection cost:** under a minute. Three fields on `EvalReport`, one hop each.
- **Correction cost:** widening the signature to a single `EvalInput` object, decided before any code existed — so zero rework, versus slice #2 where one of three drifts shipped undocumented and was found by `/pre-merge` Dimension 4.

The half that did *not* happen automatically was filing the correction comment. It was written only after `/pre-merge` flagged its absence as a Concern against this very document. That is worth noting precisely: the **detection** half of this doc's prevention transferred to a new slice on first contact, and the **recording** half did not. Detection is a check you run once and either pass or fail; recording is a follow-through with no forcing function, and follow-throughs need one. Treat "file the correction comment" as part of the same step rather than a tidy-up afterwards.

## Planning / Calibration Notes

- **What widened the work:** negligible in code; the correction cost one issue comment and a PR-body revision. The real cost was review attention — the drift was found by `/pre-merge` Dimension 4, not at decomposition, and one of the three had already been shipped undocumented.
- **What tightened the work:** downstream slices declare `Consumes` on *types*, not signatures, so all three drifts were contained to slice #2. Had a slice declared a signature-level dependency, the blast radius would have been three issues rather than one.
- **Future planning adjustment:** prefer declaring `Consumes` against types rather than call signatures — it is a looser coupling that survives exactly this class of correction.

## Related

- PR #13 — TRACER: end-to-end spine
- Issue #2 — boundary-map correction comment, 2026-08-08
- PR #25 — Eval harness + keyword baseline (second occurrence; prevention validated)
- Issue #3 — boundary-map correction comment, 2026-08-08
- PRD #1 §Implementation Decisions — locked contract shapes

## Shelf Life

Expires if `/prd-to-issues` gains a type-reachability check, at which point this documents a defect the pipeline prevents. Until then, stable — and the second occurrence (slice #3) is evidence the check is still needed, since decomposition produced the same defect class again in the same run.
