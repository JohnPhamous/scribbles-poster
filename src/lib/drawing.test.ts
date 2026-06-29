import { describe, expect, it } from "vitest";
import { drawStrokes, getStrokeDuration } from "./drawing";
import type { Stroke } from "./types";

describe("drawing helpers", () => {
  it("computes duration from stroke order and startedAt", () => {
    const strokes: Stroke[] = [
      makeStroke({ id: "late", order: 1, startedAt: 120, points: [{ x: 1, y: 1, t: 40 }] }),
      makeStroke({ id: "early", order: 0, startedAt: 10, points: [{ x: 1, y: 1, t: 25 }] }),
    ];

    expect(getStrokeDuration(strokes)).toBe(160);
  });

  it("does not clear the caller-painted background", () => {
    const ctx = makeContext();

    drawStrokes(ctx, [makeStroke()], 1024);

    expect(ctx.calls).not.toContain("clearRect");
    expect(ctx.calls).toContain("stroke");
  });

  it("respects replay cutoff times", () => {
    const ctx = makeContext();
    const stroke = makeStroke({
      points: [
        { x: 1, y: 1, t: 0 },
        { x: 10, y: 10, t: 50 },
        { x: 20, y: 20, t: 100 },
      ],
    });

    drawStrokes(ctx, [stroke], 1024, { untilMs: 60 });

    expect(ctx.curves).toHaveLength(1);
  });
});

function makeStroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: "s1",
    order: 0,
    startedAt: 0,
    color: "#E63946",
    width: 14,
    points: [
      { x: 1, y: 1, t: 0 },
      { x: 10, y: 10, t: 20 },
    ],
    ...overrides,
  };
}

function makeContext() {
  const calls: string[] = [];
  const curves: unknown[][] = [];
  return {
    calls,
    curves,
    set lineCap(_: CanvasLineCap) {},
    set lineJoin(_: CanvasLineJoin) {},
    set strokeStyle(_: string) {},
    set lineWidth(_: number) {},
    clearRect() {
      calls.push("clearRect");
    },
    beginPath() {
      calls.push("beginPath");
    },
    moveTo() {
      calls.push("moveTo");
    },
    quadraticCurveTo(...args: unknown[]) {
      curves.push(args);
      calls.push("quadraticCurveTo");
    },
    lineTo() {
      calls.push("lineTo");
    },
    stroke() {
      calls.push("stroke");
    },
  } as unknown as CanvasRenderingContext2D & { calls: string[]; curves: unknown[][] };
}
