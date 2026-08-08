# Finding the volunteers who want to come back

*A guide for the person working the follow-up queue. No technical background
needed — someone will set the app up for you and give you a link
(it looks like `localhost:3000` today).*

## What this does

After each program cycle, volunteers answer a survey. The useful part —
"put me on the list for next year," "our firm might sponsor a classroom" —
is typed into the comment boxes, and most often it's wrapped inside a
complaint in **"what could improve."** Those offers expire because nobody has
time to read 384 comment boxes.

This tool reads every sentence of every response and builds one queue of the
people worth following up with, strongest offers first. For each person it
shows **the exact sentence that made the cut**, highlighted inside the comment
it came from — so you're always judging the volunteer's own words, not the
computer's opinion.

## What it will never do

- **It never sends anything.** It has no connection to your email. You copy,
  you paste, you decide, you send.
- **It never hides a lead because of a mistake.** Marking things sent (or
  forgetting to) only changes what's shown as done — it can't make a
  volunteer disappear from a future run.

## The weekly loop

1. **Open the queue.** Strongest offers are at the top. The yellow
   **"What could improve?"** tag marks offers that were buried in complaints —
   the ones that used to be lost.
2. **Skim the highlighted sentences.** Trust your read over the tool's. The
   confidence number is the model's certainty, not a verdict.
3. **Copy.** The **Copy for Outlook** button puts the whole surfaced list on
   your clipboard as a formatted table — names, emails, programs, and each
   person's own words. Paste it into an email to whoever should act on it.
4. **Mark sent.** After you've sent a follow-up, click **Mark sent** on those
   people. Sent cards fade out, and the counter shows how many drafts remain —
   so if you're interrupted on Tuesday you can pick up Thursday where you
   stopped. Misclicked? The button turns into **undo**.
5. **New file, same steps.** When a new export lands, upload it with
   **Upload a survey CSV** in the sidebar. Small files classify in under half
   a minute while you watch; each upload keeps its own sent-marks.

## Reading the page honestly

- **"Routing inferred"** — the tool guessed which team owns each lead because
  we don't have your real routing list yet. Confirm the owner before sending.
- **The measurement table** shows how the model scores against a hand-labeled
  sample, next to a simple keyword search. On today's sample they tie. That's
  a fact about the sample (its "no" answers are short and easy), and the page
  says so rather than pretending otherwise.
- **Complaints** are counted separately from offers. A complaint that also
  contains an offer still shows in your queue, marked "service recovery."

## The one decision JA needs to make first

Classifying a survey means sending the response text to Google's AI service
(Gemini). Everything so far has used **made-up demo data only**. Before a real
export goes in, someone at JA with authority over data handling needs to okay
that — it's a privacy/policy question, not a technical one.

## Known limits, told straight

- Live upload takes files up to 60 rows; a full 384-row export is classified
  with a command your technical contact runs (about 3 minutes).
- The formatted paste has been verified in the browser but not yet into a real
  Outlook window — do one test paste before relying on it.
- One queue, one placeholder owner. Routing leads to the right JA team by
  county and program is designed but not built yet.
- There's no "this isn't a lead" button yet — if the model flags something
  silly, just skip it (don't mark it sent).
