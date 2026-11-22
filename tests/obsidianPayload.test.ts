import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCiteKey, getItemPayload } from "../src/modules/obsidianPayload";

describe("attachment payloads", () => {
  beforeEach(() => {
    (globalThis as any).Zotero = {
      debug: vi.fn(),
      HTTP: {
        request: vi.fn().mockRejectedValue(new Error("BBT unavailable")),
      },
      QuickCopy: {
        getContentFromItems: vi.fn().mockResolvedValue({ text: "Citation" }),
      },
      Items: {
        get: vi.fn((id: number) => ({
          key: `ATT${id}`,
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
      },
      {
        itemkey: "ATT2",
        title: "Attachment 2",
        path: undefined,
        url: "https://example.com",
        isFile: false,
      },
    ]);
    expect(result.libraryName).toBe("My Zotero Library");
    expect(result.citekey).toBe("key");
    expect(result.bibliography).toBe("Citation");
  });
});
