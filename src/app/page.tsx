import { readRun } from "../run/read";
import type { RunFile } from "../run/run-file";
import styles from "./page.module.css";

/**
 * One recipient queue, rendered from the committed `run.json`.
 *
 * No model call in the request path — that is the point. The demo reads a file,
 * so a rate limit or a network blip cannot kill the presentation (PRD #1
 * §No-gos), and nothing here imports Effect.
 *
 * The tracer produces a single lead, so this page shows a single queue. Slice
 * #7 turns it into the full set of inboxes.
 */

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  volunteer_again: "Volunteer again",
  committee_board: "Committee / board",
  corporate_sponsorship: "Corporate sponsorship",
  refer_colleague: "Refer a colleague",
  speaking: "Speaking",
  donation: "Donation",
};

const COLUMN_LABELS: Record<string, string> = {
  q5_what_went_well: "what went well",
  q6_what_could_improve: "what could improve",
  q7_anything_else: "anything else",
};

function firstQueue(run: RunFile) {
  const recipient = run.recipients.find((r) =>
    run.leads.some((lead) => lead.recipientIds.includes(r.id)),
  );
  if (recipient === undefined) return null;

  return {
    recipient,
    leads: run.leads.filter((lead) => lead.recipientIds.includes(recipient.id)),
  };
}

export default async function Page() {
  const run = await readRun();
  const queue = firstQueue(run);
  const teamLabel = (id: string | null) => run.teams.find((t) => t.id === id);

  return (
    <main className={styles.page}>
      <header>
        <div className={styles.masthead}>
          <h1 className={styles.title}>Volunteer Intent Router</h1>
        </div>
        <p className={styles.meta}>
          Run {new Date(run.generatedAt).toLocaleString("en-US")} · routing from{" "}
          <code>{run.configSource}</code> · {run.counts.routed} routed of {run.counts.responses}{" "}
          classified
        </p>
      </header>

      {run.partial ? (
        <p className={styles.banner}>
          <span className={styles.bannerLabel}>Partial run</span>
          <span>
            This run does not cover the whole export. It is the tracer — one response through every
            layer — not a measurement of the {run.counts.responses === 1 ? "384" : ""} rows.
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

      {queue === null ? (
        <section className={styles.queue}>
          <p className={styles.empty}>No lead in this run reached a recipient.</p>
        </section>
      ) : (
        <section className={styles.queue}>
          <div className={styles.queueHead}>
            <h2 className={styles.queueName}>{queue.recipient.name}</h2>
            <span className={styles.queueEmail}>
              {queue.recipient.role ? `${queue.recipient.role} · ` : ""}
              {queue.recipient.email}
            </span>
          </div>

          {queue.leads.map((lead) => {
            const team = teamLabel(lead.teamId);
            return (
              <article className={styles.lead} key={lead.responseId}>
                <div className={styles.leadHead}>
                  <h3 className={styles.leadName}>{lead.name}</h3>
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
                    <span className={styles.badge}>
                      {TYPE_LABELS[lead.engagementType] ?? lead.engagementType}
                    </span>
                  ) : null}
                  {team ? <span className={styles.badge}>{team.label}</span> : null}
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
                      {COLUMN_LABELS[lead.sourceColumn ?? ""] ?? lead.sourceColumn}”
                    </cite>
                  </blockquote>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
