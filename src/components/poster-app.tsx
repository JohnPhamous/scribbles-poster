"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ComponentProps,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
import { animate, motion, useMotionValue } from "motion/react";
import { drawStrokes, getStrokeDuration } from "@/lib/drawing";
import { getDirectionalCellId } from "@/lib/grid-navigation";
import type { GridNavigationDirection } from "@/lib/grid-navigation";
import { getCellIds } from "@/lib/poster-config";
import {
  applyOptimisticDrawings,
  rollbackOptimisticDrawing,
  upsertDrawing,
} from "@/lib/poster-state";
import type {
  CellDrawing,
  Point,
  PosterConfig,
  PosterSnapshot,
  Stroke,
} from "@/lib/types";

type Selection =
  | { kind: "edit"; cellId: string; camera: CameraFrame }
  | { kind: "view"; cellId: string; drawing: CellDrawing; camera: CameraFrame };

type ZoomRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CameraFrame = {
  cellId: string;
  cell: ZoomRect;
  poster: ZoomRect;
};

type CameraStyle = {
  poster: CSSProperties;
  target: CSSProperties;
  posterMotion: {
    x: number;
    y: number;
    scale: number;
  };
  targetMotion: {
    x: number;
    y: number;
    scale: number;
    opacity: number;
  };
};

type ReplayMode = "simultaneous" | "sequential";
type CellReplay = {
  elapsedMs: number;
  durationMs?: number;
};
type ZoomPhase = "enter" | "idle" | "exit" | "pan";
type PosterMotionStyle = ComponentProps<typeof motion.div>["style"];
type ZoomPanelMotionStyle = ComponentProps<typeof motion.div>["style"];

const cameraEnterMs = 680;
const cameraPanMs = 560;
const cameraExitMs = 520;
const cameraTransition = {
  duration: cameraEnterMs / 1000,
  ease: [0.19, 1, 0.22, 1],
} as const;
const cameraPanTransition = {
  duration: cameraPanMs / 1000,
  ease: [0.19, 1, 0.22, 1],
} as const;
const cameraExitTransition = {
  duration: cameraExitMs / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;
const cameraEnterCleanupMs = cameraEnterMs + 120;
const cameraPanCleanupMs = cameraPanMs + 120;
const cameraExitCleanupMs = cameraExitMs + 120;
const zoomCanvasNeighborRadius = 1;
const maxZoomCanvasScale = 14;
const authorLabelFontRatio = 0.08;
const authorLabelMarginRatio = 0.05;
const authorLabelFallbackFontFamily = "Arial, sans-serif";
const pageBackgroundColor = "#F1F1EF";
const posterBackgroundColor = "#FFFBE8";
const visibleRefreshMs = 1_000;
const hiddenRefreshMs = 5_000;
const pendingDrawingDbName = "scribble-poster-pending-drawings";
const pendingDrawingStoreName = "drawings";
const pendingDrawingStoragePrefix = "scribble-poster:pending-drawing:";
const pendingDrawingBackupTimeoutMs = 1_200;

type GridSnap = {
  cellPx: number;
  offsetX: number;
  offsetY: number;
};

function snapPixel(value: number) {
  return Math.round(value);
}

function snapRect(rect: ZoomRect): ZoomRect {
  return {
    x: snapPixel(rect.x),
    y: snapPixel(rect.y),
    width: Math.max(1, snapPixel(rect.width)),
    height: Math.max(1, snapPixel(rect.height)),
  };
}

export function PosterApp({
  initialSnapshot,
}: {
  initialSnapshot: PosterSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<PosterSnapshot | null>(
    () => initialSnapshot
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [zoomPhase, setZoomPhase] = useState<ZoomPhase>("idle");
  const [message, setMessage] = useState("");
  const [showPrintTools, setShowPrintTools] = useState(false);
  const [showReplayTools, setShowReplayTools] = useState(false);
  const [replayStartedAt, setReplayStartedAt] = useState<number | null>(null);
  const [replayElapsed, setReplayElapsed] = useState(0);
  const [replayMode, setReplayMode] = useState<ReplayMode>("simultaneous");
  const [isSaving, setIsSaving] = useState(false);
  const [panSourceCellId, setPanSourceCellId] = useState<string | null>(null);
  const [panSourceCamera, setPanSourceCamera] = useState<CameraFrame | null>(
    null
  );

  const optimisticDrawingsRef = useRef<Map<string, CellDrawing>>(new Map());
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const enterCleanupTimerRef = useRef(0);
  const exitCleanupTimerRef = useRef(0);
  const panCleanupTimerRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridSnapRef = useRef<GridSnap | null>(null);
  const [gridSnap, setGridSnap] = useState<GridSnap | null>(null);
  const cameraStyle = useMemo(
    () => (selection ? getCameraStyle(selection.camera) : undefined),
    [selection]
  );
  const posterX = useMotionValue(0);
  const posterY = useMotionValue(0);
  const posterScale = useMotionValue(1);
  const panelX = useMotionValue(0);
  const panelY = useMotionValue(0);
  const panelScale = useMotionValue(1);
  const posterMotionStyle = useMemo(
    () =>
      ({
        x: posterX,
        y: posterY,
        scale: posterScale,
      } satisfies PosterMotionStyle),
    [posterScale, posterX, posterY]
  );
  const zoomPanelMotionStyle = useMemo(
    () =>
      ({
        ...cameraStyle?.target,
        x: panelX,
        y: panelY,
        scale: panelScale,
      } satisfies ZoomPanelMotionStyle),
    [cameraStyle?.target, panelScale, panelX, panelY]
  );

  const config = snapshot?.config;
  const cellIds = useMemo(() => (config ? getCellIds(config) : []), [config]);
  const drawingsById = useMemo(() => {
    const map = new Map<string, CellDrawing>();
    for (const cell of snapshot?.cells ?? []) map.set(cell.id, cell);
    return map;
  }, [snapshot]);

  const orderedDrawings = useMemo(
    () => getOrderedDrawings(snapshot?.cells ?? []),
    [snapshot]
  );

  useEffect(() => {
    setThemeColor(selection ? posterBackgroundColor : pageBackgroundColor);
  }, [selection]);

  const withOptimisticDrawings = useCallback(
    (next: PosterSnapshot) =>
      applyOptimisticDrawings(next, optimisticDrawingsRef.current),
    []
  );

  useLayoutEffect(() => {
    if (!config || !gridRef.current || selection) return;

    const grid = gridRef.current;
    const updateGridSnap = () => {
      const poster = grid.closest(".poster")?.getBoundingClientRect();
      if (!poster) return;

      const current = gridSnapRef.current ?? {
        cellPx: 0,
        offsetX: 0,
        offsetY: 0,
      };
      const naturalWidth = poster.width * (config.gridWidthIn / config.posterWidthIn);
      const titleHeight = poster.height * (config.titleHeightIn / config.posterHeightIn);
      const gridAreaHeight = poster.height - titleHeight;
      const naturalHeight = gridAreaHeight * (config.gridHeightIn / (config.posterHeightIn - config.titleHeightIn));
      const nextCellPx = Math.max(
        1,
        snapPixel(
          Math.min(
            naturalWidth / config.columns,
            naturalHeight / config.rows
          )
        )
      );
      const snappedWidth = nextCellPx * config.columns;
      const snappedHeight = nextCellPx * config.rows;
      const unshiftedX = poster.x + (poster.width - snappedWidth) / 2;
      const unshiftedY = poster.y + titleHeight + (gridAreaHeight - snappedHeight) / 2;
      const next = {
        cellPx: nextCellPx,
        offsetX: snapPixel(unshiftedX) - unshiftedX,
        offsetY: snapPixel(unshiftedY) - unshiftedY,
      };
      if (
        current.cellPx === next.cellPx &&
        Math.abs(current.offsetX - next.offsetX) < 0.001 &&
        Math.abs(current.offsetY - next.offsetY) < 0.001
      ) {
        return;
      }
      gridSnapRef.current = next;
      setGridSnap(next);
    };

    updateGridSnap();
    const resizeObserver = new ResizeObserver(updateGridSnap);
    resizeObserver.observe(grid);
    window.visualViewport?.addEventListener("resize", updateGridSnap);
    window.addEventListener("resize", updateGridSnap);
    return () => {
      resizeObserver.disconnect();
      window.visualViewport?.removeEventListener("resize", updateGridSnap);
      window.removeEventListener("resize", updateGridSnap);
    };
  }, [config, selection]);

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    const response = await fetch("/api/poster", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load poster");
    const next = (await response.json()) as PosterSnapshot;
    if (requestId !== refreshRequestRef.current) return;
    setSnapshot(withOptimisticDrawings(next));
  }, [withOptimisticDrawings]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    setShowPrintTools(searchParams.get("print") === "1");
    setShowReplayTools(searchParams.get("replay") === "1");

    let timer = 0;
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      const delay = document.hidden ? hiddenRefreshMs : visibleRefreshMs;
      timer = window.setTimeout(() => {
        refresh()
          .catch(() => undefined)
          .finally(scheduleRefresh);
      }, delay);
    };
    const refreshNow = () => {
      refresh().catch(() => undefined);
      scheduleRefresh();
    };

    scheduleRefresh();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
    };
  }, [refresh]);

  useEffect(() => {
    const preventGesture = (event: Event) => event.preventDefault();
    const preventMultitouch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    document.addEventListener("gesturestart", preventGesture, {
      passive: false,
    });
    document.addEventListener("gesturechange", preventGesture, {
      passive: false,
    });
    document.addEventListener("gestureend", preventGesture, { passive: false });
    document.addEventListener("touchmove", preventMultitouch, {
      passive: false,
    });
    return () => {
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("gestureend", preventGesture);
      document.removeEventListener("touchmove", preventMultitouch);
    };
  }, []);

  useEffect(() => {
    if (replayStartedAt === null || !config) return;
    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - replayStartedAt;
      const duration = getReplayDuration(
        replayMode,
        orderedDrawings.length,
        config
      );
      setReplayElapsed(Math.min(elapsed, duration));
      if (elapsed < duration) frame = requestAnimationFrame(tick);
      else setReplayStartedAt(null);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [config, orderedDrawings.length, replayMode, replayStartedAt]);

  useLayoutEffect(() => {
    if (!selection || !cameraStyle) {
      posterX.set(0);
      posterY.set(0);
      posterScale.set(1);
      panelX.set(0);
      panelY.set(0);
      panelScale.set(1);
      return;
    }

    if (zoomPhase === "idle") return;

    const posterTarget =
      zoomPhase === "exit"
        ? { x: 0, y: 0, scale: 1 }
        : cameraStyle.posterMotion;
    const panelTarget =
      zoomPhase === "exit"
        ? cameraStyle.targetMotion
        : { x: 0, y: 0, scale: 1 };
    const transition =
      zoomPhase === "exit"
        ? cameraExitTransition
        : zoomPhase === "pan"
          ? cameraPanTransition
          : cameraTransition;

    if (zoomPhase === "enter") {
      panelX.set(cameraStyle.targetMotion.x);
      panelY.set(cameraStyle.targetMotion.y);
      panelScale.set(cameraStyle.targetMotion.scale);
    }

    if (zoomPhase === "pan") {
      panelX.set(0);
      panelY.set(0);
      panelScale.set(1);
    }

    const controls = [
      animate(posterX, posterTarget.x, transition),
      animate(posterY, posterTarget.y, transition),
      animate(posterScale, posterTarget.scale, transition),
      ...(zoomPhase === "pan"
        ? []
        : [
            animate(panelX, panelTarget.x, transition),
            animate(panelY, panelTarget.y, transition),
            animate(panelScale, panelTarget.scale, transition),
          ]),
    ];
    return () => {
      for (const control of controls) control.stop();
    };
  }, [
    cameraStyle,
    panelScale,
    panelX,
    panelY,
    posterScale,
    posterX,
    posterY,
    selection,
    zoomPhase,
  ]);

  const navigateView = useCallback(
    (direction: GridNavigationDirection) => {
      if (!selection || selection.kind !== "view" || !config) return;

      const targetId = getDirectionalCellId(
        selection.cellId,
        [...drawingsById.keys()],
        config,
        direction
      );
      if (!targetId) return;

      const drawing = drawingsById.get(targetId);
      const camera = getCameraForCell(
        targetId,
        selection.cellId,
        selection.camera,
        config,
        cellIds
      );
      if (!drawing || !camera) return;

      setMessage("");
      setPanSourceCellId(selection.cellId);
      setPanSourceCamera(selection.camera);
      setSelection({ kind: "view", cellId: targetId, drawing, camera });
      setZoomPhase("pan");
      window.clearTimeout(enterCleanupTimerRef.current);
      window.clearTimeout(exitCleanupTimerRef.current);
      window.clearTimeout(panCleanupTimerRef.current);
      panCleanupTimerRef.current = window.setTimeout(() => {
        setPanSourceCellId(null);
        setPanSourceCamera(null);
        setZoomPhase("idle");
      }, cameraPanCleanupMs);
    },
    [cellIds, config, drawingsById, selection]
  );

  useEffect(() => {
    if (!selection || selection.kind !== "view") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      const direction = getDirectionFromKey(event.key);
      if (!direction) return;
      event.preventDefault();
      navigateView(direction);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateView, selection]);

  useEffect(() => {
    if (!selection) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSelection();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [selection]);

  useEffect(() => {
    return () => {
      window.clearTimeout(enterCleanupTimerRef.current);
      window.clearTimeout(exitCleanupTimerRef.current);
      window.clearTimeout(panCleanupTimerRef.current);
    };
  }, []);

  function beginSwipe(event: PointerEvent<HTMLDivElement>) {
    if (selection?.kind !== "view" || event.pointerType === "mouse") return;
    swipeStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function endSwipe(event: PointerEvent<HTMLDivElement>) {
    if (selection?.kind !== "view" || event.pointerType === "mouse") return;
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;

    const direction = getDirectionFromSwipe(
      event.clientX - start.x,
      event.clientY - start.y
    );
    if (direction) navigateView(direction);
  }

  async function openCell(cellId: string, camera: CameraFrame) {
    if (!snapshot || !config) return;
    clearActiveInteractionState();
    setMessage("");

    const drawing = drawingsById.get(cellId);
    const finishEnter = () => {
      window.clearTimeout(enterCleanupTimerRef.current);
      enterCleanupTimerRef.current = window.setTimeout(() => {
        setZoomPhase("idle");
      }, cameraEnterCleanupMs);
    };

    if (drawing) {
      setPanSourceCellId(null);
      setPanSourceCamera(null);
      window.clearTimeout(enterCleanupTimerRef.current);
      window.clearTimeout(exitCleanupTimerRef.current);
      window.clearTimeout(panCleanupTimerRef.current);
      setSelection({ kind: "view", cellId, drawing, camera });
      setZoomPhase("enter");
      finishEnter();
      return;
    }

    setPanSourceCellId(null);
    setPanSourceCamera(null);
    window.clearTimeout(enterCleanupTimerRef.current);
    window.clearTimeout(exitCleanupTimerRef.current);
    window.clearTimeout(panCleanupTimerRef.current);
    setSelection({ kind: "edit", cellId, camera });
    setZoomPhase("enter");
    finishEnter();
  }

  async function closeSelection() {
    if (!selection) return;

    setZoomPhase("exit");
    setPanSourceCellId(null);
    setPanSourceCamera(null);
    window.clearTimeout(enterCleanupTimerRef.current);
    window.clearTimeout(exitCleanupTimerRef.current);
    window.clearTimeout(panCleanupTimerRef.current);

    exitCleanupTimerRef.current = window.setTimeout(() => {
      setSelection(null);
      setZoomPhase("idle");
    }, cameraExitCleanupMs);
  }

  async function saveDrawing(drawing: CellDrawing) {
    await backupPendingDrawing(drawing);
    optimisticDrawingsRef.current.set(drawing.id, drawing);
    setSnapshot((current) =>
      current
        ? upsertDrawing(withOptimisticDrawings(current), drawing)
        : current
    );
    setMessage("");
    setZoomPhase("exit");
    setPanSourceCellId(null);
    setPanSourceCamera(null);
    window.clearTimeout(enterCleanupTimerRef.current);
    window.clearTimeout(exitCleanupTimerRef.current);
    window.clearTimeout(panCleanupTimerRef.current);
    setIsSaving(true);

    exitCleanupTimerRef.current = window.setTimeout(() => {
      setSelection(null);
      setZoomPhase("idle");
    }, cameraExitCleanupMs);

    try {
      const response = await fetch(`/api/cells/${drawing.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawing }),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        logClientSaveFailure("api-error", drawing, {
          status: response.status,
          responseText,
        });
        optimisticDrawingsRef.current.delete(drawing.id);
        setSnapshot((current) =>
          current ? rollbackOptimisticDrawing(current, drawing) : current
        );
        setMessage(
          `${getSaveErrorMessage(response.status)} Your drawing is backed up in this browser.`
        );
        await refresh().catch(() => undefined);
        return;
      }

      const savedDrawing = (await response.json()) as CellDrawing;
      await clearPendingDrawingBackup(savedDrawing.id);
      optimisticDrawingsRef.current.set(savedDrawing.id, savedDrawing);
      setSnapshot((current) =>
        current ? upsertDrawing(current, savedDrawing) : current
      );
      setMessage("");
      await refresh().catch(() => undefined);
    } catch (error) {
      logClientSaveFailure("network-exception", drawing, error);
      optimisticDrawingsRef.current.delete(drawing.id);
      setSnapshot((current) =>
        current ? rollbackOptimisticDrawing(current, drawing) : current
      );
      setMessage(
        "Could not save. Your drawing is backed up in this browser. Check your connection and try another cell."
      );
      await refresh().catch(() => undefined);
    } finally {
      setIsSaving(false);
    }
  }

  function startReplay() {
    setReplayElapsed(0);
    setReplayStartedAt(performance.now());
  }

  function stopReplay() {
    setReplayStartedAt(null);
    setReplayElapsed(0);
  }

  async function exportPng() {
    if (!config) return;
    await document.fonts.ready.catch(() => undefined);

    const scale = config.exportDpi;
    const canvas = document.createElement("canvas");
    canvas.width = config.posterWidthIn * scale;
    canvas.height = config.posterHeightIn * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = posterBackgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const titleFontFamily = getComputedStyle(
      document.querySelector(".posterTitle") ?? document.body
    ).fontFamily;
    ctx.font = `400 ${Math.round(0.45 * scale)}px ${titleFontFamily}`;
    ctx.fillText(
      config.title,
      canvas.width * 0.05,
      (config.titleHeightIn * scale) / 2
    );

    const cellPx = config.cellSizeIn * scale;
    const xStart = config.gridOffsetXIn * scale;
    const yStart = (config.titleHeightIn + config.gridOffsetYIn) * scale;
    for (const id of cellIds) {
      const index = cellIds.indexOf(id);
      const col = index % config.columns;
      const row = Math.floor(index / config.columns);
      const x = xStart + col * cellPx;
      const y = yStart + row * cellPx;
      const drawing = drawingsById.get(id);
      if (!drawing) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(cellPx / config.canvasSize, cellPx / config.canvasSize);
      drawStrokes(ctx, drawing.strokes, config.canvasSize);
      drawAuthorLabel(ctx, drawing.name, config.canvasSize, titleFontFamily);
      ctx.restore();
    }

    const link = document.createElement("a");
    link.download = "scribbles-poster.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  if (!snapshot || !config) {
    return <main className="app appLoading">Loading poster...</main>;
  }

  const replayActive = replayStartedAt !== null || replayElapsed > 0;
  const zoomCanvasScale =
    selection && cameraStyle
      ? getZoomCanvasScale(cameraStyle.posterMotion.scale)
      : 1;
  const replayByCellId =
    replayActive && config
      ? getReplayByCellId(replayMode, replayElapsed, orderedDrawings, config)
      : new Map<string, CellReplay>();
  const showToolbar = showReplayTools || showPrintTools || Boolean(message);

  return (
    <main
      className={`app ${showToolbar ? "toolbarVisible" : "toolbarHidden"} ${
        selection ? "zoomActive" : ""
      } ${selection ? "viewOverlayActive" : ""} ${
        zoomPhase === "exit" ? "zoomClosing" : "zoomOpening"
      }`}
    >
      <div className="posterExperience">
        <section className="stage" aria-label="Collaborative poster">
          <motion.div
            className="poster"
            style={
              {
                "--poster-width": config.posterWidthIn,
                "--poster-height": config.posterHeightIn,
                "--title-height": config.titleHeightIn,
                "--columns": config.columns,
                "--rows": config.rows,
                "--grid-width-percent": `${
                  (config.gridWidthIn / config.posterWidthIn) * 100
                }%`,
                "--grid-height-percent": `${
                  (config.gridHeightIn /
                    (config.posterHeightIn - config.titleHeightIn)) *
                  100
                }%`,
                ...posterMotionStyle,
                ...cameraStyle?.poster,
              } as PosterMotionStyle
            }
            initial={false}
          >
            <header className="posterTitle">{config.title}</header>
            <div
              ref={gridRef}
              className="posterGrid"
              style={
                gridSnap
                  ? ({
                      "--grid-snap-x": `${gridSnap.offsetX}px`,
                      "--grid-snap-y": `${gridSnap.offsetY}px`,
                      "--snapped-cell-px": `${gridSnap.cellPx}px`,
                      height: `${gridSnap.cellPx * config.rows}px`,
                      width: `${gridSnap.cellPx * config.columns}px`,
                    } as CSSProperties)
                  : undefined
              }
            >
              {cellIds.map((cellId) => (
                <PosterCell
                  key={cellId}
                  cellId={cellId}
                  config={config}
                  drawing={drawingsById.get(cellId)}
                  replay={replayByCellId.get(cellId) ?? null}
                  isSelected={selection?.cellId === cellId}
                  renderScale={
                    shouldRenderHighResolutionCell(
                      cellIds,
                      cellId,
                      selection?.cellId,
                      panSourceCellId,
                      config
                    )
                      ? zoomCanvasScale
                      : 1
                  }
                  onOpen={(camera) => openCell(cellId, camera)}
                />
              ))}
            </div>
          </motion.div>
        </section>
        <PosterInvite config={config} />
      </div>

      {showToolbar ? (
        <div className="toolbar noPrint">
          {showReplayTools ? (
            <>
              <button
                className={`iconButton ${
                  replayMode === "simultaneous" ? "active" : ""
                }`}
                type="button"
                onClick={() => setReplayMode("simultaneous")}
              >
                All
              </button>
              <button
                className={`iconButton ${
                  replayMode === "sequential" ? "active" : ""
                }`}
                type="button"
                onClick={() => setReplayMode("sequential")}
              >
                Seq
              </button>
              <button
                className="iconButton"
                type="button"
                onClick={replayActive ? stopReplay : startReplay}
                title={replayActive ? "Stop replay" : "Play replay"}
              >
                {replayActive ? "Stop" : "Play"}
              </button>
            </>
          ) : null}
          {showPrintTools ? (
            <>
              <button
                className="iconButton"
                type="button"
                onClick={() => window.print()}
                title="Print poster"
              >
                Print
              </button>
              <button
                className="iconButton"
                type="button"
                onClick={exportPng}
                title="Export PNG"
              >
                PNG
              </button>
            </>
          ) : null}
          {message ? <p className="status">{message}</p> : null}
        </div>
      ) : null}

      {selection ? (
        <CellOverlay
          selection={selection}
          config={config}
          isSaving={isSaving}
          phase={zoomPhase}
          style={zoomPanelMotionStyle}
          cameraStyle={cameraStyle}
          panSourceCamera={panSourceCamera}
          cellIds={cellIds}
          drawingsById={drawingsById}
          onPointerDown={beginSwipe}
          onPointerUp={endSwipe}
          onPointerCancel={() => {
            swipeStartRef.current = null;
          }}
          onClose={closeSelection}
          onSave={saveDrawing}
        />
      ) : null}
    </main>
  );
}

type PendingDrawingBackup = {
  id: string;
  drawing: CellDrawing;
  savedAt: string;
  url: string;
  userAgent: string;
};

async function backupPendingDrawing(drawing: CellDrawing) {
  const backup: PendingDrawingBackup = {
    id: drawing.id,
    drawing,
    savedAt: new Date().toISOString(),
    url: window.location.href,
    userAgent: window.navigator.userAgent,
  };

  try {
    await withTimeout(
      writePendingDrawingToIndexedDb(backup),
      pendingDrawingBackupTimeoutMs
    );
    return;
  } catch (indexedDbError) {
    try {
      window.localStorage.setItem(
        `${pendingDrawingStoragePrefix}${drawing.id}`,
        JSON.stringify(backup)
      );
      return;
    } catch (localStorageError) {
      console.error("[scribble-poster] could not back up pending drawing", {
        indexedDbError,
        localStorageError,
      });
      logClientSaveFailure("backup-failed", drawing, {
        indexedDbError,
        localStorageError,
      });
    }
  }
}

async function clearPendingDrawingBackup(cellId: string) {
  try {
    await deletePendingDrawingFromIndexedDb(cellId);
  } catch (error) {
    console.warn("[scribble-poster] could not clear IndexedDB drawing backup", {
      cellId,
      error,
    });
  }

  try {
    window.localStorage.removeItem(`${pendingDrawingStoragePrefix}${cellId}`);
  } catch (error) {
    console.warn("[scribble-poster] could not clear localStorage drawing backup", {
      cellId,
      error,
    });
  }
}

function writePendingDrawingToIndexedDb(backup: PendingDrawingBackup) {
  return withPendingDrawingStore("readwrite", (store) => store.put(backup));
}

function deletePendingDrawingFromIndexedDb(cellId: string) {
  return withPendingDrawingStore("readwrite", (store) => store.delete(cellId));
}

function withPendingDrawingStore(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
) {
  return new Promise<void>((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }

    const openRequest = window.indexedDB.open(pendingDrawingDbName, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(pendingDrawingStoreName)) {
        db.createObjectStore(pendingDrawingStoreName, { keyPath: "id" });
      }
    };
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const transaction = db.transaction(pendingDrawingStoreName, mode);
      const store = transaction.objectStore(pendingDrawingStoreName);
      const request = action(store);

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      };
    };
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function logClientSaveFailure(
  reason: string,
  drawing: CellDrawing,
  details: unknown
) {
  console.error("[scribble-poster] drawing save failed", {
    reason,
    details,
  });

  try {
    console.log(
      "[scribble-poster] failed drawing payload",
      JSON.stringify(drawing)
    );
  } catch (error) {
    console.error("[scribble-poster] could not serialize failed drawing", {
      error,
      drawing,
    });
  }
}

function PosterInvite({ config }: { config: PosterConfig }) {
  return (
    <aside className="posterInvite noPrint" aria-label="Invitation note">
      <svg
        className="posterInviteArrow posterInviteArrowDesktop"
        viewBox="0 0 170 86"
        aria-hidden="true"
      >
        <path d="M160 24C122 24 86 33 43 59" />
        <path d="M43 59C57 51 64 43 70 33" />
        <path d="M43 59C58 60 67 66 76 76" />
      </svg>
      <svg
        className="posterInviteArrow posterInviteArrowMobile"
        viewBox="0 0 128 96"
        aria-hidden="true"
      >
        <path d="M40 8C52 35 69 52 77 80" />
        <path d="M77 80C67 70 57 66 44 65" />
        <path d="M77 80C83 67 91 58 103 52" />
      </svg>
      <p>kathy and john are printing this as a poster for their home</p>
      <p>would love for you to draw</p>
      <p className="posterInviteSize">
        printing at {formatPosterSize(config)}.
      </p>
    </aside>
  );
}

function PosterCell({
  cellId,
  config,
  drawing,
  replay,
  isSelected,
  renderScale,
  onOpen,
}: {
  cellId: string;
  config: PosterConfig;
  drawing?: CellDrawing;
  replay: CellReplay | null;
  isSelected: boolean;
  renderScale: number;
  onOpen: (camera: CameraFrame) => void;
}) {
  const isAvailable = !drawing;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const poster = event.currentTarget
      .closest(".poster")
      ?.getBoundingClientRect();
    if (!poster) return;
    onOpen({
      cellId,
      cell: snapRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }),
      poster: snapRect({
        x: poster.left,
        y: poster.top,
        width: poster.width,
        height: poster.height,
      }),
    });
  }

  return (
    <button
      className={`cell ${drawing ? "occupied" : ""} ${
        isAvailable ? "available" : ""
      } ${isSelected ? "selected" : ""}`}
      type="button"
      onClick={handleClick}
      aria-label={`${cellId}${drawing ? ` by ${drawing.name}` : " empty"}`}
    >
      <DrawingCanvas
        drawing={drawing}
        config={config}
        replay={replay}
        renderScale={renderScale}
      />
    </button>
  );
}

function DrawingCanvas({
  drawing,
  config,
  replay,
  renderScale = 1,
}: {
  drawing?: CellDrawing;
  config: PosterConfig;
  replay: CellReplay | null;
  renderScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const backingScale = Math.max(1, renderScale);
      const authorFontFamily = getTitleFontFamily();
      canvas.width = Math.max(
        1,
        Math.round(canvas.clientWidth * dpr * backingScale)
      );
      canvas.height = Math.max(
        1,
        Math.round(canvas.clientHeight * dpr * backingScale)
      );
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(
        canvas.width / config.canvasSize,
        0,
        0,
        canvas.height / config.canvasSize,
        0,
        0
      );
      ctx.fillStyle = posterBackgroundColor;
      ctx.fillRect(0, 0, config.canvasSize, config.canvasSize);
      if (!drawing) return;

      if (replay === null) {
        drawStrokes(ctx, drawing.strokes, config.canvasSize);
        drawAuthorLabel(ctx, drawing.name, config.canvasSize, authorFontFamily);
        return;
      }

      if (replay.elapsedMs > 0) {
        const sourceDuration = getStrokeDuration(drawing.strokes);
        const replayDuration =
          replay.durationMs ?? Math.min(sourceDuration, config.maxReplayMs);
        const untilMs =
          replayDuration <= 0
            ? sourceDuration
            : Math.min(
                sourceDuration,
                (replay.elapsedMs / replayDuration) * sourceDuration
              );
        drawStrokes(ctx, drawing.strokes, config.canvasSize, { untilMs });
      }
      drawAuthorLabel(ctx, drawing.name, config.canvasSize, authorFontFamily);
    };

    render();
    const timer = window.setTimeout(render, cameraEnterMs + 80);
    void document.fonts?.ready.then(render).catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config, drawing, replay, renderScale]);

  return (
    <>
      {drawing ? <DrawingPreviewSvg drawing={drawing} config={config} /> : null}
      <canvas
        ref={canvasRef}
        className={`drawingCanvas ${
          drawing && replay === null ? "drawingCanvasStatic" : ""
        }`}
      />
    </>
  );
}

function DrawingPreviewSvg({
  drawing,
  config,
}: {
  drawing: CellDrawing;
  config: PosterConfig;
}) {
  return (
    <svg
      className="drawingPreviewSvg"
      viewBox={`0 0 ${config.canvasSize} ${config.canvasSize}`}
      aria-hidden="true"
    >
      {getOrderedStrokes(drawing.strokes).map((stroke) => (
        <path
          key={stroke.id}
          d={getStrokePathData(stroke)}
          fill="none"
          stroke={stroke.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke.width}
        />
      ))}
      <text
        className="drawingPreviewAuthor"
        x={config.canvasSize * authorLabelMarginRatio}
        y={config.canvasSize * (1 - authorLabelMarginRatio)}
        fill="#9a9a9a"
        fontSize={Math.round(config.canvasSize * authorLabelFontRatio)}
      >
        {drawing.name}
      </text>
    </svg>
  );
}

function CellOverlay({
  selection,
  config,
  isSaving,
  phase,
  style,
  cameraStyle,
  panSourceCamera,
  cellIds,
  drawingsById,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onClose,
  onSave,
}: {
  selection: Selection;
  config: PosterConfig;
  isSaving: boolean;
  phase: ZoomPhase;
  style: ZoomPanelMotionStyle;
  cameraStyle: CameraStyle | undefined;
  panSourceCamera: CameraFrame | null;
  cellIds: string[];
  drawingsById: Map<string, CellDrawing>;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onClose: () => void;
  onSave: (drawing: CellDrawing) => void;
}) {
  if (selection.kind === "view") {
    return (
      <div className="overlay noPrint">
        <div
          className="viewPanSurface"
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />
        <VectorZoomLayer
          selection={selection}
          config={config}
          cellIds={cellIds}
          drawingsById={drawingsById}
          cameraStyle={cameraStyle}
          panSourceCamera={panSourceCamera}
          phase={phase}
        />
        <div
          className={`viewControls ${phase === "exit" ? "closing" : "opening"}`}
        >
          <button type="button" onClick={onClose}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay noPrint">
      <VectorZoomLayer
        selection={selection}
        config={config}
        cellIds={cellIds}
        drawingsById={drawingsById}
        cameraStyle={cameraStyle}
        panSourceCamera={panSourceCamera}
        phase={phase}
      />
      <motion.div
        aria-hidden="true"
        className={`drawGuideFrame ${phase === "exit" ? "closing" : "opening"}`}
        style={style}
      >
        <span className="drawGuideLine drawGuideLineTop" />
        <span className="drawGuideLine drawGuideLineRight" />
        <span className="drawGuideLine drawGuideLineBottom" />
        <span className="drawGuideLine drawGuideLineLeft" />
      </motion.div>
      <motion.div
        className={`zoomPanel ${phase === "exit" ? "closing" : "opening"}`}
        style={style}
      >
        <Editor
          cellId={selection.cellId}
          config={config}
          isCanvasReady={phase === "idle"}
          isSaving={isSaving}
          onClose={onClose}
          onSave={onSave}
        />
      </motion.div>
    </div>
  );
}

function VectorZoomLayer({
  selection,
  config,
  cellIds,
  drawingsById,
  cameraStyle,
  panSourceCamera,
  phase,
}: {
  selection: Selection;
  config: PosterConfig;
  cellIds: string[];
  drawingsById: Map<string, CellDrawing>;
  cameraStyle: CameraStyle | undefined;
  panSourceCamera: CameraFrame | null;
  phase: ZoomPhase;
}) {
  if (!cameraStyle) return null;

  const panSourceCameraStyle =
    phase === "pan" && panSourceCamera ? getCameraStyle(panSourceCamera) : null;
  const isExit = phase === "exit";

  const getMotionProps = ({
    base,
    final,
    target,
    from,
    shouldAnimateLayout,
  }: {
    base: ZoomRect;
    final: ZoomRect;
    target: ZoomRect;
    from: { x: number; y: number; scale: number } | null;
    shouldAnimateLayout: boolean;
  }) => {
    const layoutFrom = isExit ? final : base;
    if (shouldAnimateLayout) {
      return {
        initial: {
          left: layoutFrom.x,
          top: layoutFrom.y,
          width: layoutFrom.width,
          height: layoutFrom.height,
          x: 0,
          y: 0,
          scale: 1,
        },
        animate: {
          left: target.x,
          top: target.y,
          width: target.width,
          height: target.height,
          x: 0,
          y: 0,
          scale: 1,
        },
        transition: isExit
          ? cameraExitTransition
          : phase === "pan"
            ? cameraPanTransition
            : cameraTransition,
        style: {},
      };
    }

    return {
      initial: phase === "enter" || phase === "pan" ? from ?? false : false,
      animate: { x: 0, y: 0, scale: 1 },
      transition: phase === "pan" ? cameraPanTransition : cameraTransition,
      style: {
        left: target.x,
        top: target.y,
        width: target.width,
        height: target.height,
      },
    };
  };

  const editBlankPanel =
    selection.kind === "edit" && phase !== "idle"
      ? (() => {
          const base = selection.camera.cell;
          const final = getProjectedCellRect(
            base,
            selection.camera.poster,
            cameraStyle.posterMotion
          );
          const target = isExit ? base : final;
          const from = {
            x: base.x - target.x,
            y: base.y - target.y,
            scale: base.width / target.width,
          };
          const exitFrom = isExit
            ? {
                x: final.x - base.x,
                y: final.y - base.y,
                scale: final.width / base.width,
              }
            : null;

          return {
            base,
            final,
            target,
            from: exitFrom ?? from,
            shouldAnimateLayout: isExit || phase === "enter",
          };
        })()
      : null;

  const panels = [...drawingsById.values()].flatMap((drawing) => {
    const isPan = phase === "pan" && panSourceCamera && panSourceCameraStyle;
    const shouldAnimateLayout =
      isExit || (selection.kind === "edit" && phase === "enter");
    const shouldRenderAllDrawings =
      selection.kind === "edit" || isExit || isPan;
    if (
      !shouldRenderAllDrawings &&
      drawing.id !== selection.cellId &&
      !isZoomNeighborCell(cellIds, drawing.id, selection.cellId, config)
    ) {
      return [];
    }

    const cellCamera = getCameraForCell(
      drawing.id,
      selection.cellId,
      selection.camera,
      config,
      cellIds
    );
    if (!cellCamera) return [];

    const base = cellCamera.cell;
    const final = getProjectedCellRect(
      base,
      selection.camera.poster,
      cameraStyle.posterMotion
    );
    const target = isExit ? base : final;
    const from = {
      x: base.x - target.x,
      y: base.y - target.y,
      scale: base.width / target.width,
    };
    const exitFrom = isExit
      ? {
          x: final.x - base.x,
          y: final.y - base.y,
          scale: final.width / base.width,
        }
      : null;
    const panFrom = isPan
      ? getPanelTransformFromCamera(
          drawing.id,
          target,
          panSourceCamera,
          panSourceCameraStyle,
          config,
          cellIds
        )
      : null;
    return [
      {
        drawing,
        base,
        final,
        target,
        from: exitFrom ?? panFrom ?? from,
        shouldAnimateLayout,
      },
    ];
  });

  return (
    <>
      {editBlankPanel ? (
        <motion.div
          aria-hidden="true"
          className="viewZoomPanel editZoomBlankPanel"
          {...getMotionProps(editBlankPanel)}
        />
      ) : null}
      {panels.map(
        ({
          drawing,
          base,
          final,
          target,
          from,
          shouldAnimateLayout,
        }) => {
          return (
            <motion.div
              key={`${drawing.id}-${
                phase === "pan" ? selection.cellId : phase
              }`}
              aria-hidden="true"
              className="viewZoomPanel"
              {...getMotionProps({
                base,
                final,
                target,
                from,
                shouldAnimateLayout,
              })}
            >
              <DrawingPreviewSvg drawing={drawing} config={config} />
            </motion.div>
          );
        }
      )}
    </>
  );
}

function clearActiveInteractionState() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) activeElement.blur();
}

function setThemeColor(color: string) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = color;
}

function getPanelTransformFromCamera(
  cellId: string,
  targetRect: ZoomRect,
  sourceCamera: CameraFrame,
  sourceCameraStyle: CameraStyle,
  config: PosterConfig,
  cellIds: string[]
) {
  const sourceCellCamera = getCameraForCell(
    cellId,
    sourceCamera.cellId,
    sourceCamera,
    config,
    cellIds
  );
  if (!sourceCellCamera) return null;

  const sourceRect = getProjectedCellRect(
    sourceCellCamera.cell,
    sourceCamera.poster,
    sourceCameraStyle.posterMotion
  );
  return {
    x: sourceRect.x - targetRect.x,
    y: sourceRect.y - targetRect.y,
    scale: sourceRect.width / targetRect.width,
  };
}

function getCameraForCell(
  cellId: string,
  sourceCellId: string,
  sourceCamera: CameraFrame,
  config: PosterConfig,
  cellIds: string[]
): CameraFrame | null {
  const cellIndex = cellIds.indexOf(cellId);
  const sourceCellIndex = cellIds.indexOf(sourceCellId);
  if (cellIndex < 0) return null;
  if (sourceCellIndex < 0) return null;

  const col = cellIndex % config.columns;
  const row = Math.floor(cellIndex / config.columns);
  const sourceCol = sourceCellIndex % config.columns;
  const sourceRow = Math.floor(sourceCellIndex / config.columns);
  const cellWidth = snapPixel(sourceCamera.cell.width);
  const cellHeight = snapPixel(sourceCamera.cell.height);

  return {
    cellId,
    cell: {
      x: snapPixel(sourceCamera.cell.x + (col - sourceCol) * cellWidth),
      y: snapPixel(sourceCamera.cell.y + (row - sourceRow) * cellHeight),
      width: cellWidth,
      height: cellHeight,
    },
    poster: sourceCamera.poster,
  };
}

function getDirectionFromKey(key: string): GridNavigationDirection | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

function getDirectionFromSwipe(
  dx: number,
  dy: number
): GridNavigationDirection | null {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const minSwipePx = 42;
  if (Math.max(absX, absY) < minSwipePx) return null;

  if (absX >= absY) return dx < 0 ? "right" : "left";
  return dy < 0 ? "down" : "up";
}

function getCameraStyle(camera: CameraFrame): CameraStyle {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const isMobileViewport = viewportWidth <= 720;
  const controlsReserve = isMobileViewport ? 118 : 128;
  const viewportGutter = isMobileViewport ? 8 : 12;
  const targetSize = snapPixel(
    Math.max(
      1,
      Math.min(
        viewportWidth * 0.92,
        viewportHeight - controlsReserve - viewportGutter * 2
      )
    )
  );
  const targetLeft = snapPixel(Math.max(12, (viewportWidth - targetSize) / 2));
  const targetTop = snapPixel(
    Math.max(
      viewportGutter,
      (viewportHeight - targetSize - controlsReserve) / 2
    )
  );
  const scale = targetSize / camera.cell.width;
  const cellOffsetX = camera.cell.x - camera.poster.x;
  const cellOffsetY = camera.cell.y - camera.poster.y;

  return {
    poster: {
      "--camera-poster-x": `${camera.poster.x}px`,
      "--camera-poster-y": `${camera.poster.y}px`,
      "--camera-poster-width": `${camera.poster.width}px`,
      "--camera-poster-height": `${camera.poster.height}px`,
      "--camera-dx": `${snapPixel(
        targetLeft - camera.poster.x - cellOffsetX * scale
      )}px`,
      "--camera-dy": `${snapPixel(
        targetTop - camera.poster.y - cellOffsetY * scale
      )}px`,
      "--camera-scale": scale,
    } as CSSProperties,
    target: {
      "--zoom-from-x": `${camera.cell.x}px`,
      "--zoom-from-y": `${camera.cell.y}px`,
      "--zoom-from-size": `${Math.max(
        camera.cell.width,
        camera.cell.height
      )}px`,
      "--zoom-dx": `${camera.cell.x - targetLeft}px`,
      "--zoom-dy": `${camera.cell.y - targetTop}px`,
      "--zoom-scale":
        Math.max(camera.cell.width, camera.cell.height) / targetSize,
      "--zoom-to-x": `${targetLeft}px`,
      "--zoom-to-y": `${targetTop}px`,
      "--zoom-to-size": `${targetSize}px`,
    } as CSSProperties,
    posterMotion: {
      x: snapPixel(targetLeft - camera.poster.x - cellOffsetX * scale),
      y: snapPixel(targetTop - camera.poster.y - cellOffsetY * scale),
      scale,
    },
    targetMotion: {
      x: camera.cell.x - targetLeft,
      y: camera.cell.y - targetTop,
      scale: Math.max(camera.cell.width, camera.cell.height) / targetSize,
      opacity: 1,
    },
  };
}

function getZoomCanvasScale(cameraScale: number) {
  return Math.max(1, Math.min(maxZoomCanvasScale, Math.ceil(cameraScale)));
}

function getProjectedCellRect(
  cell: ZoomRect,
  poster: ZoomRect,
  posterMotion: CameraStyle["posterMotion"]
): ZoomRect {
  return {
    x: snapPixel(
      poster.x + posterMotion.x + (cell.x - poster.x) * posterMotion.scale
    ),
    y: snapPixel(
      poster.y + posterMotion.y + (cell.y - poster.y) * posterMotion.scale
    ),
    width: snapPixel(cell.width * posterMotion.scale),
    height: snapPixel(cell.height * posterMotion.scale),
  };
}

function getTitleFontFamily() {
  return (
    getComputedStyle(document.querySelector(".posterTitle") ?? document.body)
      .fontFamily || authorLabelFallbackFontFamily
  );
}

function getOrderedStrokes(strokes: Stroke[]) {
  return strokes
    .map((stroke, index) => ({ stroke, index }))
    .sort((a, b) => {
      const orderA =
        Number.isFinite(a.stroke.order) && a.stroke.order >= 0
          ? a.stroke.order
          : a.index;
      const orderB =
        Number.isFinite(b.stroke.order) && b.stroke.order >= 0
          ? b.stroke.order
          : b.index;
      if (orderA !== orderB) return orderA - orderB;
      return a.index - b.index;
    })
    .map(({ stroke }) => stroke);
}

function getStrokePathData(stroke: Stroke) {
  const [firstPoint, ...restPoints] = stroke.points;
  if (!firstPoint) return "";

  const commands = [
    `M ${formatSvgNumber(firstPoint.x)} ${formatSvgNumber(firstPoint.y)}`,
  ];
  if (restPoints.length === 0) {
    commands.push(
      `L ${formatSvgNumber(firstPoint.x + 0.1)} ${formatSvgNumber(
        firstPoint.y + 0.1
      )}`
    );
    return commands.join(" ");
  }

  let previous = firstPoint;
  for (const point of restPoints) {
    const midX = (previous.x + point.x) / 2;
    const midY = (previous.y + point.y) / 2;
    commands.push(
      `Q ${formatSvgNumber(previous.x)} ${formatSvgNumber(
        previous.y
      )} ${formatSvgNumber(midX)} ${formatSvgNumber(midY)}`
    );
    previous = point;
  }

  return commands.join(" ");
}

function formatSvgNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function drawAuthorLabel(
  ctx: CanvasRenderingContext2D,
  name: string,
  canvasSize: number,
  fontFamily = authorLabelFallbackFontFamily
) {
  const margin = canvasSize * authorLabelMarginRatio;
  ctx.save();
  ctx.fillStyle = "#9a9a9a";
  ctx.font = `400 ${Math.round(
    canvasSize * authorLabelFontRatio
  )}px ${fontFamily}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, margin, canvasSize - margin, canvasSize - margin * 2);
  ctx.restore();
}

function isZoomNeighborCell(
  cellIds: string[],
  cellId: string,
  selectedCellId: string | undefined,
  config: PosterConfig
) {
  if (!selectedCellId) return false;
  const cellIndex = cellIds.indexOf(cellId);
  const selectedIndex = cellIds.indexOf(selectedCellId);
  if (cellIndex < 0 || selectedIndex < 0) return false;

  const cellCol = cellIndex % config.columns;
  const cellRow = Math.floor(cellIndex / config.columns);
  const selectedCol = selectedIndex % config.columns;
  const selectedRow = Math.floor(selectedIndex / config.columns);

  return (
    Math.abs(cellCol - selectedCol) <= zoomCanvasNeighborRadius &&
    Math.abs(cellRow - selectedRow) <= zoomCanvasNeighborRadius
  );
}

function shouldRenderHighResolutionCell(
  cellIds: string[],
  cellId: string,
  selectedCellId: string | undefined,
  panSourceCellId: string | null,
  config: PosterConfig
) {
  return (
    isZoomNeighborCell(cellIds, cellId, selectedCellId, config) ||
    isZoomNeighborCell(cellIds, cellId, panSourceCellId ?? undefined, config)
  );
}

function formatPosterSize(
  config: Pick<PosterConfig, "posterWidthIn" | "posterHeightIn">
) {
  return `${formatInches(config.posterWidthIn)}" x ${formatInches(
    config.posterHeightIn
  )}"`;
}

function formatInches(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function getOrderedDrawings(drawings: CellDrawing[]) {
  return [...drawings].sort((a, b) => {
    const byOrder = getDrawOrder(a) - getDrawOrder(b);
    if (byOrder !== 0) return byOrder;
    const byCreatedAt =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  });
}

function getDrawOrder(drawing: CellDrawing) {
  return Number.isFinite(drawing.drawOrder) && drawing.drawOrder > 0
    ? drawing.drawOrder
    : Number.MAX_SAFE_INTEGER;
}

function getSaveErrorMessage(status: number) {
  if (status === 400) return "Could not save. Refresh and try again.";
  if (status === 409) return "That cell was already saved.";
  return "Could not save. Check your connection and try another cell.";
}

function getReplayDuration(
  mode: ReplayMode,
  drawingCount: number,
  config: PosterConfig
) {
  if (mode === "simultaneous") return config.maxReplayMs;
  return Math.max(
    config.sequentialReplayCellMs,
    drawingCount * config.sequentialReplayCellMs
  );
}

function getReplayByCellId(
  mode: ReplayMode,
  elapsedMs: number,
  drawings: CellDrawing[],
  config: PosterConfig
) {
  const map = new Map<string, CellReplay>();

  if (mode === "simultaneous") {
    for (const drawing of drawings) {
      map.set(drawing.id, { elapsedMs });
    }
    return map;
  }

  drawings.forEach((drawing, index) => {
    const startMs = index * config.sequentialReplayCellMs;
    const localElapsedMs = Math.max(
      0,
      Math.min(config.sequentialReplayCellMs, elapsedMs - startMs)
    );
    map.set(drawing.id, {
      elapsedMs: localElapsedMs,
      durationMs: config.sequentialReplayCellMs,
    });
  });

  return map;
}

function shufflePalette(palette: string[]) {
  const shuffled = [...palette];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function Editor({
  cellId,
  config,
  isCanvasReady,
  isSaving,
  onClose,
  onSave,
}: {
  cellId: string;
  config: PosterConfig;
  isCanvasReady: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (drawing: CellDrawing) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const drawingStartedAtRef = useRef(performance.now());
  const strokeStartedAtRef = useRef(0);
  const [strokesVersion, setStrokesVersion] = useState(0);
  const [randomizedPalette] = useState(() => shufflePalette(config.palette));
  const [color, setColor] = useState(randomizedPalette[0] ?? config.palette[0]);
  const [name, setName] = useState("");

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(
      canvas.width / config.canvasSize,
      0,
      0,
      canvas.height / config.canvasSize,
      0,
      0
    );
    ctx.fillStyle = posterBackgroundColor;
    ctx.fillRect(0, 0, config.canvasSize, config.canvasSize);
    drawStrokes(
      ctx,
      [
        ...strokesRef.current,
        ...(currentStrokeRef.current ? [currentStrokeRef.current] : []),
      ],
      config.canvasSize
    );
    const previewName = name.trim();
    if (previewName) {
      drawAuthorLabel(
        ctx,
        previewName,
        config.canvasSize,
        getTitleFontFamily()
      );
    }
  }, [config.canvasSize, name]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      redraw();
    };
    resize();
    const timer = window.setTimeout(resize, cameraEnterMs + 80);
    void document.fonts?.ready.then(redraw).catch(() => undefined);
    window.addEventListener("resize", resize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", resize);
    };
  }, [redraw]);

  function getPoint(event: PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * config.canvasSize;
    const y = ((event.clientY - rect.top) / rect.height) * config.canvasSize;
    return {
      x: Math.max(0, Math.min(config.canvasSize, x)),
      y: Math.max(0, Math.min(config.canvasSize, y)),
      t: Math.max(0, performance.now() - strokeStartedAtRef.current),
    };
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== null) return;
    if (event.pointerType !== "mouse") event.preventDefault();

    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const didCommitCurrentStroke = commitCurrentStroke();
    strokeStartedAtRef.current = performance.now();
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      order: strokesRef.current.length,
      startedAt: Math.max(
        0,
        strokeStartedAtRef.current - drawingStartedAtRef.current
      ),
      color,
      width: config.strokeWidth,
      points: [getPoint(event)],
    };
    if (didCommitCurrentStroke || strokesRef.current.length === 0) {
      setStrokesVersion((value) => value + 1);
    }
    redraw();
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.pointerType !== "mouse") event.preventDefault();
    if (!currentStrokeRef.current) return;
    const points = currentStrokeRef.current.points;
    const next = getPoint(event);
    const previous = points[points.length - 1];
    if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < 2)
      return;
    points.push(next);
    redraw();
  }

  function finishStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.pointerType !== "mouse") event.preventDefault();
    activePointerIdRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!commitCurrentStroke()) return;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function commitCurrentStroke() {
    const currentStroke = currentStrokeRef.current;
    if (!currentStroke) return false;
    strokesRef.current = [...strokesRef.current, currentStroke];
    currentStrokeRef.current = null;
    return true;
  }

  function undo() {
    if (currentStrokeRef.current) {
      currentStrokeRef.current = null;
      activePointerIdRef.current = null;
      setStrokesVersion((value) => value + 1);
      redraw();
      return;
    }
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    activePointerIdRef.current = null;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function save() {
    const trimmedName = name.trim();
    if (isSaving || !hasStrokeContent || !trimmedName) return;

    const didCommitCurrentStroke = commitCurrentStroke();
    if (didCommitCurrentStroke) {
      setStrokesVersion((value) => value + 1);
    }
    const now = new Date().toISOString();
    onSave({
      id: cellId,
      drawOrder: 0,
      name: trimmedName,
      strokes: strokesRef.current,
      createdAt: now,
      updatedAt: now,
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save();
  }

  function onNameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const hasStrokeContent =
    strokesRef.current.length > 0 || currentStrokeRef.current !== null;
  const hasName = name.trim().length > 0;

  return (
    <>
      <div
        className={`editorCanvasWrap editing ${
          isCanvasReady ? "ready" : "pending"
        }`}
      >
        <canvas
          ref={canvasRef}
          className="editorCanvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
        />
      </div>
      <form
        className="editorControls"
        role="toolbar"
        aria-label="Drawing tools"
        onSubmit={onSubmit}
      >
        <div className="editorControlsSegment">
          <button
            type="button"
            onClick={undo}
            disabled={!hasStrokeContent || isSaving}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!hasStrokeContent || isSaving}
          >
            Clear
          </button>
        </div>
        <div
          className="editorControlsSegment palette"
          aria-label="Drawing colors"
        >
          {randomizedPalette.map((item) => (
            <button
              key={item}
              type="button"
              className={`swatch ${item === color ? "active" : ""}`}
              style={{ backgroundColor: item }}
              onClick={() => setColor(item)}
              aria-label={`Use ${item}`}
            />
          ))}
        </div>
        <div className="editorControlsSegment editorNameSegment">
          <input
            value={name}
            autoCapitalize="words"
            autoComplete="name"
            enterKeyHint="done"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onNameKeyDown}
            placeholder="Your name"
            aria-label="Your name"
            required
          />
        </div>
        <div className="editorControlsSegment editorActionSegment">
          <button type="button" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving || !hasStrokeContent || !hasName}
            data-primary
          >
            {isSaving ? "Saving" : "Save"}
          </button>
        </div>
        <span className="srOnly">{strokesVersion}</span>
      </form>
    </>
  );
}
