import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sentenceVerdictSchemaFor } from "../domain/engagement";
import { partitionByCitation, type SentenceVerdict, SentenceVerdictSchema } from "./classify";
import type { Sentence } from "./segment";

/**
 * The contract with the model. Everything downstream — `aggregate`'s invariant,
 * `route`'s team lookup, the quote the queue UI shows — assumes a verdict that
 * got past this schema is well-formed, so the schema is the only thing standing
 * between a malformed generation and `run.json`.
 */

const VALID: SentenceVerdict = {
  column: "q6_what_could_improve",
  sentenceIndex: 1,
  quote: "That said, put me down for next fall.",
  signal: "strong",
  engagementType: "volunteer_again",
  confidence: 0.98,
  serviceRecovery: false,
  quotable: false,
};

describe("SentenceVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    expect(SentenceVerdictSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a null engagement type, because the schema cannot express the union", () => {
    const result = SentenceVerdictSchema.safeParse({
      ...VALID,
      signal: "none",
      engagementType: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a null quotability, because not-judged is a state a producer can be in", () => {
    // The keyword baseline scores signal only, and run.json artifacts written
    // before quotability existed carry no judgement either. Both are honest,
    // and both must round-trip — `extractQuotes` reads null as "no quote",
    // never as "the model said no".
    const result = SentenceVerdictSchema.safeParse({ ...VALID, quotable: null });

    expect(result.success).toBe(true);
  });

  it("rejects a missing quotability, so absence is never mistaken for a judgement", () => {
    const { quotable: _omitted, ...withoutQuotable } = VALID;

    expect(SentenceVerdictSchema.safeParse(withoutQuotable).success).toBe(false);
  });

  it("accepts the contradiction the schema is unable to reject", () => {
    // `signal: 'none'` with a type attached is well-formed *to the schema* —
    // @ai-sdk/google cannot express the discriminated union, so this arrives
    // looking valid. `aggregate` is what discards it; this test pins the reason
    // that runtime check has to exist.
    const result = SentenceVerdictSchema.safeParse({
      ...VALID,
      signal: "none",
      engagementType: "donate_swag",
    });

    expect(result.success).toBe(true);
  });

  it("accepts any category id, because the member set is not knowable here", () => {
    // This is the *read-back* schema. Categories come from
    // config/categories.json, so the set a run used is a property of that run,
    // not of this declaration — `parseRun` checks a lead against the run's own
    // denormalised list, and `sentenceVerdictSchemaFor` closes the set on the
    // way out. Pinned as a deliberate widening rather than left implicit.
    expect(SentenceVerdictSchema.safeParse({ ...VALID, engagementType: "anything" }).success).toBe(
      true,
    );
  });

  describe("rejects", () => {
    it("a column outside the three we read", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, column: "q4_volunteer_again" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["column"]);
        expect(result.error.issues[0]?.code).toBe("invalid_value");
      }
    });

    it("a confidence above 1", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, confidence: 1.5 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["confidence"]);
        expect(result.error.issues[0]?.code).toBe("too_big");
      }
    });

    it("a confidence below 0", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, confidence: -0.1 });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.code).toBe("too_small");
    });

    it("a negative sentence index", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: -1 });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["sentenceIndex"]);
    });

    it("a fractional sentence index", () => {
      const result = SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: 1.5 });

      expect(result.success).toBe(false);
    });
  });

  it("accepts the boundary confidences", () => {
    expect(SentenceVerdictSchema.safeParse({ ...VALID, confidence: 0 }).success).toBe(true);
    expect(SentenceVerdictSchema.safeParse({ ...VALID, confidence: 1 }).success).toBe(true);
  });

  it("accepts sentence index 0", () => {
    expect(SentenceVerdictSchema.safeParse({ ...VALID, sentenceIndex: 0 }).success).toBe(true);
  });
});

/**
 * The outbound half of the contract — what Gemini is actually constrained by.
 *
 * The closed enum used to be `z.enum(ENGAGEMENT_TYPES)` and is now built from
 * the categories the run loaded. Without it the structured-output contract would
 * accept any string, and an invented category would route to nobody and show up
 * as a routing-table gap that is not one.
 */
describe("sentenceVerdictSchemaFor", () => {
  const schema = sentenceVerdictSchemaFor(["volunteer_again", "donate_swag"]);

  it("accepts a category the run loaded", () => {
    expect(schema.safeParse({ ...VALID, engagementType: "donate_swag" }).success).toBe(true);
  });

  it("rejects a category the run did not load", () => {
    // `speaking` was a real category before JA's taxonomy replaced ours (#24
    // §2). A model still emitting it must be caught here rather than routed.
    const result = schema.safeParse({ ...VALID, engagementType: "speaking" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["engagementType"]);
  });

  it("still allows null, for a none-signal sentence", () => {
    expect(schema.safeParse({ ...VALID, signal: "none", engagementType: null }).success).toBe(true);
  });

  it("keeps every other bound the read-back schema has", () => {
    // Derived from `SentenceVerdictSchema` rather than declared beside it, so
    // the two cannot drift — the drift that had already happened between the
    // two hand-written declarations this module's schema exists to have merged.
    expect(schema.safeParse({ ...VALID, confidence: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...VALID, column: "q4_volunteer_again" }).success).toBe(false);
  });

  it("still asks the model for every field, quotability included", () => {
    // The one place #14 and #18 could have silently cancelled each other out.
    // #18 added `quotable` to the verdict; #14 introduced this factory to close
    // the category enum. It narrows by `.extend()`, so `quotable` survives — but
    // a later rewrite that built a fresh `z.object` here would drop it from the
    // *outbound* contract while every read-back test stayed green.
    //
    // That failure is silent by construction: the model would never be asked,
    // every verdict would come back `quotable: null`, and #18 defines null as
    // NOT JUDGED — so an empty quotes document would read as "the model found
    // nothing worth quoting" rather than "we stopped asking". Karen's stated
    // number-one need, failing quietly. Asserted against the emitted JSON
    // Schema because that is the artifact the provider actually receives.
    const emitted = z.toJSONSchema(schema, { io: "output" }) as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(emitted.properties).sort()).toEqual([
      "column",
      "confidence",
      "engagementType",
      "quotable",
      "quote",
      "sentenceIndex",
      "serviceRecovery",
      "signal",
    ]);
  });
});

/**
 * The citation guard.
 *
 * Both failure directions matter and they fail differently. An **over-claim** —
 * keeping a verdict that cites a sentence we never sent — puts a real quote
 * under the wrong survey question in a staffer's queue, and the lead still
 * looks credible, so nothing downstream can catch it. An **under-claim** —
 * dropping a verdict that was fine — loses a volunteer who did express intent,
 * which is the loss this whole project exists to prevent.
 */

function sentence(overrides: Partial<Sentence> = {}): Sentence {
  return {
    responseId: "JA-1",
    column: "q5_what_went_well",
    index: 0,
    text: "The students were engaged.",
    ...overrides,
  };
}

function cite(column: SentenceVerdict["column"], sentenceIndex: number): SentenceVerdict {
  return { ...VALID, column, sentenceIndex };
}

describe("partitionByCitation", () => {
  describe("over-claim guard — must not let an unsent citation through", () => {
    it("rejects an index past the end of the column", () => {
      const sent = [sentence({ index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q5_what_went_well", 1)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects a column the volunteer left blank", () => {
      // q6 was empty, so no q6 sentence was ever sent. A verdict citing it is
      // the planted-case failure in reverse: a quote filed under the wrong box.
      const sent = [sentence({ column: "q5_what_went_well", index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q6_what_could_improve", 0)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects a right-index, wrong-column citation", () => {
      // The sharp case: index 0 genuinely exists — in q5, not q7. Matching on
      // the index alone would wave this through and misattribute the quote.
      const sent = [sentence({ column: "q5_what_went_well", index: 0 })];

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q7_anything_else", 0)],
        sent,
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });

    it("rejects everything when the response had no free text at all", () => {
      const { addressable, unaddressable } = partitionByCitation(
        [cite("q5_what_went_well", 0)],
        [],
      );

      expect(addressable).toEqual([]);
      expect(unaddressable).toHaveLength(1);
    });
  });

  describe("under-claim guard — must not drop a valid verdict", () => {
    it("keeps a verdict for every sentence that was sent", () => {
      const sent = [
        sentence({ column: "q5_what_went_well", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 1 }),
        sentence({ column: "q7_anything_else", index: 0 }),
      ];
      const verdicts = sent.map((s) => cite(s.column, s.index));

      const { addressable, unaddressable } = partitionByCitation(verdicts, sent);

      expect(addressable).toEqual(verdicts);
      expect(unaddressable).toEqual([]);
    });

    it("keeps index 0, which a truthiness check would silently discard", () => {
      const sent = [sentence({ index: 0 })];

      const { addressable } = partitionByCitation([cite("q5_what_went_well", 0)], sent);

      expect(addressable).toHaveLength(1);
    });

    it("keeps the good verdicts when a sibling in the same batch is dropped", () => {
      // A single hallucinated citation must not cost the response its real
      // leads — the planted q6 offer is in this batch.
      const sent = [
        sentence({ column: "q6_what_could_improve", index: 0 }),
        sentence({ column: "q6_what_could_improve", index: 1 }),
      ];
      const good = cite("q6_what_could_improve", 1);

      const { addressable, unaddressable } = partitionByCitation(
        [cite("q6_what_could_improve", 0), cite("q7_anything_else", 4), good],
        sent,
      );

      expect(addressable).toEqual([cite("q6_what_could_improve", 0), good]);
      expect(unaddressable).toEqual([cite("q7_anything_else", 4)]);
    });

    it("keeps a high index when the column really is that long", () => {
      const sent = Array.from({ length: 12 }, (_, index) =>
        sentence({ column: "q7_anything_else", index }),
      );

      const { addressable } = partitionByCitation([cite("q7_anything_else", 11)], sent);

      expect(addressable).toHaveLength(1);
    });
  });

  it("preserves the model's ordering within each half", () => {
    const sent = [
      sentence({ column: "q5_what_went_well", index: 0 }),
      sentence({ column: "q7_anything_else", index: 0 }),
    ];

    const { addressable } = partitionByCitation(
      [cite("q7_anything_else", 0), cite("q5_what_went_well", 0)],
      sent,
    );

    expect(addressable.map((v) => v.column)).toEqual(["q7_anything_else", "q5_what_went_well"]);
  });

  it("returns two empty halves for an empty batch", () => {
    expect(partitionByCitation([], [sentence()])).toEqual({
      addressable: [],
      unaddressable: [],
    });
  });
});
