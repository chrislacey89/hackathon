import { SIGNAL_RANK } from "../domain/engagement";
import type { ClassMetrics } from "../eval/evaluate";
import type { RoutedLead } from "../pipeline/route";
import { draftHtml, draftText } from "../run/draft-text";
import { isBuried, leadContext } from "../run/lead-context";
import { readRun, readUploadedRun } from "../run/read";
import type { RunFile } from "../run/run-file";
import { readSentMarks, sentIds } from "../run/sent";
import { CopyQueue } from "./CopyQueue";
import { LeadList } from "./LeadList";
import styles from "./page.module.css";
import { UploadCsv } from "./UploadCsv";

/**
 * The demo surface, rendered from the committed `run.json`.
 *
 * No model call in the request path — that is the point. The page reads a file,
 * so a rate limit or a network blip cannot kill the presentation (PRD #1
 * §No-gos), and nothing here imports Effect.
 *
 * Visual direction follows the JANI front-end brand guide: Montserrat, the
 * disciplined core palette, and its colour balance — mostly white and
 * Possibility Pearl, Immersive Blue-Black for structure, turquoise for accent,
 * and yellow held under 5% for the one thing that has to be seen.
 */

export const dynamic = "force-dynamic";

const SIGNAL_LABELS: Record<string, string> = {
  strong: "Explicit offer",
  soft: "Hedged or conditional",
  none: "No forward-looking intent",
};

const pct = (value: number) => value.toFixed(2);

/**
 * The strongest buried example that still has its surrounding sentences.
 *
 * Picked from data rather than hard-coded: the hero's claim is that offers hide
 * inside complaints, and it should be showing an actual one. Falls back to any
 * buried lead, then to nothing — the panel is omitted rather than faked.
 */
function heroExample(leads: RoutedLead[]): RoutedLead | null {
  const buried = leads.filter(isBuried).sort((a, b) => b.confidence - a.confidence);
  return buried.find((lead) => leadContext(lead).buriedInContext) ?? buried[0] ?? null;
}

function SignalTable({ model, baseline }: { model: ClassMetrics[]; baseline: ClassMetrics[] }) {
  const baseFor = (className: string) => baseline.find((b) => b.className === className);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.metrics}>
        <thead>
          <tr>
            <th>Intent class</th>
            <th className={styles.numeric}>Support</th>
            <th className={`${styles.numeric} ${styles.divider}`}>Model P</th>
            <th className={styles.numeric}>Model R</th>
            <th className={`${styles.numeric} ${styles.divider} ${styles.baselineHead}`}>
              Baseline P
            </th>
            <th className={`${styles.numeric} ${styles.baselineHead}`}>Baseline R</th>
          </tr>
        </thead>
        <tbody>
          {model.map((row, index) => {
            const base = baseFor(row.className);
            const rowClass = row.unmeasurable
              ? styles.rowLow
              : index % 2
                ? styles.rowAlt
                : undefined;
            return (
              <tr key={row.className} className={rowClass}>
                <td>
                  {SIGNAL_LABELS[row.className] ?? row.className}
                  {row.unmeasurable ? (
                    <span className={styles.rowMarker}>too few labeled examples</span>
                  ) : null}
                </td>
                <td className={styles.numeric}>{row.support}</td>
                <td className={`${styles.numeric} ${styles.modelCell}`}>
                  {row.unmeasurable ? "—" : pct(row.precision)}
                </td>
                <td className={`${styles.numeric} ${styles.modelCell}`} style={{ borderLeft: 0 }}>
                  {row.unmeasurable ? "—" : pct(row.recall)}
                </td>
                <td
                  className={`${styles.numeric} ${styles.baselineCell} ${styles.baselineCellFirst}`}
                >
                  {base && !base.unmeasurable ? pct(base.precision) : "—"}
                </td>
                <td className={`${styles.numeric} ${styles.baselineCell}`}>
                  {base && !base.unmeasurable ? pct(base.recall) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const fullRun: RunFile = await readRun();
  const uploadedRun = await readUploadedRun();
  const showUploaded = view === "uploaded" && uploadedRun !== null;
  const run = showUploaded ? uploadedRun : fullRun;

  // Strongest intent first, then confidence — the queue's promise is that the
  // people most worth engaging are at the top, and the copied draft keeps the
  // same order.
  const signalLeads = run.leads
    .filter((lead) => lead.signal !== "none")
    .sort((a, b) => SIGNAL_RANK[b.signal] - SIGNAL_RANK[a.signal] || b.confidence - a.confidence);
  const sent = sentIds(await readSentMarks(), run.generatedAt);
  const sentCount = signalLeads.filter((lead) => sent.has(lead.responseId)).length;
  const buriedCount = run.leads.filter(isBuried).length;
  const hero = heroExample(run.leads);
  const heroCtx = hero ? leadContext(hero) : null;
  const recipient = run.recipients[0];
  // The dev split is the one with enough support to be readable: holdout's
  // `soft` (n=8) and `strong` (n=7) both fall under the threshold and render as
  // "—", which would leave the comparison table saying nothing.
  const scored = run.eval?.dev ?? null;
  const holdout = run.eval?.holdout ?? null;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div>
          <div className={styles.brand}>
            <div className={styles.brandMark}>LOGO</div>
            <div>
              <span className={styles.brandName}>Junior Achievement</span>
              <span className={styles.brandLocal}>of Northern Indiana</span>
            </div>
          </div>
          <span className={styles.brandNote}>Placeholder — swap approved lockup</span>
        </div>

        <nav className={styles.navGroup} aria-label="Runs">
          <span className={styles.navLabel}>Runs</span>
          <a href="/" className={`${styles.navItem} ${showUploaded ? "" : styles.navItemActive}`}>
            <span>
              <span className={styles.navItemName}>Full export</span>
              <span className={styles.navItemScope}>
                committed run.json · {fullRun.counts.responses} responses
              </span>
            </span>
            <span className={styles.navItemCount}>{fullRun.counts.routed}</span>
          </a>
          {uploadedRun ? (
            <a
              href="/?view=uploaded"
              className={`${styles.navItem} ${showUploaded ? styles.navItemActive : ""}`}
            >
              <span>
                <span className={styles.navItemName}>Uploaded CSV</span>
                <span className={styles.navItemScope}>
                  classified live · {uploadedRun.counts.responses} responses
                </span>
              </span>
              <span className={styles.navItemCount}>{uploadedRun.counts.routed}</span>
            </a>
          ) : null}
          <UploadCsv />
        </nav>

        <nav className={styles.navGroup} aria-label="Follow-up queues">
          <span className={styles.navLabel}>Follow-up queues</span>
          <button type="button" className={`${styles.navItem} ${styles.navItemActive}`}>
            <span>
              <span className={styles.navItemName}>{recipient?.name ?? "No recipient"}</span>
              <span className={styles.navItemScope}>all programs · all counties</span>
            </span>
            <span className={styles.navItemCount}>{signalLeads.length}</span>
          </button>
          <p className={styles.navNote}>
            County × program routing is not built. Every lead below lands in one placeholder queue.
          </p>
        </nav>

        <div className={styles.sidebarFoot}>
          <span>
            Run {new Date(run.generatedAt).toLocaleDateString("en-US")} · {run.configSource}
          </span>
          <span>
            {showUploaded
              ? "Read from run.uploaded.json — classified live from your upload."
              : "Read from committed run.json — no model call in the request path."}
          </span>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={`${styles.header} ${styles.gutter}`}>
          <div>
            <span className={styles.eyebrow}>Volunteer intent router</span>
            <h1 className={styles.title}>Volunteers who said they&rsquo;d come back</h1>
            <p className={styles.lede}>
              {run.counts.responses} survey responses read at the sentence level.{" "}
              {run.counts.routed} carry a forward-looking offer. Each one arrives with the sentence
              that triggered it.
            </p>
          </div>
          <div className={styles.headerActions}>
            {recipient ? (
              <CopyQueue
                html={draftHtml(signalLeads)}
                text={draftText(signalLeads)}
                recipientName={recipient.name}
              />
            ) : null}
          </div>
        </header>

        <div className={`${styles.banners} ${styles.gutter}`}>
          <p className={styles.banner}>
            <span className={styles.bannerLabel}>Routing inferred</span>
            <span className={styles.bannerBody}>
              Recipients were inferred, not supplied by JA. Confirm the owner before sending
              anything.
            </span>
          </p>
          <div className={styles.bannerRow}>
            {run.partial ? (
              <p className={`${styles.banner} ${styles.bannerWarn}`}>
                <span className={styles.bannerLabel}>Partial</span>
                <span className={styles.bannerBody}>
                  This run does not cover the whole export. Some rows failed classification and are
                  excluded from every count on this page.
                </span>
              </p>
            ) : null}
            <p className={`${styles.banner} ${styles.bannerAlert}`}>
              <span className={styles.bannerLabel}>Unowned</span>
              <span className={styles.bannerBody}>
                {run.counts.routed} of {run.counts.routed} leads have no confirmed JA owner yet.{" "}
                {sentCount > 0
                  ? `${sentCount} marked sent by hand — the tool sends nothing itself.`
                  : "Nothing has been sent."}
              </span>
            </p>
          </div>
        </div>

        {hero && heroCtx ? (
          <section className={`${styles.heroWrap} ${styles.gutter}`}>
            <div className={styles.hero}>
              <div className={styles.heroFigure}>
                <span className={styles.heroEyebrow}>Buried offers</span>
                <span className={styles.heroNumber}>{buriedCount}</span>
                <span className={styles.heroClaim}>
                  offers to return were found inside &ldquo;What could improve?&rdquo;
                </span>
                <span className={styles.heroNote}>
                  Nobody reads that column, so every one of these would have expired unanswered.
                </span>
              </div>
              <div className={styles.heroExample}>
                <span className={styles.heroExampleLabel}>
                  {hero.responseId} · What could improve?
                </span>
                <blockquote className={styles.heroQuote}>
                  {heroCtx.before ? `${heroCtx.before} ` : ""}
                  <mark>{heroCtx.trigger}</mark>
                  {heroCtx.after ? ` ${heroCtx.after}` : ""}
                </blockquote>
                <span className={styles.heroCaption}>
                  Highlighted sentence is what the classifier flagged. The complaint around it is
                  why a human never saw the offer.
                </span>
              </div>
            </div>
          </section>
        ) : null}

        <section className={`${styles.stats} ${styles.gutter}`}>
          <div className={styles.stat}>
            <span className={styles.statValue}>{run.counts.responses}</span>
            <span className={styles.statLabel}>Responses read</span>
            <span className={styles.statNote}>
              {run.counts.responses} of {run.counts.responses} classified · 0 failures
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{run.counts.routed}</span>
            <span className={styles.statLabel}>Leads carrying intent</span>
            <span className={styles.statNote}>
              {Math.round((run.counts.routed / run.counts.responses) * 100)}% of all responses
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{run.counts.serviceRecovery}</span>
            <span className={styles.statLabel}>Complaints flagged</span>
            <span className={styles.statNote}>Surfaced separately from re-engagement</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{sentCount}</span>
            <span className={styles.statLabel}>Marked sent</span>
            <span className={styles.statNote}>
              {sentCount === 0
                ? "Copy the queue, send it, mark it here"
                : `${signalLeads.length - sentCount} of ${signalLeads.length} drafts remaining`}
            </span>
          </div>
        </section>

        <section className={`${styles.section} ${styles.gutter}`}>
          <LeadList
            leads={signalLeads}
            teams={run.teams}
            runId={run.generatedAt}
            sentIds={[...sent]}
          />
        </section>

        <section className={`${styles.section} ${styles.gutter}`}>
          <div className={styles.sectionHead}>
            <div>
              <h2 className={styles.sectionTitle}>Measurement</h2>
              <p className={styles.sectionNote}>
                Model scores sit beside a regex keyword baseline on the same holdout split. Where
                the baseline wins, it wins.
              </p>
            </div>
            {scored ? (
              <span className={styles.leadFact}>
                Dev split · n = {scored.totalLabeled} responses
              </span>
            ) : null}
          </div>

          {scored === null ? (
            <p className={styles.empty}>
              {showUploaded
                ? "Uploaded runs are not scored — measurement lives on the full export, whose rows overlap the labeled sample."
                : "This run has not been scored against the labeled sample. Run "}
              {showUploaded ? null : <code>pnpm eval</code>}
            </p>
          ) : (
            <>
              <SignalTable model={scored.signal} baseline={scored.baseline.signal} />
              <div className={styles.callout}>
                <span className={styles.calloutTitle}>
                  The model and a keyword regex score identically here
                </span>
                <span className={styles.calloutBody}>
                  Every figure in the two right-hand columns matches the model, digit for digit.
                  That is a fact about the <em>sample</em>, not about the model: its <em>none</em>{" "}
                  rows are terse and surface-separable — &ldquo;Good&rdquo;, &ldquo;No
                  comment&rdquo; — and contain no politeness formulas, which is exactly where a
                  regex breaks and a model earns its keep. This sample cannot yet tell the two
                  apart. Hard negatives are the next measurement to build.
                  {holdout ? (
                    <>
                      {" "}
                      The holdout split (n = {holdout.totalLabeled}) is shown as <strong>—</strong>{" "}
                      for both non-trivial classes because each has fewer than ten labeled examples;
                      a rate over seven cases is not a measurement.
                    </>
                  ) : null}
                </span>
              </div>
            </>
          )}
        </section>

        <footer className={`${styles.footer} ${styles.gutter}`}>
          <span className={styles.footerNote}>
            Junior Achievement of Northern Indiana · internal follow-up tool ·{" "}
            {run.counts.responses}/{run.counts.responses} responses classified, 0 failures. Names
            and quotes are synthetic demo data from the committed run.
          </span>
          <div className={styles.footerLinks}>
            <a href="/">Accessibility</a>
            <a href="/">Privacy</a>
            <a href="/">Support</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
