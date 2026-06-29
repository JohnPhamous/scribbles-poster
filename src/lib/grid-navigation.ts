export type GridNavigationDirection = "left" | "right" | "up" | "down";

type GridConfig = {
  columns: number;
  rows: number;
};

type GridPosition = {
  col: number;
  id: string;
  index: number;
  row: number;
};

export function getDirectionalCellId(currentId: string, targetIds: string[], config: GridConfig, direction: GridNavigationDirection) {
  if (!Number.isInteger(config.columns) || !Number.isInteger(config.rows) || config.columns <= 0 || config.rows <= 0) return null;

  const current = getGridPosition(currentId, config);
  if (!current) return null;

  const candidates = targetIds
    .filter((id) => id !== currentId)
    .map((id) => getGridPosition(id, config))
    .filter(isPresent);

  if (candidates.length === 0) return null;

  return candidates
    .map((candidate) => ({
      candidate,
      score: getDirectionalScore(current, candidate, config, direction),
    }))
    .sort((a, b) => {
      const byPrimary = a.score.primary - b.score.primary;
      if (byPrimary !== 0) return byPrimary;
      const byCross = a.score.cross - b.score.cross;
      if (byCross !== 0) return byCross;
      return a.candidate.index - b.candidate.index;
    })[0]?.candidate.id ?? null;
}

function getDirectionalScore(current: GridPosition, candidate: GridPosition, config: GridConfig, direction: GridNavigationDirection) {
  if (direction === "left") {
    return {
      primary: wrappedBackwardDistance(current.col, candidate.col, config.columns),
      cross: wrappedAxisDistance(current.row, candidate.row, config.rows),
    };
  }

  if (direction === "right") {
    return {
      primary: wrappedForwardDistance(current.col, candidate.col, config.columns),
      cross: wrappedAxisDistance(current.row, candidate.row, config.rows),
    };
  }

  if (direction === "up") {
    return {
      primary: wrappedBackwardDistance(current.row, candidate.row, config.rows),
      cross: wrappedAxisDistance(current.col, candidate.col, config.columns),
    };
  }

  return {
    primary: wrappedForwardDistance(current.row, candidate.row, config.rows),
    cross: wrappedAxisDistance(current.col, candidate.col, config.columns),
  };
}

function wrappedBackwardDistance(current: number, target: number, size: number) {
  return ((current - target + size) % size) || size;
}

function wrappedForwardDistance(current: number, target: number, size: number) {
  return ((target - current + size) % size) || size;
}

function wrappedAxisDistance(a: number, b: number, size: number) {
  const forward = (b - a + size) % size;
  const backward = (a - b + size) % size;
  return Math.min(forward, backward);
}

function getGridPosition(id: string, config: GridConfig): GridPosition | null {
  const match = /^r(\d+)c(\d+)$/.exec(id);
  if (!match) return null;

  const row = Number(match[1]) - 1;
  const col = Number(match[2]) - 1;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= config.rows || col >= config.columns) return null;

  return {
    col,
    id,
    index: row * config.columns + col,
    row,
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
