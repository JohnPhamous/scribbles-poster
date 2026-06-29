import type { Stroke } from "./types";

export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  size: number,
  options?: { untilMs?: number; maxSourceMs?: number },
) {
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const sourceDuration = options?.maxSourceMs ?? getStrokeDuration(strokes);
  const untilMs = options?.untilMs;

  for (const stroke of strokes) {
    const points = getVisiblePoints(stroke, untilMs, sourceDuration);
    if (points.length === 0) continue;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const midX = (previous.x + current.x) / 2;
      const midY = (previous.y + current.y) / 2;
      ctx.quadraticCurveTo(previous.x, previous.y, midX, midY);
    }

    if (points.length === 1) {
      ctx.lineTo(points[0].x + 0.1, points[0].y + 0.1);
    }

    ctx.stroke();
  }
}

export function getStrokeDuration(strokes: Stroke[]) {
  let max = 0;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point.t > max) max = point.t;
    }
  }
  return max;
}

function getVisiblePoints(stroke: Stroke, untilMs: number | undefined, sourceDuration: number) {
  if (untilMs === undefined || sourceDuration <= 0) return stroke.points;
  return stroke.points.filter((point) => point.t <= untilMs);
}
