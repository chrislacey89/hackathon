import { APICallError, NoObjectGeneratedError, TypeValidationError } from "ai";
import { describe, expect, it } from "vitest";
import {
  classifyCause,
  emptyFailureCounts,
  isRetryable,
  RateLimited,
  SchemaInvalid,
  Transient,
} from "./errors";

/**
 * The fork the whole slice turns on: which failures are worth trying again.
 *
 * Getting this wrong is expensive in both directions. Treating a deterministic
 * failure as retryable burns three calls of a rate limit we have not measured,
 * per row, for a guaranteed-identical result. Treating a 429 as terminal throws
 * away a lead that would have arrived a second later.
 */

function apiError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: "boom",
    url: "https://generativelanguage.googleapis.com",
    requestBodyValues: {},
    ...overrides,
  });
}

/** What the AI SDK throws when the generation does not fit the flat schema. */
function schemaFailure() {
  return new NoObjectGeneratedError({
    message: "no object generated",
    text: "Sure! Here are the verdicts:",
    response: { id: "r", timestamp: new Date(0), modelId: "gemini-3.6-flash" },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    finishReason: "stop",
  });
}

describe("classifyCause", () => {
  it("reads a 429 as rate limiting, with the wait the provider asked for", () => {
    const error = classifyCause(
      "JA-1",
      apiError({ statusCode: 429, responseHeaders: { "retry-after": "12" } }),
    );

    expect(error._tag).toBe("RateLimited");
    if (error._tag === "RateLimited") expect(error.retryAfter).toBe(12);
  });

  it("reads a generation that did not match the schema as deterministic", () => {
    // The model returned prose, or a shape the flat schema rejects. The same
    // prompt will produce the same rejection, so this must never be retried —
    // it is the specific waste the conditional-retry policy exists to prevent.
    const error = classifyCause("JA-1", schemaFailure());

    expect(error._tag).toBe("SchemaInvalid");
    if (error._tag === "SchemaInvalid") expect(error.responseId).toBe("JA-1");
  });

  it("reads a type-validation failure as deterministic too", () => {
    const error = classifyCause("JA-2", new TypeValidationError({ value: {}, cause: "nope" }));

    expect(error._tag).toBe("SchemaInvalid");
  });

  it("omits the wait when the provider did not name one", () => {
    const error = classifyCause("JA-1", apiError({ statusCode: 429 }));

    expect(error._tag).toBe("RateLimited");
    if (error._tag === "RateLimited") expect(error.retryAfter).toBeUndefined();
  });

  it("reads a server error as transient, keeping the status for the report", () => {
    const error = classifyCause("JA-1", apiError({ statusCode: 503, isRetryable: true }));

    expect(error).toEqual(new Transient({ status: 503 }));
  });

  it("reads a rejected request as deterministic, so a bad key does not retry 384 times", () => {
    // A 401 is not a malformed generation, but it shares the property that
    // decides the policy: the same call will fail the same way. Retrying it is
    // the same waste as retrying a schema failure, so it carries the same tag.
    const error = classifyCause("JA-1", apiError({ statusCode: 401, isRetryable: false }));

    expect(error._tag).toBe("SchemaInvalid");
  });

  it("reads an error the SDK never wrapped as transient", () => {
    // A socket reset or a DNS blip arrives as a bare TypeError. Those really do
    // succeed on a second attempt, so the unknown case defaults to retryable.
    const error = classifyCause("JA-1", new TypeError("fetch failed"));

    expect(error).toEqual(new Transient({ status: 0 }));
  });
});

describe("isRetryable", () => {
  it("retries the two classes that can succeed on a second attempt", () => {
    expect(isRetryable(new RateLimited({}))).toBe(true);
    expect(isRetryable(new Transient({ status: 503 }))).toBe(true);
  });

  it("never retries a deterministic failure", () => {
    expect(isRetryable(new SchemaInvalid({ responseId: "JA-1" }))).toBe(false);
  });
});

describe("emptyFailureCounts", () => {
  it("starts every tag at zero, so an absent tag is never an absent key", () => {
    expect(emptyFailureCounts()).toEqual({ RateLimited: 0, SchemaInvalid: 0, Transient: 0 });
  });

  it("returns a fresh object per run, so two runs cannot share a counter", () => {
    const first = emptyFailureCounts();
    first.RateLimited += 1;

    expect(emptyFailureCounts().RateLimited).toBe(0);
  });
});
