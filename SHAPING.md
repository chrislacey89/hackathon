# Shaping output — Volunteer Re-Engagement Finder

Closing summary from the `/shape` session. This is the compressed handoff to `/research` — work from this rather than re-reading the transcript.

**Project:** Hackathon project #11, Junior Achievement of Northern Indiana.
**Brief and data notes:** `SCOPE.md`. **Karen interview:** `KAREN-QUESTIONS.md`.

---

## Problem

JA runs its programs on corporate volunteers and surveys them after every one. Some of those volunteers say, in free text, that they want to do more — come back next year, join a committee, introduce their employer, refer a colleague, speak, give. Reading hundreds of responses to find them is nobody's job, so those people are never contacted. Re-recruiting someone who already volunteered and enjoyed it is the cheapest growth JA has, and it is currently left on the table.

**The trap:** enthusiasm is not intent. Roughly a third of respondents write something glowing with no forward-looking statement at all. A tool that flags happiness hands JA back its own roster, which is worth nothing.

## Stakeholders

- **Uses it:** JA staff who currently read responses and hand-route the interesting ones to internal teams.
- **Pays for it:** JA of Northern Indiana (the hackathon itself is donated work).
- **Affected:** volunteers who do or don't get contacted; the internal teams who receive leads; volunteers with unresolved complaints.

## Appetite

**Hard 8 hours, solo.** Whatever exists at the buzzer is the deliverable. AI-assisted throughput is assumed — with one exception: prompt iteration against ground truth is a sequential human-speed loop and is the fixed cost the rest of the day expands around.

---

## Choices (settled — do not re-debate downstream)

1. **CSV export plus a full triage app** — review UI, service-recovery queue, draft follow-up emails, confidence review queue. Three of those four are brief-designated stretch goals, taken on deliberately.
2. **Stack:** TypeScript/Node end-to-end. Next.js app and pipeline in one repo, deploys to Vercel.
3. **Model layer:** Vercel AI SDK (`ai`) + `@ai-sdk/google`, Gemini, Zod schemas. Key in `GOOGLE_GENERATIVE_AI_API_KEY`.
4. **Flat schema, no discriminated unions.** Google structured outputs run on OpenAPI 3.0 and reject `z.union`/`z.record`. `engagementType` is a nullable enum; the "signal `none` ⇒ null type" invariant is enforced in code after parsing.
5. **JA's workflow decisions are config, not code** — routing table, thresholds, queue caps in one file.
6. **Teams are data, not an enum.** `teams: [{ id, label, owns: EngagementType[], recipientIds, inferred? }]`. Three teams or six, or a merge, is a value change rather than a schema change. This is what removes Karen from the critical path.
6a. **Two mappings, not one.** `engagement_type → team` is classification; `team → recipient` is delivery, and it can be many-to-one. `recipients: [{ id, name, email, role? }]` is a separate array so one person covering two functions gets **one bundle, not two**. Queues group by recipient, with the team as a label on each lead — the brief's "inboxes" are people.
6b. **Real recipient details never enter version control.** Karen's answer is the first real PII in an otherwise fully synthetic project. Commit `config/teams.example.json` with placeholders; gitignore the real `config/teams.json`; loader falls back to the example.
7. **Sentence-level classification** across `q5_what_went_well`, `q6_what_could_improve`, `q7_anything_else` — one response can hold both a complaint and an offer to return.
8. **Likert columns (`q1`–`q3`) are rules, no model.** `q4_volunteer_again` and `opt_in_contact` are weak evidence recorded as `structuredHint`; they never decide.
9. **Signal levels:** `strong`, `soft`, `none`.
10. **Engagement types (6):** `volunteer_again`, `committee_board`, `corporate_sponsorship`, `refer_colleague`, `speaking`, `donation`.
11. **Default routing table — 4 inboxes**, shipped as config, three rows marked `inferred`:

    | Team | Owns | Source |
    |---|---|---|
    | Program Staff | `volunteer_again`, `speaking` | first from README; `speaking` inferred |
    | Development | `committee_board`, `donation` | first from README; `donation` inferred |
    | Corporate Partnerships | `corporate_sponsorship` | README |
    | Volunteer Recruitment | `refer_colleague` | **invented — team may not exist** |

12. **Six queues:** four team inboxes, a capped **near-miss review queue** (borderline `none`s — the recall safety net), and a **service-recovery queue** (`serviceRecovery`, routed regardless of engagement signal). Plus a build-time `unowned` assertion — a routable lead with no owning team must be loud, not silently dropped.
13. **Signal → action:** `strong` and `soft` both route, `soft` visually flagged; `none` drops except near-misses. Recall-biased per the brief's explicit instruction.
13a. **Ranking is by value, not by confidence.** Confidence measures how sure the classifier was; it is not a priority order. A hesitant corporate-sponsorship signal may outrank a certain repeat-volunteer signal, and only JA can say. Per-type weights live in config and come from Karen (`KAREN-QUESTIONS.md` Q1) — captured as her judgment, including "it depends," not invented by us. `employer` and `role_this_year` are the data pack's own "context for prioritizing" and feed this, not the classifier.
13b. **Score is a pluggable sum, RFM-shaped but RFM-optional.** `score = typeWeight × signalWeight × confidence × contextMultiplier`, with recency / frequency / prior-giving multipliers defaulting to 1.0. If historical data arrives in time they slot in; if not, nothing is stubbed out or broken. **Historical data is opportunistic, not a dependency** — a CRM extract on Karen's weekend is real work, CRM integration is out of scope, and anything arriving Saturday afternoon is too late to use.
14. **Aggregation rule:** response signal = strongest sentence signal; type, quote, and source column come from that winning sentence; `serviceRecovery` true if *any* sentence flagged it. One response can appear in both a team inbox and the recovery queue.
15. **Every routed row carries the triggering quote and its source column.**
16. **Precision and recall reported separately, per class, with `support` counts** alongside rates.
17. **The demo reads a committed `run.json`** — never a live API call.
18. **Deliver a proposed survey revision** alongside the tool. The README invites it, and it addresses the cause rather than the symptom.

## The shape

```
volunteer_survey_export.csv
  └─ parse                  → SurveyResponse[]     (384)
  └─ split q5|q6|q7         → Sentence[]           (~1,000+)
  └─ classify (Gemini+Zod)  → SentenceVerdict[]    ← the only model call
  └─ aggregate per response → ResponseVerdict[]    (384)
  └─ rules layer (q1–q4, opt_in) ↑ sets structuredHint, never decides
  └─ route via Config.teams → RoutedLead[]
  └─ emit                   → run.json + leads.csv
                                  │
                        Next.js app reads run.json (committed)
```

`SentenceVerdict` = `{ signal, engagementType | null, confidence, serviceRecovery }`.
`ResponseVerdict` adds `{ responseId, quote, sourceColumn, structuredHint }`.
`RoutedLead` adds `{ teamId | null, recipientIds, name, email, employer, program }`.

---

## Assumptions

| Confidence | Assumption | Research question |
|---|---|---|
| **`Uncertain`** | Sending the supplied CSVs to the Gemini API is permitted. Hackathon ground rules reportedly forbid uploading supplied files to outside services. Sharper with Google than Anthropic: the **free tier uses submitted data to improve their products**; paid does not. | **The real gate — resolve before anything else.** Ask an organizer whether the rule covers synthetic supplied data. Separately confirm whether the key is free or paid tier. If the rule bites, this is a different project. |
| **`Uncertain`** | Rate limits support ~1,000+ calls in a day. Free-tier Gemini limits are per-minute and low. | Check the tier's RPM. If free, batching several sentences per call becomes a schedule decision, not an optimization. |
| `Uncertain` | A rich triage UI won't read to judges as the "general sentiment dashboard" the brief rules out. | Mitigate by what's on screen: inboxes, quotes, routing — no gauges, no average-satisfaction tiles. |
| `Uncertain` | A holdout split is viable. 150 labels, 22 `strong`, single-digit non-`volunteer_again` classes. | What split? Recommend 100 dev / 50 holdout, reporting per-class counts alongside rates. |
| `Uncertain` | Prefix caching helps. Gemini uses implicit/explicit context caching, not per-block `cacheControl` — the Anthropic plan doesn't carry over. | Re-check against the Google provider. Treat as optimization, not dependency. |
| **`Speculative`** | Prior-year survey or volunteer history exists in a usable, exportable form — enabling recency / frequency / prior-giving weighting. | Ask whether it exists; don't ask Karen to produce it (`KAREN-QUESTIONS.md` Q4). If it's a CRM extract, it's out of scope and too slow. Score function accepts these multipliers and defaults them to 1.0, so a "no" costs nothing. |
| **`Uncertain`** | JA has a settled view of relative intent value. Nonprofit intent is often vague or shifting, so the answer may be ranges or "it depends on X" rather than numbers. | Capture her actual model, including its hedges — encode ranges or conditional rules, don't force a scalar. A stated "it depends on the employer" is a real finding and belongs in the config as a context multiplier. |
| `Likely` | Karen confirms the routing table. **Not a gate** — teams-as-data absorbs any answer, and the default ships regardless. | One exception worth asking early: §3 of `KAREN-QUESTIONS.md`. If the handoff isn't per-lead email, the inbox metaphor the UI is built on is wrong — a redesign, not a config edit. |
| `Likely` | A Flash-tier model holds recall against the labeled sample. | A/B Flash vs Pro early. If Flash holds, biggest schedule win available. Confirm current model IDs at `ai.google.dev/gemini-api/docs/models` — do not trust cached IDs. |
| `Established` | ~30% of the labeled sample carries any signal; `q5` contains none of them; `q6` hides ~5%; neither CSV has any team or routing column. | Verified directly against the files. |

## Impositions

- Hard 8 hours, solo, no head start.
- Hackathon ground rules on external services.
- Brief's out-of-scope: no CRM integration, no email *sending*, no auth, no sentiment dashboard.
- Supplied data fixed: 384 responses, 150 labels, schema as given.
- Google structured outputs are OpenAPI 3.0 — no unions, no records.
- Nothing from Mimir — no code, no templates.

## Structural signals

- **Free-text responses have no downstream owner.** Routing depends on a human whose job it isn't. The tool substitutes for the missing owner; it doesn't create one.
- **No feedback loop on conversion.** Nobody knows which routed leads became volunteers, so nobody can tell whether the reading was worth doing. The tool inherits this blindness.
- **JA is not attached to the survey instrument** — the real upstream lever. A forward-looking structured question would dissolve most of this for future cycles, which reframes the tool honestly as backlog clearance plus unstructured residue, not a permanent answer.
- **The eval can't validate the routing.** With 1–4 examples in four of six types, per-inbox precision and recall are statistically meaningless. Say so in the demo rather than reporting a confident number over n=1.
- **Codegen compresses; evaluation doesn't.** The prompt-tuning loop runs at human speed regardless of throughput, and rate limits can only slow it.

## Open

- **Name.** Recommend **Volunteer Intent Router** — "Finder" implies search, and the current name omits routing, which is the deliverable. Undecided.

---

**Next session:** `/research volunteer-intent-router`
**Input:** this document
