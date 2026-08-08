import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { z } from "zod";
import { ENGAGEMENT_TYPES } from "../domain/engagement";

const RecipientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1),
  role: z.string().optional(),
});

const TeamSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  owns: z.array(z.enum(ENGAGEMENT_TYPES)),
  recipientIds: z.array(z.string().min(1)),
  /**
   * True when any part of this row is the builder's guess rather than JA's
   * answer. PRD #1 §Rabbit Holes: a confident-looking ranking built on invented
   * routing could get adopted as policy, so the guesses have to say so out loud.
   */
  inferred: z.boolean().optional(),
});

const ConfigSchema = z.object({
  recipients: z.array(RecipientSchema),
  teams: z.array(TeamSchema),
  nearMissCap: z.number().int().positive(),
  /** Sourced from the AI Studio rate-limit dashboard, never guessed. Slice #4 consumes it. */
  concurrency: z.number().int().positive(),
});

export type Recipient = z.infer<typeof RecipientSchema>;
export type Team = z.infer<typeof TeamSchema>;

/**
 * Routing configuration.
 *
 * Slices #5 and #6 extend this: #5 adds `positions`, `typeDepth`, `recency`,
 * and `nurture`; #6 adds `activeProfileId` and `profiles`. This slice carries
 * only what routing itself needs, plus `concurrency` for the sweep in #4.
 *
 * `source` records which file the values came from, so the UI can say whether
 * it is showing JA's routing or a committed placeholder.
 */
export type Config = z.infer<typeof ConfigSchema> & {
  source: "teams.json" | "teams.example.json";
};

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}

export type LoadConfigOptions = {
  /** Directory holding `teams.json` / `teams.example.json`. Defaults to `config`. */
  configDir?: string;
};

const CANDIDATES = ["teams.json", "teams.example.json"] as const;

function readFirstPresent(
  dir: string,
): Effect.Effect<{ raw: string; source: Config["source"] }, ConfigError> {
  return Effect.tryPromise({
    try: async () => {
      for (const source of CANDIDATES) {
        try {
          return { raw: await readFile(join(dir, source), "utf8"), source };
        } catch {
          // Absent is expected for teams.json — it holds real recipient PII and
          // is gitignored, so a fresh clone has only the example.
        }
      }
      throw new Error(`no ${CANDIDATES.join(" or ")} in ${dir}`);
    },
    catch: (cause) => new ConfigError({ reason: String(cause) }),
  });
}

/**
 * Every recipient a team routes to must actually exist.
 *
 * A dangling recipient id sends a lead into a queue nobody owns, and the run
 * looks complete. Failing at load is loud and cheap; discovering it in a
 * routed queue is neither.
 */
function checkRecipientsResolve(config: z.infer<typeof ConfigSchema>): string[] {
  const known = new Set(config.recipients.map((r) => r.id));
  return config.teams.flatMap((team) =>
    team.recipientIds
      .filter((id) => !known.has(id))
      .map((id) => `team "${team.id}" routes to unknown recipient "${id}"`),
  );
}

/**
 * Load routing config, preferring JA's real file and falling back to the
 * committed example.
 *
 * `config/teams.json` holds real recipient names and email addresses once
 * Karen answers — the first real personal data in an otherwise synthetic
 * project — so it is gitignored and `config/teams.example.json` is committed
 * with placeholders in its place (PRD #1 §Rabbit Holes). The fallback is what
 * keeps a fresh clone runnable without it.
 *
 * The example is one placeholder team owning every type, not a four-way split
 * approximating JA's structure. Per the correct-course note on #2
 * (2026-08-08), `teams` is about to gain a county dimension and three of the
 * six engagement types may not survive JA's taxonomy, so an elaborated table
 * would be investment in a shape being rewritten — and a plausible-looking
 * guess is the thing PRD #1 §No-gos warns can get adopted as policy. The real
 * mapping stays in `KAREN-QUESTIONS.md` until JA answers it.
 */
export function loadConfig(options: LoadConfigOptions = {}): Effect.Effect<Config, ConfigError> {
  const dir = options.configDir ?? "config";

  return readFirstPresent(dir).pipe(
    Effect.flatMap(({ raw, source }) =>
      Effect.try({
        try: () => ({ parsed: JSON.parse(raw) as unknown, source }),
        catch: (cause) => new ConfigError({ reason: `malformed JSON in ${source}: ${cause}` }),
      }),
    ),
    Effect.flatMap(({ parsed, source }) => {
      const result = ConfigSchema.safeParse(parsed);
      if (!result.success) {
        return Effect.fail(
          new ConfigError({ reason: `${source} does not match the config shape: ${result.error}` }),
        );
      }

      const dangling = checkRecipientsResolve(result.data);
      return dangling.length > 0
        ? Effect.fail(new ConfigError({ reason: `${source}: ${dangling.join("; ")}` }))
        : Effect.succeed({ ...result.data, source });
    }),
  );
}
