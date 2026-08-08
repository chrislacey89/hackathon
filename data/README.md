# Project 11 - JA Volunteer Re-Engagement Finder

## What JA told us (Rachael Caslow, Aug 6)

**The output is a routed list, not one flat list.** Asked what happens to these
leads today:

> "Staff review the responses and send emails to other teams if there are
> volunteers who are interested in participating in other ways."

So a human reads every response and hand-routes the interesting ones to whichever
internal team should act - development for a committee prospect, corporate
partnerships for an employer introduction, program staff for a repeat classroom
volunteer. That is the work being replaced.

Build for it. Group your output by **who at JA should follow up**, not just by
who is interested. The `engagement_type` field in the ground truth maps onto
exactly that, and a list already sorted into the right inboxes is worth far more
than a ranked list someone still has to triage.

**They are not attached to the current survey.** Rachael: "we are not tied to
necessarily asking these questions or having this exact structure." So if your
analysis is easier with two extra structured questions, propose them. Changing
the instrument is on the table.

**Karen Cooper, Chief Program Officer, is available Saturday.** She ran this area
before her promotion, so she is the person who knows how the follow-up actually
works. Ask an organizer for her number rather than passing it around.

## Note on the columns

Rachael sent JA's real column headers as a screenshot. If they have been
transcribed into this pack, the generated CSV uses them; if the columns below
still look generic, they have not, and an organizer has the image. Either way the
shape is right and the analysis does not change.

---

# Synthetic data

**Synthetic.** No real volunteer, donor, or survey data. Response patterns are
modeled on what post-program volunteer surveys actually look like.

## Files

| File | What it is |
|---|---|
| `volunteer_survey_export.csv` | 384 survey responses. Your input. |
| `ground_truth_labeled_sample.csv` | 150 responses labeled with the correct answer. Hold some back rather than tuning against all of it. |

## Schema

| Column | Notes |
|---|---|
| `response_id` | `JA-#####` |
| `submitted_at` | ISO timestamp |
| `program` | JA BizTown, Finance Park, JA in a Day, Career Speaker Series, Company Program, Inspire |
| `school`, `employer`, `role_this_year` | Context for prioritizing |
| `volunteer_name`, `volunteer_email` | Who to follow up with |
| `q1_overall_satisfaction`, `q2_would_recommend`, `q3_felt_prepared` | 1-5 |
| `q4_volunteer_again` | `Yes` / `No` / `Maybe` / blank. **Frequently blank.** |
| `q5_what_went_well` | Free text |
| `q6_what_could_improve` | Free text |
| `q7_anything_else` | Free text - the richest field |
| `opt_in_contact` | `Yes` / `No` / blank |

## Ground truth labels

- `engagement_signal` - `strong`, `soft`, or `none`
- `engagement_type` - `volunteer_again`, `committee_board`, `corporate_sponsorship`, `refer_colleague`, `speaking`, `donation`
- `signal_found_in_column` - which field the signal actually lives in
- `service_recovery_flag` - `Y` where the response is a complaint someone should answer

## The trap this data is built around

**Enthusiasm is not intent.** Roughly a third of respondents write something
genuinely glowing - "best volunteer experience I've had in years" - with no
forward-looking statement at all. A sentiment classifier will flag every one of
them, and a list of everyone who was happy is just the whole roster. It is worth
nothing to JA.

The signal you want is a **specific statement about doing something next**: come
back, join a committee, introduce their employer, refer a colleague, speak, give.
"I loved it" is not that. "Sign me up for spring" is.

## Three more things built into the data

1. **Signal in the wrong field.** About 5% of responses bury the intent in
   `q6_what_could_improve` - "more prep time, that said put me down for next
   fall." Read every free-text column, not just the last one.
2. **Structured and unstructured disagree.** `q4_volunteer_again` is blank for a
   lot of people who clearly state intent in prose, and says `Yes` for plenty who
   wrote nothing meaningful. Trusting either field alone gets you a bad list.
3. **Complaints are a second, valuable output.** Around 7% are unhappy about
   something concrete and fixable. Surfacing those for service recovery is a real
   deliverable, not a distraction.

## Which errors matter

Bias toward recall. Missing a volunteer who wanted to do more costs JA a person
they already recruited once. A false positive costs one slightly awkward email.
Those are not the same size mistake, and your threshold should say so.

## Suggested approach

The Likert columns are rules - no model needed. The free text is where a model
earns its place, but classify the *sentence*, not the response: one response can
contain a complaint and an offer to come back.

Report precision and recall separately against the labeled sample, and show
which category you get wrong most. "94% recall on strong signals, but we
over-flag warm-no-intent at 22%" is a real finding.
