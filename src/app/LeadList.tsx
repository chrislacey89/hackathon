"use client";

import { useMemo, useState } from "react";
import type { EngagementType, FreeTextColumn } from "../domain/engagement";
import type { RoutedLead } from "../pipeline/route";
import { isBuried, leadContext } from "../run/lead-context";
import type { RunTeam } from "../run/run-file";
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

type FilterKey = "all" | "buried" | "high";

export function LeadList({ leads, teams }: { leads: RoutedLead[]; teams: RunTeam[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expanded, setExpanded] = useState(false);

  const buriedCount = useMemo(() => leads.filter(isBuried).length, [leads]);

  const filtered = useMemo(() => {
    const match = (lead: RoutedLead) =>
      filter === "all" ? true : filter === "buried" ? isBuried(lead) : lead.confidence >= 0.85;
    // Highest confidence first — the reviewer's time is the scarce resource.
    return leads.filter(match).sort((a, b) => b.confidence - a.confidence);
  }, [leads, filter]);

  const shown = expanded ? filtered : filtered.slice(0, PAGE_SIZE);

  const filters: { key: FilterKey; label: string }[] = [
    { key: "all", label: `All leads (${leads.length})` },
    { key: "buried", label: `Buried in critique (${buriedCount})` },
    { key: "high", label: "Confidence ≥ 0.85" },
  ];

  return (
    <>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>Leads</h2>
          <span className={styles.sectionMeta}>
            {shown.length} of {filtered.length} shown · sorted by confidence
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
          return (
            <article className={styles.lead} key={lead.responseId}>
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
