import { describe, expect, it } from "vitest";
import { getCellIds } from "./poster-config";

describe("poster config", () => {
  it("derives cell ids from the provided grid config", () => {
    expect(getCellIds({ rows: 2, columns: 3 })).toEqual(["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]);
  });
});
