"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import type { EngagementType, FreeTextColumn } from "../domain/engagement";
import type { RoutedLead } from "../pipeline/route";
import { isBuried, leadContext } from "../run/lead-context";
import type { RunTeam } from "../run/run-file";
import { setSent } from "./actions";
import styles from "./page.module.css";

const TYPE_LABELS = {
  volunteer_again: "Volunteer again",
  committee_board: "Committee / board",
  corporate_sponsorship: "Corporate sponsorship",
  refer_colleague: "Refer a colleague",
  speaking: "Speaking",
  donation: "Donation",
} as const satisfies Record<EngagementType, string>;

const COLUMN_LABELS = {
  q5_what_went_well: "What went well?",
  q6_what_could_improve: "What could improve?",
  q7_anything_else: "Anything else?",
} as const satisfies Record<FreeTextColumn, string>;

const PAGE_SIZE = 6;

type FilterKey = "all" | "buried" | "high" | "unsent";

export function LeadList({
  leads,
  teams,
  runId,
  sentIds,
}: {
  /** Pre-ranked by the server: strongest signal first, then confidence. */
  leads: RoutedLead[];
  teams: RunTeam[];
  /** `generatedAt` of the run on screen — sent marks are scoped to it. */
  runId: string;
  sentIds: string[];
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expanded, setExpanded] = useState(false);
  const [, startTransition] = useTransition();
  // Optimistic so the card flips on click; the appended mark is the truth the
  // next render re-reads.
  const [optimisticSent, applyMark] = useOptimistic(
    sentIds,
    (current: string[], update: { id: string; sent: boolean }) =>
      update.sent ? [...current, update.id] : current.filter((id) => id !== update.id),
  );
  const sent = useMemo(() => new Set(optimisticSent), [optimisticSent]);

  function toggleSent(id: string, next: boolean) {
    startTransition(async () => {
      applyMark({ id, sent: next });
      await setSent(id, runId, next);
    });
  }

  const buriedCount = useMemo(() => leads.filter(isBuried).length, [leads]);
  const sentCount = useMemo(
    () => leads.filter((lead) => sent.has(lead.responseId)).length,
    [leads, sent],
  );

  const filtered = useMemo(() => {
    const match = (lead: RoutedLead) =>
      filter === "all"
        ? true
        : filter === "buried"
          ? isBuried(lead)
          : filter === "high"
            ? lead.confidence >= 0.85
            : !sent.has(lead.responseId);
    // Server order preserved: strongest intent first, then confidence.
    return leads.filter(match);
  }, [leads, filter, sent]);

  const shown = expanded ? filtered : filtered.slice(0, PAGE_SIZE);

  const filters: { key: FilterKey; label: string }[] = [
    { key: "all", label: `All leads (${leads.length})` },
    { key: "buried", label: `Buried in critique (${buriedCount})` },
    { key: "high", label: "Confidence ≥ 0.85" },
    { key: "unsent", label: `Not yet sent (${leads.length - sentCount})` },
  ];

  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>Leads</h2>
          <span className={styles.sectionMeta}>
            {shown.length} of {filtered.length} shown · strongest intent first ·{" "}
            {sentCount === 0 ? "none sent yet" : `${sentCount} marked sent`}
          </span>
        </div>
        <div className={styles.filters}>
          {filters.map((f) => (
            <button
              type="button"
              key={f.key}
              className={`${styles.filter} ${filter === f.key ? styles.filterActive : ""}`}
              onClick={() => {
                setFilter(f.key);
                setExpanded(false);
              }}
              aria-pressed={filter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className={styles.empty}>No lead matches this filter.</p>
      ) : (
        shown.map((lead) => {
          const context = leadContext(lead);
          const team = teams.find((t) => t.id === lead.teamId);
          const high = lead.confidence >= 0.85;
          const isSent = sent.has(lead.responseId);
          return (
            <article
              className={`${styles.lead} ${isSent ? styles.leadSent : ""}`}
              key={lead.responseId}
            >
              <div className={styles.leadMain}>
                <div className={styles.leadTags}>
                  <span className={`${styles.tag} ${isBuried(lead) ? styles.tagBuried : ""}`}>
                    {lead.sourceColumn ? COLUMN_LABELS[lead.sourceColumn] : "Unknown column"}
                  </span>
                  <span className={styles.leadFact}>{lead.responseId}</span>
                  <span className={styles.leadFact}>{lead.program}</span>
                </div>

                <blockquote className={styles.leadQuote}>
                  {context.before ? (
                    <span className={styles.quoteContext}>{context.before} </span>
                  ) : null}
                  <mark>{context.trigger}</mark>
                  {context.after ? (
                    <span className={styles.quoteContext}> {context.after}</span>
                  ) : null}
                </blockquote>

                <div className={styles.leadMeta}>
                  <span className={styles.leadIntent}>
                    {lead.engagementType ? TYPE_LABELS[lead.engagementType] : "Signal only"}
                    {lead.multiIntent ? " + more" : ""}
                  </span>
                  <span className={styles.leadWho}>
                    {lead.name} · {lead.employer}
                  </span>
                  {lead.serviceRecovery ? (
                    <span className={styles.leadWho}>Service recovery</span>
                  ) : null}
                </div>
              </div>

              <div className={styles.leadSide}>
                <div>
                  <span className={styles.sideLabel}>Confidence</span>
                  <div className={styles.confidenceRow}>
                    <span className={styles.confidenceValue}>{lead.confidence.toFixed(2)}</span>
                    <span className={styles.confidenceBand}>
                      {lead.signal} · {high ? "high" : "medium"}
                    </span>
                  </div>
                  <div className={styles.bar}>
                    <div
                      className={`${styles.barFill} ${high ? styles.barFillHigh : ""}`}
                      style={{ width: `${Math.round(lead.confidence * 100)}%` }}
                    />
                  </div>
                </div>
                <div>
                  <span className={styles.sideLabel}>Routed to</span>
                  <span className={styles.routedTo}>{team?.label ?? "No owning team"}</span>
                  {team?.inferred ? (
                    <span className={styles.inferredFlag}>
                      <span className={styles.inferredDot} />
                      Inferred — not confirmed
                    </span>
                  ) : null}
                </div>
                <div>
                  <button
                    type="button"
                    className={`${styles.markSent} ${isSent ? styles.markSentDone : ""}`}
                    onClick={() => toggleSent(lead.responseId, !isSent)}
                    aria-pressed={isSent}
                    aria-label={`Mark ${lead.name} ${isSent ? "not sent" : "sent"}`}
                  >
                    {isSent ? "Sent ✓ · undo" : "Mark sent"}
                  </button>
                </div>
              </div>
            </article>
          );
        })
      )}

      {filtered.length > PAGE_SIZE ? (
        <div className={styles.moreRow}>
          <button
            type="button"
            className={styles.moreButton}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show all ${filtered.length} in this filter`}
          </button>
        </div>
      ) : null}
    </>
  );
}
