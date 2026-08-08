import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import type { ResponseVerdict } from "./aggregate";
import { resolveCounty } from "./county";
import type { SurveyResponse } from "./ingest";
import { dispositionOf, isUnmapped, isUnowned, route } from "./route";

const CONFIG: Config = {
  sources: { teams: "teams.json", categories: "categories.json", counties: "counties.json" },
  nearMissCap: 25,
  concurrency: 4,
  categories: [
    { id: "volunteer_again", label: "Volunteer again", description: "d" },
    { id: "personal_donation", label: "Personal donation", description: "d" },
    { id: "donate_swag", label: "Donate SWAG", description: "d" },
  ],
  counties: [
    { school: "Northrop HS", county: "Allen" },
    { school: "Columbia City HS", county: "Whitley" },
  ],
  recipients: [
    { id: "r-allen-program", name: "Allen Program Lead", email: "allen@ja.org" },
    { id: "r-allen-dev", name: "Allen Development", email: "allen-dev@ja.org" },
    { id: "r-whitley", name: "Whitley Manager", email: "whitley@ja.org" },
  ],
  teams: [
    {
      id: "allen-program",
      label: "Allen — Program",
      owns: [{ category: "volunteer_again", county: "Allen" }],
      recipientIds: ["r-allen-program"],
    },
    {
      id: "allen-development",
      label: "Allen — Development",
      owns: [{ category: "personal_donation", county: "Allen" }],
      recipientIds: ["r-allen-dev"],
    },
    {
      id: "whitley",
      label: "Whitley",
      // The same category, a different county, a different person. This pair is
      // the whole reason routing gained a second dimension.
      owns: [
        { category: "volunteer_again", county: "Whitley" },
        { category: "personal_donation", county: "Whitley" },
      ],
      recipientIds: ["r-whitley"],
    },
    // `donate_swag` is owned in neither county — that is the gap `unowned`
    // exists to make visible.
  ],
};

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-01-01T09:00",
    program: "JA in a Day",
    school: "Northrop HS",
    volunteerName: "Dana Reyes",
    volunteerEmail: "dana@acme.com",
    employer: "Acme Corp",
    roleThisYear: "Classroom Volunteer",
    q1OverallSatisfaction: 4,
    q2WouldRecommend: 4,
    q3FeltPrepared: 4,
    q4VolunteerAgain: null,
    q5WhatWentWell: null,
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<ResponseVerdict> = {}): ResponseVerdict {
  return {
    responseId: "JA-1",
    signal: "strong",
    engagementType: "volunteer_again",
    engagementTypes: ["volunteer_again"],
    confidence: 0.9,
    quote: "Put me down for next fall.",
    sourceColumn: "q6_what_could_improve",
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [],
    ...overrides,
  };
}

/** Route a response the way the pipeline does — through the county lookup. */
function routed(v: Partial<ResponseVerdict> = {}, r: Partial<SurveyResponse> = {}) {
  const survey = response(r);
  return route(verdict(v), survey, resolveCounty(survey.school, CONFIG), CONFIG);
}

describe("route", () => {
  it("sends a lead to the team owning its (category, county) pair", () => {
    const lead = routed();

    expect(lead.teamId).toBe("allen-program");
    expect(lead.recipientIds).toEqual(["r-allen-program"]);
    expect(lead.county).toBe("Allen");
    expect(dispositionOf(lead)).toBe("routed");
  });

  it("sends the same category in a different county to a different person", () => {
    const allen = routed({}, { school: "Northrop HS" });
    const whitley = routed({}, { school: "Columbia City HS" });

    // Identical intent, identical category, different school. Before this
    // slice both landed on the same desk, which is the failure #24 §1 named.
    expect(allen.recipientIds).toEqual(["r-allen-program"]);
    expect(whitley.recipientIds).toEqual(["r-whitley"]);
    expect(whitley.county).toBe("Whitley");
  });

  it("carries the identity a staffer needs to make the call", () => {
    expect(routed()).toMatchObject({
      name: "Dana Reyes",
      email: "dana@acme.com",
      employer: "Acme Corp",
      program: "JA in a Day",
      school: "Northrop HS",
      // The ledger key is (responseId, submittedAt, recipientId) — PRD #1
      // §Rabbit Holes. #15 builds it from a RoutedLead, so the lead has to
      // carry the middle field.
      submittedAt: "2026-01-01T09:00",
      quote: "Put me down for next fall.",
      sourceColumn: "q6_what_could_improve",
    });
  });

  describe("the never-silently-dropped invariant", () => {
    it("still returns a lead when the school maps to no county", () => {
      const lead = routed({}, { school: "Lafayette Jeff HS" });

      expect(dispositionOf(lead)).toBe("unmapped");
      expect(isUnmapped(lead)).toBe(true);
      expect(lead.county).toBeNull();
      expect(lead.teamId).toBeNull();
      expect(lead.recipientIds).toEqual([]);
      // The school rides along so the surface can say what to add to the lookup.
      expect(lead.school).toBe("Lafayette Jeff HS");
      expect(lead.quote).toBe("Put me down for next fall.");
    });

    it("never guesses a county for an unmapped school, even when only one exists", () => {
      // The sample is single-county, so defaulting would be invisible here and
      // wrong the moment the four-market export arrives.
      const lead = routed({}, { school: "Lafayette Jeff HS" });

      expect(lead.county).toBeNull();
      expect(lead.recipientIds).toEqual([]);
    });

    it("still returns a lead when no team owns its category in its county", () => {
      const lead = routed({ engagementType: "donate_swag", engagementTypes: ["donate_swag"] });

      expect(dispositionOf(lead)).toBe("unowned");
      expect(isUnowned(lead)).toBe(true);
      expect(lead.teamId).toBeNull();
      expect(lead.recipientIds).toEqual([]);
      // Resolved county, missing owner — the two gaps are different repairs
      // (name a manager vs add a school), so they must not collapse into one.
      expect(lead.county).toBe("Allen");
    });

    it("does not call a none-signal lead unowned or unmapped — it is not routable", () => {
      const lead = routed({
        signal: "none",
        engagementType: null,
        engagementTypes: [],
        quote: null,
      });

      expect(dispositionOf(lead)).toBe("no-signal");
      expect(isUnowned(lead)).toBe(false);
      expect(isUnmapped(lead)).toBe(false);
      expect(lead.teamId).toBeNull();
    });

    it("reports unmapped ahead of unowned — the county gap blocks the owner lookup", () => {
      const lead = routed(
        { engagementType: "donate_swag", engagementTypes: ["donate_swag"] },
        { school: "Lafayette Jeff HS" },
      );

      // Nobody owns donate_swag anywhere, but that is not knowable for this
      // lead: without a county there is no key to look an owner up by. Calling
      // it unowned would send an operator to fix the wrong file.
      expect(dispositionOf(lead)).toBe("unmapped");
    });
  });

  it("reaches every owning team's recipients on a multi-intent response", () => {
    const lead = routed({
      engagementType: "volunteer_again",
      engagementTypes: ["volunteer_again", "personal_donation"],
      multiIntent: true,
    });

    expect(lead.teamId).toBe("allen-program");
    expect(lead.recipientIds).toEqual(["r-allen-program", "r-allen-dev"]);
  });

  it("reaches a secondary category's team even when the primary is unowned", () => {
    const lead = routed({
      engagementType: "donate_swag",
      engagementTypes: ["donate_swag", "personal_donation"],
      multiIntent: true,
    });

    expect(lead.teamId).toBeNull();
    expect(lead.recipientIds).toEqual(["r-allen-dev"]);
    // Somebody receives it, so it is not a config gap.
    expect(dispositionOf(lead)).toBe("routed");
  });

  it("does not deliver the same lead to one recipient twice", () => {
    const lead = routed(
      {
        engagementType: "volunteer_again",
        engagementTypes: ["volunteer_again", "personal_donation"],
        multiIntent: true,
      },
      { school: "Columbia City HS" },
    );

    // One Whitley team owns both categories.
    expect(lead.recipientIds).toEqual(["r-whitley"]);
  });

  it("is pure — routing the same inputs twice gives the same answer", () => {
    expect(routed()).toEqual(routed());
  });
});

describe("dispositionOf", () => {
  it("gives every lead exactly one disposition", () => {
    const cases = [
      routed(),
      routed({ engagementType: "donate_swag", engagementTypes: ["donate_swag"] }),
      routed({}, { school: "Lafayette Jeff HS" }),
      routed({ signal: "none", engagementType: null, engagementTypes: [], quote: null }),
    ];

    expect(cases.map(dispositionOf)).toEqual(["routed", "unowned", "unmapped", "no-signal"]);
    // The predicates are views on the disposition, so they cannot contradict it.
    for (const lead of cases) {
      expect([isUnowned(lead), isUnmapped(lead)].filter(Boolean).length).toBeLessThanOrEqual(1);
    }
  });
});
