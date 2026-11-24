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
    (globalThis as any).addon = {
      data: { alive: true, config: { prefsPrefix: "extensions.test" } },
    };
    const preferences = new Map<string, unknown>([
      ["extensions.test.reviewJournal", "[]"],
    ]);
    (globalThis as any).Services = { prefs: { savePrefFile: vi.fn() } };
    const item = { key: "ABC", isRegularItem: () => true };
    (globalThis as any).Zotero = {
      logError: vi.fn(),
      Prefs: {
        get: (name: string) => preferences.get(name),
        set: (name: string, value: unknown) => preferences.set(name, value),
      },
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
      expect.any(Function),
    );
    expect(mocks.post).toHaveBeenCalledWith({
      action: "attachment-move-complete",
      data: [payload],
      moved,
      linked: [],
    });
  });

  it.each([false, true])(
    "reports a move failure appropriately when mutation started: %s",
    async (started) => {
      const zotero = (globalThis as any).Zotero;
      const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
      zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
      const candidate = {
        baseDirectory: "C:\\vault",
        attachments: [
          {
            itemkey: "ATT1",
            mode: "linked",
            basename: "paper.pdf",
            sourcePath: "C:\\old\\paper.pdf",
            destinationPath: "C:\\vault\\paper.pdf",
            resolution: "move",
            conflict: false,
            identical: false,
            sourceMtime: 1,
          },
        ],
        linkNoteFiles: [],
      };
      mocks.payload.mockResolvedValue({
        itemkey: "ABC",
        libraryURI: "library",
        citekey: "new",
        linkedAttachmentBaseDirectory: candidate.baseDirectory,
        linkedAttachmentBaseDirectoryValidated: true,
      });
      zotero.HTTP.request.mockResolvedValue({
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
          pending: [],
        }),
      });
      mocks.moveAttachments.mockImplementation(
        async (_item, _candidate, _base, _strategy, onMutation) => {
          if (started) onMutation();
          throw new Error("attachment changed since review");
        },
      );
      mocks.post.mockResolvedValue({ success: true });

      await processReviewRequests();

      if (started) {
        expect(mocks.post).toHaveBeenCalledWith({
          action: "review-uncertain",
          error: "attachment changed since review",
          itemkey: "ABC",
          libraryURI: "library",
        });
        expect(zotero.logError).toHaveBeenCalledWith(
          expect.stringContaining("attachment changed since review"),
        );
        expect(
          JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
        ).toMatchObject([
          { error: "attachment changed since review", state: "in-flight" },
        ]);
        mocks.post.mockClear();
        await processReviewRequests();
        expect(mocks.post).toHaveBeenCalledWith({
          action: "review-uncertain",
          error: "attachment changed since review",
          itemkey: "ABC",
          libraryURI: "library",
        });
        expect(mocks.moveAttachments).toHaveBeenCalledOnce();
      } else {
        expect(mocks.post).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "review-failed",
            error: "attachment changed since review",
          }),
        );
        expect(
          JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
        ).toEqual([]);
      }
    },
  );

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
      .mockResolvedValueOnce({
        results: [{ status: "error", error: "Note not found" }],
      })
      .mockResolvedValueOnce({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "review-failed",
      itemkey: "ABC",
      libraryURI: "library",
      error: "Note not found",
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

  it("persists a review before an in-flight timeout and reports its unknown outcome", async () => {
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
          pending: [],
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
    let resolveReview!: (value: unknown) => void;
    mocks.post.mockImplementation((payload: any) =>
      payload.action === "review-sync"
        ? new Promise((resolve) => {
            resolveReview = resolve;
          })
        : Promise.resolve({ success: true }),
    );

    const pending = processReviewRequests();
    await vi.waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        expect.objectContaining({ action: "review-sync" }),
      ),
    );
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "review-sync",
        state: "in-flight",
      },
    ]);
    expect((globalThis as any).Services.prefs.savePrefFile).toHaveBeenCalled();
    resolveReview({ connectionError: true, error: "Request timed out" });
    await pending;
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-uncertain",
      error: "Request timed out",
      itemkey: "ABC",
      libraryURI: "library",
    });
    expect(
      mocks.post.mock.calls.some(
        ([request]: any[]) => request.action === "review-failed",
      ),
    ).toBe(false);
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
    expect(
      mocks.notice.mock.calls.some(
        ([message]: any[]) =>
          message.includes("outcome") && message.includes("unknown"),
      ),
    ).toBe(false);
  });

  it("retains and reports an unknown result after a prepared update may have applied", async () => {
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
          requests: [
            { itemkey: "ABC", libraryURI: "library", operation: "note-update" },
          ],
          pending: [],
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
        results: [{ status: "prepared", token: "token" }],
      })
      .mockResolvedValueOnce({ connectionError: true, error: "response lost" })
      .mockResolvedValueOnce({ success: true });

    await processReviewRequests();
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["bulk-review-sync", "apply-sync", "review-uncertain"]);
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal"))[0].state,
    ).toBe("in-flight");
  });

  it("re-reports a retained review after restart, blocks replay, and processes another identity", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Prefs.set(
      "extensions.test.reviewJournal",
      JSON.stringify([
        {
          itemkey: "ABC",
          libraryURI: "library",
          operation: "review-sync",
          state: "in-flight",
        },
      ]),
    );
    stopAutoSync();
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: "OTHER",
      isRegularItem: () => true,
      reload: vi.fn(),
    });
    mocks.payload.mockResolvedValue({
      itemkey: "OTHER",
      libraryURI: "library",
      citekey: "other",
    });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          { itemkey: "ABC", libraryURI: "library" },
          { itemkey: "OTHER", libraryURI: "library", operation: "library-uri" },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library", uncertain: true }],
      }),
    });
    mocks.post
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ results: [{ status: "updated" }] });

    await processReviewRequests();
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["review-uncertain", "bulk-library-uri"]);
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "review-sync",
        state: "in-flight",
      },
    ]);
  });

  it("persists acknowledgement-pending across restart and retries confirmation before unblocking", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Prefs.set(
      "extensions.test.reviewJournal",
      JSON.stringify([
        {
          itemkey: "ABC",
          libraryURI: "library",
          operation: "review-sync",
          state: "in-flight",
        },
      ]),
    );
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [{ itemkey: "ABC", libraryURI: "library" }],
        pending: [],
        acknowledgedUncertain: [{ itemkey: "ABC", libraryURI: "library" }],
      }),
    });
    mocks.post.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
      connectionError: true,
      error: "lost acknowledgement",
    });

    await processReviewRequests();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal"))[0].state,
    ).toBe("ack-pending");
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["review-uncertain", "review-uncertain-acknowledged"]);
    stopAutoSync();
    mocks.post.mockResolvedValueOnce({ success: true });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    await processReviewRequests();
    expect(mocks.post.mock.calls[2][0]).toEqual({
      action: "review-uncertain-acknowledged",
      itemkey: "ABC",
      libraryURI: "library",
    });
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([]);
  });

  it("does not clear an uncertain journal when Saver has lost its pending queue", async () => {
    const zotero = (globalThis as any).Zotero;
    const saved = [
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "review-sync",
        state: "in-flight",
      },
    ];
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify(saved));
    mocks.post.mockResolvedValue({ success: true });
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    await processReviewRequests();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(saved);
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-uncertain",
      itemkey: "ABC",
      libraryURI: "library",
    });
  });

  it("retains the journal when a failure acknowledgement loses its response", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(false);
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [{ itemkey: "ABC", libraryURI: "library" }],
        pending: [],
      }),
    });
    mocks.post
      .mockResolvedValueOnce({ connectionError: true, error: "response lost" })
      .mockResolvedValueOnce({ success: true });
    await processReviewRequests();
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["review-failed", "review-uncertain"]);
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
  });

  it("fails closed if the durable journal is corrupt or cannot be flushed", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Prefs.set("extensions.test.reviewJournal", "corrupt");
    await expect(processReviewRequests()).rejects.toThrow(
      "Invalid review journal",
    );
    expect(zotero.HTTP.request).not.toHaveBeenCalled();
    zotero.Prefs.set("extensions.test.reviewJournal", "[]");
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [{ itemkey: "ABC", libraryURI: "library" }],
        pending: [],
      }),
    });
    (globalThis as any).Services.prefs.savePrefFile.mockImplementation(() => {
      throw new Error("disk error");
    });
    await expect(processReviewRequests()).rejects.toThrow("disk error");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("retries a timed-out prepare-only sync without journaling or reporting uncertainty", async () => {
    const zotero = (globalThis as any).Zotero;
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    mocks.post.mockResolvedValue({
      connectionError: true,
      error: "response lost",
    });
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([]);
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["sync"]);
    expect(
      mocks.notice.mock.calls.some(([message]: any[]) =>
        message.includes("Could not prepare automatic sync"),
      ),
    ).toBe(true);
    stopAutoSync();
    now.mockReturnValue(20000);
    await syncExistingNotesOnce();
    now.mockReturnValue(24000);
    await syncExistingNotesOnce();
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["sync", "sync"]);
    now.mockRestore();
  });

  it("does not repeat locally moved attachments after their completion response is lost", async () => {
    const zotero = (globalThis as any).Zotero;
    const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    const candidate = {
      baseDirectory: "C:\\vault",
      attachments: [
        {
          itemkey: "ATT1",
          mode: "linked",
          basename: "paper.pdf",
          sourcePath: "C:\\old\\paper.pdf",
          destinationPath: "C:\\vault\\renamed.pdf",
          resolution: "move",
          conflict: false,
          identical: false,
          sourceMtime: 1,
        },
      ],
      linkNoteFiles: [],
    };
    mocks.payload.mockResolvedValue({
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
      linkedAttachmentBaseDirectory: candidate.baseDirectory,
      linkedAttachmentBaseDirectoryValidated: true,
    });
    mocks.moveAttachments.mockResolvedValue({
      moved: [{ itemkey: "ATT1", from: "old", to: "new" }],
      linked: [],
    });
    const request = {
      itemkey: "ABC",
      libraryURI: "library",
      operation: "attachment-move",
      attachmentMove: candidate,
      strategy: "zotero",
    };
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [request],
        pending: [],
      }),
    });
    mocks.post
      .mockResolvedValueOnce({ connectionError: true, error: "response lost" })
      .mockResolvedValue({ success: true });
    await processReviewRequests();
    stopAutoSync();
    await processReviewRequests();
    expect(mocks.moveAttachments).toHaveBeenCalledOnce();
    expect(mocks.post.mock.calls.map(([entry]: any[]) => entry.action)).toEqual(
      ["attachment-move-complete", "review-uncertain", "review-uncertain"],
    );
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
  });

  it("retains uncertainty if a successful review cannot be durably cleared", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: "ABC",
      isRegularItem: () => true,
      reload: vi.fn(),
    });
    zotero.HTTP.request.mockResolvedValueOnce({
      responseText: JSON.stringify({
        success: true,
        requests: [
          { itemkey: "ABC", libraryURI: "library", operation: "library-uri" },
        ],
        pending: [],
      }),
    });
    (globalThis as any).Services.prefs.savePrefFile
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("disk error");
      });
    mocks.post
      .mockResolvedValueOnce({ results: [{ status: "updated" }] })
      .mockResolvedValueOnce({ success: true });
    await processReviewRequests();
    expect(mocks.post.mock.calls.map(([entry]: any[]) => entry.action)).toEqual(
      ["bulk-library-uri", "review-uncertain"],
    );
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
  });

  it.each(["in-flight", "ack-pending"])(
    "gates automatic sync at startup while the journal is %s, before the review poll",
    async (state) => {
      const zotero = (globalThis as any).Zotero;
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([
          {
            itemkey: "ABC",
            libraryURI: "library",
            operation: "review-sync",
            state,
          },
        ]),
      );
      stopAutoSync();
      const now = vi.spyOn(Date, "now").mockReturnValue(10000);
      await syncExistingNotesOnce();
      now.mockReturnValue(15000);
      await syncExistingNotesOnce();
      expect(mocks.post).not.toHaveBeenCalled();
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal"))[0].state,
      ).toBe(state);
      now.mockRestore();
    },
  );

  it("rechecks the journal immediately before posting an automatic sync", async () => {
    const zotero = (globalThis as any).Zotero;
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    let release!: () => void;
    mocks.addCheck.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = syncExistingNotesOnce();
    await vi.waitFor(() => expect(mocks.addCheck).toHaveBeenCalledOnce());
    zotero.Prefs.set(
      "extensions.test.reviewJournal",
      JSON.stringify([
        {
          itemkey: "ABC",
          libraryURI: "library",
          operation: "review-sync",
          state: "in-flight",
        },
      ]),
    );
    release();
    await running;
    expect(mocks.post).not.toHaveBeenCalled();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
    now.mockRestore();
  });

  it("continues automatic sync for other identities when one is journaled", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Prefs.set(
      "extensions.test.reviewJournal",
      JSON.stringify([
        {
          itemkey: "ABC",
          libraryURI: "library",
          operation: "review-sync",
          state: "ack-pending",
        },
      ]),
    );
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          { itemkey: "OTHER", libraryURI: "library", citekey: "old" },
        ],
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_library: number, key: string) => ({
        key,
        isRegularItem: () => true,
      }),
    );
    mocks.payload.mockImplementation(async (item: any) => ({
      itemkey: item.key,
      libraryURI: "library",
      citekey: "new",
    }));
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.post.mock.calls[0][0]).toMatchObject({
      action: "sync",
      data: [{ itemkey: "OTHER" }],
    });
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "review-sync",
        state: "ack-pending",
      },
    ]);
    now.mockRestore();
  });

  it.each([
    ["HTTP 500", { success: false, error: "HTTP 500", outcomeUnknown: true }],
    [
      "malformed JSON",
      { success: false, error: "Invalid JSON response", outcomeUnknown: true },
    ],
    ["missing result", { success: true, results: [] }],
    ["null result", { success: true, results: [null] }],
  ])(
    "retains the review journal for %s without reporting a note failure",
    async (_label, response) => {
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
            pending: [],
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
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce({ success: true });
      await processReviewRequests();
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual(["review-sync", "review-uncertain"]);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toHaveLength(1);
    },
  );

  it.each(["empty", "unreadable", "initialization failure"])(
    "stops startup before network access when the journal is %s",
    async (problem) => {
      const zotero = (globalThis as any).Zotero;
      if (problem === "empty")
        zotero.Prefs.set("extensions.test.reviewJournal", "");
      if (problem === "unreadable")
        zotero.Prefs.get = () => {
          throw new Error("preference read failed");
        };
      if (problem === "initialization failure") {
        zotero.Prefs.set("extensions.test.reviewJournal", undefined);
        (globalThis as any).Services.prefs.savePrefFile.mockImplementation(
          () => {
            throw new Error("preference flush failed");
          },
        );
      }
      await expect(syncExistingNotesOnce()).rejects.toThrow(/review journal/);
      await expect(processReviewRequests()).rejects.toThrow(/review journal/);
      expect(zotero.HTTP.request).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    },
  );

  it("clears the journal and safely retries a review when the read-only identities GET times out", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: "ABC",
      isRegularItem: () => true,
      reload: vi.fn(),
    });
    const queue = {
      success: true,
      requests: [{ itemkey: "ABC", libraryURI: "library" }],
      pending: [],
    };
    zotero.HTTP.request
      .mockResolvedValueOnce({ responseText: JSON.stringify(queue) })
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValueOnce({ responseText: JSON.stringify(queue) })
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          identities: [
            { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          ],
        }),
      });
    await processReviewRequests();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([]);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(
      mocks.notice.mock.calls.some(([message]: any[]) =>
        message.includes("Could not contact Obsidian"),
      ),
    ).toBe(true);
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.post.mock.calls[0][0].action).toBe("review-sync");
  });

  it("fails closed without reporting an uncertain review when the read-only GET journal cannot be cleared", async () => {
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
          pending: [],
        }),
      })
      .mockRejectedValueOnce(new Error("Request timed out"));
    (globalThis as any).Services.prefs.savePrefFile
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("disk error");
      });
    await expect(processReviewRequests()).rejects.toThrow(
      "Could not persist the completed review",
    );
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toHaveLength(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("journals only actionable batch items when an apply response is lost", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        identities: [
          { itemkey: "ABC", libraryURI: "library", citekey: "old" },
          { itemkey: "OTHER", libraryURI: "library", citekey: "old" },
        ],
      }),
    });
    zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
      async (_library: number, key: string) => ({
        key,
        isRegularItem: () => true,
      }),
    );
    mocks.payload.mockImplementation(async (item: any) => ({
      itemkey: item.key,
      libraryURI: "library",
      citekey: "new",
    }));
    mocks.post
      .mockResolvedValueOnce({
        results: [
          { citekey: "new", status: "skipped" },
          { citekey: "new", status: "prepared", token: "token" },
        ],
      })
      .mockResolvedValueOnce({
        connectionError: true,
        error: "apply response lost",
      })
      .mockResolvedValueOnce({ success: true });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    await syncExistingNotesOnce();
    now.mockReturnValue(13000);
    await syncExistingNotesOnce();
    expect(
      mocks.post.mock.calls.map(([request]: any[]) => request.action),
    ).toEqual(["sync", "apply-sync", "review-uncertain"]);
    expect(mocks.post.mock.calls[2][0]).toMatchObject({ itemkey: "OTHER" });
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toMatchObject([{ itemkey: "OTHER", state: "in-flight" }]);
    now.mockRestore();
  });

  it("logs each retained incident without a popup while re-reporting on every poll", async () => {
    const zotero = (globalThis as any).Zotero;
    const entry = {
      itemkey: "ABC",
      libraryURI: "library",
      operation: "review-sync",
      state: "in-flight",
    };
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify([entry]));
    mocks.post.mockResolvedValue({ success: true });
    const empty = { success: true, requests: [], pending: [] };
    zotero.HTTP.request
      .mockResolvedValueOnce({ responseText: JSON.stringify(empty) })
      .mockResolvedValueOnce({ responseText: JSON.stringify(empty) })
      .mockResolvedValueOnce({
        responseText: JSON.stringify({
          ...empty,
          acknowledgedUncertain: [{ itemkey: "ABC", libraryURI: "library" }],
        }),
      })
      .mockResolvedValueOnce({ responseText: JSON.stringify(empty) });
    await processReviewRequests();
    await processReviewRequests();
    expect(
      mocks.post.mock.calls.filter(
        ([request]: any[]) => request.action === "review-uncertain",
      ),
    ).toHaveLength(2);
    expect(
      zotero.logError.mock.calls.filter(([message]: any[]) =>
        String(message).includes("outcome of the review"),
      ),
    ).toHaveLength(1);
    await processReviewRequests();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual([]);
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify([entry]));
    await processReviewRequests();
    expect(
      zotero.logError.mock.calls.filter(([message]: any[]) =>
        String(message).includes("outcome of the review"),
      ),
    ).toHaveLength(2);
    expect(
      mocks.notice.mock.calls.filter(([message]: any[]) =>
        String(message).includes("outcome of the review"),
      ),
    ).toHaveLength(0);
  });

  it("reports multiple uncertainty-report failures once while keeping every item blocked", async () => {
    const zotero = (globalThis as any).Zotero;
    const entries = ["ABC", "DEF", "GHI"].map((itemkey) => ({
      itemkey,
      libraryURI: "library",
      operation: "attachment-move",
      state: "in-flight",
    }));
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify(entries));
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    mocks.post.mockResolvedValue({
      success: false,
      error: "server unavailable",
    });
    await processReviewRequests();
    await processReviewRequests();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(entries);
    expect(
      mocks.post.mock.calls.filter(
        ([request]: any[]) => request.action === "review-uncertain",
      ),
    ).toHaveLength(6);
    expect(
      zotero.logError.mock.calls.filter(([message]: any[]) =>
        String(message).includes("Could not report uncertain review"),
      ),
    ).toHaveLength(3);
    expect(
      mocks.notice.mock.calls.filter(([message]: any[]) =>
        String(message).includes("Could not report interrupted reviews"),
      ),
    ).toHaveLength(1);
    expect(
      mocks.post.mock.calls.every(
        ([request]: any[]) => request.action === "review-uncertain",
      ),
    ).toBe(true);
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    mocks.post.mockResolvedValue({
      success: false,
      error: "server unavailable",
    });
    await processReviewRequests();
    expect(
      mocks.notice.mock.calls.filter(([message]: any[]) =>
        String(message).includes("Could not report interrupted reviews"),
      ),
    ).toHaveLength(2);
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(entries);
  });
});
