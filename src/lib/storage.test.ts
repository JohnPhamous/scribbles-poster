import { afterEach, describe, expect, it, vi } from "vitest";

const blobStore = new Map<string, unknown>();
const del = vi.fn(async (path: string) => {
  blobStore.delete(path);
});

vi.mock("@vercel/blob", () => ({
  del,
  get: vi.fn(async (path: string) => {
    if (!blobStore.has(path)) return null;
    return {
      statusCode: 200,
      stream: new Response(JSON.stringify(blobStore.get(path))).body,
    };
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: Array.from(blobStore.keys())
      .filter((pathname) => pathname.startsWith(prefix))
      .map((pathname) => ({ pathname })),
  })),
  put: vi.fn(async (path: string, body: string, options: { allowOverwrite?: boolean }) => {
    if (!options.allowOverwrite && blobStore.has(path)) {
      throw new Error("Blob already exists");
    }
    blobStore.set(path, JSON.parse(body));
    return {};
  }),
}));

describe("storage", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    blobStore.clear();
    del.mockClear();
  });

  it("bypasses stale cell list cache when assigning draw order", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("cells/r1c1.json", makeDrawing("r1c1", 1));
    const { listCells, saveCell } = await import("./storage");
    await listCells();
    blobStore.set("cells/r1c2.json", makeDrawing("r1c2", 5));

    const saved = await saveCell(makeDrawing("r1c3", 0));

    expect(saved).toMatchObject({ id: "r1c3", drawOrder: 6 });
  });
});

function makeDrawing(id: string, drawOrder: number) {
  return {
    id,
    drawOrder,
    name: id,
    strokes: [
      {
        id: `${id}-stroke`,
        order: 0,
        startedAt: 0,
        color: "#E63946",
        width: 14,
        points: [
          { x: 1, y: 1, t: 0 },
          { x: 2, y: 2, t: 10 },
        ],
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
