import { describe, expect, it } from "vitest";
import type { SentenceVerdict } from "../domain/engagement";
import type { ResponseVerdict } from "./aggregate";
import type { SurveyResponse } from "./ingest";
import {
  collectedKeys,
  consentOf,
  extractQuotes,
  NEEDS_CHECK_HEADING,
  type QuoteCandidate,
  renderQuotesDocument,
  USABLE_HEADING,
} from "./quotes";

function response(overrides: Partial<SurveyResponse> = {}): SurveyResponse {
  return {
    responseId: "JA-1",
    submittedAt: "2026-01-05",
    program: "JA BizTown",
    school: "Northside Elementary",
    volunteerName: "Ada Lovelace",
    volunteerEmail: "ada@example.com",
    employer: "Analytical Engines",
    roleThisYear: "Classroom volunteer",
    q1OverallSatisfaction: 5,
    q2WouldRecommend: 5,
    q3FeltPrepared: 4,
    q4VolunteerAgain: true,
    q5WhatWentWell: null,
    q6WhatCouldImprove: null,
    q7AnythingElse: null,
    optInContact: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<SentenceVerdict> = {}): SentenceVerdict {
  return {
    column: "q5_what_went_well",
    sentenceIndex: 0,
    quote: "The students asked better questions than the adults do.",
    signal: "none",
    engagementType: null,
    confidence: 0.9,
    serviceRecovery: false,
    quotable: true,
    ...overrides,
  };
}

function responseVerdict(overrides: Partial<ResponseVerdict> = {}): ResponseVerdict {
  return {
    responseId: "JA-1",
    signal: "none",
    engagementType: null,
    engagementTypes: [],
    confidence: 0,
    quote: null,
    sourceColumn: null,
    serviceRecovery: false,
    multiIntent: false,
    verdicts: [verdict()],
    ...overrides,
  };
}

describe("consentOf", () => {
  it("reads an explicit yes as granted", () => {
    expect(consentOf(response({ optInContact: true }))).toBe("granted");
  });

  it("reads an explicit no as declined", () => {
    expect(consentOf(response({ optInContact: false }))).toBe("declined");
  });

  it("reads a blank as needs_check rather than assuming either answer", () => {
    expect(consentOf(response({ optInContact: null }))).toBe("needs_check");
  });
});

describe("extractQuotes", () => {
  it("carries the attribution a grants writer needs to use the quote", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true, volunteerName: "Ada Lovelace", program: "JA BizTown" })],
      [responseVerdict()],
    );

    expect(candidates).toEqual([
      {
        responseId: "JA-1",
        quote: "The students asked better questions than the adults do.",
        sourceColumn: "q5_what_went_well",
        volunteerName: "Ada Lovelace",
        program: "JA BizTown",
        consent: "granted",
      },
    ]);
  });

  it("draws nothing at all from a volunteer who declined contact", () => {
    const candidates = extractQuotes(
      [response({ optInContact: false })],
      [responseVerdict({ verdicts: [verdict({ quotable: true })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("keeps a blank-consent quote, marked for a human to check", () => {
    const candidates = extractQuotes([response({ optInContact: null })], [responseVerdict()]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.consent).toBe("needs_check");
  });

  it("ignores a sentence the model judged unquotable", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [responseVerdict({ verdicts: [verdict({ quotable: false })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("ignores a sentence nobody judged, rather than treating null as a yes", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [responseVerdict({ verdicts: [verdict({ quotable: null })] })],
    );

    expect(candidates).toEqual([]);
  });

  it("collects a quote from a volunteer with no engagement signal whatsoever", () => {
    // The slice's reason for existing. A response nobody would ever route can
    // still hold the best line in the export, so quotability must not be
    // reachable from signal in either direction.
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [
        responseVerdict({
          signal: "none",
          engagementType: null,
          quote: null,
          sourceColumn: null,
          verdicts: [verdict({ signal: "none", engagementType: null, quotable: true })],
        }),
      ],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.quote).toBe("The students asked better questions than the adults do.");
  });

  it("collects every quotable sentence in a response, not just the strongest", () => {
    const candidates = extractQuotes(
      [response({ optInContact: true })],
      [
        responseVerdict({
          verdicts: [
            verdict({ quote: "First good line.", quotable: true }),
            verdict({ sentenceIndex: 1, quote: "Middling line.", quotable: false }),
            verdict({ sentenceIndex: 2, quote: "Second good line.", quotable: true }),
          ],
        }),
      ],
    );

    expect(candidates.map((c) => c.quote)).toEqual(["First good line.", "Second good line."]);
  });

  it("fails loudly when a verdict has no survey row to attribute it to", () => {
    expect(() => extractQuotes([], [responseVerdict({ responseId: "JA-404" })])).toThrow("JA-404");
  });
});

function candidate(overrides: Partial<QuoteCandidate> = {}): QuoteCandidate {
  return {
    responseId: "JA-1",
    quote: "The students asked better questions than the adults do.",
    sourceColumn: "q5_what_went_well",
    volunteerName: "Ada Lovelace",
    program: "JA BizTown",
    consent: "granted",
    ...overrides,
  };
}

/** The text between one heading and the next — the group a reader sees. */
function section(document: string, heading: string): string {
  const start = document.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = document.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("renderQuotesDocument", () => {
  it("files a granted quote under usable, with its attribution", () => {
    const document = renderQuotesDocument("", [candidate()]);
    const usable = section(document, USABLE_HEADING);

    expect(usable).toContain("The students asked better questions than the adults do.");
    expect(usable).toContain("Ada Lovelace");
    expect(usable).toContain("JA BizTown");
    expect(usable).toContain("q5_what_went_well");
    expect(usable).toContain("JA-1");
  });

  it("files a blank-consent quote under needs consent check, not under usable", () => {
    const document = renderQuotesDocument("", [candidate({ consent: "needs_check" })]);

    expect(section(document, NEEDS_CHECK_HEADING)).toContain("Ada Lovelace");
    expect(section(document, USABLE_HEADING)).not.toContain("Ada Lovelace");
  });

  it("does not re-add a quote a previous run already collected", () => {
    const first = renderQuotesDocument("", [candidate()]);
    const second = renderQuotesDocument(first, [candidate()]);

    expect(second).toBe(first);
  });

  it("keeps every byte of the previous document when adding a new quote", () => {
    const first = renderQuotesDocument("", [candidate()]);
    const second = renderQuotesDocument(first, [
      candidate({ responseId: "JA-2", quote: "Best day of my working year." }),
    ]);

    for (const line of first.split("\n").filter((l) => l.trim() !== "")) {
      expect(second).toContain(line);
    }
    expect(second).toContain("Best day of my working year.");
  });

  it("treats the same prose from a renumbered response as a new quote", () => {
    // PRD #1 settled the renumbering case for the ledger by widening the key.
    // The same reasoning applies here: identity is the response *and* the
    // prose, so a re-export that renumbers does not suppress a real quote.
    const first = renderQuotesDocument("", [candidate({ responseId: "JA-1" })]);
    const second = renderQuotesDocument(first, [candidate({ responseId: "JA-9001" })]);

    expect(second).not.toBe(first);
    expect(collectedKeys(second).size).toBe(2);
  });

  it("keeps a quote containing a quotation mark round-trippable", () => {
    const tricky = 'One student told me "I want to run this place one day".';
    const document = renderQuotesDocument("", [candidate({ quote: tricky })]);

    expect(collectedKeys(document)).toContain(`JA-1::q5_what_went_well::${tricky}`);
    expect(renderQuotesDocument(document, [candidate({ quote: tricky })])).toBe(document);
  });

  it("refuses to rewrite a document whose headings it cannot find", () => {
    expect(() => renderQuotesDocument("# Notes I typed myself\n", [candidate()])).toThrow(
      /refusing to rewrite/,
    );
  });

  it("fails loudly on a quote-key marker it cannot read, rather than silently losing history", () => {
    const corrupted = renderQuotesDocument("", [candidate()]).replace(
      /<!-- quote-key: .+ -->/,
      "<!-- quote-key: not-json -->",
    );

    expect(() => renderQuotesDocument(corrupted, [candidate()])).toThrow(/unreadable quote-key/);
  });
});
