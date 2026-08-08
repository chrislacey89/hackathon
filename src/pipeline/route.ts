import type { Config, Team } from "../config/load";
import type { EngagementType } from "../domain/engagement";
import type { ResponseVerdict } from "./aggregate";
import type { CountyResolution } from "./county";
import type { SurveyResponse } from "./ingest";

/**
 * A response verdict plus the answer to "who acts on this, and what do they
 * need to see before picking up the phone".
 *
 * `teamId` is the team owning the *primary* `(category, county)` pair — the
 * label on the lead. `recipientIds` is everyone who should receive it, across
 * every distinct category the response expressed, because a volunteer offering
 * to come back and to introduce their employer is two handoffs, not one.
 *
 * `county` is `null` exactly when the school reached no row of the lookup. It
 * is not "we don't know yet" and it is never a default — see `dispositionOf`.
 *
 * `school` and `submittedAt` are carried for two named consumers rather than
 * for completeness: `school` is what the `unmapped` surface has to print for an
 * operator to repair the lookup, and `submittedAt` is the middle field of the
 * ledger key `(responseId, submittedAt, recipientId)` that #15 builds from a
 * lead (PRD #1 §Rabbit Holes).
 *
 * Slice #5 adds `positionDepth`, `recencyWeight`, `nextAsk`, and `leap`; slice
 * #6 adds `score`. Both are deliberately absent here rather than stubbed: a
 * placeholder score wired into the production path is indistinguishable from a
 * real one at a glance, and ranking is the thing JA is supposed to own.
 */
export type RoutedLead = ResponseVerdict & {
  teamId: string | null;
  recipientIds: string[];
  county: string | null;
  school: string;
  submittedAt: string;
  name: string;
  email: string;
  employer: string;
  program: string;
};

/**
 * What happened to a lead — the one thing every response gets exactly one of.
 *
 * Four values, not the three named in issue #14's acceptance criteria. The
 * fourth, `no-signal`, is the 70% of responses that expressed no forward-looking
 * intent at all: they are not routed, and calling them `unowned` or `unmapped`
 * would fill both config-gap surfaces with responses that were never leads,
 * which is the fastest way to make a gap indicator unreadable. Naming the case
 * is what makes the function *total* — which is what the acceptance criterion
 * is actually asking for, since its requirement is that no response falls
 * through.
 *
 * `unmapped` outranks `unowned` deliberately. Without a county there is no key
 * to look an owner up by, so "nobody owns this" is not a finding — it is an
 * artefact of the missing county. The two gaps are also different repairs: one
 * is a row in `counties.json`, the other is a name JA has to supply.
 */
export type LeadDisposition = "routed" | "unowned" | "unmapped" | "no-signal";

export function dispositionOf(lead: RoutedLead): LeadDisposition {
  if (lead.signal === "none") return "no-signal";
  if (lead.county === null) return "unmapped";
  return lead.recipientIds.length > 0 ? "routed" : "unowned";
}

/**
 * A routable lead that reaches nobody, because no recipient owns its category
 * in its county.
 *
 * Empty is the expected state. Non-empty means the routing table has a gap, and
 * PRD #1 §Flow Sketch makes it a surface precisely so the gap is visible rather
 * than inferred from a queue that looks a bit short.
 */
export function isUnowned(lead: RoutedLead): boolean {
  return dispositionOf(lead) === "unowned";
}

/**
 * A routable lead whose school reached no row of the county lookup.
 *
 * The sample is one market and the real export is four, so this surface is
 * empty today and is the first thing that will move when the real export
 * arrives. That is the point: an unmapped school must land here rather than
 * defaulting to the only county the lookup happens to contain.
 */
export function isUnmapped(lead: RoutedLead): boolean {
  return dispositionOf(lead) === "unmapped";
}

/** Teams owning any of these categories in this county. */
function teamsOwning(categories: EngagementType[], county: string, config: Config): Team[] {
  return config.teams.filter((team) =>
    team.owns.some((key) => key.county === county && categories.includes(key.category)),
  );
}

/**
 * Attach routing and identity to a response verdict.
 *
 * Total by construction: every verdict returns a lead. There is no path that
 * returns null, filters, or throws — a lead with no owning team comes back with
 * `teamId: null` and an empty recipient list, and one whose school is unmapped
 * comes back with `county: null`. `dispositionOf` then names which. Dropping
 * either here would make a config gap look like an absence of intent, and
 * nothing downstream could tell the difference.
 *
 * Widened from the `route(rv, r, c)` declared in issue #14's boundary map:
 * `name`, `email`, `employer`, `program`, `school`, and `submittedAt` live only
 * on `SurveyResponse`, which reached neither declared parameter, so the declared
 * signature could not construct its own return type. Third occurrence of the
 * defect in `docs/solutions/patterns/boundary-map-signatures-must-be-type-reachable`;
 * correction filed as a comment on #14 before implementation.
 */
export function route(
  verdict: ResponseVerdict,
  response: SurveyResponse,
  resolution: CountyResolution,
  config: Config,
): RoutedLead {
  const county = resolution.kind === "resolved" ? resolution.county : null;

  // No county, no routing. Not a fallback to the single county the sample
  // happens to contain — that guess would be invisible here and wrong the
  // moment the real four-market export arrives (PRD #1 §Rabbit Holes).
  const owning = county === null ? [] : teamsOwning(verdict.engagementTypes, county, config);

  const primaryTeam =
    county === null || verdict.engagementType === null
      ? null
      : (teamsOwning([verdict.engagementType], county, config)[0] ?? null);

  return {
    ...verdict,
    teamId: primaryTeam?.id ?? null,
    recipientIds: [...new Set(owning.flatMap((team) => team.recipientIds))],
    county,
    school: response.school,
    submittedAt: response.submittedAt,
    name: response.volunteerName,
    email: response.volunteerEmail,
    employer: response.employer,
    program: response.program,
  };
}
