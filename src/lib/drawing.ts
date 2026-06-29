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

  const timeline = getStrokeTimeline(strokes);
  const sourceDuration = options?.maxSourceMs ?? getStrokeDuration(strokes);
  const untilMs = options?.untilMs;

  for (const item of timeline) {
    const points = getVisiblePoints(item.stroke, item.startedAt, untilMs, sourceDuration);
    if (points.length === 0) continue;

    ctx.strokeStyle = item.stroke.color;
    ctx.lineWidth = item.stroke.width;
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
  for (const item of getStrokeTimeline(strokes)) {
    for (const point of item.stroke.points) {
      const effectiveTime = item.startedAt + point.t;
      if (effectiveTime > max) max = effectiveTime;
    }
  }
  return max;
}

function getVisiblePoints(stroke: Stroke, startedAt: number, untilMs: number | undefined, sourceDuration: number) {
  if (untilMs === undefined || sourceDuration <= 0) return stroke.points;
  return stroke.points.filter((point) => startedAt + point.t <= untilMs);
}

function getStrokeTimeline(strokes: Stroke[]) {
  let legacyStart = 0;

  return strokes
    .map((stroke, index) => ({ stroke, index }))
    .sort((a, b) => {
      const orderA = getStrokeOrder(a.stroke, a.index);
      const orderB = getStrokeOrder(b.stroke, b.index);
      if (orderA !== orderB) return orderA - orderB;
      return a.index - b.index;
    })
    .map(({ stroke, index }) => {
      const hasStartedAt = Number.isFinite(stroke.startedAt) && stroke.startedAt >= 0;
      const startedAt = hasStartedAt ? stroke.startedAt : legacyStart;
      const localDuration = getLocalStrokeDuration(stroke);
      legacyStart = Math.max(legacyStart, startedAt + localDuration);
      return { stroke, index, startedAt };
    });
}

function getStrokeOrder(stroke: Stroke, index: number) {
  return Number.isFinite(stroke.order) && stroke.order >= 0 ? stroke.order : index;
}

function getLocalStrokeDuration(stroke: Stroke) {
  let max = 0;
  for (const point of stroke.points) {
    if (point.t > max) max = point.t;
  }
  return max;
}
