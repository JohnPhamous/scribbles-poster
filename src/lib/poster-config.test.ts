import { describe, expect, it } from "vitest";
import { getCellIds, posterConfig } from "./poster-config";

describe("poster config", () => {
  it("derives cell ids from the provided grid config", () => {
    expect(getCellIds({ rows: 2, columns: 3 })).toEqual(["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]);
  });

  it("keeps a padded poster grid away from the poster edge", () => {
    expect(posterConfig.gridPaddingIn).toBe(0.5);
    expect(posterConfig.titleHeightIn).toBe(2);
    expect(posterConfig.title).toBe("204 scribbles by friends");
    expect(posterConfig.columns).toBe(12);
    expect(posterConfig.rows).toBe(17);
    expect(posterConfig.gridOffsetXIn).toBeGreaterThanOrEqual(posterConfig.gridPaddingIn);
    expect(posterConfig.gridOffsetYIn).toBeGreaterThanOrEqual(posterConfig.gridPaddingIn);
  });
});
