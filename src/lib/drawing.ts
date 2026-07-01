import type { Stroke } from "./types";

type PathPoint = {
  x: number;
  y: number;
};

const packedPathScale = 10;
const unpackedPathCacheLimit = 10_000;
const unpackedPathCache = new Map<string, string>();

export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  size: number,
  options?: { untilMs?: number; maxSourceMs?: number },
) {
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

export function getOrderedStrokes(strokes: Stroke[]) {
  return strokes
    .map((stroke, index) => ({ stroke, index }))
    .sort((a, b) => {
      const orderA = getStrokeOrder(a.stroke, a.index);
      const orderB = getStrokeOrder(b.stroke, b.index);
      if (orderA !== orderB) return orderA - orderB;
      return a.index - b.index;
    })
    .map(({ stroke }) => stroke);
}

export function getStrokePathData(stroke: Stroke) {
  return getStrokePathDataFromPoints(stroke.points);
}

export function packStrokePathData(stroke: Stroke) {
  const [firstPoint, ...restPoints] = stroke.points;
  if (!firstPoint) return "";

  let previousX = Math.round(firstPoint.x * packedPathScale);
  let previousY = Math.round(firstPoint.y * packedPathScale);
  const values = [previousX, previousY];

  for (const point of restPoints) {
    const nextX = Math.round(point.x * packedPathScale);
    const nextY = Math.round(point.y * packedPathScale);
    values.push(nextX - previousX, nextY - previousY);
    previousX = nextX;
    previousY = nextY;
  }

  return values.map((value) => value.toString(36)).join(".");
}

export function unpackStrokePathData(packed: string) {
  if (!packed) return "";
  const cached = unpackedPathCache.get(packed);
  if (cached !== undefined) return cached;

  const values = packed.split(".").map((value) => Number.parseInt(value, 36));
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    return "";
  }

  let currentX = values[0];
  let currentY = values[1];
  const points: PathPoint[] = [
    { x: currentX / packedPathScale, y: currentY / packedPathScale },
  ];

  for (let index = 2; index + 1 < values.length; index += 2) {
    currentX += values[index];
    currentY += values[index + 1];
    points.push({
      x: currentX / packedPathScale,
      y: currentY / packedPathScale,
    });
  }

  const path = getStrokePathDataFromPoints(points);
  if (unpackedPathCache.size >= unpackedPathCacheLimit) {
    unpackedPathCache.clear();
  }
  unpackedPathCache.set(packed, path);
  return path;
}

function getStrokePathDataFromPoints(points: PathPoint[]) {
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) return "";

  let currentX = firstPoint.x;
  let currentY = firstPoint.y;
  let path = `M${formatSvgNumber(currentX)} ${formatSvgNumber(currentY)}`;

  if (restPoints.length === 0) {
    return `${path}l${formatSvgNumber(0.1)} ${formatSvgNumber(0.1)}`;
  }

  let previous = firstPoint;
  for (const point of restPoints) {
    const midX = (previous.x + point.x) / 2;
    const midY = (previous.y + point.y) / 2;
    path += `q${formatSvgNumber(previous.x - currentX)} ${formatSvgNumber(
      previous.y - currentY,
    )} ${formatSvgNumber(midX - currentX)} ${formatSvgNumber(
      midY - currentY,
    )}`;
    currentX = midX;
    currentY = midY;
    previous = point;
  }

  return path;
}

function formatSvgNumber(value: number) {
  if (Number.isInteger(value)) return String(value);
  const formatted = value.toFixed(1).replace(/\.?0+$/, "");
  return formatted === "" || formatted === "-" ? "0" : formatted;
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
