export type Point = {
  x: number;
  y: number;
  t: number;
};

export type Stroke = {
  id: string;
  color: string;
  width: number;
  points: Point[];
};

export type CellDrawing = {
  id: string;
  name: string;
  strokes: Stroke[];
  createdAt: string;
  updatedAt: string;
};

export type CellSummary = {
  id: string;
  name: string;
  updatedAt: string;
};

export type CellHold = {
  cellId: string;
  sessionId: string;
  name?: string;
  startedAt: string;
  expiresAt: string;
};

export type PosterConfig = {
  title: string;
  posterWidthIn: number;
  posterHeightIn: number;
  titleHeightIn: number;
  cellSizeIn: number;
  columns: number;
  rows: number;
  canvasSize: number;
  strokeWidth: number;
  maxReplayMs: number;
  holdMs: number;
  exportDpi: number;
  palette: string[];
};

export type PosterSnapshot = {
  config: PosterConfig;
  cells: CellDrawing[];
  holds: CellHold[];
  now: string;
};

export type HoldResult =
  | { ok: true; hold: CellHold }
  | { ok: false; reason: "occupied" | "held" | "invalid"; hold?: CellHold };
