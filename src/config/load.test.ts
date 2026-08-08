import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./load";

async function configDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vir-config-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }
  return dir;
}

const TEAMS = JSON.stringify({
  recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
  teams: [
    {
      id: "t1",
      label: "Real Team",
      owns: [{ category: "volunteer_again", county: "Allen" }],
      recipientIds: ["r1"],
    },
  ],
  nearMissCap: 10,
  concurrency: 2,
});

const CATEGORIES = JSON.stringify({
  categories: [{ id: "volunteer_again", label: "Volunteer again", description: "come back" }],
});

const COUNTIES = JSON.stringify({ counties: [{ school: "Northrop HS", county: "Allen" }] });

/** The three files a complete config needs, any of which a test can override. */
function complete(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "teams.json": TEAMS,
    "categories.json": CATEGORIES,
    "counties.json": COUNTIES,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("prefers the real teams.json when it is present", async () => {
    const dir = await configDir(complete({ "teams.example.json": TEAMS }));

    const config = await Effect.runPromise(loadConfig({ configDir: dir }));

    expect(config.teams[0]?.label).toBe("Real Team");
    expect(config.sources.teams).toBe("teams.json");
  });

  it("reads categories and the school lookup from their own files", async () => {
    const dir = await configDir(complete());

    const config = await Effect.runPromise(loadConfig({ configDir: dir }));

    expect(config.categories).toEqual([
      { id: "volunteer_again", label: "Volunteer again", description: "come back" },
    ]);
    expect(config.counties).toEqual([{ school: "Northrop HS", county: "Allen" }]);
  });

  it("falls back to the committed example when a file's real name is absent", async () => {
    const dir = await configDir({
      "teams.example.json": TEAMS,
      "categories.json": CATEGORIES,
      "counties.example.json": COUNTIES,
    });

    const config = await Effect.runPromise(loadConfig({ configDir: dir }));

    // Each file falls back independently — a repo with JA's real taxonomy but
    // still-placeholder recipients is a state the UI has to be able to describe.
    expect(config.sources).toEqual({
      teams: "teams.example.json",
      categories: "categories.json",
      counties: "counties.example.json",
    });
  });

  it("fails with a typed ConfigError when neither file exists", async () => {
    const dir = await configDir({});

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigError);
      // Asserting the reason, not just the failure: without this the test would
      // still pass if the loader started failing for some unrelated cause.
      expect(result.left.reason).toMatch(/no teams\.json or teams\.example\.json/);
    }
  });

  it("names the missing file when only one of the three is absent", async () => {
    const dir = await configDir({ "teams.json": TEAMS, "categories.json": CATEGORIES });

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.reason).toMatch(/no counties\.json or counties\.example\.json/);
    }
  });

  it("fails rather than returning a partial object when the shape is wrong", async () => {
    const dir = await configDir(complete({ "teams.json": JSON.stringify({ teams: [] }) }));

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.reason).toMatch(/does not match the config shape/);
    }
  });

  it("rejects a recipient whose email is malformed", async () => {
    const dir = await configDir(
      complete({
        "teams.json": JSON.stringify({
          recipients: [{ id: "r1", name: "Real Person", email: "not-an-email" }],
          teams: [{ id: "t1", label: "Team", owns: [], recipientIds: ["r1"] }],
          nearMissCap: 10,
          concurrency: 2,
        }),
      }),
    );

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left")
      expect(result.left.reason).toMatch(/does not match the config shape/);
  });

  it("rejects a team routing to a recipient that does not exist", async () => {
    const dir = await configDir(
      complete({
        "teams.json": JSON.stringify({
          recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
          teams: [{ id: "t1", label: "Team", owns: [], recipientIds: ["ghost"] }],
          nearMissCap: 10,
          concurrency: 2,
        }),
      }),
    );

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toMatch(/ghost/);
  });

  describe("the checks that replace the compiler", () => {
    // Category ids used to be members of a TS union, so `owns: ["donatoin"]`
    // was a build error. They come from a file now, and these three checks are
    // what stands in for the type that used to catch a typo.

    it("rejects a team owning a category no categories file defines", async () => {
      const dir = await configDir(
        complete({
          "teams.json": JSON.stringify({
            recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
            teams: [
              {
                id: "t1",
                label: "Team",
                owns: [{ category: "volunteer_agian", county: "Allen" }],
                recipientIds: ["r1"],
              },
            ],
            nearMissCap: 10,
            concurrency: 2,
          }),
        }),
      );

      const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.reason).toMatch(/unknown category "volunteer_agian"/);
      }
    });

    it("rejects a team owning a county no school maps to", async () => {
      const dir = await configDir(
        complete({
          "teams.json": JSON.stringify({
            recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
            teams: [
              {
                id: "t1",
                label: "Team",
                owns: [{ category: "volunteer_again", county: "Tippecanoe" }],
                recipientIds: ["r1"],
              },
            ],
            nearMissCap: 10,
            concurrency: 2,
          }),
        }),
      );

      const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.reason).toMatch(/unknown county "Tippecanoe"/);
      }
    });

    it("rejects a school mapped to two counties", async () => {
      const dir = await configDir(
        complete({
          "counties.json": JSON.stringify({
            counties: [
              { school: "Northrop HS", county: "Allen" },
              { school: "Northrop HS", county: "Whitley" },
            ],
          }),
        }),
      );

      const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.reason).toMatch(/"Northrop HS" is mapped to more than one county/);
      }
    });

    it("rejects a category defined twice", async () => {
      const dir = await configDir(
        complete({
          "categories.json": JSON.stringify({
            categories: [
              { id: "volunteer_again", label: "One", description: "d" },
              { id: "volunteer_again", label: "Two", description: "d" },
            ],
          }),
        }),
      );

      const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.reason).toMatch(/"volunteer_again" is defined more than once/);
      }
    });
  });

  describe("the committed example config", () => {
    it("loads from all three example files", async () => {
      const config = await Effect.runPromise(loadConfig());

      expect(config.sources).toEqual({
        teams: "teams.example.json",
        categories: "categories.example.json",
        counties: "counties.example.json",
      });
    });

    it("carries JA's provisional seven categories, every one flagged inferred", async () => {
      const config = await Effect.runPromise(loadConfig());

      // Seven because that is what Karen named in the interview (#24 §2):
      // volunteer again, then JAFP / in-school / events, then SWAG, personal
      // donation, employer involvement. Her definitive list may differ in
      // members, which is exactly why every row says `inferred`.
      expect(config.categories).toHaveLength(7);
      expect(config.categories.every((c) => c.inferred)).toBe(true);
    });

    it("maps all twelve schools in the export, and flags every row inferred", async () => {
      const config = await Effect.runPromise(loadConfig());

      // Geography, not JA's org chart — publicly checkable, and a wrong row
      // misroutes one lead visibly rather than silently. That is why this file
      // ships seeded while `teams.example.json` ships as one placeholder.
      expect(config.counties).toHaveLength(12);
      expect(config.counties.every((c) => c.inferred)).toBe(true);
      expect(new Set(config.counties.map((c) => c.county))).toEqual(new Set(["Allen"]));
    });

    it("is a single placeholder team, and says so", async () => {
      const config = await Effect.runPromise(loadConfig());

      // Deliberately not JA's routing table, and deliberately not our best
      // guess at one — `county → manager` is JA's org chart and is not
      // inferrable. One placeholder owning everything keeps the pipeline
      // exercisable and routes nothing on a guess. See
      // docs/solutions/patterns/inferred-config-guesses-the-axis-not-the-values.
      expect(config.teams).toHaveLength(1);
      expect(config.recipients).toHaveLength(1);
      expect(config.teams.every((t) => t.inferred)).toBe(true);
    });

    it("owns every category in every mapped county, so nothing routes to nobody", async () => {
      const config = await Effect.runPromise(loadConfig());

      const owned = new Set(
        config.teams.flatMap((t) => t.owns.map((k) => `${k.category}|${k.county}`)),
      );
      const expected = new Set(
        config.categories.flatMap((c) =>
          [...new Set(config.counties.map((row) => row.county))].map(
            (county) => `${c.id}|${county}`,
          ),
        ),
      );

      // Enumerated rather than wildcarded, deliberately. A `county: "*"` row
      // would swallow Tippecanoe and Elkhart the moment the real four-market
      // export arrives, and the placeholder would silently claim to own leads
      // JA never told us who owns. Enumeration means a new county is `unowned`
      // and visible — which is the whole point of that surface.
      expect(owned).toEqual(expected);
    });
  });
});
