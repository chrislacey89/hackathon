---
date: 2026-08-08
category: patterns
problem_type: inferred-configuration modelling
components: [config, routing, boundary-maps]
technologies: [zod, json-config]
severity: high
volatility: evergreen
---

# An `inferred: true` flag marks the values provisional, not the axis

## Problem

We inferred JA's lead-routing table as `engagementType → team → recipient`, marked the guessed rows `inferred: true`, and shipped it as `config/teams.example.json`. When the stakeholder answered, the values were not merely wrong — **the axis was wrong.** JA routes by `county × program → manager`. Nothing about `engagementType` partitions their org chart.

The honesty flag could not have caught this. It annotates rows *within* a schema; the guess was the schema.

## Context

Slice #2 of the Volunteer Intent Router (PR #13) needed a routing table so the tracer could send one classified lead to one recipient. The stakeholder interview (`KAREN-QUESTIONS.md`) was outstanding, so the table was inferred from two sources: the six engagement types the survey data exposes, and three handoffs a second contact had described (committee prospect → development, employer introduction → corporate partnerships, repeat classroom volunteer → program staff).

That produced a four-team table. Three rows carried `inferred: true` per the PRD's own resolution to its "JA adopting our guesses as policy" rabbit hole.

Both inputs pointed at the same axis, and both were misleading in the same way. The survey data exposes engagement type per response, so engagement type is the axis available to infer *from*. The three confirmed handoffs were real, but they were the three cases where the county dimension happens not to disambiguate — so they read as confirmation of an axis they never tested.

## Symptoms

Recognise this shape before the answer arrives, not after:

- The inferred mapping's key is a field your **input data** exposes, rather than a field your **stakeholder's organisation** is partitioned by.
- The evidence for the mapping is a handful of confirmed instances, none of which discriminate between competing axes.
- The artifact mirrors the real organisation closely enough to be read as a description of it — real team names, plausible ownership.
- Provisional-ness is expressed as row metadata (`inferred: true`, a comment, a doc) rather than as structure.

## Root Cause

Two distinct failures, and only the first is obvious.

**1. Axis inference follows data availability, not domain reality.** We had `engagementType` for every response and no county field anywhere in the export, so the routing key we could compute was the routing key we proposed. The organisation's actual partition (county, then program) was unobservable from the input and therefore never a candidate.

**2. `inferred: true` is unable to express the failure.** The flag lives on a row of a `Team` record. To say "the axis may be wrong" it would have to annotate the type of `Config.teams` itself. A schema cannot flag itself as provisional from the inside, so the mechanism the PRD chose to mitigate this risk was structurally incapable of mitigating this instance of it.

The second failure is the durable one. The PRD named the risk correctly — *"a confident-looking ranking built on invented weights and an invented team could get treated as validated"* — and prescribed a resolution that addresses only value-level invention.

## Learning Level

- **Level:** Structure
- **Feedback loop or delay:** A long delay between authoring the inference and receiving the ground truth, with no cheap intermediate signal. During that window the artifact is indistinguishable from a validated one — and each downstream slice that reads it (`route`, the queue UI, the weights editor) increases the cost of changing the axis. The inference hardens precisely while it is least verified.

## Rule Scope

- **Applies when:** a config artifact encodes a mapping whose **key** was inferred rather than supplied by the domain owner; the inference drew its key from fields present in the input data; and downstream modules will type against that key. Strongest when the stakeholder answer is outstanding but expected.
- **Inverts or does not apply when:** the domain owner supplied the axis and only the values are provisional — that is exactly the case `inferred: true` handles well, and a richer table is then genuinely more useful than a thin one. Also does not apply when the mapping is internal and has no external ground truth to be wrong about (a feature-flag table, an internal enum→handler map).
- **Sibling docs:** [`boundary-map-signatures-must-be-type-reachable-2026-08-08.md`](./boundary-map-signatures-must-be-type-reachable-2026-08-08.md) — the adjacent case where a *declared* contract is unimplementable rather than unvalidated.

## Solution

Collapse the inferred artifact until it can no longer assert the axis.

**Before** — four teams, three flagged, structurally a claim about JA's org chart:

```json
{
  "teams": [
    { "id": "program-staff", "label": "Program Staff",
      "owns": ["volunteer_again", "speaking"], "inferred": true },
    { "id": "development", "label": "Development",
      "owns": ["committee_board", "donation"], "inferred": true },
    { "id": "corporate-partnerships", "label": "Corporate Partnerships",
      "owns": ["corporate_sponsorship"], "inferred": false },
    { "id": "volunteer-recruitment", "label": "Volunteer Recruitment",
      "owns": ["refer_colleague"], "inferred": true }
  ]
}
```

**After** — one placeholder owning everything; asserts nothing about how JA is partitioned:

```json
{
  "teams": [
    { "id": "placeholder-team", "label": "Placeholder Team",
      "owns": ["volunteer_again", "speaking", "refer_colleague",
               "committee_board", "corporate_sponsorship", "donation"],
      "inferred": true }
  ]
}
```

The single team still owns every engagement type, so the pipeline stays exercisable end to end and `unowned` stays empty — that is the property the tracer needs. The taxonomy is not.

The confirmed knowledge is not discarded; it moves to prose (`KAREN-QUESTIONS.md`), where it cannot be mistaken for a shipped mapping and cannot be typed against.

## Prevention

**Code-level:** Assert the placeholder's shape, not its contents. A test reading `expect(config.teams).toHaveLength(1)` with a comment naming the outstanding question fails loudly the moment someone elaborates the table before the answer lands — which is the moment the axis silently hardens. Keep inferred mappings *total* (one bucket owning everything) rather than *partitioned*; a partition is the assertion.

**Process-level:** During `/write-a-prd`, for each config mapping the PRD proposes, ask **"is the key of this map a field our input data exposes, or a field the domain owner's organisation is partitioned by?"** When those differ, the map is an axis guess and belongs in the Rabbit Holes section with a resolution stronger than a flag. When `/research` cannot resolve the axis, prefer a total single-bucket placeholder over a plausible partition, and say so in the slice's Produces.

Note for the resolution language specifically: *"every inferred row carries `inferred: true`"* is a sound resolution for value-level invention and an unsound one for axis-level invention. A PRD proposing it should state which kind it is guarding against.

## Planning / Calibration Notes

- **What widened the work:** nothing measurably — the elaborate table cost minutes to write and minutes to remove. The exposure was latent: had slices #7 (queues UI) or #9 (routing editor) been built against it, the axis would have been load-bearing across three modules before the answer arrived.
- **What tightened the work:** the correct-course comment on #2 arrived *before* any downstream slice consumed `Config.teams`, so the change was one file and one test. Cheap only because of when it landed.
- **Future planning adjustment:** `/prd-to-issues` should sequence slices that *consume* an inferred mapping after the slice that resolves it, or explicitly accept the rework. Here, #7 and #9 both type against `Config.teams` and both were decomposed before the interview returned.

## Actuals Worth Reusing

- **Comparable future work:** any feature whose routing, ownership, or assignment rules come from a stakeholder interview that has not yet returned.
- **Reusable baseline:** the cost of a total single-bucket placeholder is roughly zero; the cost of a plausible partition is zero *until* a second module types against it, then it is the cost of changing every consumer. Sequence accordingly.

## Key Decision

**Decision:** Ship inferred mappings as a single total bucket rather than a plausible partition, until the domain owner supplies the axis.
**Rationale:** A partition is an assertion about the domain that no row-level flag can retract. A total bucket exercises the same code paths without asserting anything.
**Alternatives considered:** (a) keep the four-team table and rely on `inferred: true` — rejected, it cannot express axis uncertainty; (b) omit the example config entirely and require `teams.json` — rejected, it breaks the fresh-clone run and the PRD requires a committed fallback.
**Revisable:** Yes — once JA supplies the routing axis, the example should carry a realistic shape, because at that point the axis is knowledge rather than inference.

## Outcome (2026-08-08, PR #27)

The axis landed, and the placeholder behaved as this doc predicted it would.

`Config` now carries `categories` and `counties`, and `Team.owns` is a list of
`(category, county)` pairs. `config/teams.example.json` was rebuilt against the new axis
and is **still one placeholder team owning everything** — the Prevention advice held under
the rewrite rather than being abandoned once the real shape arrived.

Three things are worth recording because they refine the original advice:

1. **"Total, not partitioned" needed restating once the axis became two-dimensional.**
   With one dimension, total is obvious: one team owns every type. With two, "total" means
   the cross product, and there is a tempting shortcut — a wildcard row (`county: "*"`).
   The wildcard was rejected precisely on this doc's logic: it would silently swallow
   Tippecanoe and Elkhart when the real four-market export arrives, claiming ownership of
   leads JA never assigned. Enumerating all 7 × 1 pairs means a new county surfaces as
   `unowned` and visible. **The rule generalises as: a total placeholder must be total over
   the values you have seen, never over the values you might see.**

2. **The `expect(config.teams).toHaveLength(1)` guard survived and is still doing its job**
   — it now sits alongside assertions that every category and every county row carries
   `inferred: true`.

3. **The two halves of the axis have different epistemics, and only one stayed a
   placeholder.** `school → county` is geography: publicly checkable, and a wrong row
   misroutes one lead visibly. It ships *seeded* with all 12 schools, flagged `inferred`.
   `county → manager` is JA's org chart: not inferrable, and it stays a placeholder. The
   original doc treated "the inferred mapping" as one thing; a two-dimensional key can
   have one dimension that is honestly guessable and one that is not, and collapsing them
   would have meant either shipping an empty lookup or inventing an org chart.

## Related

- PR #13 — TRACER: end-to-end spine
- PR #27 — Routing model: JA categories × county (the rewrite that met this doc's expiry
  condition)
- Issue #2, correct-course comment 2026-08-08
- Issue #14, unblock comment 2026-08-08 — the geography-vs-org-chart split in point 3
- PRD #1 §Rabbit Holes — "JA adopting our guesses as policy"
- `KAREN-QUESTIONS.md` — the outstanding questions this inference was standing in for
- [`required-nullable-makes-a-dropped-contract-field-loud-2026-08-08.md`](./required-nullable-makes-a-dropped-contract-field-loud-2026-08-08.md)
  — the adjacent case where a *field within* a shared schema, rather than the schema's
  axis, is what a later slice can silently lose

## Shelf Life

**Expiry condition met 2026-08-08 (PR #27)** — the axis is encoded in `Config` and
`config/teams.example.json` has been rebuilt against it. The specific JA routing instance
is now history rather than live guidance; it is retained because the Outcome section above
records how the advice behaved under the rewrite, which is the part worth reusing.

The principle remains evergreen: ship inferred mappings as a total single bucket rather
than a plausible partition, and prefer a wrong-but-visible `unmapped` to a
plausible-and-invisible default. Delete this document only when nothing in the repo
depends on an inferred mapping — at which point the JA instance and the principle both
stop earning their keep.
