import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSentMark, readSentMarks, type SentMark, sentIds } from "./sent";

const mark = (overrides: Partial<SentMark> = {}): SentMark => ({
  responseId: "JA-24001",
  runId: "2026-08-08T12:00:00.000Z",
  action: "sent",
  at: "2026-08-08T13:00:00.000Z",
  ...overrides,
});

describe("sent marks", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sent-marks-"));
    path = join(dir, "sent-marks.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads an empty log when the file does not exist", async () => {
    expect(await readSentMarks(path)).toEqual([]);
  });

  it("round-trips appended marks", async () => {
    await appendSentMark(mark(), path);
    await appendSentMark(mark({ responseId: "JA-24002" }), path);
    const marks = await readSentMarks(path);
    expect(marks).toHaveLength(2);
    expect(marks[1]?.responseId).toBe("JA-24002");
  });

  it("appends rather than updates — un-marking preserves the earlier record", async () => {
    await appendSentMark(mark(), path);
    await appendSentMark(mark({ action: "unsent", at: "2026-08-08T14:00:00.000Z" }), path);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(await readSentMarks(path)).toHaveLength(2);
  });

  it("folds the log so the last action per lead wins", () => {
    const runId = mark().runId;
    const marks = [
      mark(),
      mark({ responseId: "JA-24002" }),
      mark({ action: "unsent" }),
      mark({ responseId: "JA-24003", runId: "other-run" }),
    ];
    expect(sentIds(marks, runId)).toEqual(new Set(["JA-24002"]));
  });

  it("keeps marks scoped to their run", () => {
    const marks = [mark(), mark({ responseId: "JA-24009", runId: "run-b" })];
    expect(sentIds(marks, "run-b")).toEqual(new Set(["JA-24009"]));
  });

  it("marking twice is idempotent in the folded view", async () => {
    await appendSentMark(mark(), path);
    await appendSentMark(mark(), path);
    const marks = await readSentMarks(path);
    expect(sentIds(marks, mark().runId)).toEqual(new Set(["JA-24001"]));
  });

  it("rejects a malformed line instead of guessing", async () => {
    await appendSentMark(mark(), path);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, '{"responseId":"JA-24002"}\n', "utf8");
    await expect(readSentMarks(path)).rejects.toThrow();
  });
});
