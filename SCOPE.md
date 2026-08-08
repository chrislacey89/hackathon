# Volunteer Re-Engagement Finder

**Organization:** Junior Achievement of Northern Indiana

| | |
|---|---|
| **Difficulty** | Starter to Core |
| **Suggested team** | 1–2 people |
| **Before you start** | None — JA confirmed the workflow and the real column headers |

---

## The problem

JA runs its programs on corporate volunteers, and surveys them after every one. Buried in those free-text responses are people saying they want to do more — come back next year, join a committee, introduce their employer as a sponsor.

Reading hundreds of responses line by line is nobody's actual job, so those people never get called. Re-recruiting someone who already volunteered and enjoyed it is the cheapest growth JA has, and it is currently being left on the table.

---

## Build this

- Load a survey export and read **every** free-text column, not just the last one.
- Classify each respondent by **forward-looking intent**: strong, soft, or none.
- Identify the **kind of engagement** — volunteer again, committee, corporate sponsorship, referral, speaking, giving.
- **Group the output by which JA team should follow up.** That is how the handoff works today.
- Every row carries **the quote that triggered it**. Export to CSV.

---

## Out of scope — deliberately cut

- No CRM integration.
- Do not send any email.
- No authentication.
- No general sentiment dashboard — that is the thing this project is specifically *not*.

---

## Stretch goals — only after the core build works

- Draft a personalized follow-up email per lead, referencing what they actually said.
- A second list of complaints flagged for service recovery.
- Confidence scores, with borderline cases going to a review queue instead of being guessed.
- Deduplicate volunteers who appear across multiple programs and surveys.

---

## Suggested approach

The Likert columns are rules and need no model. The free text is where a model earns its place — but **classify at the sentence level**, because one response can hold both a complaint and an offer to come back.

---

## What a successful demo looks like

- Run the full export.
- Produce a **ranked top 20** with the supporting quote beside each name.
- Report **precision and recall** against the labeled sample — **separately, not blended**.

---

## What the organization is providing

- Their real column headers, and they are open to changing the survey itself.
- Confirmation of how leads are routed to JA teams today.

### Stakeholder notes (from the data pack README)

- **Rachael Caslow, Aug 6** — on what happens to leads today: *"Staff review the responses and send emails to other teams if there are volunteers who are interested in participating in other ways."* A human reads every response and hand-routes the interesting ones — development for a committee prospect, corporate partnerships for an employer introduction, program staff for a repeat classroom volunteer. **That is the work being replaced.**
- **They are not attached to the current survey.** Rachael: *"we are not tied to necessarily asking these questions or having this exact structure."* If the analysis is easier with two extra structured questions, propose them.
- **Karen Cooper, Chief Program Officer**, is available Saturday — she ran this area before her promotion and knows how follow-up actually works. Ask an organizer for her number.
- The real column headers came as a screenshot. If they were transcribed into the pack the CSV uses them; if the columns look generic they weren't, and an organizer has the image. The shape is right either way.

---

## The data

Pack copied to `data/` (see `data/README.md` for the original brief). **Synthetic** — no real volunteer, donor, or survey data.

| File | What it is |
|---|---|
| `data/volunteer_survey_export.csv` | 384 survey responses. The input. |
| `data/ground_truth_labeled_sample.csv` | 150 labeled responses. Hold some back rather than tuning against all of it. |

### Input schema

| Column | Notes |
|---|---|
| `response_id` | `JA-#####` |
| `submitted_at` | ISO timestamp |
| `program` | JA BizTown, Finance Park, JA in a Day, Career Speaker Series, Company Program, Inspire |
| `school`, `employer`, `role_this_year` | Context for prioritizing |
| `volunteer_name`, `volunteer_email` | Who to follow up with |
| `q1_overall_satisfaction`, `q2_would_recommend`, `q3_felt_prepared` | 1–5 |
| `q4_volunteer_again` | `Yes` / `No` / `Maybe` / blank. **Frequently blank.** |
| `q5_what_went_well` | Free text |
| `q6_what_could_improve` | Free text |
| `q7_anything_else` | Free text — the richest field |
| `opt_in_contact` | `Yes` / `No` / blank |

### Ground truth labels

| Column | Values |
|---|---|
| `engagement_signal` | `strong`, `soft`, `none` |
| `engagement_type` | `volunteer_again`, `committee_board`, `corporate_sponsorship`, `refer_colleague`, `speaking`, `donation` |
| `signal_found_in_column` | Which field the signal actually lives in |
| `service_recovery_flag` | `Y` where the response is a complaint someone should answer |

### Observed distribution in the labeled sample (n=150)

All 150 labeled IDs are present in the export; 234 export rows are unlabeled.

- **`engagement_signal`** — `none` 105, `soft` 23, `strong` 22. **Only 30% of the sample carries any signal at all.**
- **`engagement_type`** — `volunteer_again` 33, `corporate_sponsorship` 4, `committee_board` 3, `speaking` 2, `donation` 2, `refer_colleague` 1. The non-`volunteer_again` classes are **single-digit** — routing accuracy will be judged on very few examples each.
- **`signal_found_in_column`** — `q7_anything_else` 37, `q6_what_could_improve` 8. Notably **zero** in `q5_what_went_well` in this sample.
- **`service_recovery_flag`** — `Y` 19 (13% of the labeled sample).

### Full-export field behavior (n=384)

- `q4_volunteer_again`: `Maybe` 127, `Yes` 114, blank 113, `No` 30.
- `opt_in_contact`: `Yes` 234, blank 104, `No` 46.
- Blank free-text: `q5` 58, `q6` 44, `q7` 28.
- Programs are roughly balanced (48–77 responses each).

### Three more traps built into the data

1. **Signal in the wrong field.** ~5% bury intent in `q6_what_could_improve` — *"more prep time, that said put me down for next fall."* Read every free-text column.
2. **Structured and unstructured disagree.** `q4_volunteer_again` is blank for many who clearly state intent in prose, and `Yes` for plenty who wrote nothing meaningful. Trusting either alone gets you a bad list.
3. **Complaints are a second, valuable output.** ~7% are unhappy about something concrete and fixable. Surfacing those for service recovery is a real deliverable.

### Reporting bar

Report precision and recall **separately**, and show which category you get wrong most. *"94% recall on strong signals, but we over-flag warm-no-intent at 22%"* is a real finding.

---

## Build decisions (settled)

| Decision | Choice |
|---|---|
| **Surface** | CSV export **plus** a triage app — review UI, service-recovery queue, draft emails, confidence review queue |
| **Stack** | TypeScript/Node end-to-end. Next.js app + pipeline in one repo, deploys to Vercel |
| **Model layer** | Vercel AI SDK (`ai`) + `@ai-sdk/google`, Gemini. Zod schemas for structured output |
| **Config over code** | Routing table, signal thresholds, and queue caps live in one config file — JA's workflow decisions are data, not logic |
| **Routing default** | 4 inboxes (Program Staff / Development / Corporate Partnerships / Volunteer Recruitment), to be confirmed with Karen Cooper |
| **Signal → action** | `strong` + `soft` → inboxes (`soft` flagged), plus a capped near-miss review queue over `none`. Recall-biased per the brief |
| **Classification** | Sentence level, across `q5`, `q6`, `q7`. Likert columns are rules, no model |
| **Demo** | Reads a committed cached run, not live API calls |
| **Appetite** | Hard 8 hours, solo |

**Open:** rename to *Volunteer Intent Router* (routing is the deliverable; "Finder" implies search).

---

## Read this before you commit

**Enthusiasm is not intent, and that is the whole project.**

Roughly a third of respondents write something genuinely glowing with no forward-looking statement anywhere in it. A sentiment classifier flags every one of them and hands JA back its own roster, which is worth nothing.

**Bias toward recall.** Missing someone who wanted to help costs a volunteer JA already recruited once, while a false positive costs one awkward email.

**And route it.** Staff currently email leads on to whichever JA team should act, so a list sorted into the right inboxes beats a ranked list somebody still has to triage.
