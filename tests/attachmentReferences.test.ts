import { beforeEach, describe, expect, it, vi } from "vitest";
import { enumerateZoteroAttachmentPaths } from "../src/modules/attachmentReferences";

function fileAttachment(
  key: string,
  filePath: string | false,
  deleted = false,
) {
  return {
    key,
    deleted,
    isFileAttachment: () => true,
    getFilePath: vi.fn(() => filePath),
    getFilePathAsync: vi.fn(async () => filePath),
    getAnnotations: vi.fn(() => {
      throw new Error("annotations must not be read");
    }),
    hasEmbeddedAnnotations: vi.fn(async () => {
      throw new Error("PDF contents must not be read");
    }),
  };
}

describe("Zotero attachment-path enumeration", () => {
  const trashedChild = fileAttachment(
    "TRASHED",
    "C:\\Zotero\\storage\\trashed.pdf",
    true,
  );

  beforeEach(() => {
    (globalThis as any).Zotero = {
      Libraries: {
        getAll: () => [
          { libraryID: 1, libraryType: "user" },
          { libraryID: 2, libraryType: "group" },
          { libraryID: 3, libraryType: "feed" },
        ],
      },
      Items: {
        getAll: vi.fn(async (libraryID: number) =>
          libraryID === 1
            ? [{ isFileAttachment: () => false }, trashedChild]
            : [{ isFileAttachment: () => false }],
        ),
      },
    };
  });

  it("includes child and trashed file attachments from user and group libraries", async () => {
    const groupChild = fileAttachment("GROUP", "C:\\Zotero\\group.pdf");
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getAll.mockImplementation(async (libraryID: number) =>
      libraryID === 1
        ? [{ isFileAttachment: () => false }, trashedChild]
        : [{ isFileAttachment: () => false }, groupChild],
    );

    await expect(enumerateZoteroAttachmentPaths()).resolves.toEqual([
      "C:\\Zotero\\storage\\trashed.pdf",
      "C:\\Zotero\\group.pdf",
    ]);
    expect(zotero.Items.getAll).toHaveBeenCalledWith(1, false, true);
    expect(zotero.Items.getAll).toHaveBeenCalledWith(2, false, true);
    expect(trashedChild.getAnnotations).not.toHaveBeenCalled();
    expect(trashedChild.hasEmbeddedAnnotations).not.toHaveBeenCalled();
    expect(groupChild.getAnnotations).not.toHaveBeenCalled();
    expect(groupChild.hasEmbeddedAnnotations).not.toHaveBeenCalled();
  });

  it("includes a recorded path even when its attachment file is missing", async () => {
    const missingFile = fileAttachment("MISSING", "C:\\vault\\missing.pdf");
    missingFile.getFilePathAsync.mockResolvedValue(false);
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getAll.mockResolvedValueOnce([missingFile]);

    await expect(enumerateZoteroAttachmentPaths()).resolves.toEqual([
      "C:\\vault\\missing.pdf",
    ]);
    expect(missingFile.getFilePathAsync).not.toHaveBeenCalled();
  });

  it("fails closed when a library cannot be enumerated or a path is missing", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getAll.mockRejectedValueOnce(new Error("offline"));
    await expect(enumerateZoteroAttachmentPaths()).rejects.toThrow(
      "Could not enumerate Zotero library 1: offline",
    );

    zotero.Items.getAll.mockResolvedValueOnce([
      fileAttachment("MISSING", false),
    ]);
    await expect(enumerateZoteroAttachmentPaths()).rejects.toThrow(
      "File path is unavailable for attachment MISSING in library 1",
    );
  });
});
