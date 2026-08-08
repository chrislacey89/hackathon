import { describe, expect, it } from "vitest";
import { countCsvDataRows } from "./csv-rows";

describe("countCsvDataRows", () => {
  it("counts simple rows minus the header", () => {
    expect(countCsvDataRows("a,b\n1,2\n3,4\n")).toBe(2);
  });

  it("treats newlines inside quoted fields as part of the row", () => {
    const csv = 'id,comment\n1,"first line\nsecond line"\n2,plain\n';
    expect(countCsvDataRows(csv)).toBe(2);
  });

  it("handles escaped quotes inside quoted fields", () => {
    const csv = 'id,comment\n1,"she said ""more please""\nand left"\n';
    expect(countCsvDataRows(csv)).toBe(1);
  });

  it("counts a final row with no trailing newline", () => {
    expect(countCsvDataRows("a,b\n1,2")).toBe(1);
  });

  it("returns zero for an empty or header-only file", () => {
    expect(countCsvDataRows("")).toBe(0);
    expect(countCsvDataRows("a,b\n")).toBe(0);
  });
});
