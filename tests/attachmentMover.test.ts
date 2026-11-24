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
import { tmpdir } from "os";
import path from "path";
import { moveReviewedAttachments } from "../src/modules/attachmentMover";

let root = "";

async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), "zotero-attachment-move-"));
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
    Libraries: { get: () => ({ libraryType: "user" }) },
    Items: {
      get: (id: number) =>
        id === 1 ? item : id === 2 ? attachment : undefined,
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
          sourceMtime: Date.now(),
        },
      ],
      linkNoteFiles: [] as string[],
    },
  };
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
    const moved = await moveReviewedAttachments(
      f.item,
      f.request,
      f.base,
      "newest",
    );
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(f.attachment.relinkAttachmentFile).toHaveBeenCalledWith(
      f.destination,
    );
    expect(moved).toEqual({
      moved: [{ itemkey: "ATTACH1", from: f.sourcePath, to: f.destination }],
      linked: [],
    });
  });

  it("keeps the newest existing destination and preserves the other copy as a backup", async () => {
    const f = await fixture();
    await writeFile(f.destination, "newer vault file");
    await utimes(f.destination, new Date(2000000000), new Date(2000000000));
    await utimes(f.sourcePath, new Date(1000000000), new Date(1000000000));
    await moveReviewedAttachments(f.item, f.request, f.base, "newest");
    expect(await readFile(f.destination, "utf8")).toBe("newer vault file");
    expect(
      await readFile(`${f.sourcePath}.perplexity-saver-backup`, "utf8"),
    ).toBe("Zotero file");
  });

  it("keeps the Zotero file when requested and preserves the replaced destination", async () => {
    const f = await fixture();
    await writeFile(f.destination, "older vault file");
    await moveReviewedAttachments(f.item, f.request, f.base, "zotero");
    expect(await readFile(f.destination, "utf8")).toBe("Zotero file");
    expect(
      await readFile(`${f.destination}.perplexity-saver-backup`, "utf8"),
    ).toBe("older vault file");
  });

  it("does not move a stale attachment path", async () => {
    const f = await fixture();
    f.request.attachments[0].sourcePath = path.join(root, "changed.html");
    await expect(
      moveReviewedAttachments(f.item, f.request, f.base, "newest"),
    ).rejects.toThrow("changed since review");
    expect(await readdir(f.base)).toEqual([]);
  });

  it("converts a stored file to a linked item while preserving its Zotero metadata", async () => {
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
});
