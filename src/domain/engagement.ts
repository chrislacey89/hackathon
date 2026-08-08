/**
 * The project's shared vocabulary: the three free-text columns we read, and the
 * two enumerated schemes every downstream module agrees on.
 *
 * These live in one place because `segment`, `classify`, `aggregate`, and
 * `route` all speak them, and a second definition drifting from the first is
 * exactly the failure the boundary maps exist to prevent. The modules named in
 * issue #2's boundary map re-export the members they own, so a consumer can
 * import from either the module it was promised or from here.
 */

/**
 * Every free-text column the pipeline reads. `q6` is on this list because
 * roughly 5% of forward-looking intent is buried in "what could improve" — a
 * tool that only reads the last box misses those by construction.
 */
export const FREE_TEXT_COLUMNS = [
  "q5_what_went_well",
  "q6_what_could_improve",
  "q7_anything_else",
] as const;

export type FreeTextColumn = (typeof FREE_TEXT_COLUMNS)[number];

export const ENGAGEMENT_SIGNALS = ["strong", "soft", "none"] as const;

export type EngagementSignal = (typeof ENGAGEMENT_SIGNALS)[number];

export const ENGAGEMENT_TYPES = [
  "volunteer_again",
  "committee_board",
  "corporate_sponsorship",
  "refer_colleague",
  "speaking",
  "donation",
] as const;

export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

/**
 * Signal strength as an order, so "the strongest sentence wins" is a comparison
 * rather than a chain of ifs. Not a public ranking — `score` (slice #6) owns
 * priority, and it reads config weights, not this table.
 */
const SIGNAL_RANK: Record<EngagementSignal, number> = {
  none: 0,
  soft: 1,
  strong: 2,
};

export function signalRank(signal: EngagementSignal): number {
  return SIGNAL_RANK[signal];
}
