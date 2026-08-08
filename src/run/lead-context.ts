import type { RoutedLead } from "../pipeline/route";

/**
 * The triggering sentence, with the sentences that surrounded it.
 *
 * This is what makes "buried in a complaint" visible rather than asserted. The
 * lead's `quote` alone shows the offer; showing it *in situ* — greyed
 * complaint, highlighted offer — shows why a human skimming the column never
 * saw it. That contrast is the demo's whole argument, so it is reconstructed
 * from data rather than hand-written.
 */
export type LeadContext = {
  before: string;
  trigger: string;
  after: string;
  /** True when the trigger sat alongside other sentences rather than alone. */
  buriedInContext: boolean;
};

/**
 * Rebuild the surrounding sentences from the lead's own verdicts.
 *
 * `aggregate` keeps every sentence verdict on the lead, so the neighbours are
 * already present — they just have to be put back in order. Matching is on
 * `(column, quote)` because `ResponseVerdict` records which sentence won but
 * not its index; the column narrows it and the text settles it.
 *
 * Falls back to trigger-only whenever anything is ambiguous or missing. A
 * wrong `before` would misattribute someone else's words to this volunteer,
 * which is worse than showing no context at all.
 */
export function leadContext(lead: RoutedLead): LeadContext {
  const trigger = lead.quote ?? "";
  const alone: LeadContext = { before: "", trigger, after: "", buriedInContext: false };

  if (trigger === "" || lead.sourceColumn === null) return alone;

  const column = lead.verdicts
    .filter((verdict) => verdict.column === lead.sourceColumn)
    .sort((a, b) => a.sentenceIndex - b.sentenceIndex);

  const at = column.findIndex((verdict) => verdict.quote === trigger);
  if (at === -1) return alone;

  const before = column
    .slice(0, at)
    .map((verdict) => verdict.quote)
    .join(" ");
  const after = column
    .slice(at + 1)
    .map((verdict) => verdict.quote)
    .join(" ");

  return {
    before,
    trigger,
    after,
    buriedInContext: before !== "" || after !== "",
  };
}

/** Leads whose offer sat inside "what could improve" — the column nobody skims. */
export function isBuried(lead: RoutedLead): boolean {
  return lead.signal !== "none" && lead.sourceColumn === "q6_what_could_improve";
}
