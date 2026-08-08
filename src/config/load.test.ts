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

const MINIMAL = JSON.stringify({
  recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
  teams: [{ id: "t1", label: "Real Team", owns: ["volunteer_again"], recipientIds: ["r1"] }],
  nearMissCap: 10,
  concurrency: 2,
});

describe("loadConfig", () => {
  it("prefers the real teams.json when it is present", async () => {
    const dir = await configDir({ "teams.json": MINIMAL, "teams.example.json": MINIMAL });

    const config = await Effect.runPromise(loadConfig({ configDir: dir }));

    expect(config.teams[0]?.label).toBe("Real Team");
    expect(config.source).toBe("teams.json");
  });

  it("falls back to the committed example when teams.json is absent", async () => {
    const dir = await configDir({ "teams.example.json": MINIMAL });

    const config = await Effect.runPromise(loadConfig({ configDir: dir }));

    expect(config.source).toBe("teams.example.json");
  });

  it("fails with a typed ConfigError when neither file exists", async () => {
    const dir = await configDir({});

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(ConfigError);
  });

  it("fails rather than returning a partial object when the shape is wrong", async () => {
    const dir = await configDir({ "teams.json": JSON.stringify({ teams: [] }) });

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
  });

  it("rejects a team routing to a recipient that does not exist", async () => {
    const dir = await configDir({
      "teams.json": JSON.stringify({
        recipients: [{ id: "r1", name: "Real Person", email: "real@ja.org" }],
        teams: [{ id: "t1", label: "Team", owns: ["donation"], recipientIds: ["ghost"] }],
        nearMissCap: 10,
        concurrency: 2,
      }),
    });

    const result = await Effect.runPromise(Effect.either(loadConfig({ configDir: dir })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toMatch(/ghost/);
  });

  describe("the committed example config", () => {
    it("loads and owns every engagement type exactly once", async () => {
      const config = await Effect.runPromise(loadConfig());
      const owned = config.teams.flatMap((t) => t.owns);

      expect(config.source).toBe("teams.example.json");
      expect([...owned].sort()).toEqual([
        "committee_board",
        "corporate_sponsorship",
        "donation",
        "refer_colleague",
        "speaking",
        "volunteer_again",
      ]);
    });

    it("marks the three guessed routing rows as inferred", async () => {
      const config = await Effect.runPromise(loadConfig());

      // Rachael confirmed three handoffs: committee prospect -> development,
      // employer introduction -> corporate partnerships, repeat classroom
      // volunteer -> program staff. Referrals, speaking, and giving are ours,
      // and volunteer recruitment may not even exist as a function at JA.
      expect(config.teams.filter((t) => t.inferred).map((t) => t.id)).toEqual([
        "program-staff",
        "development",
        "volunteer-recruitment",
      ]);
    });
  });
});
