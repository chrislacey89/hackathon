import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import type { SentenceVerdict } from "../domain/engagement";
import type { SurveyResponse } from "./ingest";
import { sweep } from "./sweep";

/**
 * The sweep is where Effect earns its place: 384 calls against a rate limit
 * nobody has read off the dashboard yet. Everything worth testing here is a
 * *reliability* property — did we stay under the concurrency bound, did we
 * retry the errors worth retrying and only those, and does a run that lost
 * rows say so — so every test injects a classify function instead of calling
 * the model.
 *
 * Injecting `classify` is mocking a seam we own (`classify.ts` is ours), which
 * is the case GOOS permits. The model boundary itself is never mocked here;
 * `classify.ts` owns that, and slice #3's eval harness exercises it for real.
 */

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-05-01",
    program: "JA in a Day",
    school: "Northside Elementary",
    volunteerName: "Dana Reyes",
    volunteerEmail: "dana@acme.com",
    employer: "Acme Corp",
    roleThisYear: "Classroom volunteer",
    q1OverallSatisfaction: 5,
    q2WouldRecommend: 5,
    q3FeltPrepared: 4,
    q4VolunteerAgain: true,
    q5WhatWentWell: "The students were engaged.",
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: true,
    ...overrides,
  };
}

function rows(count: number): SurveyResponse[] {
  return Array.from({ length: count }, (_, i) => response({ responseId: `JA-${i + 1}` }));
}

const CONFIG: Config = {
  source: "teams.example.json",
  nearMissCap: 25,
  concurrency: 4,
  recipients: [{ id: "r-1", name: "Program Lead", email: "program@ja.org" }],
  teams: [{ id: "t-1", label: "Placeholder", owns: ["volunteer_again"], recipientIds: ["r-1"] }],
};

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q5_what_went_well",
    sentenceIndex: 0,
    quote: "Put me down for next fall.",
    signal: "strong",
    engagementType: "volunteer_again",
    confidence: 0.9,
    serviceRecovery: false,
    ...overrides,
  };
}

describe("sweep", () => {
  it("returns one response verdict per row, and a clean reliability report", async () => {
    const result = await Effect.runPromise(
      sweep(rows(2), CONFIG, { classify: () => Effect.succeed([verdict()]) }),
    );

    expect(result.verdicts.map((v) => v.responseId)).toEqual(["JA-1", "JA-2"]);
    expect(result.verdicts[0]?.signal).toBe("strong");
    expect(result.attempted).toBe(2);
    expect(result.partial).toBe(false);
    expect(result.failures).toEqual({ RateLimited: 0, SchemaInvalid: 0, Transient: 0 });
  });

  /**
   * Records the high-water mark of rows in flight at once.
   *
   * `yieldNow` rather than a sleep: it hands control back to the scheduler so
   * every fiber the bound permits is started before any of them finishes, which
   * makes the peak deterministic without coupling the test to wall-clock time.
   */
  function peakInFlight() {
    let inFlight = 0;
    let peak = 0;

    const classify = () =>
      Effect.gen(function* () {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        inFlight -= 1;
        return [verdict()];
      });

    return { classify, peak: () => peak };
  }

  it("runs rows in parallel, never more at once than the configured bound", async () => {
    const probe = peakInFlight();

    await Effect.runPromise(sweep(rows(12), CONFIG, { classify: probe.classify }));

    // Not 1: `Effect.forEach` defaults to sequential, and 384 calls run serially
    // is a silent failure — no error, just a sweep that takes all afternoon.
    expect(probe.peak()).toBe(4);
  });

  it("takes the bound from config rather than a constant of its own", async () => {
    const probe = peakInFlight();

    await Effect.runPromise(
      sweep(rows(12), { ...CONFIG, concurrency: 2 }, { classify: probe.classify }),
    );

    expect(probe.peak()).toBe(2);
  });
});
