import type { FreeTextColumn } from "../domain/engagement";
import type { RoutedLead } from "../pipeline/route";

/**
 * Build the message body for one recipient's queue, in both flavours.
 *
 * The POC precursor to slice #16's `DraftBundle`. Kept deliberately small and
 * pure: it takes leads and returns two strings, so it is testable without a
 * browser and #16 can replace it without touching the copy surface.
 *
 * Both flavours carry the same rows. The plain-text version is not a stripped
 * afterthought — it is what lands when the HTML flavour does not survive the
 * paste, and a recipient who gets a mangled table is worse off than one who
 * gets a readable list.
 */

// Typed by the column union, not `Record<string, string>`, so a new free-text
// column breaks the build here rather than silently rendering "their response".
const COLUMN_LABELS = {
  q5_what_went_well: "what went well",
  q6_what_could_improve: "what could improve",
  q7_anything_else: "anything else",
} as const satisfies Record<FreeTextColumn, string>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `2026-01-15T20:15` → `Jan 15, 2026`. Date only — the time of day is noise to a caller. */
function attendedOn(submittedAt: string): string {
  const date = new Date(submittedAt);
  return Number.isNaN(date.getTime())
    ? submittedAt
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export type DraftLead = RoutedLead & { school?: string; submittedAt?: string };

export function draftSubject(recipientName: string, leadCount: number): string {
  const plural = leadCount === 1 ? "volunteer" : "volunteers";
  return `${leadCount} ${plural} to follow up with — ${recipientName}`;
}

export function draftText(leads: DraftLead[]): string {
  const rows = leads.map((lead) => {
    const where = lead.sourceColumn ? COLUMN_LABELS[lead.sourceColumn] : "their response";
    const when = lead.submittedAt ? ` · ${attendedOn(lead.submittedAt)}` : "";
    const school = lead.school ? ` · ${lead.school}` : "";
    return [
      `${lead.name} — ${lead.email}`,
      `  ${lead.employer} · ${lead.program}${school}${when}`,
      `  ${lead.signal} signal${lead.serviceRecovery ? " · service recovery" : ""}`,
      lead.quote ? `  "${lead.quote}"  (in "${where}")` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  });

  return `${rows.join("\n\n")}\n`;
}

export function draftHtml(leads: DraftLead[]): string {
  const rows = leads
    .map((lead) => {
      const where = lead.sourceColumn ? COLUMN_LABELS[lead.sourceColumn] : "their response";
      const meta = [
        lead.employer,
        lead.program,
        lead.school,
        lead.submittedAt ? attendedOn(lead.submittedAt) : null,
      ]
        .filter((part): part is string => Boolean(part))
        .map(escapeHtml)
        .join(" &middot; ");

      const quote = lead.quote
        ? `<div style="margin-top:4px;color:#14181f"><em>&ldquo;${escapeHtml(
            lead.quote,
          )}&rdquo;</em> <span style="color:#55606f">(in &ldquo;${escapeHtml(where)}&rdquo;)</span></div>`
        : "";

      return `<tr><td style="padding:10px 12px;border-bottom:1px solid #e3e7ee;vertical-align:top">
<div><strong>${escapeHtml(lead.name)}</strong> &mdash; <a href="mailto:${escapeHtml(
        lead.email,
      )}">${escapeHtml(lead.email)}</a></div>
<div style="color:#55606f;font-size:13px">${meta}</div>
<div style="color:#55606f;font-size:13px">${escapeHtml(lead.signal)} signal${
        lead.serviceRecovery ? " &middot; service recovery" : ""
      }</div>
${quote}
</td></tr>`;
    })
    .join("\n");

  return `<table style="border-collapse:collapse;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px">
${rows}
</table>`;
}
