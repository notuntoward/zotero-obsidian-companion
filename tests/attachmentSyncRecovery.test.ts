import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverAttachmentSyncState } from "../src/modules/attachmentSyncRecovery";
import { createHash } from "node:crypto";

describe("attachment sync-state recovery", () => {
  let item: any;
  let clone: any;
  let cache: any;
  let journal: any;
  let zotero: any;
  let files: Map<string, string>;

  beforeEach(() => {
    let saved = false;
    let loaded = false;
    journal = undefined;
    files = new Map([
      ["/data/vault/paper.pdf", "vault"],
      ["/data/storage/OLDKEY12/image.png", "resource"],
    ]);
    cache = {
      key: "OLDKEY12",
      version: 7,
      data: {
        key: "OLDKEY12",
        version: 7,
        itemType: "attachment",
        parentItem: "PARENT12",
        linkMode: "imported_file",
        filename: "paper.pdf",
      },
    };
    clone = {
      key: "",
      id: 3,
      libraryID: 1,
      parentKey: "PARENT12",
      attachmentLinkMode: 2,
      attachmentPath: "/data/vault/paper.pdf",
      deleted: false,
      text: "",
      getNote: () => clone.text,
      setRelations: vi.fn(),
      save: vi.fn(async () => {
        saved = true;
      }),
      isLinkedFileAttachment: () => true,
      getFilePath: () => clone.attachmentPath,
    };
    item = {
      key: "OLDKEY12",
      id: 2,
      libraryID: 1,
      parentKey: "PARENT12",
      version: 7,
      synced: false,
      deleted: false,
      attachmentLinkMode: 2,
      attachmentPath: "/data/vault/paper.pdf",
      dateAdded: "2020-01-01",
      toJSON: () => {
        if (!loaded) throw new Error("Unloaded item data");
        return {
          ...cache.data,
          linkMode:
            item.attachmentLinkMode === 2 ? "linked_file" : cache.data.linkMode,
          path: item.attachmentPath,
          deleted: item.deleted,
        };
      },
      isLinkedFileAttachment: () => item.attachmentLinkMode === 2,
      getFilePath: () => item.attachmentPath,
      clone: () => clone,
      getRelations: () => ({}),
      save: vi.fn(),
      isNote: () => false,
      isAttachment: () => true,
      getNote: () => "",
      loadAllData: vi.fn(async () => {
        loaded = true;
      }),
      isFileAttachment: () => true,
    };
    zotero = {
      DataDirectory: { dir: "/data" },
      Sync: {
        Runner: { syncInProgress: false },
        Data: {
          Local: { getCacheObject: vi.fn(async () => structuredClone(cache)) },
        },
      },
      Libraries: { getAll: () => [{ libraryID: 1, libraryType: "user" }] },
      Items: {
        getAll: vi.fn(async () => [item]),
        getByLibraryAndKeyAsync: vi.fn(async (_id, key) =>
          key === item.key ? item : clone.key === key && saved ? clone : false,
        ),
        moveChildItems: vi.fn(),
        trash: vi.fn(async () => {
          item.deleted = true;
        }),
      },
      Attachments: {
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        getStorageDirectory: () => ({ path: "/data/storage/OLDKEY12" }),
      },
      Utilities: { generateObjectKey: () => "NEWKEY12" },
      URI: { getItemURI: (value: any) => value.key },
      Relations: { getByObject: vi.fn(async () => []) },
      Notes: {
        replaceItemKey: vi.fn((note, oldKey, newKey) => {
          note.text = note.text.replaceAll(oldKey, newKey);
        }),
      },
      DB: {
        executeTransaction: vi.fn(async (run) => {
          const previous = {
            attachmentLinkMode: item.attachmentLinkMode,
            attachmentPath: item.attachmentPath,
            deleted: item.deleted,
          };
          try {
            await run();
          } catch (error) {
            saved = false;
            Object.assign(item, previous);
            throw error;
          }
        }),
      },
      Fulltext: { queueItem: vi.fn() },
    };
    (globalThis as any).Zotero = zotero;
    (globalThis as any).addon = { data: { alive: true } };
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) => parts.join("/"),
      parent: (value: string) => value.slice(0, value.lastIndexOf("/")),
      filename: (value: string) => value.split("/").pop(),
      isAbsolute: (value: string) => value.startsWith("/"),
    };
    (globalThis as any).IOUtils = {
      exists: async (value: string) =>
        files.has(value) ||
        [...files.keys()].some((key) => key.startsWith(value + "/")) ||
        (value.endsWith("recovery.json") && journal !== undefined),
      stat: async (value: string) => ({
        type: files.has(value) ? "regular" : "directory",
        size: files.get(value)?.length || 0,
      }),
      getChildren: async (value: string) => [
        ...new Set(
          [...files.keys()]
            .filter((key) => key.startsWith(value + "/"))
            .map(
              (key) => value + "/" + key.slice(value.length + 1).split("/")[0],
            ),
        ),
      ],
      computeHexDigest: async (value: string) =>
        createHash("sha256").update(files.get(value)!).digest("hex"),
      makeDirectory: vi.fn(),
      copy: vi.fn(async (source, target) => {
        if (files.has(source)) files.set(target, files.get(source)!);
        for (const [key, value] of [...files])
          if (key.startsWith(source + "/"))
            files.set(target + key.slice(source.length), value);
      }),
      move: async (source: string, target: string) => {
        files.set(target, files.get(source)!);
        files.delete(source);
      },
      remove: async (target: string) => {
        files.delete(target);
      },
      readJSON: async () => structuredClone(journal),
      writeJSON: vi.fn(async (_path, value) => {
        journal = structuredClone(value);
      }),
    };
  });

  it.each(["imported_file", "imported_url"])(
    "recovers %s evidence and retains the vault file, resources and references",
    async (mode) => {
      cache.data.linkMode = mode;
      const note = {
        text: "citation OLDKEY12",
        getNote: () => note.text,
        loadAllData: vi.fn(),
        isNote: () => true,
        isFileAttachment: () => false,
        save: vi.fn(),
      };
      zotero.Items.getAll.mockResolvedValue([item, note]);
      const subject = {
        loadAllData: vi.fn(),
        isEditable: () => true,
        addRelation: vi.fn(),
        save: vi.fn(),
      };
      zotero.Relations.getByObject.mockResolvedValue([
        { subject, predicate: "related" },
      ]);
      await recoverAttachmentSyncState();
      expect(item.attachmentLinkMode).toBe(mode === "imported_file" ? 0 : 1);
      expect(item.attachmentPath).toBe("storage:paper.pdf");
      expect(item.deleted).toBe(true);
      expect(clone.key).toBe("NEWKEY12");
      expect(clone.attachmentPath).toBe("/data/vault/paper.pdf");
      expect(files.get("/data/vault/paper.pdf")).toBe("vault");
      expect(files.get("/data/storage/OLDKEY12/image.png")).toBe("resource");
      expect(zotero.Items.moveChildItems).toHaveBeenCalledWith(item, clone, {
        includeTrashed: true,
      });
      expect(zotero.Notes.replaceItemKey).toHaveBeenCalledWith(
        note,
        "OLDKEY12",
        "NEWKEY12",
      );
      expect(subject.addRelation).toHaveBeenCalledWith("related", "NEWKEY12");
      expect(journal[0].state).toBe("complete");
      await recoverAttachmentSyncState();
      expect(clone.save).toHaveBeenCalledOnce();
    },
  );

  it("does not infer prior mode from an absent or different-version cache", async () => {
    cache.version = 6;
    await expect(recoverAttachmentSyncState()).rejects.toThrow("cache");
    expect(clone.save).not.toHaveBeenCalled();
    expect(item.save).not.toHaveBeenCalled();
  });

  it("rejects changed evidence immediately before mutation", async () => {
    zotero.DB.executeTransaction.mockImplementation(
      async (run: () => Promise<void>) => {
        cache.data.filename = "changed.pdf";
        await run();
      },
    );
    await expect(recoverAttachmentSyncState()).rejects.toThrow("changed");
    expect(item.save).not.toHaveBeenCalled();
    expect(journal[0].state).toBe("prepared");
  });

  it("resumes after commit when the completion journal could not be written", async () => {
    const io = (globalThis as any).IOUtils;
    io.writeJSON
      .mockImplementationOnce(async (_path: string, value: any) => {
        journal = structuredClone(value);
      })
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(recoverAttachmentSyncState()).rejects.toThrow("disk full");
    io.writeJSON.mockImplementation(async (_path: string, value: any) => {
      journal = structuredClone(value);
    });
    await recoverAttachmentSyncState();
    expect(clone.save).toHaveBeenCalledOnce();
    expect(journal[0].state).toBe("complete");
  });

  it("stops while Zotero sync is running", async () => {
    zotero.Sync.Runner.syncInProgress = true;
    await expect(recoverAttachmentSyncState()).rejects.toThrow("sync");
    expect(item.save).not.toHaveBeenCalled();
  });

  it("keeps the prepared journal and resumes a rolled-back database transaction", async () => {
    item.save.mockRejectedValueOnce(new Error("database failure"));
    await expect(recoverAttachmentSyncState()).rejects.toThrow(
      "database failure",
    );
    expect(item.attachmentLinkMode).toBe(2);
    expect(item.deleted).toBe(false);
    expect(journal[0].state).toBe("prepared");
    await recoverAttachmentSyncState();
    expect(item.attachmentLinkMode).toBe(0);
    expect(item.deleted).toBe(true);
    expect(journal).toHaveLength(1);
    expect(journal[0].state).toBe("complete");
  });

  it("resumes interrupted archival without treating abandoned staging files as resources", async () => {
    const io = (globalThis as any).IOUtils;
    io.copy.mockRejectedValueOnce(new Error("copy interrupted"));
    await expect(recoverAttachmentSyncState()).rejects.toThrow(
      "copy interrupted",
    );
    files.set(
      "/data/obsidian-companion-attachment-archive/1/OLDKEY12-sync-recovery/transfers/image.png.perplexity-saver-transfer",
      "partial",
    );
    expect(item.save).not.toHaveBeenCalled();
    await recoverAttachmentSyncState();
    expect(journal[0].state).toBe("complete");
    expect(
      files.get(
        "/data/obsidian-companion-attachment-archive/1/OLDKEY12-sync-recovery/contents/image.png",
      ),
    ).toBe("resource");
  });

  it("does not mutate Zotero if the prepared journal cannot be persisted", async () => {
    (globalThis as any).IOUtils.writeJSON.mockRejectedValue(
      new Error("disk full"),
    );
    await expect(recoverAttachmentSyncState()).rejects.toThrow("disk full");
    expect(item.save).not.toHaveBeenCalled();
    expect(clone.save).not.toHaveBeenCalled();
  });
});
