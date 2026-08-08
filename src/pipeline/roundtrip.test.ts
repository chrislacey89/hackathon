import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../config/load";
import { aggregate, type ResponseVerdict } from "./aggregate";
import { resolveCounty } from "./county";
import { loadResponses, type SurveyResponse } from "./ingest";
import { dispositionOf, type LeadDisposition, type RoutedLead, route } from "./route";

/**
 * Routing, over the whole export, with the config that actually ships.
 *
 * The unit tests pin behaviour against a hand-built three-team config. This one
 * asks the question the unit tests structurally cannot: does every one of the
 * 384 real responses come out the other side, routed through the real
 * `config/*.example.json` and the real school names?
 *
 * No model call — the classifier is not what is under test here, and a test
 * that needed one could not run in CI. Verdicts are assigned deterministically
 * so the routing paths are all exercised and the result is reproducible.
 */

const EXPORT_PATH = "data/volunteer_survey_export.csv";

let responses: SurveyResponse[];
let config: Config;

beforeAll(async () => {
  responses = await Effect.runPromise(loadResponses(EXPORT_PATH));
  config = await Effect.runPromise(loadConfig());
});

/**
 * A verdict per response, cycling the loaded categories.
 *
 * Every fourth response gets no signal, so the `no-signal` path is exercised at
 * roughly its real frequency rather than not at all. Built through `aggregate`
 * rather than as a literal, so these verdicts satisfy the same signal/type
 * invariant the model's do — a hand-built `ResponseVerdict` could carry a
 * contradiction the pipeline never produces, and the test would be measuring a
 * shape that cannot occur.
 */
function verdictFor(response: SurveyResponse, index: number): ResponseVerdict {
  if (index % 4 === 0) return aggregate(response.responseId, []);

  const category = config.categories[index % config.categories.length];
  return aggregate(response.responseId, [
    {
      column: "q7_anything_else",
      sentenceIndex: 0,
      quote: "Count me in.",
      signal: "strong",
      // Non-null: `config.categories` is validated non-empty at load.
      engagementType: category?.id ?? "",
      confidence: 0.9,
      serviceRecovery: false,
      // `null`, not `false` — these verdicts are synthesised to exercise
      // routing and have no opinion about quotability. #18's rule is that null
      // means NOT JUDGED rather than judged-and-rejected, and claiming a
      // judgement this fixture never made would be the exact conflation that
      // field is nullable to prevent.
      quotable: null,
    },
  ]);
}

function routeAll(withConfig: Config = config): RoutedLead[] {
  return responses.map((response, index) =>
    route(
      verdictFor(response, index),
      response,
      resolveCounty(response.school, withConfig),
      withConfig,
    ),
  );
}

function tally(leads: RoutedLead[]): Record<LeadDisposition, number> {
  const counts: Record<LeadDisposition, number> = {
    routed: 0,
    unowned: 0,
    unmapped: 0,
    "no-signal": 0,
  };
  for (const lead of leads) counts[dispositionOf(lead)]++;
  return counts;
}

describe("the whole export, routed", () => {
  it("returns one lead per response — nothing is filtered on the way through", () => {
    const leads = routeAll();

    expect(leads).toHaveLength(384);
    expect(new Set(leads.map((l) => l.responseId)).size).toBe(384);
  });

  it("gives every response exactly one disposition, and none falls through", () => {
    const leads = routeAll();
    const counts = tally(leads);

    // The acceptance criterion on #14: no response falls through
    // routed / unowned / unmapped. `no-signal` is the fourth case and the
    // reason this is stated as a total function rather than three predicates —
    // a response with no forward-looking intent was never a lead, and putting
    // it in a config-gap surface would make that surface unreadable.
    expect(counts.routed + counts.unowned + counts.unmapped + counts["no-signal"]).toBe(384);
    expect(counts.routed).toBeGreaterThan(0);
    expect(counts["no-signal"]).toBeGreaterThan(0);
  });

  it("routes every routable lead with the shipped config — no gaps today", () => {
    const counts = tally(routeAll());

    // Both surfaces empty is the *expected* state, and it is why the two tests
    // below exist: an empty surface proves nothing on its own, because a
    // `route` that always returned "routed" would pass this and only this.
    expect(counts.unowned).toBe(0);
    expect(counts.unmapped).toBe(0);
  });

  it("every lead carries the county its school maps to", () => {
    const leads = routeAll().filter((lead) => lead.signal !== "none");

    // The sample is one market, so this is a weak assertion about counties and
    // a strong one about wiring: the county on the lead is the one the lookup
    // gives for that lead's school, for all 384 rows.
    for (const lead of leads) {
      const expected = config.counties.find((row) => row.school === lead.school);
      expect(lead.county).toBe(expected?.county ?? null);
    }
  });

  describe("when the config has a gap", () => {
    it("surfaces every lead from an unlisted school as unmapped, never as Allen", () => {
      // Drop one school. The rest of the export is untouched, so anything that
      // moved is attributable to this row — and Allen is still the only county
      // in the lookup, which is exactly the condition under which a default
      // would be invisible.
      const dropped = "Northrop HS";
      const gapped: Config = {
        ...config,
        counties: config.counties.filter((row) => row.school !== dropped),
      };

      const leads = routeAll(gapped);
      const affected = leads.filter((lead) => lead.school === dropped && lead.signal !== "none");

      expect(affected.length).toBeGreaterThan(0);
      for (const lead of affected) {
        expect(dispositionOf(lead)).toBe("unmapped");
        expect(lead.county).toBeNull();
        expect(lead.recipientIds).toEqual([]);
      }
      // And nothing else moved.
      expect(tally(leads).unmapped).toBe(affected.length);
    });

    it("surfaces every lead in an unowned category, and only those", () => {
      const orphaned = "donate_swag";
      const gapped: Config = {
        ...config,
        teams: config.teams.map((team) => ({
          ...team,
          owns: team.owns.filter((key) => key.category !== orphaned),
        })),
      };

      const leads = routeAll(gapped);
      const affected = leads.filter((lead) => lead.engagementType === orphaned);

      expect(affected.length).toBeGreaterThan(0);
      for (const lead of affected) expect(dispositionOf(lead)).toBe("unowned");
      expect(tally(leads).unowned).toBe(affected.length);
    });
  });

  it("names every school in the export, so today's zero is coverage not luck", () => {
    const schools = new Set(responses.map((response) => response.school));
    const mapped = new Set(config.counties.map((row) => row.school));

    // If the export gains a school, this fails before the routing tests do,
    // and it says which one — the useful failure. The routing tests would
    // report a non-zero `unmapped` count and leave the reader to work out why.
    expect([...schools].filter((school) => !mapped.has(school))).toEqual([]);
  });
});
