import { posterConfig } from "./poster-config";
import type { CellDrawing, Stroke } from "./types";

const maxStrokes = 600;
const maxPoints = 80_000;

export function validateDrawing(value: unknown, id: string): CellDrawing | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CellDrawing>;
  if (candidate.id !== id) return null;
  if (typeof candidate.name !== "string") return null;
  if (!Array.isArray(candidate.strokes)) return null;
  if (candidate.strokes.length > maxStrokes) return null;

  let pointCount = 0;
  const strokes: Stroke[] = [];

  for (const stroke of candidate.strokes) {
    if (!stroke || typeof stroke !== "object") return null;
    const item = stroke as Partial<Stroke>;
    if (typeof item.id !== "string") return null;
    if (!posterConfig.palette.includes(String(item.color))) return null;
    if (typeof item.width !== "number" || item.width <= 0 || item.width > 80) return null;
    if (!Array.isArray(item.points) || item.points.length === 0) return null;

    pointCount += item.points.length;
    if (pointCount > maxPoints) return null;

    const points = item.points.map((point) => {
      if (!point || typeof point !== "object") return null;
      const x = Number((point as { x?: unknown }).x);
      const y = Number((point as { y?: unknown }).y);
      const t = Number((point as { t?: unknown }).t);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return null;
      if (x < 0 || x > posterConfig.canvasSize || y < 0 || y > posterConfig.canvasSize || t < 0) {
        return null;
      }
      return { x, y, t };
    });

    if (points.some((point) => point === null)) return null;
    strokes.push({
      id: item.id,
      color: String(item.color),
      width: item.width,
      points: points as Stroke["points"],
    });
  }

  const now = new Date().toISOString();
  return {
    id,
    name: candidate.name.trim() || "Anonymous",
    strokes,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    updatedAt: now,
  };
}
