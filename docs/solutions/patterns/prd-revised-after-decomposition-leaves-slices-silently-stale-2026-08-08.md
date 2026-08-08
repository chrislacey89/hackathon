---
date: 2026-08-08
category: patterns
problem_type: cross-artifact drift after mid-cycle re-shaping
components: [prd, slice-issues, boundary-maps, acceptance-criteria]
technologies: [github-issues]
severity: high
volatility: evergreen
---

# A PRD revised after decomposition leaves every slice silently stale

## Problem

`/correct-course` revised PRD #1 after all 21 slices had already been decomposed from it. The slices were not re-synced, nothing detects the gap, and a slice that reads correct on its own can carry citations and acceptance criteria the PRD no longer supports.

## Context

Slice #3 (eval harness) was implemented on 2026-08-08. Both of its parent artifacts read as authoritative, and they disagreed:

- **Slice #3 §Boundary Map** declares `engagementType: ClassMetrics[]` on `EvalReport` — per-type precision and recall.
- **PRD #1 §Rabbit Holes** says the opposite: *"eval scores signal-vs-none and service-recovery only — both taxonomy-independent. Per-type accuracy is dropped as unmeasurable (1–4 examples per class), not quietly reported as if real."*

Neither artifact is wrong for its own moment. The slice was decomposed from the PRD *as it stood*; the PRD was later revised by correct-course #24, which replaced four assumptions after the stakeholder interview returned. The slice froze; the PRD moved.

The timestamps make the mechanism plain — every slice predates the correction:

| Artifact | Created (2026-08-08) |
|---|---|
| Slices #2–#12 | 16:11 – 16:13 |
| Slices #14–#23 | 17:03 – 17:11 |
| **Correct-course #24** | **17:19** |

## Symptoms

Recognise this before implementing against a slice, not after.

- The repo has a `correct-course`-labeled issue **created after** the slice issues it affects. This is the cheapest possible detector and it is one `gh issue list --json createdAt` away.
- A slice's `## User Stories Addressed` cites story numbers that do not describe what the slice does. Slice #3 claims "User story 7, 9"; the current PRD's evaluator story is **11**, while 7 is now complaints-as-their-own-draft and 9 is config editability. The citation is a *positional* reference into a renumbered list, so it rots silently — the numbers still resolve, they just resolve to the wrong stories.
- A slice's boundary map and the PRD's Rabbit Holes prescribe opposite things for the same field.
- Terminology in the slice matches an older section name. Slice #3 cites "PRD #1 §Error Modes, item 2" and a "regex scores precision 0.78 / recall 0.69" figure; the current PRD has no §Error Modes and no such figure — the section was reorganised into §Rabbit Holes.

## Root Cause

Two failures, and the second is the durable one.

**1. Decomposition copies rather than references.** `/prd-to-issues` writes the PRD's content *into* each slice — user-story numbers, boundary maps, assumptions, section citations. That is deliberate and correct: a slice has to be legible on its own, months later, without its reader reconstructing the PRD. But a copy is a snapshot, and the copy carries no record of which PRD revision it was taken from.

**2. Nothing owns re-synchronisation, and the drift emits no signal.** `/correct-course` edits the PRD body. It does not — and arguably should not — rewrite 21 slice bodies. But no step downstream compares them either, so a stale slice looks *exactly* like a fresh one: it has a boundary map, acceptance criteria, and story citations, all well-formed. The failure is silent in the strict sense that every artifact individually passes every check that exists.

The delay is what makes it dangerous. Between decomposition and execution the slice is unread, so the drift accrues with no cost; the bill arrives at implementation time, when the implementer is least inclined to stop and go verify the parent.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** A missing feedback link plus a long delay. Re-shaping updates the PRD (the source), execution reads the slice (the copy), and there is no path from the first back to the second. The gap is invisible for exactly as long as nobody implements the affected slice, which is why it is discovered one slice at a time and always at the most expensive moment. Each additional slice decomposed before the correction widens the exposure without producing any signal that it has.

## Rule Scope

- **Applies when:** a PRD (or any parent spec) was revised *after* child issues were decomposed from it, **and** the children embed copied content — positional citations (story numbers, section names), declared types, or assumptions. Strongest when the revision was a `/correct-course` that replaced assumptions rather than adding scope, because assumption replacement changes what existing slices *mean* without changing what they *say*.
- **Inverts or does not apply when:**
  - The revision **supersedes** the slice rather than contradicting a detail of it — a new No-go that kills the work, or a scope cut that removes it. Reconciling is then exactly wrong; the slice should be closed or reshaped via `/correct-course`, not harmonised. The discriminator: ask whether both constraints *can* hold at once. If they cannot, this is not drift, it is a cancelled slice.
  - The parent references rather than copies (a link to a living section instead of an inlined snapshot). Then there is no copy to go stale, and the corresponding cost is that the slice stops being self-contained.
  - The child was decomposed *after* the revision. Check timestamps rather than assuming — in this repo, slices #14–#23 look "late" by issue number and are still pre-correction.
- **Sibling docs:** [`inferred-config-guesses-the-axis-not-the-values-2026-08-08.md`](./inferred-config-guesses-the-axis-not-the-values-2026-08-08.md) — the same correct-course, seen from the other end: what the stakeholder answer invalidated. [`boundary-map-signatures-must-be-type-reachable-2026-08-08.md`](./boundary-map-signatures-must-be-type-reachable-2026-08-08.md) — the adjacent case where a slice declaration is defective *at authoring time* rather than made stale later.

## Solution

**When the PRD and the slice contradict, do not pick a winner. Look for the shape that satisfies both constraints, and only escalate if none exists.**

The contradiction here looked binary — report per-type metrics, or drop them. It was not. The PRD's actual requirement is in its own wording: per-type accuracy must not be *"quietly reported as if real."* The operative word is **quietly**, and that is a constraint on *how* the numbers travel, not on whether they exist.

**Before** — reading it as a choice between two artifacts:

```ts
// Option A: obey the slice, contradict the PRD's honesty requirement.
type ClassMetrics = { className: string; precision: number; recall: number; support: number };

// Option B: obey the PRD, break the slice's declared contract and any
// downstream consumer that types against EvalReport.
type EvalReport = { signal: ClassMetrics[]; /* engagementType dropped */ };
```

**After** — the shape that satisfies both:

```ts
type ClassMetrics = {
  className: string;
  precision: number;
  recall: number;
  support: number;
  /**
   * True when `support` is too small for the rates above to mean anything.
   * PRD #1 §Rabbit Holes requires per-type accuracy not be "quietly reported
   * as if real"; a flag on the record is how that becomes structural rather
   * than a doc comment nobody reads.
   */
  unmeasurable: boolean;
};
```

The slice's declared field survives, so downstream slices typing against `EvalReport` still compile. The PRD's honesty constraint is enforced *in the type*, so a consumer cannot read the rate without also receiving the disclaimer — which is strictly stronger than dropping the field, because dropping it would have left the question "how good is per-type?" unanswered rather than answered-with-caveat.

Record the reconciliation on the slice issue as a comment, not a body edit — the original declaration and the reason it moved are both worth reading later (the convention established in the sibling doc).

## Prevention

**Code-level:** Not applicable — no code artifact can detect a drifted issue body. The nearest equivalent is what this slice did anyway: encode the contested constraint *in the type* (`unmeasurable: boolean`) so the reconciliation cannot be silently unwound by a later edit.

**Process-level:**

1. **Cite user stories by text, not by number.** `/prd-to-issues` writing `- User story 11` creates a positional reference into a list that re-shaping renumbers. `- User story: "As an evaluator, I want signal-vs-none precision and recall with support counts…"` survives renumbering and fails *visibly* when the story is deleted. This is the single highest-leverage change here, and it costs one line per slice.
2. **Stamp the parent revision into each slice at decomposition.** A `Decomposed from PRD #1 @ <comment-id or ISO timestamp>` line lets any later step compare against the PRD's current `updatedAt` mechanically, instead of a human noticing prose disagrees.
3. **Add a staleness check to `/execute` Step 0.** Alongside the existing Consumes gate: if a `correct-course` issue exists whose `createdAt` is later than this slice's, read it before implementing. One `gh issue list` call, and it is the check that would have caught this one.
4. **`/correct-course` should enumerate its blast radius.** When it revises a PRD, list the already-decomposed slices and post a one-line note on each affected one — not a rewrite, just a pointer. Cheap to emit at the moment the information exists; expensive to reconstruct later.

Items 1, 3, and 4 are Skill Kit changes rather than project changes — worth raising via `/improve-pipeline`.

## Planning / Calibration Notes

- **What widened the work:** Reconciling the contradiction cost roughly 20 minutes of reading PRD, slice, and the correct-course comment side by side before any code was written, plus one added field and its test. Small here — but only because it was caught at Step 0. Absorbed mid-implementation it would have meant either a wrong-and-shipped per-type report or a late boundary-map change.
- **What tightened the work:** The correct-course comment on #3 explicitly said the taxonomy question *"moves to re-shaping, not here"* and that the harness should be taxonomy-agnostic machinery. That one sentence pre-authorised the reconciliation and made the decision fast. Correct-course comments that name what is *out* of scope for a slice are disproportionately valuable.
- **Future planning adjustment:** `/execute` Step 0 should treat "a correct-course issue postdates this slice" as a first-class gate alongside the blocked-by and Consumes checks. `/prd-to-issues` should cite stories by text.

## Actuals Worth Reusing

- **Comparable future work:** Every remaining open slice in this milestone — #4, #10, and #14–#23 were all decomposed before #24 and carry the same exposure.
- **Reusable baseline:** Checking a slice against a post-dating correct-course costs ~10 minutes and one `gh issue view`. Assume it is needed for every pre-#24 slice in this repo rather than re-deciding per slice.

## Key Decision

**Decision:** Reconcile PRD and slice by finding the shape that satisfies both, rather than treating the PRD as the tiebreaker.
**Rationale:** The PRD is the source of truth about *intent*; the slice is the contract downstream slices type against. Letting the PRD win silently breaks compilation for consumers that were decomposed against the slice; letting the slice win ships something the PRD explicitly forbade. The reconciliation cost one boolean.
**Alternatives considered:** (a) Drop `engagementType` per the PRD — rejected, breaks the declared contract and answers a real question with silence. (b) Report per-type unqualified per the slice — rejected, this is the precise thing the PRD names as the failure mode. (c) Backtrack via `/correct-course` to reshape #3 — rejected as disproportionate, because both constraints could hold at once; this would be the right call if they could not.
**Revisable:** Yes. If JA supplies a definitive category list and the labeled sample is re-annotated against it, per-type support rises and the `unmeasurable` flag stops firing — at which point the constraint that motivated it no longer binds.

## Related

- PR #25 — Eval harness + keyword baseline
- Issue #3 — boundary-map correction comment, 2026-08-08
- Issue #24 — CORRECT-COURSE: stakeholder answers replace four PRD assumptions
- PRD #1 §Rabbit Holes — "Taxonomy/ground-truth mismatch"

## Shelf Life

Evergreen as a principle — any pipeline that decomposes a parent spec into children by copying will have this failure mode. The specific JA instance expires when every pre-#24 slice has been either implemented or re-synced against the current PRD.
