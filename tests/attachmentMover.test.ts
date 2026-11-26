import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "fs/promises";
import path from "path";
import { moveReviewedAttachments } from "../src/modules/attachmentMover";

let root = "";

async function fixture() {
  root = await mkdtemp(path.join(process.cwd(), ".zotero-attachment-move-"));
  const base = path.join(root, "vault");
  const sourceDirectory = path.join(root, "storage");
  await Promise.all([mkdir(base), mkdir(sourceDirectory)]);
  const sourcePath = path.join(sourceDirectory, "paper.html");
  const destination = path.join(base, "paper.html");
  await writeFile(sourcePath, "Zotero file");
  let currentPath = sourcePath;
  const attachment = {
    key: "ATTACH1",
    id: 2,
    parentItemID: 1,
    libraryID: 1,
    attachmentPath: sourcePath,
    attachmentLinkMode: 2,
    getFilePath: () => currentPath,
    getFilePathAsync: async (): Promise<string | false> => currentPath,
    isFileAttachment: () => true,
    isLinkedFileAttachment: () => true,
    isStoredFileAttachment: () => false,
    saveTx: vi.fn(async () => {
      currentPath = attachment.attachmentPath;
    }),
    relinkAttachmentFile: vi.fn(async (nextPath: string) => {
      currentPath = nextPath;
      return true;
    }),
  };
  const item = {
    id: 1,
    libraryID: 1,
    getAttachments: () => [2],
    getNotes: () => [],
  };
  (globalThis as any).addon = { data: { alive: true } };
  (globalThis as any).Zotero = {
    DataDirectory: { dir: root },
    Prefs: { get: () => base },
    Libraries: {
      get: () => ({ libraryType: "user" }),
      getAll: () => [{ libraryID: 1, libraryType: "user" }],
    },
    Items: {
      get: (id: number) =>
        id === 1 ? item : id === 2 ? attachment : undefined,
      getAll: vi.fn(async () => [attachment]),
    },
  };
  (globalThis as any).PathUtils = {
    filename: (value: string) => {
      if (!path.isAbsolute(value))
        throw new Error(
          "PathUtils.filename: Could not initialize path: NS_ERROR_FILE_UNRECOGNIZED_PATH",
        );
      return path.basename(value);
    },
    join: path.join,
    parent: path.dirname,
    isAbsolute: path.isAbsolute,
  };
  (globalThis as any).IOUtils = {
    makeDirectory: (target: string) => mkdir(target, { recursive: true }),
    exists: async (target: string) => {
      try {
        await stat(target);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (target: string) => {
      const info = await stat(target);
      return {
        type: info.isFile() ? "regular" : "directory",
        size: info.size,
        lastModified: info.mtimeMs,
      };
    },
    computeHexDigest: async (target: string) =>
      createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
    getChildren: async (target: string) =>
      (await readdir(target)).map((name) => path.join(target, name)),
    copy: async (
      source: string,
      destination: string,
      options?: { recursive?: boolean },
    ) =>
      options?.recursive
        ? (await import("fs/promises")).cp(source, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
          })
        : copyFile(source, destination),
    move: rename,
    remove: unlink,
    setModificationTime: async (target: string, modified: number) => {
      const date = new Date(modified);
      await utimes(target, date, date);
      return modified;
    },
  };
  return {
    item,
    attachment,
    base,
    sourcePath,
    destination,
    request: {
      baseDirectory: base,
      attachments: [
        {
          itemkey: "ATTACH1",
          mode: "linked" as "linked" | "stored",
          basename: "paper.html",
          sourcePath,
          destinationPath: destination,
          resolution: "move" as
            "move" | "newest" | "keep-destination" | "trash",
          conflict: false,
          identical: false,
          sourceMtime: (await stat(sourcePath)).mtimeMs,
          destinationMtime: undefined as number | undefined,
        },
      ],
      linkNoteFiles: [] as string[],
    },
  };
}

function configureStored(
  f: Awaited<ReturnType<typeof fixture>>,
  source = f.sourcePath,
) {
  const clone = {
    id: 3,
    key: "LINKED1",
    setRelations: vi.fn(),
    libraryID: 1,
    attachmentLinkMode: 0,
    attachmentPath: "",
    dateAdded: "",
    save: vi.fn(),
    isLinkedFileAttachment: () => clone.attachmentLinkMode === 2,
    getFilePathAsync: async () => clone.attachmentPath,
  };
  const original = Object.assign(f.attachment, {
    attachmentLinkMode: 0,
    getFilePath: () => source,
    getFilePathAsync: async () => source,
    isStoredFileAttachment: () => true,
    isLinkedFileAttachment: () => false,
    getRelations: () => ({ "owl:sameAs": ["https://example.test/items/A"] }),
    clone: vi.fn(() => clone),
    dateAdded: "2024-01-02",
  });
  f.request.attachments[0].mode = "stored";
  const zotero = (globalThis as any).Zotero;
  zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
  zotero.Items.get = (id: number | number[]) =>
    Array.isArray(id)
      ? []
      : id === 1
        ? f.item
        : id === 2
          ? original
          : id === 3
            ? clone
            : undefined;
  zotero.Items.moveChildItems = vi.fn();
  zotero.Items.trash = vi.fn();
  zotero.URI = { getItemURI: (item: { key: string }) => item.key };
  zotero.Relations = { getByObject: vi.fn(async () => []) };
  zotero.Notes = { replaceItemKey: vi.fn() };
  zotero.Fulltext = { queueItem: vi.fn() };
  zotero.DB = { executeTransaction: async (run: () => Promise<void>) => run() };
  return { clone, original, zotero };
}

async function captureReview(f: Awaited<ReturnType<typeof fixture>>) {
  for (const candidate of f.request.attachments) {
    candidate.sourceMtime = (await stat(candidate.sourcePath)).mtimeMs;
    candidate.destinationMtime = (await (globalThis as any).IOUtils.exists(
      candidate.destinationPath,
    ))
      ? (await stat(candidate.destinationPath)).mtimeMs
      : undefined;
  }
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
  delete (globalThis as any).addon;
  delete (globalThis as any).Zotero;
  delete (globalThis as any).PathUtils;
  delete (globalThis as any).IOUtils;
});

describe("moveReviewedAttachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "copies snapshot resources and rejects an incomplete copy: %s",
    async (incomplete) => {
      const f = await fixture();
      const zotero = (globalThis as any).Zotero;
      zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
      const sourceDir = path.join(path.dirname(f.sourcePath), "ATTACH1");
      const targetDir = path.join(f.base, "paper snapshot");
      await mkdir(sourceDir);
      await mkdir(path.join(sourceDir, "assets"));
      const source = path.join(sourceDir, "paper.html");
      const destination = path.join(targetDir, "paper.html");
      await writeFile(source, "<img src=assets/image.png>");
      await writeFile(
        path.join(sourceDir, "assets", "image.png"),
        "image bytes",
      );
      const { original, clone } = configureStored(f, source);
      (globalThis as any).PathUtils.parent = path.dirname;
      (globalThis as any).IOUtils.getChildren = async (dir: string) =>
        (await readdir(dir)).map((name) => path.join(dir, name));
      (globalThis as any).IOUtils.copy = async (
        from: string,
        to: string,
        options: { recursive?: boolean },
      ) =>
        options?.recursive
          ? (await import("fs/promises")).cp(from, to, {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
          : copyFile(from, to);
      if (incomplete) {
        const copy = (globalThis as any).IOUtils.copy;
        (globalThis as any).IOUtils.copy = async (...args: any[]) => {
          await copy(...args);
          await unlink(path.join(targetDir, "assets", "image.png"));
        };
      }
      const candidate = {
        ...f.request,
        attachments: [
          {
            ...f.request.attachments[0],
            mode: "stored" as const,
            sourcePath: source,
            destinationPath: destination,
            sourceMtime: (await stat(source)).mtimeMs,
            snapshotDirectory: true,
          },
        ],
      };
      if (incomplete) {
        await expect(
          moveReviewedAttachments(
            f.item,
            candidate,
            f.base,
            "newest",
            undefined,
            true,
          ),
        ).rejects.toThrow();
        expect(await original.getFilePathAsync()).toBe(source);
        expect(
          await readFile(path.join(sourceDir, "assets", "image.png"), "utf8"),
        ).toBe("image bytes");
        return;
      }
      const result = await moveReviewedAttachments(
        f.item,
        candidate,
        f.base,
        "newest",
        undefined,
        true,
      );
      expect(
        await readFile(path.join(targetDir, "assets", "image.png"), "utf8"),
      ).toBe("image bytes");
      expect(
        await readFile(path.join(sourceDir, "assets", "image.png"), "utf8"),
      ).toBe("image bytes");
      expect(await clone.getFilePathAsync()).toBe(destination);
      expect(
        await readFile(
          path.join(
            path.dirname(result.moved[0].archivePath!),
            "assets",
            "image.png",
          ),
          "utf8",
        ),
      ).toBe("image bytes");
      expect(result.moved[0]).toMatchObject({
        preservedSource: true,
        copied: true,
        to: destination,
      });
    },
  );

  it("automatically keeps a different nonempty note file and preserves the Zotero original", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    await writeFile(f.destination, "Note file");
    const candidate = {
      ...f.request,
      attachments: [
        {
          ...f.request.attachments[0],
          resolution: "keep-note" as const,
          destinationMtime: (await stat(f.destination)).mtimeMs,
        },
      ],
    };
    const result = await moveReviewedAttachments(
      f.item,
      candidate,
      f.base,
      "newest",
      undefined,
      true,
    );
    expect(await readFile(f.destination, "utf8")).toBe("Note file");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await f.attachment.getFilePathAsync()).toBe(f.destination);
    expect(result.moved[0]).toMatchObject({
      itemkey: "ATTACH1",
      from: f.sourcePath,
      to: f.destination,
      newKey: "ATTACH1",
      preservedSource: true,
    });
  });

  it("relinks a missing source to the matching nonempty note file", async () => {
    const f = await fixture();
    vi.spyOn(f.attachment, "getFilePathAsync").mockImplementation(async () =>
      f.attachment.getFilePath() === f.sourcePath
        ? false
        : f.attachment.getFilePath(),
    );
    (globalThis as any).Zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    await writeFile(f.destination, "Note file");
    await unlink(f.sourcePath);
    const candidate = {
      ...f.request,
      attachments: [
        {
          ...f.request.attachments[0],
          sourceMissing: true as const,
          sourceMtime: undefined,
          resolution: "keep-note" as const,
          destinationMtime: (await stat(f.destination)).mtimeMs,
        },
      ],
    };
    const result = await moveReviewedAttachments(
      f.item,
      candidate,
      f.base,
      "newest",
      undefined,
      true,
    );
    expect(await f.attachment.getFilePathAsync()).toBe(f.destination);
    expect(await readFile(f.destination, "utf8")).toBe("Note file");
    expect(result.moved[0]).toMatchObject({
      itemkey: "ATTACH1",
      from: f.sourcePath,
      to: f.destination,
      newKey: "ATTACH1",
      sourceMissing: true,
    });
    expect(result.moved[0].preservedSource).toBeUndefined();
  });

  it("archives remaining resources when the stored main file is missing", async () => {
    const f = await fixture();
    const { clone, zotero } = configureStored(f);
    await unlink(f.sourcePath);
    await writeFile(
      path.join(path.dirname(f.sourcePath), "image.png"),
      "snapshot resource",
    );
    await writeFile(f.destination, "Note file");
    Object.assign(f.request.attachments[0], {
      sourceMissing: true,
      sourceMtime: undefined,
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    const archived = vi.fn();
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
      undefined,
      true,
      archived,
    );
    expect(
      await readFile(
        path.join(result.moved[0].archiveDirectory!, "image.png"),
        "utf8",
      ),
    ).toBe("snapshot resource");
    expect(result.moved[0]).toMatchObject({
      sourceMissing: true,
      oldKey: "ATTACH1",
      newKey: clone.key,
    });
    expect(result.moved[0].archivePath).toBeUndefined();
    expect(archived).toHaveBeenCalledWith(
      "ATTACH1",
      result.moved[0].archiveDirectory,
      true,
    );
    expect(zotero.Items.trash).toHaveBeenCalledOnce();
    expect(await readFile(f.destination, "utf8")).toBe("Note file");
  });

  it("does not replace a missing stored main file when another item references its resources", async () => {
    const f = await fixture();
    const { zotero } = configureStored(f);
    await unlink(f.sourcePath);
    await writeFile(f.destination, "Note file");
    Object.assign(f.request.attachments[0], {
      sourceMissing: true,
      sourceMtime: undefined,
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    zotero.Items.getAll.mockResolvedValue([
      f.attachment,
      {
        isFileAttachment: () => true,
        getFilePath: () => path.join(path.dirname(f.sourcePath), "image.png"),
      },
    ]);
    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "newest",
        undefined,
        true,
      ),
    ).rejects.toThrow("another Zotero attachment");
    expect(zotero.Items.trash).not.toHaveBeenCalled();
  });

  it("rechecks a missing main file after journaling its resource archive", async () => {
    const f = await fixture();
    const { zotero } = configureStored(f);
    await unlink(f.sourcePath);
    await writeFile(
      path.join(path.dirname(f.sourcePath), "image.png"),
      "resource",
    );
    await writeFile(f.destination, "Note file");
    Object.assign(f.request.attachments[0], {
      sourceMissing: true,
      sourceMtime: undefined,
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    const io = (globalThis as any).IOUtils;
    const exists = io.exists;
    let journaled = false;
    io.exists = async (file: string) =>
      journaled && file === f.sourcePath ? true : exists(file);
    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "newest",
        undefined,
        true,
        () => {
          journaled = true;
        },
      ),
    ).rejects.toThrow("changed before replacement");
    expect(zotero.Items.trash).not.toHaveBeenCalled();
    expect(await readFile(f.destination, "utf8")).toBe("Note file");
  });

  it("refuses a missing-source plan if the Zotero file reappears", async () => {
    const f = await fixture();
    (globalThis as any).Zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    await writeFile(f.destination, "Note file");
    const candidate = {
      ...f.request,
      attachments: [
        {
          ...f.request.attachments[0],
          sourceMissing: true as const,
          sourceMtime: undefined,
          resolution: "keep-note" as const,
          destinationMtime: (await stat(f.destination)).mtimeMs,
        },
      ],
    };
    await expect(
      moveReviewedAttachments(
        f.item,
        candidate,
        f.base,
        "newest",
        undefined,
        true,
      ),
    ).rejects.toThrow("changed since review");
    expect(await f.attachment.getFilePathAsync()).toBe(f.sourcePath);
  });

  it("refuses a missing-source relink to an empty note attachment", async () => {
    const f = await fixture();
    (globalThis as any).Zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    vi.spyOn(f.attachment, "getFilePathAsync").mockImplementation(async () =>
      f.attachment.getFilePath() === f.sourcePath
        ? false
        : f.attachment.getFilePath(),
    );
    await writeFile(f.destination, "");
    await unlink(f.sourcePath);
    const candidate = {
      ...f.request,
      attachments: [
        {
          ...f.request.attachments[0],
          sourceMissing: true as const,
          sourceMtime: undefined,
          resolution: "keep-note" as const,
          destinationMtime: (await stat(f.destination)).mtimeMs,
        },
      ],
    };
    await expect(
      moveReviewedAttachments(
        f.item,
        candidate,
        f.base,
        "newest",
        undefined,
        true,
      ),
    ).rejects.toThrow("note attachment is empty");
    expect(f.attachment.getFilePath()).toBe(f.sourcePath);
  });

  it("moves a linked file and updates Zotero's attachment path", async () => {
    const f = await fixture();
    const onMutation = vi.fn();
    const moved = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
      onMutation,
    );
    expect(onMutation).toHaveBeenCalledOnce();
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(f.attachment.relinkAttachmentFile).toHaveBeenCalledWith(
      f.destination,
    );
    expect(moved).toEqual({
      moved: [{ itemkey: "ATTACH1", from: f.sourcePath, to: f.destination }],
      linked: [],
    });
  });

  it("archives snapshot resources when keeping an existing note attachment", async () => {
    const f = await fixture();
    configureStored(f);
    await mkdir(path.join(path.dirname(f.sourcePath), "assets"));
    await writeFile(
      path.join(path.dirname(f.sourcePath), "assets", "image.png"),
      "image bytes",
    );
    await writeFile(f.destination, "note file");
    Object.assign(f.request.attachments[0], {
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
      undefined,
      true,
    );
    expect(await readFile(f.destination, "utf8")).toBe("note file");
    expect(
      await readFile(
        path.join(
          path.dirname(result.moved[0].archivePath!),
          "assets",
          "image.png",
        ),
        "utf8",
      ),
    ).toBe("image bytes");
  });

  it("archives a stored attachment and replaces it without changing its link mode", async () => {
    const f = await fixture();
    const { original, clone, zotero } = configureStored(f);
    const onArchived = vi.fn();
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
      undefined,
      true,
      onArchived,
    );
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(await readFile(result.moved[0].archivePath!, "utf8")).toBe(
      "Zotero file",
    );
    expect(onArchived).toHaveBeenCalledWith(
      "ATTACH1",
      result.moved[0].archivePath,
    );
    expect(original.clone).toHaveBeenCalledOnce();
    expect(clone.setRelations).toHaveBeenCalledWith({
      "owl:sameAs": ["https://example.test/items/A"],
    });
    expect(original.attachmentLinkMode).toBe(0);
    expect(await clone.getFilePathAsync()).toBe(f.destination);
    expect(zotero.Items.trash).toHaveBeenCalledWith([original.id]);
    expect(result.moved[0]).toMatchObject({
      itemkey: "ATTACH1",
      oldKey: "ATTACH1",
      newKey: "LINKED1",
      preservedSource: true,
      copied: true,
    });
  });

  it("replaces a missing stored attachment without claiming an archive", async () => {
    const f = await fixture();
    const { original, clone, zotero } = configureStored(f);
    vi.spyOn(f.attachment, "getFilePathAsync").mockResolvedValue(false);
    await unlink(f.sourcePath);
    await writeFile(f.destination, "note file");
    Object.assign(f.request.attachments[0], {
      sourceMissing: true,
      sourceMtime: undefined,
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    const archived = vi.fn();
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
      undefined,
      true,
      archived,
    );
    expect(await clone.getFilePathAsync()).toBe(f.destination);
    expect(original.attachmentLinkMode).toBe(0);
    expect(zotero.Items.trash).toHaveBeenCalledWith([original.id]);
    expect(archived).not.toHaveBeenCalled();
    expect(result.moved[0]).toMatchObject({
      oldKey: "ATTACH1",
      newKey: "LINKED1",
      sourceMissing: true,
    });
    expect(result.moved[0].archivePath).toBeUndefined();
  });

  it("does not replace a stored attachment if its archive fails verification", async () => {
    const f = await fixture();
    const { original, zotero } = configureStored(f);
    const copy = (globalThis as any).IOUtils.copy;
    (globalThis as any).IOUtils.copy = async (
      from: string,
      to: string,
      options?: { recursive?: boolean },
    ) => {
      await copy(from, to, options);
      if (to.includes("obsidian-companion-attachment-archive"))
        await writeFile(path.join(to, "paper.html"), "bad copy");
    };
    const archived = vi.fn();
    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "newest",
        undefined,
        true,
        archived,
      ),
    ).rejects.toThrow("A snapshot resource could not be verified");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(original.clone).not.toHaveBeenCalled();
    expect(zotero.Items.trash).not.toHaveBeenCalled();
    expect(archived).not.toHaveBeenCalled();
  });

  it("does not replace a missing main file if the resource archive cannot be verified", async () => {
    const f = await fixture();
    const { original, zotero } = configureStored(f);
    vi.spyOn(f.attachment, "getFilePathAsync").mockResolvedValue(false);
    await unlink(f.sourcePath);
    await writeFile(
      path.join(path.dirname(f.sourcePath), "resource.png"),
      "resource",
    );
    await writeFile(f.destination, "note file");
    Object.assign(f.request.attachments[0], {
      sourceMissing: true,
      sourceMtime: undefined,
      resolution: "keep-note",
      destinationMtime: (await stat(f.destination)).mtimeMs,
    });
    const io = (globalThis as any).IOUtils;
    const copy = io.copy;
    io.copy = async (source: string, destination: string, options: object) => {
      await copy(source, destination, options);
      await writeFile(path.join(destination, "resource.png"), "corrupt");
    };
    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "newest",
        undefined,
        true,
      ),
    ).rejects.toThrow("A snapshot resource could not be verified");
    expect(original.clone).not.toHaveBeenCalled();
    expect(zotero.Items.trash).not.toHaveBeenCalled();
  });

  it("does not trash a stored attachment referenced by another Zotero item", async () => {
    const f = await fixture();
    const { original, zotero } = configureStored(f);
    const otherReference = {
      isFileAttachment: () => true,
      getFilePath: () => f.sourcePath,
    };
    zotero.Items.getAll.mockResolvedValue([original, otherReference]);
    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("another Zotero attachment references");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(original.clone).not.toHaveBeenCalled();
    expect(zotero.Items.trash).not.toHaveBeenCalled();
  });

  it("does not trash stored snapshot resources referenced by another attachment", async () => {
    const f = await fixture();
    const { original, zotero } = configureStored(f);
    const resource = path.join(path.dirname(f.sourcePath), "image.png");
    await writeFile(resource, "resource");
    zotero.Items.getAll.mockResolvedValue([
      original,
      {
        isFileAttachment: () => true,
        getFilePath: () => resource,
      },
    ]);
    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("another Zotero attachment references");
    expect(zotero.Items.trash).not.toHaveBeenCalled();
  });

  it("copies an interrupted attachment without enumerating references or removing its original", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clone),
      eraseTx: vi.fn(),
    });
    zotero.Items.get = (id: number) =>
      id === 1 ? f.item : id === 2 ? original : id === 3 ? clone : undefined;
    const onMutation = vi.fn();
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
      onMutation,
      true,
    );
    expect(onMutation).toHaveBeenCalledOnce();
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(zotero.Items.getAll).not.toHaveBeenCalled();
    expect(original.eraseTx).not.toHaveBeenCalled();
    expect(original.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(original.attachmentPath).toBe(f.destination);
    expect(result.moved[0]).toMatchObject({
      preservedSource: true,
      copied: true,
      newKey: "ATTACH1",
    });
  });

  it.each([".", "..", "../paper.html", "nested\\paper.html", "paper\0.html"])(
    "rejects an invalid reviewed basename %s before recording paths or moving files",
    async (basename) => {
      const f = await fixture();
      f.request.attachments[0].basename = basename;
      const onMutation = vi.fn();
      await expect(
        moveReviewedAttachments(
          f.item,
          f.request,
          f.base,
          "zotero",
          onMutation,
          true,
        ),
      ).rejects.toThrow("invalid filename or destination");
      expect(onMutation).not.toHaveBeenCalled();
      expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
      expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    },
  );

  it("does not overwrite a different destination during interrupted repair", async () => {
    const f = await fixture();
    await writeFile(f.destination, "other file");
    await captureReview(f);
    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "zotero",
        undefined,
        true,
      ),
    ).rejects.toThrow("differs");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("other file");
  });

  it("copies and preserves the original when Zotero references cannot be checked", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    zotero.logError = vi.fn();
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clone),
      eraseTx: vi.fn(),
    });
    zotero.Items.get = (id: number) =>
      id === 1 ? f.item : id === 2 ? original : id === 3 ? clone : undefined;
    const onMutation = vi.fn();

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
      onMutation,
    );

    expect(onMutation).toHaveBeenCalledOnce();
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(original.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(original.eraseTx).not.toHaveBeenCalled();
    expect(original.attachmentPath).toBe(f.destination);
    expect(result.moved[0]).toMatchObject({
      preservedSource: true,
      copied: true,
      referenceCheckFailed: true,
    });
  });

  it("preserves every original when a duplicate is part of an unchecked batch", async () => {
    const f = await fixture();
    const duplicatePath = path.join(root, "storage", "copy.html");
    await writeFile(duplicatePath, "Zotero file");
    const clones = [
      {
        id: 3,
        key: "LINKED1",
        attachmentPath: "",
        saveTx: vi.fn(),
        eraseTx: vi.fn(),
      },
      {
        id: 5,
        key: "LINKED2",
        attachmentPath: "",
        saveTx: vi.fn(),
        eraseTx: vi.fn(),
      },
    ];
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clones[0]),
      eraseTx: vi.fn(),
    });
    const duplicate = {
      key: "ATTACH2",
      id: 4,
      parentItemID: 1,
      libraryID: 1,
      deleted: false,
      attachmentPath: duplicatePath,
      getFilePathAsync: async () => duplicate.attachmentPath,
      isFileAttachment: () => true,
      isLinkedFileAttachment: () => true,
      isStoredFileAttachment: () => false,
      clone: vi.fn(() => clones[1]),
      saveTx: vi.fn(),
    };
    const zotero = (globalThis as any).Zotero;
    zotero.logError = vi.fn();
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    zotero.Items.get = (id: number) =>
      ({ 1: f.item, 2: original, 3: clones[0], 4: duplicate, 5: clones[1] })[
        id
      ];
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    f.item.getAttachments = () => [2, 4];
    f.request.attachments.push({
      ...f.request.attachments[0],
      itemkey: "ATTACH2",
      basename: "copy.html",
      sourcePath: duplicatePath,
      resolution: "trash",
      identical: true,
    });
    await captureReview(f);

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(duplicatePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(duplicate.deleted).toBe(false);
    expect(duplicate.saveTx).toHaveBeenCalledOnce();
    expect([original.attachmentPath, duplicate.attachmentPath]).toEqual([
      f.destination,
      f.destination,
    ]);
    expect(result.moved).toMatchObject([
      {
        itemkey: "ATTACH1",
        preservedSource: true,
        copied: true,
        referenceCheckFailed: true,
      },
      {
        itemkey: "ATTACH2",
        preservedSource: true,
        referenceCheckFailed: true,
      },
    ]);
  });

  it("copies to a new name when references cannot be checked and the destination differs", async () => {
    const f = await fixture();
    await writeFile(f.destination, "existing vault file");
    await captureReview(f);
    const zotero = (globalThis as any).Zotero;
    zotero.logError = vi.fn();
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clone),
      eraseTx: vi.fn(),
    });
    zotero.Items.get = (id: number) =>
      id === 1 ? f.item : id === 2 ? original : id === 3 ? clone : undefined;
    const onMutation = vi.fn();

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
      onMutation,
    );
    const alternate = path.join(f.base, "paper 2.html");
    expect(result.moved[0]).toMatchObject({
      to: alternate,
      copied: true,
      preservedSource: true,
      referenceCheckFailed: true,
    });
    expect(original.attachmentPath).toBe(alternate);
    expect(onMutation).toHaveBeenCalledOnce();
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("existing vault file");
    expect(await readFile(alternate, "utf8")).toBe("Zotero file");
  });

  it("keeps and links a different note file when reference checking fails", async () => {
    const f = await fixture();
    await writeFile(f.destination, "different note file");
    await captureReview(f);
    f.request.attachments[0].resolution = "newest";
    const zotero = (globalThis as any).Zotero;
    zotero.logError = vi.fn();
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clone),
      eraseTx: vi.fn(),
    });
    zotero.Items.get = (id: number) =>
      id === 1 ? f.item : id === 2 ? original : id === 3 ? clone : undefined;
    zotero.Attachments = {
      LINK_MODE_LINKED_FILE: 2,
      linkFromFile: vi.fn(async () => ({ key: "NOTE" })),
    };
    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
    );
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("different note file");
    expect(await readFile(path.join(f.base, "paper 2.html"), "utf8")).toBe(
      "Zotero file",
    );
    expect(result.linked).toEqual([{ path: f.destination, newKey: "NOTE" }]);
    expect(zotero.Attachments.linkFromFile).toHaveBeenCalledWith({
      file: f.destination,
      parentItemID: f.item.id,
    });
  });

  it("keeps both files when saving the Zotero attachment has an unknown outcome", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.logError = vi.fn();
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    const clone = {
      id: 3,
      key: "LINKED1",
      attachmentPath: "",
      saveTx: vi.fn().mockRejectedValue(new Error("save failed")),
      eraseTx: vi.fn().mockRejectedValue(new Error("erase failed")),
    };
    const original = Object.assign(f.attachment, {
      clone: vi.fn(() => clone),
      saveTx: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    zotero.Items.get = (id: number) =>
      id === 1 ? f.item : id === 2 ? original : id === 3 ? clone : undefined;

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow(
      "The Zotero attachment may have changed; the original and vault copy were kept",
    );
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
  });

  it("restores a stored attachment when setting a linked path is rejected", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.logError = vi.fn();
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    let mode = 0;
    let attachmentPath = "storage:paper.html";
    Object.defineProperties(f.attachment, {
      attachmentLinkMode: {
        get: () => mode,
        set: (value: number) => {
          mode = value;
        },
      },
      attachmentPath: {
        get: () => attachmentPath,
        set: (value: string) => {
          if (mode === 2)
            throw new Error("Linked files can only be added to user library");
          attachmentPath = value;
        },
      },
      isLinkedFileAttachment: { value: () => mode === 2 },
      isStoredFileAttachment: { value: () => mode === 0 },
    });
    f.request.attachments[0].mode = "stored";

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("Zotero attachment references could not be checked");
    expect(mode).toBe(0);
    expect(attachmentPath).toBe("storage:paper.html");
    expect(f.attachment.saveTx).not.toHaveBeenCalled();
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readdir(f.base)).toEqual([]);
  });

  it("keeps the newest existing destination and preserves the other copy as a backup", async () => {
    const f = await fixture();
    await writeFile(f.destination, "newer vault file");
    await utimes(f.destination, new Date(2000000000), new Date(2000000000));
    await utimes(f.sourcePath, new Date(1000000000), new Date(1000000000));
    await captureReview(f);
    await moveReviewedAttachments(f.item, f.request, f.base, "newest");
    expect(await readFile(f.destination, "utf8")).toBe("newer vault file");
    expect(
      await readFile(`${f.sourcePath}.perplexity-saver-backup`, "utf8"),
    ).toBe("Zotero file");
  });

  it("keeps the Zotero file when requested and preserves the replaced destination", async () => {
    const f = await fixture();
    await writeFile(f.destination, "older vault file");
    await captureReview(f);
    await moveReviewedAttachments(f.item, f.request, f.base, "zotero");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(
      await readFile(`${f.destination}.perplexity-saver-backup`, "utf8"),
    ).toBe("older vault file");
  });

  it("does not move a stale attachment path", async () => {
    const f = await fixture();
    f.request.attachments[0].sourcePath = path.join(root, "changed.html");
    const onMutation = vi.fn();
    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest", onMutation),
    ).rejects.toThrow("changed since review");
    expect(onMutation).not.toHaveBeenCalled();
    expect(await readdir(f.base)).toEqual([]);
  });

  it("converts a stored file to a linked item while preserving its Zotero metadata", async () => {
    const f = await fixture();
    f.destination = path.join(f.base, "renamed.html");
    f.request.attachments[0].destinationPath = f.destination;
    const { original, clone, zotero } = configureStored(f);
    const related = {
      isEditable: () => true,
      addRelation: vi.fn(),
      save: vi.fn(),
    };
    zotero.Relations.getByObject.mockResolvedValue([
      { subject: related, predicate: "related" },
    ]);

    const { moved } = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(original.clone).toHaveBeenCalledWith(1, {
      includeCollections: true,
    });
    expect(clone.attachmentLinkMode).toBe(2);
    expect(clone.attachmentPath).toBe(f.destination);
    expect(zotero.Items.moveChildItems).toHaveBeenCalledWith(original, clone, {
      includeTrashed: true,
    });
    expect(related.addRelation).toHaveBeenCalledWith("related", "LINKED1");
    expect(related.save).toHaveBeenCalledOnce();
    expect(zotero.Fulltext.queueItem).toHaveBeenCalledWith(clone);
    expect(zotero.Items.trash).toHaveBeenCalledWith([original.id]);
    expect(moved[0]).toMatchObject({ oldKey: "ATTACH1", newKey: "LINKED1" });
  });

  it("keeps the original and archive when Zotero cannot save the linked replacement", async () => {
    const f = await fixture();
    const { clone, original, zotero } = configureStored(f);
    clone.save.mockRejectedValue(new Error("save failed"));
    const archived = vi.fn();

    await expect(
      moveReviewedAttachments(
        f.item,
        f.request,
        f.base,
        "newest",
        undefined,
        true,
        archived,
      ),
    ).rejects.toThrow("save failed");

    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(archived.mock.calls[0][1], "utf8")).toBe(
      "Zotero file",
    );
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(original.attachmentLinkMode).toBe(0);
    expect(zotero.Items.trash).not.toHaveBeenCalled();
  });

  it("replaces an empty destination without leaving a backup", async () => {
    const f = await fixture();
    await writeFile(f.destination, "");
    await captureReview(f);
    await moveReviewedAttachments(f.item, f.request, f.base, "skip");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(await readdir(f.base)).toEqual(["paper.html"]);
  });

  it("links Zotero to the note's newer same-named file wherever it is in the vault", async () => {
    const f = await fixture();
    const noteCopy = path.join(f.base, "notes", "paper.html");
    await mkdir(path.dirname(noteCopy));
    await writeFile(noteCopy, "newer note file");
    await utimes(noteCopy, new Date(2000000000), new Date(2000000000));
    await utimes(f.sourcePath, new Date(1000000000), new Date(1000000000));
    Object.assign(f.request.attachments[0], {
      destinationPath: noteCopy,
      resolution: "newest",
    });
    await captureReview(f);
    const { moved } = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
    );
    expect(await readFile(noteCopy, "utf8")).toBe("newer note file");
    expect(f.attachment.relinkAttachmentFile).toHaveBeenCalledWith(noteCopy);
    expect(moved[0].to).toBe(noteCopy);
  });

  it("trashes identical duplicates after moving the kept file and links note-only files", async () => {
    const f = await fixture();
    const duplicatePath = path.join(root, "storage", "copy.html");
    await writeFile(duplicatePath, "Zotero file");
    const noteOnly = path.join(f.base, "notes.txt");
    await writeFile(noteOnly, "mine");
    const duplicate = {
      key: "ATTACH2",
      id: 4,
      parentItemID: 1,
      deleted: false,
      getFilePathAsync: async () => duplicatePath,
      isFileAttachment: () => true,
      isLinkedFileAttachment: () => true,
      isStoredFileAttachment: () => false,
      saveTx: vi.fn(),
    };
    const zotero = (globalThis as any).Zotero;
    const get = zotero.Items.get;
    zotero.Items.get = (id: number) => (id === 4 ? duplicate : get(id));
    f.item.getAttachments = () => [2, 4];
    zotero.Attachments = {
      linkFromFile: vi.fn(async () => ({ key: "LINKED3" })),
    };
    f.request.attachments.unshift({
      ...f.request.attachments[0],
      itemkey: "ATTACH2",
      basename: "copy.html",
      sourcePath: duplicatePath,
      resolution: "trash",
      identical: true,
    });
    f.request.linkNoteFiles = [noteOnly];
    await captureReview(f);

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(duplicate.deleted).toBe(true);
    expect(duplicate.saveTx).toHaveBeenCalledOnce();
    expect(result.moved.map((entry) => entry.itemkey)).toEqual([
      "ATTACH1",
      "ATTACH2",
    ]);
    expect(result.moved[1]).toMatchObject({ trashed: true, to: f.destination });
    expect(zotero.Attachments.linkFromFile).toHaveBeenCalledWith({
      file: noteOnly,
      parentItemID: 1,
    });
    expect(result.linked).toEqual([{ path: noteOnly, newKey: "LINKED3" }]);
  });

  it("moves a reviewed renamed file directly into the base directory", async () => {
    const f = await fixture();
    const destination = path.join(f.base, "Smith - 2026.HTML");
    f.request.attachments[0].destinationPath = destination;

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(await readFile(destination, "utf8")).toBe("Zotero file");
    expect(f.attachment.relinkAttachmentFile).toHaveBeenCalledWith(destination);
    expect(result.moved[0]).toMatchObject({
      from: f.sourcePath,
      to: destination,
    });
  });

  it.each([
    [
      "outside the base",
      (base: string) => path.join(path.dirname(base), "renamed.html"),
    ],
    [
      "in a subdirectory",
      (base: string) => path.join(base, "nested", "renamed.html"),
    ],
    [
      "with traversal",
      (base: string) => `${base}${path.sep}..${path.sep}renamed.html`,
    ],
    [
      "with a changed extension",
      (base: string) => path.join(base, "renamed.pdf"),
    ],
    [
      "with an unsafe character",
      (base: string) => path.join(base, "renamed:stream.html"),
    ],
    ["with a reserved name", (base: string) => path.join(base, "CON.html")],
    ["with a trailing dot", (base: string) => path.join(base, "renamed.html.")],
  ])(
    "rejects a move destination %s before changing files",
    async (_label, destination) => {
      const f = await fixture();
      f.request.attachments[0].destinationPath = destination(f.base);

      await expect(
        moveReviewedAttachments(f.item, f.request, f.base, "newest"),
      ).rejects.toThrow("invalid filename or destination");
      expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
      expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
    },
  );

  it("backs up a conflicting renamed destination before replacing it", async () => {
    const f = await fixture();
    const destination = path.join(f.base, "renamed.html");
    f.request.attachments[0].destinationPath = destination;
    await writeFile(destination, "existing note file");
    await captureReview(f);

    await moveReviewedAttachments(f.item, f.request, f.base, "zotero");

    expect(await readFile(destination, "utf8")).toBe("Zotero file");
    expect(
      await readFile(`${destination}.perplexity-saver-backup`, "utf8"),
    ).toBe("existing note file");
  });

  it("preserves a conflicting renamed destination and rolls it back if relinking fails", async () => {
    const f = await fixture();
    const destination = path.join(f.base, "renamed.html");
    f.request.attachments[0].destinationPath = destination;
    await writeFile(destination, "existing note file");
    await captureReview(f);
    f.attachment.relinkAttachmentFile.mockResolvedValue(false);

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "zotero"),
    ).rejects.toThrow("could not relink");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readFile(destination, "utf8")).toBe("existing note file");
    expect(await readdir(f.base)).toEqual(["renamed.html"]);
  });

  it("keeps the newer differently named note file and preserves the source", async () => {
    const f = await fixture();
    const noteCopy = path.join(f.base, "notes", "renamed.html");
    await mkdir(path.dirname(noteCopy));
    await writeFile(noteCopy, "newer note file");
    await utimes(noteCopy, new Date(2000000000), new Date(2000000000));
    await utimes(f.sourcePath, new Date(1000000000), new Date(1000000000));
    Object.assign(f.request.attachments[0], {
      destinationPath: noteCopy,
      resolution: "newest",
    });
    await captureReview(f);

    const { moved } = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "zotero",
    );

    expect(await readFile(noteCopy, "utf8")).toBe("newer note file");
    expect(
      await readFile(`${f.sourcePath}.perplexity-saver-backup`, "utf8"),
    ).toBe("Zotero file");
    expect(moved[0].to).toBe(noteCopy);
  });

  it("rejects a differently named note file with a different extension", async () => {
    const f = await fixture();
    const noteCopy = path.join(f.base, "note.pdf");
    await writeFile(noteCopy, "other file");
    Object.assign(f.request.attachments[0], {
      destinationPath: noteCopy,
      resolution: "newest",
    });
    await captureReview(f);

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("no longer matches");
    expect(await readFile(noteCopy, "utf8")).toBe("other file");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
  });

  it("does not move a source onto itself", async () => {
    const f = await fixture();
    f.request.attachments[0].destinationPath = f.sourcePath;
    f.request.attachments[0].resolution = "newest";

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("already points to its destination");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
  });

  it.each([
    "source changed",
    "source deleted",
    "destination changed",
    "destination deleted",
    "destination created",
  ])("rejects a stale plan when the %s before any mutation", async (change) => {
    const f = await fixture();
    if (change.startsWith("destination") && change !== "destination created")
      await writeFile(f.destination, "reviewed destination");
    await captureReview(f);
    if (change === "source changed") {
      await writeFile(f.sourcePath, "changed source");
      await utimes(f.sourcePath, new Date(2000000000), new Date(2000000000));
    } else if (change === "source deleted") {
      await unlink(f.sourcePath);
    } else if (change === "destination changed") {
      await writeFile(f.destination, "changed destination");
      await utimes(f.destination, new Date(2000000000), new Date(2000000000));
    } else if (change === "destination deleted") {
      await unlink(f.destination);
    } else {
      await writeFile(f.destination, "unexpected destination");
    }

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("changed since review; no files were moved");
    expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(await readdir(f.base)).toEqual(
      ["destination changed", "destination created"].includes(change)
        ? ["paper.html"]
        : [],
    );
  });

  it("keeps the newer source for an unchanged newest plan", async () => {
    const f = await fixture();
    const destination = path.join(f.base, "note-renamed.html");
    await writeFile(destination, "older note file");
    await utimes(destination, new Date(1000000000), new Date(1000000000));
    await utimes(f.sourcePath, new Date(2000000000), new Date(2000000000));
    Object.assign(f.request.attachments[0], {
      destinationPath: destination,
      resolution: "newest",
    });
    await captureReview(f);

    await moveReviewedAttachments(f.item, f.request, f.base, "zotero");

    expect(await readFile(destination, "utf8")).toBe("Zotero file");
    expect(
      await readFile(`${destination}.perplexity-saver-backup`, "utf8"),
    ).toBe("older note file");
  });

  it("rejects a stale later trash candidate before moving any earlier attachment", async () => {
    const f = await fixture();
    const duplicatePath = path.join(root, "storage", "copy.html");
    await writeFile(duplicatePath, "Zotero file");
    const duplicate = {
      key: "ATTACH2",
      id: 4,
      parentItemID: 1,
      getFilePathAsync: async () => duplicatePath,
      isFileAttachment: () => true,
      isLinkedFileAttachment: () => true,
      isStoredFileAttachment: () => false,
      saveTx: vi.fn(),
    };
    const zotero = (globalThis as any).Zotero;
    const get = zotero.Items.get;
    zotero.Items.get = (id: number) => (id === 4 ? duplicate : get(id));
    f.item.getAttachments = () => [2, 4];
    f.request.attachments.push({
      ...f.request.attachments[0],
      itemkey: "ATTACH2",
      basename: "copy.html",
      sourcePath: duplicatePath,
      resolution: "trash",
      identical: true,
    });
    await captureReview(f);
    await writeFile(duplicatePath, "changed duplicate");
    await utimes(duplicatePath, new Date(2000000000), new Date(2000000000));

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("changed since review; no files were moved");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readdir(f.base)).toEqual([]);
    expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(duplicate.saveTx).not.toHaveBeenCalled();
  });

  it("accepts fractional review timestamps at IOUtils millisecond precision", async () => {
    const f = await fixture();
    await utimes(f.sourcePath, new Date(1000000000), new Date(1000000000));
    await captureReview(f);
    f.request.attachments[0].sourceMtime += 0.75;

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );
    expect(result.moved).toHaveLength(1);
  });

  it("rejects non-finite review timestamps", async () => {
    const f = await fixture();
    f.request.attachments[0].sourceMtime = NaN;
    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("changed since review; no files were moved");
    expect(f.attachment.relinkAttachmentFile).not.toHaveBeenCalled();
  });
});
