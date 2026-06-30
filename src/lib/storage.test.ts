import { afterEach, describe, expect, it, vi } from "vitest";

const blobStore = new Map<string, unknown>();
const del = vi.fn(async (path: string) => {
  blobStore.delete(path);
});
const get = vi.fn(async (path: string) => {
  if (!blobStore.has(path)) return null;
  return {
    statusCode: 200,
    stream: new Response(JSON.stringify(blobStore.get(path))).body,
  };
});
const list = vi.fn(async ({ prefix }: { prefix: string }) => ({
  blobs: Array.from(blobStore.keys())
    .filter((pathname) => pathname.startsWith(prefix))
    .map((pathname) => ({ pathname })),
}));
const put = vi.fn(async (path: string, body: string, options: { allowOverwrite?: boolean }) => {
  if (!options.allowOverwrite && blobStore.has(path)) {
    throw new Error("Blob already exists");
  }
  blobStore.set(path, JSON.parse(body));
  return {};
});

vi.mock("@vercel/blob", () => ({
  del,
  get,
  list,
  put,
}));

describe("storage", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    blobStore.clear();
    del.mockClear();
    get.mockClear();
    list.mockClear();
    put.mockClear();
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

  it("reads a single cell directly instead of using a stale list cache", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const { getCell, listCells } = await import("./storage");
    await listCells();
    blobStore.set("cells/r1c1.json", makeDrawing("r1c1", 1));

    await expect(getCell("r1c1")).resolves.toMatchObject({ id: "r1c1" });
  });

  it("does not overwrite an occupied cell hidden by a stale list cache", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const { listCells, saveCell } = await import("./storage");
    await listCells();
    blobStore.set("cells/r1c1.json", makeDrawing("r1c1", 1));

    await expect(saveCell(makeDrawing("r1c1", 0))).resolves.toBe("occupied");
    expect(blobStore.get("cells/r1c1.json")).toMatchObject({ drawOrder: 1 });
  });

  it("does not silently drop cells when blob reads fail", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("cells/r1c1.json", makeDrawing("r1c1", 1));
    get.mockImplementationOnce(async () => ({
      statusCode: 500,
      stream: null,
    }));
    const { listCells } = await import("./storage");

    await expect(listCells({ bypassCache: true })).rejects.toThrow(
      "Failed to read blob cells/r1c1.json: 500",
    );
  });

  it("uses dev-prefixed blob credentials outside production", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "prod-token");
    vi.stubEnv("BLOB_DEV_STORE_ID", "store_dev");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "dev-oidc");
    const { listCells } = await import("./storage");

    await listCells({ bypassCache: true });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        oidcToken: "dev-oidc",
        storeId: "store_dev",
      }),
    );
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty("token");
  });

  it("uses the production read-write token in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "prod-token");
    vi.stubEnv("BLOB_DEV_STORE_ID", "store_dev");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "dev-oidc");
    const { listCells } = await import("./storage");

    await listCells({ bypassCache: true });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ token: "prod-token" }),
    );
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty("storeId");
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
