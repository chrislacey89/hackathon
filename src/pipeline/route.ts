import type { Config, Team } from "../config/load";
import type { EngagementType } from "../domain/engagement";
import type { ResponseVerdict } from "./aggregate";
import type { SurveyResponse } from "./ingest";

/**
 * A response verdict plus the answer to "who acts on this, and what do they
 * need to see before picking up the phone".
 *
 * `teamId` is the team owning the *primary* engagement type — the label on the
 * lead. `recipientIds` is everyone who should receive it, across every distinct
 * type the response expressed, because a volunteer offering to speak and to
 * introduce their employer is two handoffs, not one.
 *
 * Slice #5 adds `positionDepth`, `recencyWeight`, `nextAsk`, and `leap`; slice
 * #6 adds `score`. Both are deliberately absent here rather than stubbed: a
 * placeholder score wired into the production path is indistinguishable from a
 * real one at a glance, and ranking is the thing JA is supposed to own.
 */
export type RoutedLead = ResponseVerdict & {
  teamId: string | null;
  recipientIds: string[];
  name: string;
  email: string;
  employer: string;
  program: string;
};

function teamsOwning(types: EngagementType[], config: Config): Team[] {
  return config.teams.filter((team) => types.some((type) => team.owns.includes(type)));
}

/**
 * A routable lead that reaches nobody.
 *
 * Empty is the expected state. Non-empty means the routing table has a gap —
 * an engagement type JA's teams do not cover — and PRD #1 §Flow Sketch makes it
 * a build-time surface precisely so the gap is visible rather than inferred
 * from a queue that looks a bit short.
 *
 * A `none`-signal response is not unowned: there is nothing to route. Those go
 * to nurture or near-miss segmentation in slice #5.
 */
export function isUnowned(lead: RoutedLead): boolean {
  return lead.signal !== "none" && lead.recipientIds.length === 0;
}

/**
 * Attach routing and identity to a response verdict.
 *
 * Total by construction: every verdict returns a lead. There is no path that
 * returns null, filters, or throws — a lead with no owning team comes back with
 * `teamId: null` and an empty recipient list, which `isUnowned` then surfaces.
 * Dropping it here would make a config gap look like an absence of intent,
 * and nothing downstream could tell the difference.
 */
export function route(
  verdict: ResponseVerdict,
  response: SurveyResponse,
  config: Config,
): RoutedLead {
  const primaryTeam =
    verdict.engagementType === null
      ? null
      : (teamsOwning([verdict.engagementType], config)[0] ?? null);

  const recipientIds = [
    ...new Set(teamsOwning(verdict.engagementTypes, config).flatMap((team) => team.recipientIds)),
  ];

  return {
    ...verdict,
    teamId: primaryTeam?.id ?? null,
    recipientIds,
    name: response.volunteerName,
    email: response.volunteerEmail,
    employer: response.employer,
    program: response.program,
  };
}

/**
 * Route a whole sweep's worth of verdicts, pairing each back to its volunteer.
 *
 * By id, never by position. The sweep omits rows that exhausted their retries,
 * so its verdict list is shorter than the row list — and pairing by index would
 * shift every lead after the first failure onto the next volunteer's name and
 * email. That lead still looks entirely credible in a queue, which is what
 * makes it worse than a lead that is simply missing.
 *
 * A verdict whose response is unknown throws rather than being dropped. It
 * cannot happen from a sweep over these rows, so if it does, ingest and the
 * sweep disagree about what was processed — a bug to surface, not a row to
 * quietly skip.
 */
export function routeAll(
  responses: SurveyResponse[],
  verdicts: ResponseVerdict[],
  config: Config,
): RoutedLead[] {
  const byId = new Map(responses.map((response) => [response.responseId, response]));

  return verdicts.map((verdict) => {
    const response = byId.get(verdict.responseId);
    if (response === undefined) {
      throw new Error(`verdict for unknown response ${verdict.responseId}`);
    }

    return route(verdict, response, config);
  });
}
