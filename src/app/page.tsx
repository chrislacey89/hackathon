import type { FreeTextColumn } from "../domain/engagement";
import { readRun } from "../run/read";
import type { RunCategory, RunFile } from "../run/run-file";
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

const COLUMN_LABELS = {
  q5_what_went_well: "what went well",
  q6_what_could_improve: "what could improve",
  q7_anything_else: "anything else",
} as const satisfies Record<FreeTextColumn, string>;

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

  /**
   * Category labels come from the run, not from a map in this file.
   *
   * The old `TYPE_LABELS satisfies Record<EngagementType, string>` broke the
   * build when a category was added without a label — a guard worth naming
   * because it is gone. It cannot survive a runtime-sourced member set, so the
   * label moved into `config/categories.json` beside the id, where a category
   * without one is rejected at load rather than caught at compile time.
   * `parseRun` refuses a lead citing a category the run does not carry, so the
   * fallback below is unreachable for a validated run — it exists so this
   * function is total rather than as a place a raw id could quietly surface.
   */
  const category = (id: string): RunCategory =>
    run.categories.find((c) => c.id === id) ?? { id, label: id, inferred: false };

  const countyInferred = (school: string) =>
    run.counties.find((row) => row.school === school)?.inferred ?? false;

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
            No recipient owns their category in their county — <code>teams.json</code> has a gap.
          </span>
        </p>
      ) : null}

      {/* A separate banner, not a second sentence in the one above. The repairs
          are different files and different people: an unowned lead needs JA to
          name a manager, an unmapped one needs a row added to the lookup. */}
      {run.counts.unmapped > 0 ? (
        <p className={styles.banner}>
          <span className={styles.bannerLabel}>Unmapped</span>
          <span>
            {run.counts.unmapped} routable lead{run.counts.unmapped === 1 ? "" : "s"} came from a
            school that is in no county. They are held here rather than guessed —{" "}
            <code>counties.json</code> has a gap.
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
                    <span className={styles.badge}>{category(lead.engagementType).label}</span>
                  ) : null}
                  {lead.county ? (
                    <span className={styles.badge}>{lead.county} County</span>
                  ) : (
                    <span className={`${styles.badge} ${styles.badgeInferred}`}>
                      county unmapped · {lead.school}
                    </span>
                  )}
                  {team ? <span className={styles.badge}>{team.label}</span> : null}
                  {/* PRD #1 §Flow Sketch: anything JA has not authored says so.
                      Three separate guesses, badged separately, because they are
                      three separate things for JA to correct. */}
                  {team?.inferred ? (
                    <span className={`${styles.badge} ${styles.badgeInferred}`}>
                      routing inferred
                    </span>
                  ) : null}
                  {lead.engagementType && category(lead.engagementType).inferred ? (
                    <span className={`${styles.badge} ${styles.badgeInferred}`}>
                      category inferred
                    </span>
                  ) : null}
                  {lead.county && countyInferred(lead.school) ? (
                    <span className={`${styles.badge} ${styles.badgeInferred}`}>
                      county inferred
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
      )}
    </main>
  );
}
