# JA Volunteer Intent Router

Reads post-program survey exports, finds the volunteers whose free-text answers
contain an offer to come back — including the ones buried inside complaints in
*"what could improve"* — and puts them in a ranked queue a coordinator can copy
into an email and mark off as sent.

**Nothing is ever sent automatically.** The tool reads a file, classifies text,
and writes to the clipboard and a local log. Every email is composed and sent
by a human in their own mail client.

If you are the coordinator using this day to day, read
[`docs/handoff/GUIDE-FOR-KAREN.md`](docs/handoff/GUIDE-FOR-KAREN.md) instead —
this page is for whoever sets it up.

## Setup

Requires Node 22+ and pnpm 10 (`corepack enable` handles pnpm).

```sh
pnpm install
echo "GOOGLE_GENERATIVE_AI_API_KEY=<key>" > .env.local   # aistudio.google.com
pnpm run build && pnpm start                              # → localhost:3000
```

`pnpm run dev` works too; `build` + `start` is what to use in front of people.

The page renders from the committed `run.json` (384 classified responses), so
it works with no network and no API key. The key is only needed for the two
things that call the model:

- `pnpm run sweep` — classify `data/volunteer_survey_export.csv` in full
  (~3 min, one API call per response) and rewrite `run.json`.
- **Upload a survey CSV** in the app sidebar — classifies a small file
  (≤60 rows, ~15–30s) live and shows it as a second run beside the committed
  one.

## Demo files and reset

- `data/demo_upload_dummy.csv` — 20 fully synthetic rows the model has never
  seen. Use this one to show live classification.
- `data/demo_upload_sample.csv` — 24 rows drawn from the committed export.
- `pnpm run demo:reset` — wipes the three gitignored state files
  (`run.uploaded.json`, `sent-marks.jsonl`, `data/uploads/`) so the app opens
  fresh.

## What is real and what is placeholder

- **All data in this repo is synthetic** (see `data/README.md`). No real
  volunteer or survey data has been used or sent anywhere.
- **Recipients and teams are inferred placeholders** (`teams.example.json`).
  JA's real routing roster belongs in `config/teams.json`, which is gitignored
  because it is PII. The UI badges this honestly ("Routing inferred").
- **The sidebar logo is a stand-in monogram.** The brand guide says not to
  rebuild the lockup — it needs JANI's approved SVG.
- **Measurement is honest by construction**: model scores render beside a
  keyword baseline with support counts, and on the current labeled sample the
  two tie — the page says so rather than hiding it. Hard negatives are the
  next measurement to build (issue #10).

## Before real survey data goes anywhere near this

Classifying means sending response text to Google's Gemini API. **JA has not
yet confirmed that its data-handling rules permit that for real survey
responses.** Until someone with authority says yes in writing, only synthetic
data goes in. This is the one gate that is about policy, not code.

## Layout

- `src/pipeline/` — CSV → sentence-level Gemini classification → routing →
  `run.json`. Effect-based; never imported by the app.
- `src/run/` — the app's side of the boundary: plain-promise readers/writers
  for `run.json` and the append-only `sent-marks.jsonl`.
- `src/app/` — Next.js UI. The only model calls it can trigger run in a child
  process via the upload Server Action.
- `src/eval/` — scoring against the labeled sample (`pnpm run eval`).
