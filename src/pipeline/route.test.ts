import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import type { ResponseVerdict } from "./aggregate";
import type { SurveyResponse } from "./ingest";
import { isUnowned, route } from "./route";

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
