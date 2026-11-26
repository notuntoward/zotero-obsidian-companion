import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CitationKeyValidationError,
  getCiteKey,
  getItemPayload,
} from "../src/modules/obsidianPayload";

describe("attachment payloads", () => {
  beforeEach(() => {
    (globalThis as any).Zotero = {
      debug: vi.fn(),
      logError: vi.fn(),
      Prefs: { get: vi.fn(() => "C:\\vault") },
      Attachments: {
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        BASE_PATH_PLACEHOLDER: "attachments:",
        getFileBaseNameFromItem: vi.fn(() => "Author - Title"),
      },
      HTTP: {
        request: vi.fn().mockRejectedValue(new Error("BBT unavailable")),
      },
      QuickCopy: {
        getContentFromItems: vi.fn().mockResolvedValue({ text: "Citation" }),
      },
      Items: {
        get: vi.fn((id: number) => ({
          key: `ATT${id}`,
          attachmentLinkMode: 0,
          attachmentPath: "storage:file.pdf",
          getField: (name: string) =>
            name === "title" ? `Attachment ${id}` : "https://example.com",
          getFilePath: () => false,
          isFileAttachment: () => id === 1,
        })),
      },
      Libraries: { get: vi.fn(() => ({ name: "My Zotero Library" })) },
      Collections: { get: vi.fn() },
      CreatorTypes: { getName: vi.fn() },
      URI: {
        getItemURI: vi.fn(() => "zotero://item"),
        getLibraryURI: vi.fn(() => "library"),
      },
      ItemTypes: { getName: vi.fn(() => "book") },
    };
  });

  it("reads current Better BibTeX cached citation keys for read-only items", async () => {
    (globalThis as any).Zotero.BetterBibTeX = {
      KeyManager: { get: () => ({ citationKey: "bbt-key" }) },
    };
    expect(await getCiteKey({ id: 4, getField: () => "" })).toBe("bbt-key");
  });

  it.each(["bad:key", "CON"])(
    "classifies invalid citation key %s as a terminal data issue",
    async (key) => {
      await expect(
        getCiteKey({ id: 1, getField: () => key }),
      ).rejects.toBeInstanceOf(CitationKeyValidationError);
    },
  );

  it("distinguishes unresolved file attachments with URLs from web links", async () => {
    const item = {
      id: 1,
      key: "ABC",
      libraryID: 1,
      itemTypeID: 1,
      getField: (name: string) => (name === "citationKey" ? "key" : ""),
      getTags: () => [],
      getCollections: () => [],
      getCreators: () => [],
      getAttachments: () => [1, 2],
      getNotes: () => [],
      getRelations: () => ({}),
    };

    const result = await getItemPayload(item);
    expect(result.attachments).toEqual([
      {
        itemkey: "ATT1",
        title: "Attachment 1",
        path: undefined,
        url: "https://example.com",
        isFile: true,
        mode: "stored",
      },
      {
        itemkey: "ATT2",
        title: "Attachment 2",
        path: undefined,
        url: "https://example.com",
        isFile: false,
        mode: "url",
      },
    ]);
    expect(result.libraryName).toBe("My Zotero Library");
    expect(result.linkedAttachmentBaseDirectory).toBe("C:\\vault");
    expect(result.linkedAttachmentBaseDirectoryValidated).toBe(false);
    expect(result.citekey).toBe("key");
    expect(result.bibliography).toBe("Citation");
  });

  it("reports relative linked attachment mode without treating stored files as linked", async () => {
    const z = (globalThis as any).Zotero;
    z.Items.get = vi.fn((id: number) => ({
      key: `ATT${id}`,
      attachmentLinkMode: id === 1 ? 2 : 0,
      attachmentPath: id === 1 ? "attachments:paper.pdf" : "storage:paper.pdf",
      getField: () => "",
      getFilePath: () => false,
      isFileAttachment: () => true,
    }));
    const { getSyncPayload } = await import("../src/modules/obsidianPayload");
    const result = await getSyncPayload({
      id: 1,
      key: "ABC",
      libraryID: 1,
      getField: () => "key",
      getAttachments: () => [1, 2],
    });
    expect(result.attachments?.[0]).toMatchObject({
      mode: "linked",
      usesRelativePath: true,
    });
    expect(result.attachments?.[1]).toMatchObject({ mode: "stored" });
    expect(result.attachments?.[1]).not.toHaveProperty("usesRelativePath");
    expect(result.linkedAttachmentBaseDirectory).toBe("C:\\vault");
  });

  it("does not treat an unset base directory as validated", async () => {
    const z = (globalThis as any).Zotero;
    z.Prefs.get.mockReturnValue("");
    const { getSyncPayload } = await import("../src/modules/obsidianPayload");
    const result = await getSyncPayload({
      id: 1,
      key: "ABC",
      libraryID: 1,
      getField: () => "key",
      getAttachments: () => [],
    });
    expect(result.linkedAttachmentBaseDirectory).toBe("");
    expect(result.linkedAttachmentBaseDirectoryValidated).toBe(false);
  });

  it("includes Zotero's evaluated attachment filename", async () => {
    const z = (globalThis as any).Zotero;
    const { getSyncPayload } = await import("../src/modules/obsidianPayload");
    const item = {
      key: "ABC",
      libraryID: 1,
      getField: () => "citekey",
      getAttachments: () => [],
    };
    const result = await getSyncPayload(item);
    expect(result.attachmentBaseName).toBe("Author - Title");
    expect(z.Attachments.getFileBaseNameFromItem).toHaveBeenCalledWith(item);
    expect(z.logError).not.toHaveBeenCalled();
  });

  it.each(["throws", "empty"])(
    "logs a %s attachment template result without substituting a citekey",
    async (failure) => {
      const z = (globalThis as any).Zotero;
      if (failure === "throws")
        z.Attachments.getFileBaseNameFromItem.mockImplementation(() => {
          throw new Error("template failed");
        });
      else z.Attachments.getFileBaseNameFromItem.mockReturnValue("  ");
      const { getSyncPayload } = await import("../src/modules/obsidianPayload");
      const result = await getSyncPayload({
        key: "ABC",
        libraryID: 1,
        getField: () => "citekey",
        getAttachments: () => [],
      });
      expect(result.attachmentBaseName).toBeUndefined();
      expect(z.logError).toHaveBeenCalledOnce();
      expect(z.logError.mock.calls[0][0].toLowerCase()).toContain(
        "attachment renaming template",
      );
      expect(z.logError.mock.calls[0][0]).toContain("ABC");
    },
  );
});
