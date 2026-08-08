import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { z } from "zod";

const RecipientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Strict here, unlike the volunteer address in `run-file.ts`: this is a short
  // hand-authored roster of JA staff, and a typo means a lead is routed to
  // nobody. Failing at config load is the cheapest place to catch it.
  email: z.email(),
  role: z.string().optional(),
});

/**
 * True when any part of this row is the builder's guess rather than JA's
 * answer. PRD #1 §Rabbit Holes: a confident-looking ranking built on invented
 * routing could get adopted as policy, so the guesses have to say so out loud.
 */
const inferred = z.boolean().optional();

/**
 * One of JA's engagement categories.
 *
 * These are **JA's**, not ours, and they live in a file rather than in a
 * TypeScript enum because Karen's list is provisional and her definitive one is
 * meant to be a data change (PRD #1 §Rabbit Holes). `label` and `description`
 * ride along with the id for the same reason: a category without a label used
 * to be caught by `satisfies Record<EngagementType, string>` in the UI, and that
 * guard cannot survive a runtime-sourced member set. Keeping all three fields on
 * one row makes the incomplete category unrepresentable instead of caught.
 *
 * `description` is what the classifier is told to look for — it is emitted
 * verbatim into the prompt, so editing the taxonomy retunes the model without
 * touching code.
 */
const CategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  inferred,
});

/**
 * One row of the `school → county` lookup.
 *
 * County is the axis JA is actually partitioned by and the export does not
 * carry it — the 16 columns have `school` and nothing else geographic (PRD #1
 * §Rabbit Holes). This is the only bridge between the two, and it is config
 * rather than code because the real export spans four markets while the sample
 * spans one.
 */
const CountySchema = z.object({
  school: z.string().min(1),
  county: z.string().min(1),
  inferred,
});

/**
 * The routing key: what a team owns is a `(category, county)` pair, not a
 * category.
 *
 * Deliberately a pair rather than two parallel lists (`categories[] × counties[]`).
 * A cross product would let a team claim ownership of combinations nobody
 * checked, and JA's real table is not a product — a development manager owns
 * donations in DeKalb without owning them everywhere.
 */
const RoutingKeySchema = z.object({
  category: z.string().min(1),
  county: z.string().min(1),
});

const TeamSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  owns: z.array(RoutingKeySchema),
  recipientIds: z.array(z.string().min(1)),
  inferred,
});

/** `config/teams.json` — the roster and the routing table. Gitignored; holds PII. */
const TeamsFileSchema = z.object({
  recipients: z.array(RecipientSchema),
  teams: z.array(TeamSchema),
  nearMissCap: z.number().int().positive(),
  /** Sourced from the AI Studio rate-limit dashboard, never guessed. Slice #4 consumes it. */
  concurrency: z.number().int().positive(),
});

/** `config/categories.json` — JA's engagement taxonomy. */
const CategoriesFileSchema = z.object({ categories: z.array(CategorySchema).min(1) });

/** `config/counties.json` — the `school → county` lookup. */
const CountiesFileSchema = z.object({ counties: z.array(CountySchema) });

export type Recipient = z.infer<typeof RecipientSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type CountyRow = z.infer<typeof CountySchema>;
export type RoutingKey = z.infer<typeof RoutingKeySchema>;

/**
 * Which file each part of the config actually came from.
 *
 * Three files rather than one because they have three different lifecycles:
 * `teams.json` carries staff PII and is gitignored, `categories.json` is JA's
 * taxonomy, and `counties.json` is publicly checkable geography. Each falls back
 * to a committed `.example.json` independently, so a fresh clone runs and the UI
 * can still say which parts are placeholders.
 */
export type ConfigSources = {
  teams: string;
  categories: string;
  counties: string;
};

/**
 * Routing configuration.
 *
 * Slices #5 and #6 extend this: #5 adds `positions`, `typeDepth`, `recency`,
 * and `nurture`; #6 adds `activeProfileId` and `profiles`. This slice carries
 * only what routing itself needs, plus `concurrency` for the sweep in #4.
 */
export type Config = z.infer<typeof TeamsFileSchema> &
  z.infer<typeof CategoriesFileSchema> &
  z.infer<typeof CountiesFileSchema> & { sources: ConfigSources };

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}

export type LoadConfigOptions = {
  /** Directory holding the config files. Defaults to `config`. */
  configDir?: string;
};

/** Preferred file first, committed example second. */
const CANDIDATES = {
  teams: ["teams.json", "teams.example.json"],
  categories: ["categories.json", "categories.example.json"],
  counties: ["counties.json", "counties.example.json"],
} as const satisfies Record<keyof ConfigSources, readonly [string, string]>;

/**
 * Read and validate one config file, preferring JA's over the committed example.
 *
 * The `.json` / `.example.json` pair is what keeps a fresh clone runnable:
 * `teams.json` holds real recipient names and addresses and is gitignored, so
 * absent is the expected state rather than an error (PRD #1 §Rabbit Holes).
 */
function readPart<T extends z.ZodType>(
  dir: string,
  part: keyof ConfigSources,
  schema: T,
): Effect.Effect<{ value: z.infer<T>; source: string }, ConfigError> {
  const candidates = CANDIDATES[part];

  return Effect.tryPromise({
    try: async () => {
      for (const source of candidates) {
        try {
          return { raw: await readFile(join(dir, source), "utf8"), source };
        } catch {
          // Absent is expected for the non-example name.
        }
      }
      throw new Error(`no ${candidates.join(" or ")} in ${dir}`);
    },
    catch: (cause) => new ConfigError({ reason: String(cause) }),
  }).pipe(
    Effect.flatMap(({ raw, source }) =>
      Effect.try({
        try: () => ({ parsed: JSON.parse(raw) as unknown, source }),
        catch: (cause) => new ConfigError({ reason: `malformed JSON in ${source}: ${cause}` }),
      }),
    ),
    Effect.flatMap(({ parsed, source }) => {
      const result = schema.safeParse(parsed);
      return result.success
        ? Effect.succeed({ value: result.data as z.infer<T>, source })
        : Effect.fail(
            new ConfigError({
              reason: `${source} does not match the config shape: ${result.error}`,
            }),
          );
    }),
  );
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * Every id a routing row names must actually resolve.
 *
 * A dangling reference sends a lead into a queue nobody owns, and the run looks
 * complete. Failing at load is loud and cheap; discovering it in a routed queue
 * is neither. Three files make this stricter than it was with one: a category id
 * typed into `teams.json` has no compiler to catch it now that the member set
 * lives in a file, so this check is the compiler.
 */
function crossFileProblems(config: Omit<Config, "sources">): string[] {
  const problems: string[] = [];

  const knownRecipients = new Set(config.recipients.map((r) => r.id));
  const knownCategories = new Set(config.categories.map((c) => c.id));
  const knownCounties = new Set(config.counties.map((c) => c.county));

  for (const id of duplicates(config.categories.map((c) => c.id))) {
    problems.push(`category "${id}" is defined more than once`);
  }
  // A school mapped to two counties is a silent misroute: the lookup would take
  // whichever row it happened to reach first, and both are plausible.
  for (const school of duplicates(config.counties.map((c) => c.school))) {
    problems.push(`school "${school}" is mapped to more than one county`);
  }

  for (const team of config.teams) {
    for (const id of team.recipientIds.filter((id) => !knownRecipients.has(id))) {
      problems.push(`team "${team.id}" routes to unknown recipient "${id}"`);
    }
    for (const key of team.owns) {
      if (!knownCategories.has(key.category)) {
        problems.push(`team "${team.id}" owns unknown category "${key.category}"`);
      }
      // Checked against the *values* of the lookup rather than a county list of
      // its own: a county nothing maps to can never be produced by
      // `resolveCounty`, so owning it is dead routing, not a gap to surface.
      if (!knownCounties.has(key.county)) {
        problems.push(
          `team "${team.id}" owns category "${key.category}" in unknown county "${key.county}"`,
        );
      }
    }
  }

  return problems;
}

/**
 * Load routing config from its three files, preferring JA's over the committed
 * examples.
 *
 * The examples assert as little as possible about how JA is partitioned:
 * `teams.example.json` is one placeholder recipient owning every category in
 * every county the lookup knows, per the reasoning recorded in
 * `docs/solutions/patterns/inferred-config-guesses-the-axis-not-the-values`.
 * `counties.example.json` is different in kind — geography is publicly checkable
 * and a wrong row misroutes one lead visibly, so it ships seeded and flagged
 * rather than empty.
 */
export function loadConfig(options: LoadConfigOptions = {}): Effect.Effect<Config, ConfigError> {
  const dir = options.configDir ?? "config";

  return Effect.all(
    {
      teams: readPart(dir, "teams", TeamsFileSchema),
      categories: readPart(dir, "categories", CategoriesFileSchema),
      counties: readPart(dir, "counties", CountiesFileSchema),
    },
    // Sequential rather than concurrent: three small local reads, and a
    // deterministic failure order means the operator is told about the first
    // broken file rather than whichever lost the race.
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((parts) => {
      const merged = {
        ...parts.teams.value,
        ...parts.categories.value,
        ...parts.counties.value,
      };

      const problems = crossFileProblems(merged);
      if (problems.length > 0) {
        return Effect.fail(new ConfigError({ reason: problems.join("; ") }));
      }

      return Effect.succeed({
        ...merged,
        sources: {
          teams: parts.teams.source,
          categories: parts.categories.source,
          counties: parts.counties.source,
        },
      });
    }),
  );
}
