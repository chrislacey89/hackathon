import { describe, expect, it } from "vitest";
import type { Config } from "../config/load";
import { resolveCounty } from "./county";

const CONFIG: Config = {
  sources: { teams: "teams.example.json", categories: "x", counties: "y" },
  nearMissCap: 25,
  concurrency: 4,
  recipients: [],
  teams: [],
  categories: [{ id: "volunteer_again", label: "Volunteer again", description: "come back" }],
  counties: [
    { school: "Northrop HS", county: "Allen" },
    { school: "Leo JR/SR HS", county: "Allen" },
    { school: "Central Catholic HS", county: "Whitley" },
  ],
};

describe("resolveCounty", () => {
  it("resolves a school the lookup knows", () => {
    expect(resolveCounty("Central Catholic HS", CONFIG)).toEqual({
      kind: "resolved",
      county: "Whitley",
    });
  });

  it("reports a school the lookup does not know, and names it", () => {
    // Naming the school is the whole value of the `unmapped` surface: "3 leads
    // unmapped" tells an operator there is a gap, "Lafayette Jeff HS" tells
    // them what to add to counties.json.
    expect(resolveCounty("Lafayette Jeff HS", CONFIG)).toEqual({
      kind: "unmapped",
      school: "Lafayette Jeff HS",
    });
  });

  it("does not guess at a near miss", () => {
    // PRD #1 §Rabbit Holes: an unmapped school routes to `unmapped` rather than
    // being guessed. Fuzzy matching would be the guess — "Northrop MS" is not a
    // typo for "Northrop HS", it is a different school, and the only honest
    // answer is that JA has not told us where it is.
    expect(resolveCounty("northrop hs", CONFIG)).toEqual({
      kind: "unmapped",
      school: "northrop hs",
    });
    expect(resolveCounty("Northrop MS", CONFIG)).toEqual({
      kind: "unmapped",
      school: "Northrop MS",
    });
  });

  it("treats a blank school cell as unmapped rather than as a county", () => {
    // `ingest` turns a blank cell into "", and the whole export is one market
    // today — so "no school" defaulting to the only county in the lookup is a
    // real risk and would be invisible.
    expect(resolveCounty("", CONFIG)).toEqual({ kind: "unmapped", school: "" });
  });

  it("is pure — the same school resolves the same way every time", () => {
    const first = resolveCounty("Northrop HS", CONFIG);
    const second = resolveCounty("Northrop HS", CONFIG);

    expect(first).toEqual(second);
    expect(CONFIG.counties).toHaveLength(3);
  });
});
