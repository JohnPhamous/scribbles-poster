import { getOrderedStrokes, packStrokePathData } from "./drawing";
import type { CellDrawing, RenderedCellDrawing } from "./types";

export function renderCellDrawing(drawing: CellDrawing): RenderedCellDrawing {
  return {
    id: drawing.id,
    drawOrder: drawing.drawOrder,
    name: drawing.name,
    createdAt: drawing.createdAt,
    updatedAt: drawing.updatedAt,
    paths: getOrderedStrokes(drawing.strokes).map((stroke) => ({
      c: stroke.color,
      w: stroke.width,
      p: packStrokePathData(stroke),
    })),
  };
}
