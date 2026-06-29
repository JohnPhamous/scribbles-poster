import { describe, expect, it } from "vitest";
import { posterConfig } from "./poster-config";
import { applyOptimisticDrawings, rollbackOptimisticDrawing, upsertDrawing } from "./poster-state";
import type { CellDrawing, PosterSnapshot } from "./types";

describe("poster state helpers", () => {
  it("keeps optimistic drawings over stale snapshots", () => {
    const drawing = makeDrawing("r1c1", { drawOrder: 0, name: "Optimistic" });
    const optimistic = new Map([[drawing.id, drawing]]);
    const snapshot = makeSnapshot({
      cells: [],
    });

    const next = applyOptimisticDrawings(snapshot, optimistic);

    expect(next.cells).toEqual([drawing]);
    expect(optimistic.has("r1c1")).toBe(true);
  });

  it("drops optimistic entries only when the server snapshot confirms the cell", () => {
    const optimisticDrawing = makeDrawing("r1c1", { drawOrder: 0, name: "Optimistic" });
    const confirmedDrawing = makeDrawing("r1c1", { drawOrder: 4, name: "Confirmed" });
    const optimistic = new Map([[optimisticDrawing.id, optimisticDrawing]]);
    const snapshot = makeSnapshot({ cells: [confirmedDrawing] });

    const next = applyOptimisticDrawings(snapshot, optimistic);

    expect(next.cells).toEqual([confirmedDrawing]);
    expect(optimistic.size).toBe(0);
  });

  it("rolls back only the optimistic cell version, not a confirmed replacement", () => {
    const optimisticDrawing = makeDrawing("r1c1", { drawOrder: 0, name: "Optimistic" });
    const confirmedDrawing = makeDrawing("r1c1", { drawOrder: 5, name: "Winner" });
    const snapshot = makeSnapshot({ cells: [confirmedDrawing] });

    const next = rollbackOptimisticDrawing(snapshot, optimisticDrawing);

    expect(next.cells).toEqual([confirmedDrawing]);
  });

  it("upserts drawings", () => {
    const oldDrawing = makeDrawing("r1c1", { drawOrder: 1, name: "Old" });
    const nextDrawing = makeDrawing("r1c1", { drawOrder: 2, name: "New" });
    const otherDrawing = makeDrawing("r1c2", { drawOrder: 3, name: "Other" });
    const snapshot = makeSnapshot({
      cells: [oldDrawing, otherDrawing],
    });

    const next = upsertDrawing(snapshot, nextDrawing);

    expect(next.cells).toEqual([otherDrawing, nextDrawing]);
  });
});

function makeSnapshot({ cells }: Pick<PosterSnapshot, "cells">): PosterSnapshot {
  return {
    config: posterConfig,
    cells,
    now: "2026-01-01T00:00:00.000Z",
  };
}

function makeDrawing(id: string, overrides: Partial<CellDrawing>): CellDrawing {
  return {
    id,
    drawOrder: 1,
    name: "Name",
    strokes: [
      {
        id: `${id}-stroke`,
        order: 0,
        startedAt: 0,
        color: posterConfig.palette[0],
        width: posterConfig.strokeWidth,
        points: [
          { x: 1, y: 1, t: 0 },
          { x: 2, y: 2, t: 10 },
        ],
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
