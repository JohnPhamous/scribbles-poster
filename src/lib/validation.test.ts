import { describe, expect, it } from "vitest";
import { posterConfig } from "./poster-config";
import { validateDrawing } from "./validation";

describe("validateDrawing", () => {
  it("normalizes valid drawing input", () => {
    const drawing = validateDrawing(
      {
        id: "r1c1",
        name: "  Ada  ",
        strokes: [
          {
            id: "s1",
            order: 2,
            startedAt: 30,
            color: posterConfig.palette[0],
            width: posterConfig.strokeWidth,
            points: [
              { x: "10", y: "12", t: "0" },
              { x: 20, y: 24, t: 100 },
            ],
          },
        ],
      },
      "r1c1",
    );

    expect(drawing).toMatchObject({
      id: "r1c1",
      drawOrder: 0,
      name: "Ada",
      strokes: [
        {
          id: "s1",
          order: 2,
          startedAt: 30,
          color: posterConfig.palette[0],
          width: posterConfig.strokeWidth,
          points: [
            { x: 10, y: 12, t: 0 },
            { x: 20, y: 24, t: 100 },
          ],
        },
      ],
    });
  });

  it("rejects invalid ids, colors, bounds, and empty strokes", () => {
    expect(validateDrawing({ id: "r1c2", name: "Ada", strokes: [] }, "r1c1")).toBeNull();
    expect(validateDrawing({ id: "r1c1", name: "   ", strokes: [makeStroke()] }, "r1c1")).toBeNull();
    expect(validateDrawing({ id: "r1c1", name: "Ada", strokes: [makeStroke({ color: "#000" })] }, "r1c1")).toBeNull();
    expect(validateDrawing({ id: "r1c1", name: "Ada", strokes: [makeStroke({ points: [{ x: -1, y: 0, t: 0 }] })] }, "r1c1")).toBeNull();
    expect(validateDrawing({ id: "r1c1", name: "Ada", strokes: [makeStroke({ points: [] })] }, "r1c1")).toBeNull();
  });
});

function makeStroke(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    order: 0,
    startedAt: 0,
    color: posterConfig.palette[0],
    width: posterConfig.strokeWidth,
    points: [{ x: 0, y: 0, t: 0 }],
    ...overrides,
  };
}
