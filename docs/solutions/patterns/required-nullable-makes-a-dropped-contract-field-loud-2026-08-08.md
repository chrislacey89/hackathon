---
date: 2026-08-08
category: patterns
problem_type: shared-schema evolution across parallel slices
components: [domain-schema, classify, run-file, emit]
technologies: [zod, typescript, ai-sdk]
severity: medium
volatility: stable
---

# A required-but-nullable field makes a dropped contract field loud; `.optional()` makes it silent

## Problem

Two slices developed in parallel both touched one shared schema. #18 added a field
(`quotable`) to `SentenceVerdictSchema`; #14 added a factory that *derives a narrowed
copy* of that same schema for the model boundary. Git merged both cleanly, because they
edited different lines. Nothing in the merge checks that the derived copy still carries
the added field.

## Context

`SentenceVerdictSchema` has two consumers pulling in opposite directions:

- **Read-back** — `run-file.ts` validates verdicts coming off disk and must not import
  the AI SDK.
- **Outbound** — `classify.ts` needs the same shape with `engagementType` narrowed to the
  categories the run loaded, so Gemini's structured output is constrained to a closed set.

#14 introduced `sentenceVerdictSchemaFor(categoryIds)` for the second. It narrows by
`.extend()` on the base schema, so any field #18 added to the base flows through
automatically. That is correct — but it is correct *by construction of the implementation*,
and a future rewrite that built a fresh `z.object()` here would look equally reasonable.

The question this doc answers is what happens then.

## Symptoms

Recognise the shape before the merge, not after:

- Two in-flight slices both name the same schema module in their boundary maps.
- One slice *adds a field*; the other *derives, narrows, or re-declares* the same shape.
- Git reports a clean auto-merge, because the edits are on different lines.
- The derived copy is consumed at a boundary — a model, a wire format, an external API —
  where a missing field produces a *default-looking* value rather than an error.

## Root Cause

**The near-miss was real; the failure mode I first assigned to it was not.** The initial
assumption was that dropping `quotable` from the outbound schema would fail silently: the
model would never be asked, every verdict would come back with no judgement, and an empty
quotes document would read as "nothing worth quoting" rather than "we stopped asking."

Constructing the regression showed that is wrong. It is caught **twice**:

1. **Typecheck** — `TS2741: Property 'quotable' is missing in type ... but required in type
   SentenceVerdict`. The narrowed schema's inferred type stops being assignable to the
   type `classifyResponse` returns.
2. **`parseRun`** — `Invalid input: expected boolean, received undefined at ['quotable']`.
   The read-back schema rejects a verdict with no `quotable` key.

Both guards exist for one reason: #18 declared the field **required-but-nullable**
(`z.boolean().nullable()`), not optional. `null` is a value the producer must
affirmatively supply, so *absent* is unrepresentable and a drop cannot be mistaken for
"the model had no opinion."

Had the field been `.optional()`, both guards would have evaporated. The inferred type
would still be assignable, `parseRun` would still accept the verdict, and the only
observable difference would be an empty quotes document — the exact silent degradation
first assumed.

So the durable lesson is not "add a test for the derived schema." It is that the
nullability decision made at field-declaration time determines whether a *whole class* of
downstream merge accident is loud or silent, and that decision is made by the slice adding
the field, usually before the slice that will derive the schema even exists.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** The producing slice and the deriving slice are separated in
  time and authorship, and git's merge is line-based while the invariant is
  schema-shaped — so no signal fires at the moment the two meet. The cost of the wrong
  nullability choice is paid at an arbitrary later merge, by someone who did not make it.
  Required-but-nullable converts that delayed, invisible cost into an immediate compile
  error.

## Rule Scope

- **Applies when:** a schema field's *absence* and one of its *values* would be
  interpreted differently by a downstream consumer — most sharply when the field records a
  judgement, a measurement, or a decision that a producer can legitimately decline to make
  ("not judged", "not measured", "not applicable"). Strongest when the schema is derived,
  narrowed, or re-declared anywhere, because that is where a field can be dropped without
  anyone editing the field's own line.
- **Inverts or does not apply when:** the field is genuinely optional *in the domain* —
  additive metadata where absent and default mean the same thing to every consumer.
  Forcing `null` there adds a required key with no information in it, and every producer
  pays to write a value nobody reads. Also does not apply to schemas with exactly one
  producer and one consumer in the same module, where a drop is visible in one screen.
- **The discriminator:** ask whether a consumer could act differently on *absent* than on
  *the default*. If yes, required-but-nullable. If no, optional is fine.
- **Sibling docs:**
  [`inferred-config-guesses-the-axis-not-the-values-2026-08-08.md`](./inferred-config-guesses-the-axis-not-the-values-2026-08-08.md)
  — the adjacent case where the *schema itself* was the guess rather than a field within
  it, and row-level metadata could not express the uncertainty.

## Solution

**Before** — the shape that would have made the drop silent:

```ts
const SentenceVerdictSchema = z.object({
  // …
  quotable: z.boolean().optional(),
});
```

A derived schema that forgets `quotable` still type-checks, still parses, and produces
verdicts that read as "no opinion" forever.

**After** — the shape that ships:

```ts
const SentenceVerdictSchema = z.object({
  // …
  // Required, not optional. `null` means NOT JUDGED — a state two producers
  // legitimately occupy (the keyword baseline scores signal only; run.json
  // artifacts predate the field). Making absence unrepresentable is what stops a
  // dropped field being mistaken for a judgement.
  quotable: z.boolean().nullable(),
});
```

The derived schema inherits it via `.extend()`, and the two guards above fire if it ever
stops doing so.

A cheap explicit assertion is still worth having, but as *documentation of a co-owned
contract*, not as the safety net — the safety net is the nullability choice:

```ts
it("still asks the model for every field, quotability included", () => {
  const emitted = z.toJSONSchema(schema, { io: "output" });
  expect(Object.keys(emitted.properties).sort()).toEqual([
    "column", "confidence", "engagementType", "quotable",
    "quote", "sentenceIndex", "serviceRecovery", "signal",
  ]);
});
```

Asserted against the **emitted JSON Schema** rather than the Zod object, because that is
the artifact the provider actually receives.

## Prevention

**Code-level:** When adding a field to a schema that any other module derives, narrows, or
re-declares, choose required-but-nullable unless absent and default are interchangeable to
every consumer. Where the schema crosses a provider boundary, assert against the *emitted*
schema — a Zod-level assertion can pass while the serialised form the provider sees is
missing the field.

**Process-level:** At `/execute` Step 0, the Consumes gate already checks that upstream
symbols exist and match their declared shape. Extend the same scepticism to *sibling*
slices in flight: if another open slice names the same schema module, check whether one
adds a field while the other derives the shape. That pairing is invisible to git and is
the specific condition this doc describes.

Also: **verify the failure mode before writing the guard.** The test here was originally
written and committed with a justification that turned out to be false. The test survived
scrutiny; its stated reason did not. A guard whose rationale is wrong is worse than no
comment — it teaches the next reader a threat model the system does not actually have, and
it hides the real mechanism (here, a nullability decision made in a different slice).
Constructing the regression took one throwaway file and settled it in under a minute.

## Planning / Calibration Notes

- **What widened the work:** nothing measurable — the merge itself was ~20 minutes, and
  the two conflicts were structural rather than semantic because the slices were genuinely
  orthogonal (`quotes.ts` reads no field #14 touched).
- **What tightened the work:** #18's required-but-nullable decision, made before #14's
  factory existed, is what made the merge safe to verify quickly rather than requiring a
  live model run to trust.
- **Future planning adjustment:** when `/prd-to-issues` decomposes two slices that both
  name a shared schema module in their boundary maps, note the pairing explicitly in the
  later slice's Consumes — "adds a field to X" versus "derives X" is a merge hazard worth
  one line at decomposition time.

## Actuals Worth Reusing

- **Comparable future work:** any two slices in flight against one shared contract —
  schema, wire format, config shape, or event payload.
- **Reusable baseline:** verifying a suspected silent-merge hazard cost one throwaway
  script and one `pnpm typecheck`. Cheap enough that it should be the default response to
  "this could fail silently," rather than writing the guard and moving on.

## Key Decision

**Decision:** Declare a judgement-carrying schema field required-but-nullable rather than
optional.
**Rationale:** It makes *absent* unrepresentable, which converts a class of downstream
merge accident from silent degradation into a compile error plus a parse rejection.
**Alternatives considered:** (a) `.optional()` — rejected, it collapses "not judged" and
"field dropped" into one observable state; (b) `.default(false)` — rejected by #18 for the
same reason, since it makes "the pass is broken" and "there were no quotes" render
identically.
**Revisable:** Yes, per field — if a field's absence stops being semantically distinct
from its default, optional is the lighter choice.

## Related

- PR #27 — Route on (category, county) with JA's config-defined taxonomy
- PR #28 — Quotes stream + consent filter (the slice that made the nullability decision)
- Issue #14, Issue #18

## Shelf Life

Stable. Expires if `SentenceVerdictSchema` stops being derived anywhere — at that point
there is one declaration, a dropped field is visible in one screen, and the nullability
choice reverts to an ordinary domain-modelling question.
