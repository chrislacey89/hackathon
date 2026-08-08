import type { Config } from "../config/load";

/**
 * What the `school → county` lookup had to say about one response.
 *
 * A discriminated union rather than `string | null`, because the two outcomes
 * carry different payloads and the caller must handle both: a resolved county
 * is a routing key, an unmapped school is a config gap that has to reach the
 * `unmapped` surface carrying the school name an operator will need to fix it.
 * `null` would let a caller write `county ?? "Allen"` — the guess PRD #1
 * §Rabbit Holes forbids — without anything in the type objecting.
 */
export type CountyResolution =
  | { kind: "resolved"; county: string }
  | { kind: "unmapped"; school: string };

/**
 * Look up which county a school is in.
 *
 * Pure and total: no I/O, no clock, and every input — including a blank cell —
 * returns a resolution rather than throwing. County is the axis JA's
 * organisation is actually partitioned by, and it is not in the export; this
 * lookup is the only bridge, so it is the one place a wrong answer would
 * misroute every lead from a school at once.
 *
 * Matching is **exact**, deliberately. Issue #14's assumptions record that
 * `school` is a stable identifier in the real export rather than free text that
 * varies by typist, so normalising case or fuzzy-matching would buy nothing
 * real and would convert an honest `unmapped` into a confident wrong county.
 * The sample is single-county today, which makes that failure especially cheap
 * to make and impossible to see: every wrong guess would be right.
 */
export function resolveCounty(school: string, config: Config): CountyResolution {
  const row = config.counties.find((entry) => entry.school === school);
  return row === undefined
    ? { kind: "unmapped", school }
    : { kind: "resolved", county: row.county };
}
