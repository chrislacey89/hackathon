import type { EngagementType, FreeTextColumn } from "../domain/engagement";
import type { ClassMetrics } from "../eval/evaluate";
import type { RoutedLead } from "../pipeline/route";
import { draftHtml, draftText } from "../run/draft-text";
import { readRun } from "../run/read";
import type { RunFile } from "../run/run-file";
import { CopyQueue } from "./CopyQueue";
import styles from "./page.module.css";

/**
 * The demo surface, rendered from the committed `run.json`.
 *
 * No model call in the request path — that is the point. The page reads a file,
 * so a rate limit or a network blip cannot kill the presentation (PRD #1
 * §No-gos), and nothing here imports Effect.
 */

export const dynamic = "force-dynamic";

const TYPE_LABELS = {
  volunteer_again: "Volunteer again",
  committee_board: "Committee / board",
  corporate_sponsorship: "Corporate sponsorship",
  refer_colleague: "Refer a colleague",
  speaking: "Speaking",
  donation: "Donation",
} as const satisfies Record<EngagementType, string>;

const COLUMN_LABELS = {
  q5_what_went_well: "what went well",
  q6_what_could_improve: "what could improve",
  q7_anything_else: "anything else",
} as const satisfies Record<FreeTextColumn, string>;

const pct = (value: number) => `${Math.round(value * 100)}%`;

type Queue = { recipient: RunFile["recipients"][number]; leads: RoutedLead[] };

/** Every recipient with at least one lead. A recipient with none gets no queue, not an empty one. */
function queues(run: RunFile): Queue[] {
  return run.recipients
    .map((recipient) => ({
      recipient,
      leads: run.leads.filter(
        (lead) => lead.recipientIds.includes(recipient.id) && lead.signal !== "none",
      ),
    }))
    .filter((queue) => queue.leads.length > 0);
}

/**
 * Model vs keyword baseline, side by side, with support counts.
 *
 * The baseline column is the whole point: an LLM at 0.85 is a marginal gain
 * over a regex at 0.78, not a win, and a headline that omits the comparison
 * measures access to a model rather than capability from it (PRD #1 §Error
 * Modes 2). A rate is never shown without its `support`.
 */
function SignalTable({ model, baseline }: { model: ClassMetrics[]; baseline: ClassMetrics[] }) {
  const baseFor = (className: string) => baseline.find((b) => b.className === className);

  return (
    <table className={styles.metrics}>
      <thead>
        <tr>
          <th>Signal</th>
          <th>Support</th>
          <th>Model P</th>
          <th>Model R</th>
          <th>Baseline P</th>
          <th>Baseline R</th>
        </tr>
      </thead>
      <tbody>
        {model.map((row) => {
          const base = baseFor(row.className);
          return (
            <tr key={row.className}>
              <td>
                {row.className}
                {row.unmeasurable ? <span className={styles.unmeasurable}> too few</span> : null}
              </td>
              <td>{row.support}</td>
              <td>{row.unmeasurable ? "—" : pct(row.precision)}</td>
              <td>{row.unmeasurable ? "—" : pct(row.recall)}</td>
              <td className={styles.baselineCell}>{base ? pct(base.precision) : "—"}</td>
              <td className={styles.baselineCell}>{base ? pct(base.recall) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function Page() {
  const run = await readRun();
  const all = queues(run);
  const teamLabel = (id: string | null) => run.teams.find((t) => t.id === id);
  const buried = run.leads.filter(
    (lead) => lead.signal !== "none" && lead.sourceColumn === "q6_what_could_improve",
  ).length;

  return (
    <main className={styles.page}>
      <header>
        <div className={styles.masthead}>
          <h1 className={styles.title}>Volunteer Intent Router</h1>
        </div>
        <p className={styles.meta}>
          Run {new Date(run.generatedAt).toLocaleString("en-US")} · routing from{" "}
          <code>{run.configSource}</code>
        </p>
      </header>

      <section className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{run.counts.responses}</span>
          <span className={styles.statLabel}>responses read</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} ${styles.statValueAccent}`}>
            {run.counts.routed}
          </span>
          <span className={styles.statLabel}>carrying intent</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{buried}</span>
          <span className={styles.statLabel}>buried in “what could improve”</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{run.counts.serviceRecovery}</span>
          <span className={styles.statLabel}>service recovery</span>
        </div>
      </section>

      {run.partial ? (
        <p className={styles.banner}>
          <span className={styles.bannerLabel}>Partial run</span>
          <span>
            This run does not cover the whole export — some rows failed classification and are
            excluded from the counts above.
          </span>
        </p>
      ) : null}

      {run.counts.unowned > 0 ? (
        <p className={styles.banner}>
          <span className={styles.bannerLabel}>Unowned</span>
          <span>
            {run.counts.unowned} routable lead{run.counts.unowned === 1 ? "" : "s"} reached nobody.
            The routing table has a gap.
          </span>
        </p>
      ) : null}

      {run.eval === null ? (
        <p className={styles.banner}>
          <span className={styles.bannerLabel}>Not scored</span>
          <span>
            This run has not been measured against the labeled sample. Run <code>pnpm eval</code>.
          </span>
        </p>
      ) : (
        <section className={styles.evalBlock}>
          <h2 className={styles.sectionTitle}>How well did it do?</h2>
          <p className={styles.sectionNote}>
            Signal detection on the <strong>holdout</strong> split ({run.eval.holdout.totalLabeled}{" "}
            labeled rows), beside a keyword-only baseline. Rates are shown with their support counts
            — a percentage over four examples is not a measurement.
          </p>
          <SignalTable
            model={run.eval.holdout.signal}
            baseline={run.eval.holdout.baseline.signal}
          />
        </section>
      )}

      <h2 className={styles.sectionTitle}>
        {all.length} {all.length === 1 ? "queue" : "queues"}
      </h2>

      {all.length === 0 ? (
        <section className={styles.queue}>
          <p className={styles.empty}>No lead in this run reached a recipient.</p>
        </section>
      ) : (
        all.map((queue) => (
          <section className={styles.queue} key={queue.recipient.id}>
            <div className={styles.queueHead}>
              <div>
                <h3 className={styles.queueName}>{queue.recipient.name}</h3>
                <span className={styles.queueEmail}>
                  {queue.recipient.role ? `${queue.recipient.role} · ` : ""}
                  {queue.recipient.email} · {queue.leads.length} lead
                  {queue.leads.length === 1 ? "" : "s"}
                </span>
              </div>
              <CopyQueue
                html={draftHtml(queue.leads)}
                text={draftText(queue.leads)}
                recipientName={queue.recipient.name}
              />
            </div>

            {queue.leads.map((lead) => {
              const team = teamLabel(lead.teamId);
              return (
                <article className={styles.lead} key={lead.responseId}>
                  <div className={styles.leadHead}>
                    <h4 className={styles.leadName}>{lead.name}</h4>
                    <span className={styles.leadWhere}>
                      {lead.employer} · {lead.program}
                    </span>
                  </div>

                  <div className={styles.badges}>
                    <span
                      className={`${styles.badge} ${lead.signal === "strong" ? styles.badgeStrong : ""}`}
                    >
                      {lead.signal} signal
                    </span>
                    {lead.engagementType ? (
                      <span className={styles.badge}>{TYPE_LABELS[lead.engagementType]}</span>
                    ) : null}
                    {team?.inferred ? (
                      <span className={`${styles.badge} ${styles.badgeInferred}`}>
                        routing inferred
                      </span>
                    ) : null}
                    {lead.serviceRecovery ? (
                      <span className={styles.badge}>service recovery</span>
                    ) : null}
                  </div>

                  {lead.quote ? (
                    <blockquote className={styles.quote}>
                      <p>“{lead.quote}”</p>
                      <cite className={styles.cite}>
                        {lead.name.split(" ")[0]}, in “
                        {lead.sourceColumn ? COLUMN_LABELS[lead.sourceColumn] : "an unknown box"}”
                      </cite>
                    </blockquote>
                  ) : null}
                </article>
              );
            })}
          </section>
        ))
      )}
    </main>
  );
}
