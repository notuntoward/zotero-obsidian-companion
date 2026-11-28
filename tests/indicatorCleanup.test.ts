import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  post: vi.fn(),
  alert: vi.fn(),
  identities: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  ensureObsidianConnection: mocks.connect,
  postToObsidian: mocks.post,
}));
vi.mock("../src/utils/alert", () => ({
  getMainWindow: () => ({}),
  showAlert: mocks.alert,
}));
vi.mock("../src/utils/progressNotice", () => ({ showNotice: vi.fn() }));
vi.mock("../src/modules/citationKeyCheck", () => ({
  getIndicatorIdentities: mocks.identities,
}));
vi.mock("../src/modules/noteIndicators", () => ({
  refreshNoteIndicators: mocks.refresh,
}));

import {
  cleanupOldIndicators,
  fillMissingLibraryURIs,
} from "../src/modules/indicatorCleanup";

describe("old indicator cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ ready: true });
    (globalThis as any).Zotero = {
      logError: vi.fn(),
      Libraries: { getAll: () => [{ libraryID: 1, libraryType: "user" }] },
      Items: { getAll: vi.fn() },
      Tags: { getColor: () => true, setColor: vi.fn() },
    };
  });

  describe("missing library identity cleanup", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.connect.mockResolvedValue({ ready: true });
      (globalThis as any).addon = { data: { alive: true } };
      (globalThis as any).Zotero = {
        logError: vi.fn(),
        Libraries: {
          getAll: () => [
            { libraryID: 1, libraryType: "user" },
            { libraryID: 2, libraryType: "group" },
          ],
        },
        URI: { getLibraryURI: (id: number) => `library-${id}` },
        Items: { getByLibraryAndKeyAsync: vi.fn() },
      };
    });

    it("writes only uniquely matching notes and reports ambiguous or missing matches", async () => {
      mocks.identities.mockResolvedValue({
        identities: [
          { itemkey: "ONE", notePath: "one.md" },
          { itemkey: "TWO", notePath: "two.md" },
          { itemkey: "MISSING", notePath: "missing.md" },
          { itemkey: "DUP", notePath: "dup.md" },
          { itemkey: "DUP", notePath: "dup2.md" },
          { itemkey: "KNOWN", notePath: "known.md", libraryURI: "library-1" },
        ],
        unidentifiedNotes: 1,
      });
      const item = { isRegularItem: () => true, deleted: false };
      (
        globalThis as any
      ).Zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
        async (id: number, key: string) =>
          key === "ONE" && id === 1 ? item : key === "TWO" ? item : null,
      );
      mocks.post.mockResolvedValue({
        success: true,
        updated: 1,
        reordered: 2,
        unfilled: 0,
        errors: [],
      });
      await fillMissingLibraryURIs();
      expect(mocks.post).toHaveBeenCalledWith({
        action: "fill-missing-library-uris",
        notes: [
          { itemkey: "ONE", notePath: "one.md", libraryURI: "library-1" },
        ],
      });
      expect(mocks.refresh).toHaveBeenCalledWith(true);
      expect(mocks.alert.mock.calls[0][2]).toContain("Skipped 5 notes");
      expect(mocks.alert.mock.calls[0][2]).toContain(
        "repositioned existing identities in 2 notes",
      );
      expect(mocks.alert.mock.calls[0][2]).toContain("missing.md");
      expect(mocks.alert.mock.calls[0][2]).toContain("dup.md");
    });

    it("does not write when a library lookup fails", async () => {
      mocks.identities.mockResolvedValue({
        identities: [{ itemkey: "ONE", notePath: "one.md" }],
        unidentifiedNotes: 0,
      });
      (
        globalThis as any
      ).Zotero.Items.getByLibraryAndKeyAsync.mockRejectedValue(
        new Error("library unavailable"),
      );
      await fillMissingLibraryURIs();
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.alert.mock.calls[0][2]).toContain("library unavailable");
    });

    it("does not write if a match becomes ambiguous before submission", async () => {
      mocks.identities.mockResolvedValue({
        identities: [{ itemkey: "ONE", notePath: "one.md" }],
        unidentifiedNotes: 0,
      });
      const item = { isRegularItem: () => true, deleted: false };
      (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync
        .mockResolvedValueOnce(item)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(item)
        .mockResolvedValueOnce(item);
      await fillMissingLibraryURIs();
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.alert.mock.calls[0][2]).toContain("matches changed");
    });

    it("backfills unique identities silently during automatic sync", async () => {
      mocks.identities.mockResolvedValue({
        identities: [{ itemkey: "ONE", notePath: "one.md" }],
        unidentifiedNotes: 0,
      });
      const item = { isRegularItem: () => true, deleted: false };
      (
        globalThis as any
      ).Zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
        async (id: number) => (id === 1 ? item : null),
      );
      mocks.post.mockResolvedValue({
        success: true,
        updated: 1,
        reordered: 0,
        unfilled: 0,
        errors: [],
      });

      await expect(fillMissingLibraryURIs({ notify: false })).resolves.toBe(
        true,
      );

      expect(mocks.post).toHaveBeenCalledWith({
        action: "fill-missing-library-uris",
        notes: [
          { itemkey: "ONE", notePath: "one.md", libraryURI: "library-1" },
        ],
      });
      expect(mocks.alert).not.toHaveBeenCalled();
    });
  });

  it("removes only the authorized Zotero tag and reports both counts", async () => {
    const tags = new Set(["obsLitNote", "personal"]);
    const item = {
      key: "ABC",
      hasTag: (tag: string) => tags.has(tag),
      removeTag: (tag: string) => tags.delete(tag),
      saveTx: vi.fn(),
    };
    const z = (globalThis as any).Zotero;
    z.Items.getAll.mockResolvedValue([item]);
    mocks.post.mockResolvedValue({ success: true, removed: 2, errors: [] });
    await cleanupOldIndicators();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "cleanup-obs-lit-note-tag",
    });
    expect(tags).toEqual(new Set(["personal"]));
    expect(z.Tags.setColor).toHaveBeenCalledWith(1, "obsLitNote", false);
    expect(mocks.alert.mock.calls[0][2]).toContain(
      "1 Zotero items and 2 Obsidian notes",
    );
  });

  it("reports partial failures and keeps the color when Zotero removal fails", async () => {
    const z = (globalThis as any).Zotero;
    const reload = vi.fn();
    z.Items.getAll.mockResolvedValue([
      {
        key: "ABC",
        hasTag: () => true,
        removeTag: vi.fn(),
        saveTx: vi.fn().mockRejectedValue(new Error("read-only")),
        reload,
      },
    ]);
    mocks.post.mockResolvedValue({
      success: false,
      removed: 1,
      errors: ["note.md: locked"],
    });
    await cleanupOldIndicators();
    expect(z.Tags.setColor).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledWith(["tags"], true);
    expect(mocks.alert.mock.calls[0][2]).toContain("note.md: locked");
    expect(mocks.alert.mock.calls[0][2]).toContain("read-only");
  });

  it("does not touch Zotero if the peer does not support cleanup", async () => {
    mocks.post.mockResolvedValue({ success: false, error: "Unknown action" });
    await cleanupOldIndicators();
    expect((globalThis as any).Zotero.Items.getAll).not.toHaveBeenCalled();
    expect(mocks.alert.mock.calls[0][2]).toContain("invalid cleanup result");
  });
});
