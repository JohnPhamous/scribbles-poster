import { describe, expect, it } from "vitest";
import { getDirectionalCellId } from "./grid-navigation";

const grid = { columns: 4, rows: 3 };

describe("getDirectionalCellId", () => {
  it("skips empty cells and picks the nearest drawing in the requested direction", () => {
    expect(getDirectionalCellId("r2c2", ["r2c4", "r3c1"], grid, "left")).toBe("r3c1");
    expect(getDirectionalCellId("r2c2", ["r2c4", "r1c1"], grid, "right")).toBe("r2c4");
  });

  it("wraps across grid edges", () => {
    expect(getDirectionalCellId("r1c1", ["r1c4", "r2c3"], grid, "left")).toBe("r1c4");
    expect(getDirectionalCellId("r3c2", ["r1c2", "r2c4"], grid, "down")).toBe("r1c2");
  });

  it("prefers same-row or same-column drawings before cross-axis drawings", () => {
    expect(getDirectionalCellId("r2c2", ["r1c1", "r2c1"], grid, "left")).toBe("r2c1");
    expect(getDirectionalCellId("r2c2", ["r1c1", "r1c2"], grid, "up")).toBe("r1c2");
  });

  it("returns null for invalid current cells or when there is no other drawing", () => {
    expect(getDirectionalCellId("nope", ["r1c1"], grid, "left")).toBeNull();
    expect(getDirectionalCellId("r1c1", ["r1c1"], grid, "right")).toBeNull();
  });
});
