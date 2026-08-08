import { describe, expect, it } from "vitest";
import { type DraftLead, draftHtml, draftSubject, draftText } from "./draft-text";

function lead(overrides: Partial<DraftLead> = {}): DraftLead {
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
    teamId: "placeholder-team",
    recipientIds: ["r1"],
    county: "Allen",
    school: "Wayne HS",
    submittedAt: "2026-01-15T20:15",
    name: "Dana Reyes",
    email: "dana@acme.com",
    employer: "Acme Corp",
    program: "JA in a Day",
    ...overrides,
  };
}

describe("draftHtml", () => {
  it("escapes markup in volunteer-supplied text", () => {
    // The quote comes from a survey box a human typed into. An unescaped `<`
    // silently swallows the rest of the row when Outlook renders it.
    const html = draftHtml([
      lead({ name: "Ben & Co <admin>", quote: 'She said "yes" & <meant> it' }),
    ]);

    expect(html).toContain("Ben &amp; Co &lt;admin&gt;");
    expect(html).toContain("&quot;yes&quot; &amp; &lt;meant&gt;");
    expect(html).not.toContain("<admin>");
    expect(html).not.toContain("<meant>");
  });

  it("cites the column the quote came from", () => {
    expect(draftHtml([lead()])).toContain("what could improve");
  });

  it("renders one row per lead", () => {
    const html = draftHtml([lead(), lead({ responseId: "JA-2", name: "Sam Okoro" })]);

    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain("Sam Okoro");
  });

  it("omits the quote block entirely when there is no quote", () => {
    expect(draftHtml([lead({ quote: null })])).not.toContain("<em>");
  });
});

describe("draftText", () => {
  it("carries the same substance as the HTML flavour", () => {
    // The plain version is the fallback when rich paste does not survive, so a
    // recipient reading it must not be missing the thing that made this a lead.
    const text = draftText([lead()]);

    expect(text).toContain("Dana Reyes");
    expect(text).toContain("dana@acme.com");
    expect(text).toContain("Put me down for next fall.");
    expect(text).toContain("what could improve");
    expect(text).toContain("strong signal");
  });

  it("does not escape — it is not markup", () => {
    expect(draftText([lead({ name: "Ben & Co" })])).toContain("Ben & Co");
  });

  it("flags service recovery inline", () => {
    expect(draftText([lead({ serviceRecovery: true })])).toContain("service recovery");
  });

  it("includes school and date when the lead carries them", () => {
    const text = draftText([lead({ school: "Wayne HS", submittedAt: "2026-01-15T20:15" })]);

    expect(text).toContain("Wayne HS");
    expect(text).toContain("Jan 15, 2026");
  });

  it("omits them cleanly when it does not", () => {
    expect(draftText([lead()])).not.toContain("undefined");
  });
});

describe("draftSubject", () => {
  it("agrees in number", () => {
    expect(draftSubject("Program Staff", 1)).toContain("1 volunteer to");
    expect(draftSubject("Program Staff", 4)).toContain("4 volunteers to");
  });
});
