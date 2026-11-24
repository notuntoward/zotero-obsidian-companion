import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  post: vi.fn(),
  payload: vi.fn(),
  notice: vi.fn(),
  addCheck: vi.fn(),
  report: vi.fn(),
  closeReport: vi.fn(),
  moveAttachments: vi.fn(),
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  isObsidianServerReady: mocks.ready,
  postToObsidian: mocks.post,
}));
vi.mock("../src/modules/obsidianPayload", () => ({
  getSyncPayload: mocks.payload,
}));
vi.mock("../src/modules/citationKeyCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/citationKeyCheck")>()),
  addCitationKeyCheck: mocks.addCheck,
}));
vi.mock("../src/modules/attachmentMover", () => ({
  moveReviewedAttachments: mocks.moveAttachments,
}));
vi.mock("../src/modules/attachmentBaseMonitor", () => ({
  getAttachmentBaseValidationState: () => "valid",
}));
vi.mock("../src/modules/noteMatchReport", () => ({
  showNoteMatchReport: mocks.report,
  closeNoteMatchReport: mocks.closeReport,
}));
vi.mock("../src/utils/progressNotice", () => ({ showNotice: mocks.notice }));

import {
  processReviewRequests,
  stopAutoSync,
  syncExistingNotesOnce,
} from "../src/modules/autoSync";

describe("automatic note reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveAttachments.mockReset();
    mocks.addCheck.mockReset();
    mocks.report.mockReset();
    (globalThis as any).addon = { data: { alive: true } };
    const item = { key: "ABC", isRegularItem: () => true };
    (globalThis as any).Zotero = {
      logError: vi.fn(),
      HTTP: {
        request: vi.fn().mockResolvedValue({
          responseText: JSON.stringify({
            success: true,
            identities: [
              { itemkey: "ABC", libraryURI: "library", citekey: "old" },
            ],
          }),
        }),
      },
      Libraries: {
        getAll: () => [
          { libraryType: "user", libraryID: 1, name: "My Library" },
        ],
      },
      URI: { getLibraryURI: () => "library" },
      Items: { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(item) },
    };
    mocks.ready.mockResolvedValue(true);
    mocks.payload.mockResolvedValue({
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
    });
    mocks.post.mockResolvedValue({
      results: [{ citekey: "new", status: "updated" }],
    });
    stopAutoSync();
  });
  it("moves a requested attachment batch and asks Obsidian to update note links", async () => {
    const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
    (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(
      item,
    );
    const candidate = {
      baseDirectory: "C:\\vault\\attachments",
      attachments: [
        {
          itemkey: "ATT1",
          mode: "linked",
          basename: "paper.html",
          sourcePath: "C:\\zotero\\paper.html",
          destinationPath: "C:\\vault\\attachments\\paper.html",
          resolution: "move",
          conflict: false,
          identical: false,
          sourceMtime: 1,
        },
      ],
      linkNoteFiles: [],
    };
    const payload = {
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
      linkedAttachmentBaseDirectory: candidate.baseDirectory,
      linkedAttachmentBaseDirectoryValidated: true,
    };
    mocks.payload.mockResolvedValue(payload);
    const moved = [
      {
        itemkey: "ATT1",
        from: "C:\\zotero\\paper.html",
        to: "C:\\vault\\attachments\\paper.html",
      },
    ];
    mocks.moveAttachments.mockResolvedValue({ moved, linked: [] });
    (globalThis as any).Zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          {
            itemkey: "ABC",
            libraryURI: "library",
            operation: "attachment-move",
            attachmentMove: candidate,
            strategy: "newest",
          },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });

    await expect(processReviewRequests()).resolves.toBe(false);
    expect(mocks.moveAttachments).toHaveBeenCalledWith(
      item,
      candidate,
      candidate.baseDirectory,
      "newest",
    );
    expect(mocks.post).toHaveBeenCalledWith({
      action: "attachment-move-complete",
      data: [payload],
      moved,
      linked: [],
    });
  });
  it("revalidates and applies a requested bulk note update", async () => {
    const zotero = (globalThis as any).Zotero;
    const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    zotero.HTTP.request
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          requests: [
            {
              itemkey: "ABC",
              libraryURI: "library",
              operation: "note-update",
            },
          ],
          pending: [{ itemkey: "ABC", libraryURI: "library" }],
        }),
      })
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          identities: [
            { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          ],
        }),
      });
    mocks.post
      .mockResolvedValueOnce({
        results: [{ citekey: "new", status: "prepared", token: "token" }],
      })
      .mockResolvedValueOnce({
        results: [{ citekey: "new", status: "updated" }],
      });
    await processReviewRequests();
    expect(zotero.HTTP.request).toHaveBeenCalledWith(
      "GET",
      "http://127.0.0.1:27124/lit-note-review-requests?bulk=1",
      { timeout: 5000 },
    );
    expect(mocks.post.mock.calls[0][0].action).toBe("bulk-review-sync");
    expect(mocks.post.mock.calls[1][0]).toMatchObject({
      action: "apply-sync",
      token: "token",
    });
    expect(item.reload).toHaveBeenCalledOnce();
  });

  it("reloads the Zotero item before sending a library-only correction", async () => {
    const zotero = (globalThis as any).Zotero;
    const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          { itemkey: "ABC", libraryURI: "library", operation: "library-uri" },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          {
            itemkey: "ABC",
            libraryURI: "library",
            operation: "library-recheck",
          },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    mocks.post
      .mockResolvedValueOnce({ results: [{ status: "updated" }] })
      .mockResolvedValueOnce({ results: [{ status: "skipped" }] });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await processReviewRequests();
    expect(item.reload).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-recheck",
      data: [expect.objectContaining({ itemkey: "ABC" })],
    });
    expect(mocks.post).toHaveBeenCalledWith({
      action: "bulk-library-uri",
      data: [
        expect.objectContaining({ itemkey: "ABC", libraryURI: "library" }),
      ],
    });
    expect(mocks.addCheck).not.toHaveBeenCalled();
  });

  it("keeps a recheck pending while Obsidian indexes the URI", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      isRegularItem: () => true,
      reload: vi.fn(),
    });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          {
            itemkey: "ABC",
            libraryURI: "library",
            operation: "library-recheck",
          },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    mocks.post.mockResolvedValueOnce({
      results: [{ status: "waiting-index" }],
    });
    expect(await processReviewRequests()).toBe(false);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.post.mock.calls[0][0].action).toBe("review-recheck");
  });

  it("does not assign a library when the item key is ambiguous across libraries", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Libraries.getAll = () => [
      { libraryType: "user", libraryID: 1 },
      { libraryType: "group", libraryID: 2 },
    ];
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      isRegularItem: () => true,
    });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          { itemkey: "ABC", libraryURI: "library", operation: "library-uri" },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review-failed",
        error: expect.stringContaining("more than one library"),
      }),
    );
  });

  it("reloads only the requested item and checks its current citation key", async () => {
    const zotero = (globalThis as any).Zotero;
    const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    zotero.HTTP.request
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          requests: [{ itemkey: "ABC", libraryURI: "library" }],
          pending: [{ itemkey: "ABC", libraryURI: "library" }],
        }),
      })
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          identities: [
            { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          ],
        }),
      });
    await processReviewRequests();
    expect(item.reload).toHaveBeenCalledOnce();
    expect(mocks.addCheck).toHaveBeenCalledWith(
      item,
      expect.objectContaining({ citekey: "new" }),
      expect.objectContaining({ citekey: "old" }),
    );
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-sync",
      data: [expect.objectContaining({ itemkey: "ABC" })],
    });
  });

  it("returns a missing item to the queue with a specific error", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(false);
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [{ itemkey: "ABC", libraryURI: "library" }],
        pending: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-failed",
      itemkey: "ABC",
      libraryURI: "library",
      error: "The Zotero item is missing or in the trash.",
    });
    expect(mocks.notice).toHaveBeenCalled();
  });

  it("returns a failed review request to the queue with its error", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: "ABC",
      isRegularItem: () => true,
      reload: vi.fn(),
    });
    zotero.HTTP.request
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          requests: [{ itemkey: "ABC", libraryURI: "library" }],
          pending: [{ itemkey: "ABC", libraryURI: "library" }],
        }),
      })
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          identities: [
            { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          ],
        }),
      });
    mocks.post
      .mockResolvedValueOnce({ error: "Connection refused" })
      .mockResolvedValueOnce({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "review-failed",
      itemkey: "ABC",
      libraryURI: "library",
      error: "Connection refused",
    });
  });

  it("rediscovers a pending review after the Obsidian queue is lost", async () => {
    const zotero = (globalThis as any).Zotero;
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    mocks.post.mockResolvedValue({
      results: [{ citekey: "new", status: "pending-review" }],
    });
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    await processReviewRequests();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    stopAutoSync();
    now.mockRestore();
  });

  it("continues searching other libraries when Zotero returns false for a missing key", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [{ itemkey: "ABC", citekey: "old" }],
      }),
    });
    zotero.Libraries.getAll = () => [
      { libraryType: "user", libraryID: 1 },
      { libraryType: "group", libraryID: 2 },
    ];
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (id: number) =>
        id === 1 ? false : { key: "ABC", isRegularItem: () => true },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.notice).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("reports missing items without preventing other notes from syncing", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "MISSING", libraryURI: "library", citekey: "old" },
          { itemkey: "LOST", libraryURI: "library", citekey: "old" },
          { itemkey: "ABC", libraryURI: "library", citekey: "old" },
        ],
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_id: number, key: string) =>
        key !== "ABC" ? false : { key, isRegularItem: () => true },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(mocks.report.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemkey: "MISSING",
          kind: "missing",
          checkedLibraries: ["My Library"],
        }),
        expect.objectContaining({
          itemkey: "LOST",
          kind: "missing",
          checkedLibraries: ["My Library"],
        }),
      ]),
    );
    expect(mocks.post).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("passes all missing notes to the report", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: ["ONE", "TWO", "THREE", "FOUR"].map((itemkey) => ({
          itemkey,
          libraryURI: "library",
          citekey: "old",
        })),
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(false);
    await syncExistingNotesOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(
      mocks.report.mock.calls[0][0].map((issue: any) => issue.itemkey),
    ).toEqual(["FOUR", "ONE", "THREE", "TWO"]);
  });

  it("reports note paths and unavailable Zotero libraries without claiming they were searched", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          {
            itemkey: "MISSING",
            notePath: "lit/First.md",
            libraryURI: "unavailable",
            citekey: "first",
          },
          {
            itemkey: "MISSING",
            notePath: "lit/Second.md",
            libraryURI: "unavailable",
            citekey: "second",
          },
        ],
      }),
    });
    await syncExistingNotesOnce();
    expect(zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    expect(mocks.report.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        notePath: "lit/First.md",
        itemkey: "MISSING",
        checkedLibraries: [],
        unavailableLibrary: "unavailable",
      }),
      expect.objectContaining({
        notePath: "lit/Second.md",
        itemkey: "MISSING",
        checkedLibraries: [],
        unavailableLibrary: "unavailable",
      }),
    ]);
    await syncExistingNotesOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
  });

  it("reports a dialog failure without blocking other notes", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "MISSING", citekey: "old" },
          { itemkey: "ABC", citekey: "old" },
        ],
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_id: number, key: string) =>
        key === "ABC" ? { key, isRegularItem: () => true } : false,
    );
    mocks.report.mockImplementation(() => {
      throw new Error("dialog unavailable");
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.notice.mock.calls[0][0]).toContain("dialog unavailable");
    expect(mocks.post).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("checks the note citation key before the automatic request", async () => {
    mocks.addCheck.mockImplementation(async (_item: any, payload: any) => {
      payload.citationKeyCheck = { citekey: "old", matches: [] };
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.addCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ citekey: "old" }),
    );
    expect(mocks.post.mock.calls[0][0].data[0].citationKeyCheck).toEqual({
      citekey: "old",
      matches: [],
    });
    now.mockRestore();
  });

  it("reconciles an independently changed key without relying on a notifier", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "sync",
      data: [{ itemkey: "ABC", libraryURI: "library", citekey: "new" }],
    });
    now.mockRestore();
  });

  it("waits for changed attachment snapshots to settle before sending", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    mocks.payload.mockResolvedValue({
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
      attachments: [{ path: "moved.pdf" }],
    });
    await syncExistingNotesOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    now.mockReturnValue(14999);
    await syncExistingNotesOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    now.mockReturnValue(15000);
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("continues syncing other notes when one item cannot be read", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          { itemkey: "DEF", libraryURI: "library", citekey: "old" },
        ],
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_library: number, key: string) => ({
        key,
        isRegularItem: () => true,
      }),
    );
    mocks.payload.mockImplementation(async (item: { key: string }) => {
      if (item.key === "ABC") throw new Error("attachment unavailable");
      return { itemkey: item.key, libraryURI: "library", citekey: "new" };
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.notice.mock.calls[0][0]).toContain("attachment unavailable");
    expect(mocks.post).toHaveBeenCalledWith({
      action: "sync",
      data: [{ itemkey: "DEF", libraryURI: "library", citekey: "new" }],
    });
    now.mockRestore();
  });

  it("retries failed updates after the server recovers", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    mocks.post.mockResolvedValueOnce({
      results: [{ citekey: "new", status: "error", error: "write failed" }],
    });
    await syncExistingNotesOnce();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.notice.mock.calls[0][0]).toContain("write failed");
    now.mockRestore();
  });

  it("does not repeatedly ask to adopt a declined legacy note", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [{ itemkey: "ABC", citekey: "old" }],
      }),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    mocks.post.mockResolvedValueOnce({
      results: [{ citekey: "new", status: "skipped" }],
    });
    await syncExistingNotesOnce();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("does not repeatedly ask about retained links until the item changes", async () => {
    const zotero = (globalThis as any).Zotero;
    const identity = { itemkey: "ABC", libraryURI: "library", citekey: "new" };
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({ success: true, identities: [identity] }),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    mocks.post.mockResolvedValueOnce({
      results: [
        {
          citekey: "new",
          status: "error",
          error: "Link kept",
          deferUntilChanged: true,
        },
      ],
    });
    await syncExistingNotesOnce();
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    mocks.payload.mockResolvedValue({
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
      attachments: [{ path: "later.pdf" }],
    });
    await syncExistingNotesOnce();
    now.mockReturnValue(16000);
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("does not launch Obsidian when it is unavailable", async () => {
    mocks.ready.mockResolvedValue(false);
    await syncExistingNotesOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("reports ambiguous legacy item keys instead of guessing", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [{ itemkey: "ABC", citekey: "old" }],
      }),
    });
    zotero.Libraries.getAll = () => [
      { libraryType: "user", libraryID: 1 },
      { libraryType: "group", libraryID: 2 },
    ];
    await syncExistingNotesOnce();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith([
      expect.objectContaining({
        itemkey: "ABC",
        kind: "ambiguous",
        checkedLibraries: ["Zotero library 1", "Zotero library 2"],
      }),
    ]);
  });

  it("distinguishes missing from ambiguous matches in one warning", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "MISSING", citekey: "old" },
          { itemkey: "AMBIGUOUS", citekey: "old" },
        ],
      }),
    });
    zotero.Libraries.getAll = () => [
      { libraryType: "user", libraryID: 1 },
      { libraryType: "group", libraryID: 2 },
    ];
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_id: number, key: string) =>
        key === "MISSING" ? false : { key, isRegularItem: () => true },
    );
    await syncExistingNotesOnce();
    expect(mocks.report).toHaveBeenCalledOnce();
    expect(mocks.report.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemkey: "MISSING", kind: "missing" }),
        expect.objectContaining({
          itemkey: "AMBIGUOUS",
          kind: "ambiguous",
          matchingLibraries: ["Zotero library 1", "Zotero library 2"],
        }),
      ]),
    );
  });
});
