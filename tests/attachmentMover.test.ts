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
    getFilePath: () => currentPath,
    getFilePathAsync: async () => currentPath,
    isFileAttachment: () => true,
    isLinkedFileAttachment: () => true,
    isStoredFileAttachment: () => false,
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
  (globalThis as any).PathUtils = { filename: path.basename, join: path.join };
  (globalThis as any).IOUtils = {
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
    copy: (source: string, destination: string) =>
      copyFile(source, destination),
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
          mode: "linked" as const,
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

  it("copies a shared stored attachment and keeps the original item and file", async () => {
    const f = await fixture();
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentLinkMode: 0,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const storedAttachment = Object.assign(f.attachment, {
      isLinkedFileAttachment: () => false,
      isStoredFileAttachment: () => true,
      clone: vi.fn(() => clone),
      dateAdded: "2024-01-02",
      eraseTx: vi.fn(),
    });
    const otherReference = {
      isFileAttachment: () => true,
      getFilePath: () => f.sourcePath,
    };
    const zotero = (globalThis as any).Zotero;
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    zotero.Items.get = (id: number) =>
      id === 1
        ? f.item
        : id === 2
          ? storedAttachment
          : id === 3
            ? clone
            : undefined;
    zotero.Items.getAll.mockResolvedValue([storedAttachment, otherReference]);

    const result = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(storedAttachment.clone).toHaveBeenCalledWith(1, {
      includeCollections: true,
    });
    expect(clone.attachmentPath).toBe(f.destination);
    expect(storedAttachment.eraseTx).not.toHaveBeenCalled();
    expect(storedAttachment.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(result.moved[0]).toMatchObject({
      itemkey: "ATTACH1",
      from: f.sourcePath,
      to: f.destination,
      newKey: "LINKED1",
      preservedSource: true,
      copied: true,
    });
  });

  it("fails closed before mutation when Zotero attachment references cannot be checked", async () => {
    const f = await fixture();
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getAll.mockRejectedValue(new Error("offline"));
    const onMutation = vi.fn();

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest", onMutation),
    ).rejects.toThrow(
      "Could not verify Zotero attachment references; no files were moved. Could not enumerate Zotero library 1: offline",
    );

    expect(onMutation).not.toHaveBeenCalled();
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
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      attachmentLinkMode: 0,
      attachmentPath: "",
      saveTx: vi.fn(),
      eraseTx: vi.fn(),
    };
    const storedAttachment = Object.assign(f.attachment, {
      isLinkedFileAttachment: () => false,
      isStoredFileAttachment: () => true,
      clone: vi.fn(() => clone),
      dateAdded: "2024-01-02",
      eraseTx: vi.fn(),
    });
    const zotero = (globalThis as any).Zotero;
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    zotero.Items.get = (id: number | number[]) =>
      Array.isArray(id)
        ? []
        : id === 2
          ? storedAttachment
          : id === 3
            ? clone
            : undefined;
    zotero.Items.moveChildItems = vi.fn();
    zotero.Items._moveRelations = vi.fn();
    zotero.Fulltext = { transferItemIndex: vi.fn() };
    zotero.Notes = { replaceItemKey: vi.fn() };
    zotero.DB = {
      executeTransaction: async (run: () => Promise<void>) => run(),
    };

    const { moved } = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );

    expect(storedAttachment.clone).toHaveBeenCalledWith(1, {
      includeCollections: true,
    });
    expect(clone.attachmentLinkMode).toBe(2);
    expect(clone.attachmentPath).toBe(f.destination);
    expect(zotero.Items._moveRelations).toHaveBeenCalledWith(
      storedAttachment,
      clone,
    );
    expect(zotero.Fulltext.transferItemIndex).toHaveBeenCalledWith(
      storedAttachment,
      clone,
    );
    expect(storedAttachment.eraseTx).toHaveBeenCalledOnce();
    expect(moved[0]).toMatchObject({ oldKey: "ATTACH1", newKey: "LINKED1" });
  });

  it("restores the source file when Zotero cannot save the linked replacement", async () => {
    const f = await fixture();
    const clone = {
      id: 3,
      key: "LINKED1",
      libraryID: 1,
      saveTx: vi.fn().mockRejectedValue(new Error("save failed")),
      eraseTx: vi.fn(),
    };
    const storedAttachment = Object.assign(f.attachment, {
      isLinkedFileAttachment: () => false,
      isStoredFileAttachment: () => true,
      clone: () => clone,
    });
    const zotero = (globalThis as any).Zotero;
    zotero.Attachments = { LINK_MODE_LINKED_FILE: 2 };
    zotero.Items.get = (id: number | number[]) =>
      Array.isArray(id)
        ? []
        : id === 2
          ? storedAttachment
          : id === 3
            ? clone
            : undefined;

    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("save failed");

    expect(await readFile(f.sourcePath, "utf8")).toBe("Zotero file");
    expect(await readdir(f.base)).toEqual([]);
    expect(clone.eraseTx).toHaveBeenCalledOnce();
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
