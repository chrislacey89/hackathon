import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import type { ResponseVerdict } from "./aggregate";
import type { SurveyResponse } from "./ingest";
import { isUnowned, route, routeAll } from "./route";

const CONFIG: Config = {
  source: "teams.example.json",
  nearMissCap: 25,
  concurrency: 4,
  recipients: [
    { id: "r-program", name: "Program Lead", email: "program@ja.org" },
    { id: "r-dev", name: "Development Officer", email: "dev@ja.org" },
  ],
  teams: [
    {
      id: "program-staff",
      label: "Program Staff",
      owns: ["volunteer_again", "speaking"],
      recipientIds: ["r-program"],
    },
    {
      id: "development",
      label: "Development",
      owns: ["committee_board"],
      recipientIds: ["r-dev"],
    },
    // donation, corporate_sponsorship and refer_colleague are deliberately
    // unowned here — that is the gap `unowned` exists to make visible.
  ],
};

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-01-01T09:00",
    program: "JA in a Day",
    school: "Test HS",
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

describe("route", () => {
  it("sends a lead to the team owning its engagement type", () => {
    const lead = route(verdict(), response(), CONFIG);

    expect(lead.teamId).toBe("program-staff");
    expect(lead.recipientIds).toEqual(["r-program"]);
    expect(isUnowned(lead)).toBe(false);
  });

  it("carries the identity a staffer needs to make the call", () => {
    const lead = route(verdict(), response(), CONFIG);

    expect(lead).toMatchObject({
      name: "Dana Reyes",
      email: "dana@acme.com",
      employer: "Acme Corp",
      program: "JA in a Day",
      quote: "Put me down for next fall.",
      sourceColumn: "q6_what_could_improve",
    });
  });

  describe("the never-silently-dropped invariant", () => {
    it("still returns a lead when no team owns its type", () => {
      const lead = route(
        verdict({ engagementType: "donation", engagementTypes: ["donation"] }),
        response(),
        CONFIG,
      );

      expect(lead.teamId).toBeNull();
      expect(lead.recipientIds).toEqual([]);
      expect(isUnowned(lead)).toBe(true);
      expect(lead.responseId).toBe("JA-1");
      expect(lead.quote).toBe("Put me down for next fall.");
    });

    it("does not call a none-signal lead unowned — it is not routable", () => {
      const lead = route(
        verdict({ signal: "none", engagementType: null, engagementTypes: [], quote: null }),
        response(),
        CONFIG,
      );

      expect(lead.teamId).toBeNull();
      expect(isUnowned(lead)).toBe(false);
    });
  });

  it("reaches every owning team's recipients on a multi-intent response", () => {
    const lead = route(
      verdict({
        engagementType: "speaking",
        engagementTypes: ["speaking", "committee_board"],
        multiIntent: true,
      }),
      response(),
      CONFIG,
    );

    expect(lead.teamId).toBe("program-staff");
    expect(lead.recipientIds).toEqual(["r-program", "r-dev"]);
  });

  it("reaches a secondary type's team even when the primary type is unowned", () => {
    const lead = route(
      verdict({
        engagementType: "donation",
        engagementTypes: ["donation", "committee_board"],
        multiIntent: true,
      }),
      response(),
      CONFIG,
    );

    expect(lead.teamId).toBeNull();
    expect(lead.recipientIds).toEqual(["r-dev"]);
    // Somebody receives it, so it is not a config gap.
    expect(isUnowned(lead)).toBe(false);
  });

  it("does not deliver the same lead to one recipient twice", () => {
    const lead = route(
      verdict({
        engagementType: "volunteer_again",
        engagementTypes: ["volunteer_again", "speaking"],
        multiIntent: true,
      }),
      response(),
      CONFIG,
    );

    expect(lead.recipientIds).toEqual(["r-program"]);
  });
});

/**
 * Re-attaching each verdict to the volunteer it came from.
 *
 * The sweep drops rows that exhausted their retries, so its verdict list is
 * shorter than the row list and the two no longer line up by position. Pairing
 * by index would then shift every lead after the first failure onto the next
 * volunteer's name and email — a lead that still looks entirely credible, sent
 * to the wrong person about something they never said.
 */
describe("routeAll", () => {
  it("keeps each verdict with its own volunteer when a row in the middle is missing", () => {
    const rows = [
      response({ responseId: "JA-1", volunteerName: "Ana", volunteerEmail: "ana@x.com" }),
      response({ responseId: "JA-2", volunteerName: "Bo", volunteerEmail: "bo@x.com" }),
      response({ responseId: "JA-3", volunteerName: "Cy", volunteerEmail: "cy@x.com" }),
    ];
    // JA-2 exhausted its retries and never produced a verdict.
    const verdicts = [verdict({ responseId: "JA-1" }), verdict({ responseId: "JA-3" })];

    const leads = routeAll(rows, verdicts, CONFIG);

    expect(leads.map((l) => [l.responseId, l.name, l.email])).toEqual([
      ["JA-1", "Ana", "ana@x.com"],
      ["JA-3", "Cy", "cy@x.com"],
    ]);
  });

  it("pairs by id rather than position when the verdicts come back reordered", () => {
    const rows = [
      response({ responseId: "JA-1", volunteerName: "Ana" }),
      response({ responseId: "JA-2", volunteerName: "Bo" }),
    ];
    const verdicts = [verdict({ responseId: "JA-2" }), verdict({ responseId: "JA-1" })];

    const leads = routeAll(rows, verdicts, CONFIG);

    expect(leads.map((l) => [l.responseId, l.name])).toEqual([
      ["JA-2", "Bo"],
      ["JA-1", "Ana"],
    ]);
  });

  it("returns no leads for no verdicts", () => {
    expect(routeAll([response()], [], CONFIG)).toEqual([]);
  });
});
