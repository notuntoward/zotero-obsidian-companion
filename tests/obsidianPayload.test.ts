import { beforeEach, describe, expect, it, vi } from "vitest";
import { getItemPayload } from "../src/modules/obsidianPayload";

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
          getField: (name: string) =>
            name === "title" ? `Attachment ${id}` : "https://example.com",
          getFilePath: () => false,
          isFileAttachment: () => id === 1,
        })),
      },
      Collections: { get: vi.fn() },
      CreatorTypes: { getName: vi.fn() },
      URI: { getItemURI: vi.fn(() => "zotero://item") },
      ItemTypes: { getName: vi.fn(() => "book") },
    };
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
        title: "Attachment 1",
        path: undefined,
        url: "https://example.com",
        isFile: true,
      },
      {
        title: "Attachment 2",
        path: undefined,
        url: "https://example.com",
        isFile: false,
      },
    ]);
    expect(result.citekey).toBe("key");
    expect(result.bibliography).toBe("Citation");
  });
});
