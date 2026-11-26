import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  post: vi.fn(),
  payload: vi.fn(),
  attachments: vi.fn(),
  notice: vi.fn(),
  addCheck: vi.fn(),
  report: vi.fn(),
  closeReport: vi.fn(),
  moveAttachments: vi.fn(),
  syncRecovery: vi.fn(),
  dismissNotice: vi.fn(),
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  isObsidianServerReady: mocks.ready,
  postToObsidian: mocks.post,
}));
vi.mock("../src/modules/obsidianPayload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/obsidianPayload")>()),
  getSyncPayload: mocks.payload,
  getAttachments: mocks.attachments,
}));
vi.mock("../src/modules/citationKeyCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/citationKeyCheck")>()),
  addCitationKeyCheck: mocks.addCheck,
}));
vi.mock("../src/modules/attachmentMover", () => ({
  moveReviewedAttachments: mocks.moveAttachments,
}));
vi.mock("../src/modules/attachmentSyncRecovery", () => ({
  recoverAttachmentSyncState: mocks.syncRecovery,
}));
vi.mock("../src/modules/attachmentBaseMonitor", () => ({
  getAttachmentBaseValidationState: () => "valid",
  getValidatedAttachmentBaseDirectory: () =>
    (globalThis as any).Zotero.Prefs.get("baseAttachmentPath"),
}));
vi.mock("../src/modules/noteMatchReport", () => ({
  showNoteMatchReport: mocks.report,
  closeNoteMatchReport: mocks.closeReport,
}));
vi.mock("../src/utils/progressNotice", () => ({
  showNotice: mocks.notice,
  showDismissibleNotice: mocks.notice,
}));
vi.mock("../src/utils/locale", () => ({
  getString: () => "Zotero Obsidian Companion is ready",
}));

import {
  processReviewRequests,
  startAutoSync,
  stopAutoSync,
  syncExistingNotesOnce,
} from "../src/modules/autoSync";

describe("automatic note reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncRecovery.mockResolvedValue(undefined);
    mocks.notice.mockReturnValue(mocks.dismissNotice);
    mocks.attachments.mockReset();
    mocks.attachments.mockReturnValue([]);
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
  it.each([false, true])(
    "preflights and completes automatic attachment reconciliation without a review (missing source: %s)",
    async (missingSource) => {
      const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
      (
        globalThis as any
      ).Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
      const candidate = {
        baseDirectory: "C:\\vault",
        automatic: true,
        attachments: [
          {
            itemkey: "ATT",
            mode: "linked",
            basename: "paper.pdf",
            sourcePath: "C:\\storage\\paper.pdf",
            destinationPath: "C:\\vault\\paper.pdf",
            resolution: "keep-note",
            conflict: true,
            identical: false,
            ...(missingSource ? { sourceMissing: true } : { sourceMtime: 1 }),
            destinationMtime: 2,
          },
        ],
        linkNoteFiles: [],
      };
      const payload = {
        itemkey: "ABC",
        libraryURI: "library",
        citekey: "new",
        automaticAttachments: true,
        linkedAttachmentBaseDirectory: candidate.baseDirectory,
        linkedAttachmentBaseDirectoryValidated: true,
      };
      mocks.payload.mockResolvedValue(payload);
      const moved = [
        {
          itemkey: "ATT",
          from: candidate.attachments[0].sourcePath,
          to: candidate.attachments[0].destinationPath,
          newKey: "ATT",
          ...(missingSource
            ? { sourceMissing: true }
            : { preservedSource: true }),
        },
      ];
      mocks.moveAttachments.mockImplementation(
        async (_item, _candidate, _base, _strategy, onMutation) => {
          onMutation();
          const journal = JSON.parse(
            (globalThis as any).Zotero.Prefs.get(
              "extensions.test.reviewJournal",
            ),
          );
          expect(journal[0].attachmentPaths).toEqual([
            {
              itemkey: "ATT",
              sourcePath: candidate.attachments[0].sourcePath,
              destinationPath: candidate.attachments[0].destinationPath,
            },
          ]);
          return { moved, linked: [] };
        },
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "attachment-auto-prepare"
          ? { success: true }
          : { success: true, results: [{ citekey: "new", status: "updated" }] },
      );
      (globalThis as any).Zotero.HTTP.request.mockResolvedValueOnce({
        responseText: JSON.stringify({
          success: true,
          requests: [
            {
              itemkey: "ABC",
              libraryURI: "library",
              operation: "attachment-move",
              automaticAttachment: true,
              attachmentMove: candidate,
              strategy: "newest",
            },
          ],
          pending: [],
        }),
      });
      await processReviewRequests();
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual(["attachment-auto-prepare", "attachment-move-complete"]);
      expect(mocks.moveAttachments).toHaveBeenCalledWith(
        item,
        candidate,
        candidate.baseDirectory,
        "newest",
        expect.any(Function),
        true,
        expect.any(Function),
      );
      expect(mocks.post).toHaveBeenCalledWith({
        action: "attachment-move-complete",
        data: [payload],
        moved,
        linked: [],
      });
      expect(
        JSON.parse(
          (globalThis as any).Zotero.Prefs.get("extensions.test.reviewJournal"),
        ),
      ).toEqual([]);
    },
  );

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
      false,
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
    "copies an interrupted attachment without repeating the old move; lost completion: %s",
    async (lost) => {
      const zotero = (globalThis as any).Zotero;
      const item = { key: "ABC", isRegularItem: () => true, reload: vi.fn() };
      zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
      const original = {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "attachment-move",
        state: "in-flight",
      };
      const other = {
        itemkey: "OTHER",
        libraryURI: "library",
        operation: "attachment-move",
        state: "in-flight",
      };
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([original, other]),
      );
      const candidate = {
        baseDirectory: "C:\\vault",
        attachments: [
          {
            itemkey: "ATT",
            mode: "stored",
            basename: "paper.pdf",
            sourcePath: "C:\\storage\\paper.pdf",
            destinationPath: "C:\\vault\\paper.pdf",
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
          itemkey: "ATT",
          from: candidate.attachments[0].sourcePath,
          to: candidate.attachments[0].destinationPath,
          newKey: "NEW",
          preservedSource: true,
          copied: true,
        },
      ];
      mocks.moveAttachments.mockImplementation(
        async (
          _item: unknown,
          _candidate: unknown,
          _base: unknown,
          _strategy: unknown,
          onMutation: () => void,
        ) => {
          onMutation();
          const journal = JSON.parse(
            zotero.Prefs.get("extensions.test.reviewJournal"),
          );
          expect(
            journal.find((entry: any) => entry.itemkey === "ABC").repairPaths,
          ).toEqual([
            {
              itemkey: "ATT",
              sourcePath: candidate.attachments[0].sourcePath,
              destinationPath: candidate.attachments[0].destinationPath,
            },
          ]);
          return { moved, linked: [] };
        },
      );
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "attachment-repair-prepare")
          return { success: true, attachmentMove: candidate };
        if (request.action === "attachment-repair-complete")
          return lost
            ? { connectionError: true, error: "connection lost" }
            : { success: true, results: [{ status: "updated" }] };
        return { success: true };
      });
      zotero.HTTP.request.mockResolvedValue({
        responseText: JSON.stringify({
          success: true,
          requests: [
            {
              itemkey: "ABC",
              libraryURI: "library",
              operation: "attachment-repair",
              repairId: "attempt-1",
            },
          ],
          pending: [{ itemkey: "ABC", libraryURI: "library", uncertain: true }],
        }),
      });
      await processReviewRequests();
      expect(mocks.moveAttachments).toHaveBeenCalledWith(
        item,
        candidate,
        candidate.baseDirectory,
        "zotero",
        expect.any(Function),
        true,
        expect.any(Function),
      );
      const remaining = JSON.parse(
        zotero.Prefs.get("extensions.test.reviewJournal"),
      );
      expect(remaining.find((entry: any) => entry.itemkey === "OTHER")).toEqual(
        other,
      );
      if (lost) {
        expect(
          remaining.find((entry: any) => entry.itemkey === "ABC"),
        ).toMatchObject({ state: "in-flight", repairAttempt: "attempt-1" });
        await processReviewRequests();
        expect(mocks.moveAttachments).toHaveBeenCalledTimes(1);
      } else {
        expect(
          remaining.find((entry: any) => entry.itemkey === "ABC"),
        ).toBeUndefined();
        expect(mocks.post).toHaveBeenCalledWith({
          action: "review-uncertain-acknowledged",
          itemkey: "ABC",
          libraryURI: "library",
        });
      }
    },
  );

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
          operation: "attachment-move",
          attachments: [],
          attachmentPaths: [
            {
              itemkey: "ATT1",
              sourcePath: "C:\\old\\paper.pdf",
              destinationPath: "C:\\vault\\paper.pdf",
            },
          ],
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
          operation: "attachment-move",
          attachments: [],
          attachmentPaths: [
            {
              itemkey: "ATT1",
              sourcePath: "C:\\old\\paper.pdf",
              destinationPath: "C:\\vault\\paper.pdf",
            },
          ],
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

  it.each([undefined, "note-update"] as const)(
    "handles duplicate-note review requests without choosing a citation key (%s)",
    async (operation) => {
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
              {
                itemkey: "ABC",
                libraryURI: "library",
                ...(operation ? { operation } : {}),
              },
            ],
            pending: [{ itemkey: "ABC", libraryURI: "library" }],
          }),
        })
        .mockResolvedValueOnce({
          responseText: JSON.stringify({
            success: true,
            identities: [
              { itemkey: "ABC", libraryURI: "library", citekey: "first" },
              { itemkey: "ABC", libraryURI: "library", citekey: "second" },
            ],
          }),
        });
      mocks.post.mockImplementation(async (payload) =>
        payload.action === "review-sync"
          ? {
              results: [
                {
                  status: "pending-review",
                },
              ],
            }
          : { success: true },
      );

      await processReviewRequests();

      if (operation) {
        expect(mocks.post).toHaveBeenCalledOnce();
        expect(mocks.post.mock.calls[0][0]).toEqual({
          action: "review-failed",
          itemkey: "ABC",
          libraryURI: "library",
          operation,
          error:
            "Bulk note updates require exactly one matching Obsidian note.",
        });
      } else {
        expect(mocks.post.mock.calls[0][0]).toEqual({
          action: "review-sync",
          data: [expect.objectContaining({ itemkey: "ABC", citekey: "new" })],
        });
        expect(mocks.post).toHaveBeenCalledOnce();
        expect(mocks.notice).not.toHaveBeenCalled();
      }
      expect(mocks.addCheck).not.toHaveBeenCalled();
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
    },
  );

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

  it("does not rediscover a cleared pending review during the session", async () => {
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
    expect(mocks.post).toHaveBeenCalledTimes(1);
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
      operation: "review-sync",
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

  it("reports the recorded action and Zotero title without retrying the update", async () => {
    const zotero = (globalThis as any).Zotero;
    const entries = [
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "attachment-move",
        state: "in-flight",
      },
    ];
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify(entries));
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      isRegularItem: () => true,
      getField: (field: string) => (field === "title" ? "A useful paper" : ""),
    });
    mocks.attachments.mockReturnValue([
      {
        itemkey: "A",
        isFile: true,
        mode: "stored",
        path: "C:\\storage\\a.pdf",
      },
      { itemkey: "B", isFile: true, mode: "linked", path: "C:\\vault\\b.pdf" },
      { itemkey: "URL", isFile: false, mode: "url" },
    ]);
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-uncertain",
      itemkey: "ABC",
      libraryURI: "library",
      operation: "attachment-move",
      title: "A useful paper",
      attachments: [
        {
          itemkey: "A",
          isFile: true,
          mode: "stored",
          path: "C:\\storage\\a.pdf",
        },
        {
          itemkey: "B",
          isFile: true,
          mode: "linked",
          path: "C:\\vault\\b.pdf",
        },
      ],
    });
    expect(mocks.moveAttachments).not.toHaveBeenCalled();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(entries);
  });

  it("reports attachment inspection errors without retrying or clearing the review", async () => {
    const zotero = (globalThis as any).Zotero;
    const entries = [
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "attachment-move",
        state: "in-flight",
      },
    ];
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify(entries));
    mocks.attachments.mockImplementation(() => {
      throw new Error("attachment list unavailable");
    });
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review-uncertain",
        itemkey: "ABC",
        attachmentCheckError: "attachment list unavailable",
      }),
    );
    expect(mocks.moveAttachments).not.toHaveBeenCalled();
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(entries);
  });

  it("still reports an uncertain action when its title lookup fails", async () => {
    const zotero = (globalThis as any).Zotero;
    const entries = [
      {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "attachment-move",
        state: "in-flight",
      },
    ];
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify(entries));
    zotero.Items.getByLibraryAndKeyAsync.mockRejectedValue(
      new Error("Title unavailable"),
    );
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "review-uncertain",
      itemkey: "ABC",
      libraryURI: "library",
      operation: "attachment-move",
      attachmentCheckError: "Title unavailable",
    });
    expect(zotero.logError).toHaveBeenCalledWith(
      expect.stringContaining("Title unavailable"),
    );
    expect(
      JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
    ).toEqual(entries);
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
      operation: "review-sync",
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
  function startupRecoveryFixture() {
    const zotero = (globalThis as any).Zotero;
    const entry = {
      itemkey: "ABC",
      libraryURI: "library",
      operation: "attachment-move",
      state: "in-flight",
    };
    const item = {
      key: "ABC",
      id: 12,
      libraryID: 1,
      isRegularItem: () => true,
      reload: vi.fn(),
    };
    const payload = {
      title: "Paper",
      itemkey: "ABC",
      libraryURI: "library",
      citekey: "new",
      attachments: [
        {
          itemkey: "ATT",
          isFile: true,
          mode: "stored",
          path: "C:\\storage\\paper.pdf",
        },
      ],
    };
    zotero.Prefs.set("extensions.test.reviewJournal", JSON.stringify([entry]));
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    mocks.payload.mockResolvedValue(payload);
    zotero.HTTP.request.mockImplementation(
      async (_method: string, url: string) => ({
        responseText: JSON.stringify(
          url.includes("identities")
            ? {
                success: true,
                identities: [
                  { itemkey: "ABC", libraryURI: "library", citekey: "new" },
                ],
              }
            : { success: true, requests: [], pending: [] },
        ),
      }),
    );
    return { zotero, entry, item, payload };
  }
  it("pauses startup checks while preserving recovery, manual checks and resuming", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, payload } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.pauseAutomaticChecks", true);
      let rescan = "";
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    { itemkey: "ABC", libraryURI: "library", citekey: "new" },
                  ],
                }
              : { success: true, requests: [], pending: [], rescan },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover")
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        if (request.action === "sync")
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.post).toHaveBeenCalledWith({
        action: "review-recover",
        data: [payload],
      });
      expect(mocks.post).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "initial-review-scan-start",
          preserveExisting: true,
        }),
      );
      expect(mocks.post).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "initial-review-scan-end",
          status: "paused",
        }),
      );
      expect(
        zotero.HTTP.request.mock.calls.some(([, url]: any[]) =>
          url.includes("identities"),
        ),
      ).toBe(false);
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "sync",
        ),
      ).toBe(false);

      rescan = "manual-1";
      await vi.advanceTimersByTimeAsync(9000);
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "sync",
        ),
      ).toBe(true);
      expect(
        mocks.post.mock.calls
          .filter(
            ([request]: any[]) => request.action === "initial-review-scan-end",
          )
          .at(-1)?.[0].status,
      ).toBe("paused");

      zotero.Prefs.set("extensions.test.pauseAutomaticChecks", false);
      await vi.advanceTimersByTimeAsync(9000);
      expect(
        mocks.post.mock.calls
          .filter(
            ([request]: any[]) => request.action === "initial-review-scan-end",
          )
          .at(-1)?.[0].status,
      ).toBe("complete");
      zotero.Prefs.set("extensions.test.pauseAutomaticChecks", true);
      await vi.advanceTimersByTimeAsync(6000);
      expect(
        mocks.post.mock.calls
          .filter(
            ([request]: any[]) => request.action === "initial-review-scan-end",
          )
          .at(-1)?.[0].status,
      ).toBe("paused");
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("finishes an in-flight check before applying the pause", async () => {
    vi.useFakeTimers();
    try {
      const { zotero } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? { success: true, results: [{ status: "skipped", citekey: "new" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      zotero.Prefs.set("extensions.test.pauseAutomaticChecks", true);
      await vi.advanceTimersByTimeAsync(10000);
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "sync",
        ),
      ).toBe(true);
      expect(
        mocks.post.mock.calls
          .filter(
            ([request]: any[]) => request.action === "initial-review-scan-end",
          )
          .map(([request]: any[]) => request.status),
      ).toEqual(["complete", "paused"]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("keeps the automatic attachment journal until recovered work is resumed, even after restart", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry, payload } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.pauseAutomaticChecks", true);
      const paths = [
        {
          itemkey: "ATT",
          sourcePath: "C:\\storage\\paper.pdf",
          destinationPath: "C:\\vault\\paper.pdf",
        },
      ];
      const automatic = {
        ...entry,
        operation: "auto-attachment",
        attachmentPaths: paths,
      };
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([automatic]),
      );
      Object.assign(payload, {
        automaticAttachments: true,
        linkedAttachmentBaseDirectory: "C:\\vault",
        linkedAttachmentBaseDirectoryValidated: true,
      });
      const candidate = {
        baseDirectory: "C:\\vault",
        automatic: true,
        attachments: [
          {
            itemkey: "ATT",
            mode: "linked",
            basename: "paper.pdf",
            sourcePath: paths[0].sourcePath,
            destinationPath: paths[0].destinationPath,
            resolution: "keep-note",
            conflict: true,
            identical: false,
            sourceMtime: 1,
            destinationMtime: 2,
          },
        ],
        linkNoteFiles: [],
      };
      let available = false;
      let rescan = "";
      let finished = false;
      let lostResponse = false;
      zotero.HTTP.request.mockImplementation(async () => ({
        responseText: JSON.stringify({
          success: true,
          requests: available
            ? [
                {
                  itemkey: "ABC",
                  libraryURI: "library",
                  operation: "attachment-move",
                  automaticAttachment: true,
                  attachmentMove: candidate,
                  strategy: "newest",
                },
              ]
            : [],
          pending: [],
          rescan,
        }),
      }));
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover") {
          if (!lostResponse) {
            lostResponse = true;
            throw new Error("Lost recovery response");
          }
          return {
            success: true,
            results: [
              {
                status: "pending-review",
                citekey: "new",
                automaticRecoveryPending: true,
              },
            ],
          };
        }
        if (
          request.action === "initial-review-scan-start" &&
          rescan &&
          !finished
        )
          return {
            success: false,
            retryable: true,
            initialReviewScan: { scanId: "previous", status: "paused" },
            error: "A Zotero review update is still running",
          };
        if (request.action === "attachment-move-complete")
          return {
            success: true,
            results: [{ status: "updated", citekey: "new" }],
          };
        return { success: true };
      });
      mocks.moveAttachments.mockImplementation(
        async (_item, _candidate, _base, _strategy, onMutation) => {
          onMutation();
          finished = true;
          available = false;
          return {
            moved: [
              {
                itemkey: "ATT",
                from: paths[0].sourcePath,
                to: paths[0].destinationPath,
              },
            ],
            linked: [],
          };
        },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([automatic]);
      expect(
        mocks.post.mock.calls.filter(
          ([request]: any[]) => request.action === "review-recover",
        ).length,
      ).toBeGreaterThan(1);
      stopAutoSync();
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([automatic]);
      available = true;
      rescan = "manual-while-recovering";
      await vi.advanceTimersByTimeAsync(10000);
      expect(mocks.moveAttachments).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("retains interrupted automatic attachment paths for recovery without requesting a review", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry, payload } = startupRecoveryFixture();
      const paths = [
        {
          itemkey: "ATT",
          sourcePath: "C:\\storage\\paper.pdf",
          destinationPath: "C:\\vault\\paper.pdf",
        },
      ];
      const automatic = {
        ...entry,
        operation: "auto-attachment",
        attachmentPaths: paths,
      };
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([automatic]),
      );
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover")
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        if (request.action === "sync")
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.post).toHaveBeenCalledWith({
        action: "review-recover",
        data: [payload],
        automaticAttachmentPaths: paths,
      });
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "review-uncertain",
        ),
      ).toBe(false);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("defers an invalid attachment base without turning it into an interrupted review", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry } = startupRecoveryFixture();
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover")
          return {
            success: false,
            results: [
              {
                status: "attachment-error",
                citekey: "new",
                error: "Invalid base",
              },
            ],
          };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "review-uncertain",
        ),
      ).toBe(false);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([entry]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it.each(["skipped", "pending-review"])(
    "recovers %s before the startup scan and rechecks the item",
    async (status) => {
      vi.useFakeTimers();
      try {
        const { zotero, payload } = startupRecoveryFixture();
        mocks.post.mockImplementation(async (request: any) => {
          if (request.action === "review-recover")
            return { success: true, results: [{ status, citekey: "new" }] };
          if (request.action === "sync")
            return {
              success: true,
              results: [{ citekey: "new", status: "skipped" }],
            };
          return { success: true };
        });
        startAutoSync();
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.post).toHaveBeenCalledWith({
          action: "review-recover",
          data: [payload],
        });
        expect(
          mocks.post.mock.calls.map(([request]: any[]) => request.action),
        ).toEqual([
          "initial-review-scan-start",
          "review-recover",
          "sync",
          "initial-review-scan-end",
        ]);
        expect(
          JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
        ).toEqual([]);
      } finally {
        stopAutoSync();
        vi.useRealTimers();
      }
    },
  );

  it("starts a new scan when Obsidian requests a recheck after the scan finished", async () => {
    vi.useFakeTimers();
    try {
      const { zotero } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      const state: { rescan?: string } = {};
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    { itemkey: "ABC", libraryURI: "library", citekey: "new" },
                  ],
                }
              : {
                  success: true,
                  requests: [],
                  pending: [],
                  rescan: state.rescan,
                },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? { success: true, results: [{ citekey: "new", status: "skipped" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      const starts = () =>
        mocks.post.mock.calls
          .map(([request]: any[]) => request)
          .filter(
            (request: any) => request.action === "initial-review-scan-start",
          );
      expect(starts()).toHaveLength(1);
      state.rescan = "r1";
      await vi.advanceTimersByTimeAsync(8000);
      expect(starts()).toHaveLength(2);
      expect(starts()[1].scanId).not.toBe(starts()[0].scanId);
      await vi.advanceTimersByTimeAsync(8000);
      expect(starts()).toHaveLength(2);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("resends items with already-reported reviews when a recheck starts", async () => {
    vi.useFakeTimers();
    try {
      const { zotero } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      const state: { rescan?: string } = {};
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    { itemkey: "ABC", libraryURI: "library", citekey: "new" },
                  ],
                }
              : {
                  success: true,
                  requests: [],
                  pending: [],
                  rescan: state.rescan,
                },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? {
              success: true,
              results: [{ citekey: "new", status: "pending-review" }],
            }
          : { success: true },
      );
      const syncs = () =>
        mocks.post.mock.calls.filter(
          ([request]: any[]) => request.action === "sync",
        );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(8000);
      expect(syncs()).toHaveLength(1);
      state.rescan = "r1";
      await vi.advanceTimersByTimeAsync(8000);
      expect(syncs()).toHaveLength(2);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("starts a new scan when a restarted Obsidian reports a new session", async () => {
    vi.useFakeTimers();
    try {
      const { zotero } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      const state = { session: "s1" };
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    { itemkey: "ABC", libraryURI: "library", citekey: "new" },
                  ],
                }
              : {
                  success: true,
                  requests: [],
                  pending: [],
                  obsidianSession: state.session,
                },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? { success: true, results: [{ citekey: "new", status: "skipped" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(8000);
      const starts = () =>
        mocks.post.mock.calls.filter(
          ([request]: any[]) => request.action === "initial-review-scan-start",
        );
      expect(starts()).toHaveLength(1);
      state.session = "s2";
      await vi.advanceTimersByTimeAsync(8000);
      expect(starts()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(8000);
      expect(starts()).toHaveLength(2);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("moves a merged note's Zotero item to the trash and reports the result", async () => {
    const zotero = (globalThis as any).Zotero;
    const item = {
      key: "OLD",
      deleted: false,
      isRegularItem: () => true,
      saveTx: vi.fn(),
    };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    const request = {
      id: '["library","OLD"]',
      itemkey: "OLD",
      libraryURI: "library",
      title: "Old",
    };
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [],
        pending: [],
        itemTrash: [request],
      }),
    });
    mocks.post.mockResolvedValue({ success: true });
    await processReviewRequests();
    expect(item.deleted).toBe(true);
    expect(item.saveTx).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "item-trash-complete",
      id: request.id,
    });
    // A repeated request for an item already in the trash is reported as done without saving again.
    await processReviewRequests();
    expect(item.saveTx).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "item-trash-complete",
      id: request.id,
    });
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: "OLD",
      deleted: false,
      isRegularItem: () => false,
      saveTx: vi.fn(),
    });
    await processReviewRequests();
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "item-trash-complete",
      id: request.id,
      error: "It is not a regular Zotero item.",
    });
  });

  it.each(["error", "waiting-index", "unknown", "transport"])(
    "retains and reports uncertainty when recovery returns %s",
    async (status) => {
      vi.useFakeTimers();
      try {
        const { zotero, entry } = startupRecoveryFixture();
        mocks.post.mockImplementation(async (request: any) => {
          if (request.action === "review-recover")
            return status === "transport"
              ? { connectionError: true, error: "offline" }
              : {
                  success: status !== "error",
                  results: [{ status, citekey: "new" }],
                };
          return { success: true };
        });
        startAutoSync();
        await vi.advanceTimersByTimeAsync(1500);
        expect(
          JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
        ).toEqual([entry]);
        expect(mocks.post).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "review-uncertain",
            itemkey: "ABC",
          }),
        );
        expect(zotero.logError).toHaveBeenCalledWith(
          expect.stringContaining("Could not recover interrupted review"),
        );
      } finally {
        stopAutoSync();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "missing attachment path",
    "deleted during request",
    "replaced during request",
    "changed payload",
    "changed journal",
  ])("does not clear a recovery with %s", async (scenario) => {
    vi.useFakeTimers();
    try {
      const { zotero, entry, item, payload } = startupRecoveryFixture();
      if (scenario === "missing attachment path")
        payload.attachments[0].path = "";
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover") {
          if (scenario === "deleted during request")
            Object.assign(item, { deleted: true });
          if (scenario === "replaced during request")
            zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
              ...item,
              id: 99,
            });
          if (scenario === "changed payload")
            mocks.payload.mockResolvedValue({ ...payload, citekey: "changed" });
          if (scenario === "changed journal")
            zotero.Prefs.set(
              "extensions.test.reviewJournal",
              JSON.stringify([{ ...entry, operation: "note-update" }]),
            );
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        }
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      const journal = JSON.parse(
        zotero.Prefs.get("extensions.test.reviewJournal"),
      );
      expect(journal).toHaveLength(1);
      expect(journal[0].operation).toBe(
        scenario === "changed journal" ? "note-update" : entry.operation,
      );
      if (scenario === "missing attachment path")
        expect(
          mocks.post.mock.calls.some(
            ([request]: any[]) => request.action === "review-recover",
          ),
        ).toBe(false);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("rechecks an identity recovered after it was already scanned", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      let syncs = 0;
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "sync") {
          if (++syncs === 1)
            zotero.Prefs.set(
              "extensions.test.reviewJournal",
              JSON.stringify([entry]),
            );
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        }
        if (request.action === "review-recover")
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(12000);
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual([
        "initial-review-scan-start",
        "sync",
        "review-recover",
        "sync",
        "initial-review-scan-end",
      ]);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("retains and reports the review if clearing the durable journal fails", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry } = startupRecoveryFixture();
      (globalThis as any).Services.prefs.savePrefFile.mockImplementationOnce(
        () => {
          throw new Error("disk failure");
        },
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "review-recover"
          ? { success: true, results: [{ status: "skipped", citekey: "new" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([entry]);
      expect(mocks.post).toHaveBeenCalledWith(
        expect.objectContaining({ action: "review-uncertain" }),
      );
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("does not consume an acknowledgement while recovery is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry } = startupRecoveryFixture();
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-recover") {
          await waiting;
          return {
            success: true,
            results: [{ status: "skipped", citekey: "new" }],
          };
        }
        return { success: true };
      });
      zotero.HTTP.request.mockResolvedValue({
        responseText: JSON.stringify({
          success: true,
          requests: [],
          pending: [],
          acknowledgedUncertain: [{ itemkey: "ABC", libraryURI: "library" }],
        }),
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      await processReviewRequests();
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([entry]);
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) =>
            request.action === "review-uncertain-acknowledged",
        ),
      ).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "publishes normal reviews without touching sync-cache recovery (Zotero syncing: %s)",
    async (syncing) => {
      vi.useFakeTimers();
      try {
        const { zotero, payload } = startupRecoveryFixture();
        zotero.Prefs.set("extensions.test.reviewJournal", "[]");
        zotero.Sync = { Runner: { syncInProgress: syncing } };
        mocks.syncRecovery.mockRejectedValue(
          new Error(
            "Attachment sync recovery waits until Zotero sync is idle.",
          ),
        );
        mocks.post.mockImplementation(async (request: any) =>
          request.action === "sync"
            ? {
                success: true,
                results: [
                  { citekey: payload.citekey, status: "pending-review" },
                ],
              }
            : { success: true },
        );
        startAutoSync();
        await vi.advanceTimersByTimeAsync(15000);
        expect(mocks.post).toHaveBeenCalledWith({
          action: "sync",
          data: [payload],
        });
        expect(mocks.post).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "initial-review-scan-end",
            status: "complete",
          }),
        );
        expect(mocks.syncRecovery).not.toHaveBeenCalled();
        expect(
          mocks.notice.mock.calls.some(
            ([, options]) => options?.type === "fail",
          ),
        ).toBe(false);
      } finally {
        stopAutoSync();
        vi.useRealTimers();
      }
    },
  );

  it("replaces a failed startup notice with readiness only after the scan succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, payload } = startupRecoveryFixture();
      zotero.Prefs.set("extensions.test.reviewJournal", "[]");
      let starts = 0;
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "initial-review-scan-start" && ++starts === 1)
          throw new Error("Temporary connection failure");
        return request.action === "sync"
          ? {
              success: true,
              results: [{ citekey: payload.citekey, status: "pending-review" }],
            }
          : { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mocks.notice).toHaveBeenCalledWith(
        expect.stringContaining("Temporary connection failure"),
        expect.objectContaining({ type: "fail" }),
      );
      expect(mocks.notice).not.toHaveBeenCalledWith(
        "Zotero Obsidian Companion is ready",
      );
      await vi.advanceTimersByTimeAsync(15000);
      expect(mocks.dismissNotice).toHaveBeenCalled();
      expect(mocks.notice).toHaveBeenLastCalledWith(
        "Zotero Obsidian Companion is ready",
      );
      const end = mocks.post.mock.calls.findIndex(
        ([request]) =>
          request.action === "initial-review-scan-end" &&
          request.status === "complete",
      );
      expect(end).toBeGreaterThan(-1);
      expect(mocks.post.mock.invocationCallOrder[end]).toBeLessThan(
        mocks.notice.mock.invocationCallOrder.at(-1)!,
      );
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("uses the existing handshake for acknowledgement-pending entries", async () => {
    vi.useFakeTimers();
    try {
      const { zotero, entry } = startupRecoveryFixture();
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([{ ...entry, state: "ack-pending" }]),
      );
      mocks.post.mockResolvedValue({ success: true });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mocks.post).toHaveBeenCalledWith({
        action: "review-uncertain-acknowledged",
        itemkey: "ABC",
        libraryURI: "library",
      });
      expect(
        mocks.post.mock.calls.some(
          ([request]: any[]) => request.action === "review-recover",
        ),
      ).toBe(false);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("waits for Obsidian, reports the journal before publishing, and keeps polling without rescanning", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      const entry = {
        itemkey: "ABC",
        libraryURI: "library",
        operation: "review-sync",
        state: "in-flight",
      };
      zotero.Prefs.set(
        "extensions.test.reviewJournal",
        JSON.stringify([entry]),
      );
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? { success: true, identities: [] }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      mocks.ready.mockResolvedValue(false);
      mocks.post.mockResolvedValue({ success: true });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(4500);
      expect(mocks.post).not.toHaveBeenCalled();
      expect(zotero.HTTP.request).not.toHaveBeenCalled();
      mocks.ready.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(3000);
      const actions = mocks.post.mock.calls.map(
        ([request]: any[]) => request.action,
      );
      expect(actions).toEqual([
        "initial-review-scan-start",
        "review-uncertain",
        "initial-review-scan-end",
      ]);
      const start = mocks.post.mock.calls[0][0];
      expect(start.scanId).toEqual(expect.any(String));
      expect(mocks.post.mock.calls[2][0]).toEqual({
        action: "initial-review-scan-end",
        scanId: start.scanId,
        status: "complete",
      });
      await vi.advanceTimersByTimeAsync(12000);
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual(actions);
      expect(
        zotero.HTTP.request.mock.calls.filter(([, url]: any[]) =>
          url.includes("identities"),
        ),
      ).toHaveLength(1);
      expect(
        zotero.HTTP.request.mock.calls.filter(([, url]: any[]) =>
          url.includes("review-requests"),
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("retries failed journal reporting with the same scan ID before publishing", async () => {
    vi.useFakeTimers();
    try {
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
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? { success: true, identities: [] }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      let failed = false;
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "review-uncertain" && !failed) {
          failed = true;
          return { success: false, error: "offline" };
        }
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      const first = mocks.post.mock.calls.map(([request]: any[]) => request);
      expect(first.map((request: any) => request.action)).toEqual([
        "initial-review-scan-start",
        "review-uncertain",
        "initial-review-scan-end",
      ]);
      expect(first[2]).toMatchObject({
        status: "error",
        error: expect.any(String),
        scanId: first[0].scanId,
      });
      await vi.advanceTimersByTimeAsync(3000);
      const calls = mocks.post.mock.calls.map(([request]: any[]) => request);
      expect(calls.slice(3).map((request: any) => request.action)).toEqual([
        "initial-review-scan-start",
        "review-uncertain",
        "initial-review-scan-end",
      ]);
      expect(calls[3].scanId).toBe(first[0].scanId);
      expect(calls[5]).toMatchObject({
        scanId: first[0].scanId,
        status: "complete",
      });
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("retries a lost completion acknowledgement without running the scan again", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? { success: true, identities: [] }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      let endings = 0;
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "initial-review-scan-end" && ++endings === 1)
          return { outcomeUnknown: true, error: "response lost" };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(4500);
      const calls = mocks.post.mock.calls.map(([request]: any[]) => request);
      expect(calls.map((request: any) => request.action)).toEqual([
        "initial-review-scan-start",
        "initial-review-scan-end",
        "initial-review-scan-end",
      ]);
      expect(calls[2]).toEqual(calls[1]);
      expect(
        zotero.HTTP.request.mock.calls.filter(([, url]: any[]) =>
          url.includes("identities"),
        ),
      ).toHaveLength(1);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });
  it.each([-1, 0, 1])(
    "finishes the initial check when two notes share a Zotero identity (legacy index: %s)",
    async (legacyIndex) => {
      vi.useFakeTimers();
      try {
        const zotero = (globalThis as any).Zotero;
        zotero.HTTP.request.mockImplementation(
          async (_method: string, url: string) => ({
            responseText: JSON.stringify(
              url.includes("identities")
                ? {
                    success: true,
                    identities: ["one.md", "two.md"].map((notePath, index) => ({
                      itemkey: "ABC",
                      ...(index === legacyIndex
                        ? {}
                        : { libraryURI: "library" }),
                      citekey: "old",
                      notePath,
                    })),
                  }
                : { success: true, requests: [], pending: [] },
            ),
          }),
        );
        mocks.post.mockImplementation(async (request: any) =>
          request.action === "sync"
            ? { results: [{ citekey: "new", status: "pending-review" }] }
            : { success: true },
        );
        startAutoSync();
        await vi.advanceTimersByTimeAsync(15000);
        const calls = mocks.post.mock.calls.map(([request]: any[]) => request);
        expect(
          calls.filter((request: any) => request.action === "sync"),
        ).toHaveLength(1);
        expect(
          calls.find((request: any) => request.action === "sync").data,
        ).toHaveLength(1);
        expect(calls.at(-1)).toMatchObject({
          action: "initial-review-scan-end",
          status: "complete",
        });
      } finally {
        stopAutoSync();
        vi.useRealTimers();
      }
    },
  );

  it("retries failed items without resubmitting successful identities", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: ["ABC", "DEF"].map((itemkey) => ({
                    itemkey,
                    libraryURI: "library",
                    citekey: "old",
                  })),
                }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
        async (_id: number, key: string) => ({
          key,
          isRegularItem: () => true,
        }),
      );
      let failures = 0;
      mocks.payload.mockImplementation(async (item: any) => {
        if (item.key === "DEF" && failures++ < 2)
          throw new Error("item unavailable");
        return { itemkey: item.key, libraryURI: "library", citekey: "new" };
      });
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? {
              results: request.data.map(() => ({
                citekey: "new",
                status: "updated",
              })),
            }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(20000);
      const batches = mocks.post.mock.calls
        .map(([request]: any[]) => request)
        .filter((request: any) => request.action === "sync");
      expect(
        batches.map((request: any) =>
          request.data.map((item: any) => item.itemkey),
        ),
      ).toEqual([["ABC"], ["DEF"]]);
      const endings = mocks.post.mock.calls
        .map(([request]: any[]) => request)
        .filter((request: any) => request.action === "initial-review-scan-end");
      expect(endings.some((request: any) => request.status === "error")).toBe(
        true,
      );
      expect(endings.at(-1).status).toBe("complete");
      await vi.advanceTimersByTimeAsync(10000);
      expect(
        mocks.post.mock.calls.filter(
          ([request]: any[]) => request.action === "sync",
        ),
      ).toHaveLength(2);
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });
  it("retries a lost start response without reporting or scanning early", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? { success: true, identities: [] }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      let starts = 0;
      mocks.post.mockImplementation(async (request: any) => {
        if (request.action === "initial-review-scan-start" && ++starts === 1)
          return { outcomeUnknown: true, error: "response lost" };
        return { success: true };
      });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      expect(zotero.HTTP.request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      const calls = mocks.post.mock.calls.map(([request]: any[]) => request);
      expect(calls.map((request: any) => request.action)).toEqual([
        "initial-review-scan-start",
        "initial-review-scan-start",
        "initial-review-scan-end",
      ]);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toMatchObject({
        scanId: calls[0].scanId,
        status: "complete",
      });
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });
  it("publishes other reviews while reporting an item with no citation key", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: ["ABC", "DEF"].map((itemkey) => ({
                    itemkey,
                    libraryURI: "library",
                    citekey: "old",
                    notePath: `${itemkey}.md`,
                  })),
                }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      zotero.Items.getByLibraryAndKeyAsync.mockImplementation(
        async (_id: number, key: string) => ({
          key,
          isRegularItem: () => true,
        }),
      );
      mocks.payload.mockImplementation(async (item: any) => ({
        itemkey: item.key,
        libraryURI: "library",
        citekey: item.key === "ABC" ? "" : "new",
      }));
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? {
              results: request.data.map(() => ({
                citekey: "new",
                status: "pending-review",
              })),
            }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(6000);
      expect(mocks.report).toHaveBeenLastCalledWith([
        expect.objectContaining({
          itemkey: "ABC",
          notePath: "ABC.md",
          kind: "missing-citekey",
        }),
      ]);
      const calls = mocks.post.mock.calls.map(([request]: any[]) => request);
      expect(
        calls
          .filter((request: any) => request.action === "sync")
          .map((request: any) => request.data.map((item: any) => item.itemkey)),
      ).toEqual([["DEF"]]);
      expect(calls.at(-1)).toMatchObject({
        action: "initial-review-scan-end",
        status: "complete",
      });
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });

  it("waits through lost Obsidian connectivity and resumes the unfinished scan", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    { itemkey: "ABC", libraryURI: "library", citekey: "old" },
                  ],
                }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? { results: [{ citekey: "new", status: "updated" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      mocks.ready.mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(6000);
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual(["initial-review-scan-start"]);
      mocks.ready.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(6000);
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toEqual([
        "initial-review-scan-start",
        "sync",
        "initial-review-scan-end",
      ]);
      expect(mocks.post.mock.calls.at(-1)![0]).toMatchObject({
        status: "complete",
      });
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });
  it.each([
    [
      "initial-review-scan-start",
      {
        success: false,
        error: "different session",
        initialReviewScan: { scanId: "previous", status: "pending" },
      },
    ],
    [
      "initial-review-scan-end",
      {
        success: false,
        error: "unknown session",
        initialReviewScan: { scanId: "new", status: "pending" },
      },
    ],
    [
      "initial-review-scan-end",
      { success: false, error: "no active scan", initialReviewScan: null },
    ],
    [
      "initial-review-scan-end",
      { success: false, error: "HTTP 409: scan session mismatch" },
    ],
  ])(
    "stops automatic scan retries on a session rejection from %s and keeps polling existing reviews",
    async (rejectedAction, rejection) => {
      vi.useFakeTimers();
      try {
        const zotero = (globalThis as any).Zotero;
        zotero.HTTP.request.mockImplementation(
          async (_method: string, url: string) => ({
            responseText: JSON.stringify(
              url.includes("identities")
                ? { success: true, identities: [] }
                : { success: true, requests: [], pending: [] },
            ),
          }),
        );
        mocks.post.mockImplementation(async (request: any) =>
          request.action === rejectedAction ? rejection : { success: true },
        );
        startAutoSync();
        await vi.advanceTimersByTimeAsync(1500);
        const initial = mocks.post.mock.calls.map(
          ([request]: any[]) => request.action,
        );
        expect(initial.at(-1)).toBe(rejectedAction);
        expect(mocks.notice).toHaveBeenCalledWith(
          expect.stringContaining("Restart both applications"),
          expect.any(Object),
        );
        await vi.advanceTimersByTimeAsync(12000);
        expect(
          mocks.post.mock.calls.map(([request]: any[]) => request.action),
        ).toEqual(initial);
        expect(
          zotero.HTTP.request.mock.calls.filter(([, url]: any[]) =>
            url.includes("review-requests"),
          ).length,
        ).toBeGreaterThan(0);
      } finally {
        stopAutoSync();
        vi.useRealTimers();
      }
    },
  );
  it("repairs an interrupted Windows attachment through real payload, copy, link, and journal code", async () => {
    const zotero = (globalThis as any).Zotero;
    const base = "C:\\Vault\\Attachments";
    const source = "C:\\Zotero\\storage\\ABCD1234\\paper.pdf";
    const destination = `${base}\\paper.pdf`;
    const files = new Map<string, { content: string; mtime: number }>([
      [source, { content: "fixture PDF", mtime: 1234 }],
    ]);
    const directories = new Set([base, path.win32.dirname(source)]);
    const pathsSeen: string[] = [];
    (globalThis as any).PathUtils = {
      filename: (value: string) => {
        pathsSeen.push(value);
        if (!path.win32.isAbsolute(value))
          throw new Error(
            "PathUtils.filename: Could not initialize path: NS_ERROR_FILE_UNRECOGNIZED_PATH",
          );
        return path.win32.basename(value);
      },
      join: path.win32.join,
      parent: path.win32.dirname,
      isAbsolute: path.win32.isAbsolute,
    };
    const original = {
      id: 2,
      key: "ATT",
      parentItemID: 1,
      libraryID: 1,
      attachmentLinkMode: 0,
      attachmentPath: "storage:paper.pdf",
      dateAdded: "2024-01-01",
      getField: (field: string) => (field === "title" ? "Paper" : ""),
      getFilePath: () =>
        original.attachmentLinkMode === 2 ? original.attachmentPath : source,
      getFilePathAsync: async () => original.getFilePath(),
      isFileAttachment: () => true,
      isLinkedFileAttachment: () => original.attachmentLinkMode === 2,
      isStoredFileAttachment: () => original.attachmentLinkMode === 0,
      eraseTx: vi.fn(),
      saveTx: vi.fn(),
      getRelations: () => ({}),
      clone: vi.fn(() => clone),
    };
    const attached = [2];
    const clone = {
      id: 3,
      key: "NEW",
      setRelations: vi.fn(),
      parentItemID: 1,
      libraryID: 1,
      attachmentLinkMode: 0,
      attachmentPath: "",
      dateAdded: "",
      getField: (field: string) => (field === "title" ? "Paper" : ""),
      getFilePath() {
        return this.attachmentPath;
      },
      getFilePathAsync() {
        return Promise.resolve(this.attachmentPath);
      },
      isFileAttachment: () => true,
      isLinkedFileAttachment: () => true,
      save: vi.fn(async () => {
        attached.push(3);
      }),
      eraseTx: vi.fn(),
    };
    const item = {
      id: 1,
      key: "ABC",
      libraryID: 1,
      isRegularItem: () => true,
      reload: vi.fn(),
      getField: (field: string) =>
        field === "citationKey" ? "Cite2024" : "Paper",
      getAttachments: () => attached,
      getNotes: () => [],
    };
    zotero.Prefs.set("baseAttachmentPath", base);
    zotero.Prefs.set(
      "extensions.test.reviewJournal",
      JSON.stringify([
        {
          itemkey: "ABC",
          libraryURI: "library",
          operation: "attachment-move",
          state: "in-flight",
        },
      ]),
    );
    zotero.Libraries.get = () => ({ name: "My Library", libraryType: "user" });
    zotero.Attachments = {
      LINK_MODE_LINKED_FILE: 2,
      LINK_MODE_IMPORTED_FILE: 0,
      LINK_MODE_IMPORTED_URL: 1,
      BASE_PATH_PLACEHOLDER: "attachments:",
      getFileBaseNameFromItem: () => "Paper",
    };
    zotero.DataDirectory = { dir: "C:\\Zotero" };
    zotero.Items.get = (id: number | number[]) =>
      Array.isArray(id)
        ? []
        : id === 1
          ? item
          : id === 2
            ? original
            : id === 3
              ? clone
              : undefined;
    zotero.Items.getAll = vi.fn(async () => [original]);
    zotero.Items.moveChildItems = vi.fn();
    zotero.Items.trash = vi.fn(async () => {
      attached.splice(attached.indexOf(2), 1);
    });
    zotero.URI.getItemURI = (entry: { key: string }) => entry.key;
    zotero.Relations = { getByObject: vi.fn(async () => []) };
    zotero.Fulltext = { queueItem: vi.fn() };
    zotero.Notes = { replaceItemKey: vi.fn() };
    zotero.DB = {
      executeTransaction: async (run: () => Promise<void>) => run(),
    };
    zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    (globalThis as any).IOUtils = {
      makeDirectory: vi.fn(async (target: string) => {
        directories.add(target);
      }),
      exists: async (target: string) =>
        files.has(target) || directories.has(target),
      getChildren: async (target: string) =>
        [...files.keys()].filter((file) => path.win32.dirname(file) === target),
      stat: async (target: string) => {
        if (directories.has(target)) return { type: "directory" };
        const file = files.get(target);
        if (!file) throw new Error(`Missing fixture file: ${target}`);
        return {
          type: "regular",
          size: file.content.length,
          lastModified: file.mtime,
        };
      },
      computeHexDigest: async (target: string) => files.get(target)!.content,
      copy: vi.fn(
        async (from: string, to: string, options?: { recursive?: boolean }) => {
          const entry = JSON.parse(
            zotero.Prefs.get("extensions.test.reviewJournal"),
          )[0];
          expect(entry.repairAttempt).toBe("attempt-1");
          expect(entry.repairPaths).toEqual([
            {
              itemkey: "ATT",
              sourcePath: source,
              destinationPath: destination,
            },
          ]);
          if (options?.recursive) {
            directories.add(to);
            for (const [file, contents] of [...files]) {
              if (path.win32.dirname(file) === from)
                files.set(path.win32.join(to, path.win32.basename(file)), {
                  ...contents,
                });
            }
          } else files.set(to, { ...files.get(from)! });
        },
      ),
      setModificationTime: async (target: string, time: number) => {
        files.get(target)!.mtime = time;
      },
      move: async (from: string, to: string) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (target: string) => {
        files.delete(target);
      },
    };
    const candidate = {
      baseDirectory: base,
      attachments: [
        {
          itemkey: "ATT",
          mode: "stored",
          basename: "paper.pdf",
          sourcePath: source,
          destinationPath: destination,
          resolution: "move",
          conflict: false,
          identical: false,
          sourceMtime: 1234,
        },
      ],
      linkNoteFiles: [],
    };
    const actualPayload = await vi.importActual<
      typeof import("../src/modules/obsidianPayload")
    >("../src/modules/obsidianPayload");
    const actualMover = await vi.importActual<
      typeof import("../src/modules/attachmentMover")
    >("../src/modules/attachmentMover");
    mocks.payload.mockImplementation(actualPayload.getSyncPayload);
    mocks.moveAttachments.mockImplementation(
      actualMover.moveReviewedAttachments,
    );
    mocks.post.mockImplementation(async (request: any) => {
      if (request.action === "attachment-repair-prepare") {
        expect(request.data[0].attachments).toEqual([
          expect.objectContaining({
            itemkey: "ATT",
            path: source,
            mode: "stored",
          }),
        ]);
        return { success: true, attachmentMove: candidate };
      }
      if (request.action === "attachment-repair-complete") {
        expect(request.data[0].attachments).toEqual([
          expect.objectContaining({
            itemkey: "NEW",
            path: destination,
            mode: "linked",
          }),
        ]);
        return { success: true, results: [{ status: "updated" }] };
      }
      return { success: true };
    });
    zotero.HTTP.request.mockResolvedValue({
      responseText: JSON.stringify({
        success: true,
        requests: [
          {
            itemkey: "ABC",
            libraryURI: "library",
            operation: "attachment-repair",
            repairId: "attempt-1",
          },
        ],
        pending: [{ itemkey: "ABC", libraryURI: "library", uncertain: true }],
      }),
    });
    try {
      await processReviewRequests();
      expect(files.get(source)?.content).toBe("fixture PDF");
      expect(files.get(destination)?.content).toBe("fixture PDF");
      expect(
        files.get(
          "C:\\Zotero\\obsidian-companion-attachment-archive\\1\\ATT\\contents\\paper.pdf",
        )?.content,
      ).toBe("fixture PDF");
      expect(original.saveTx).not.toHaveBeenCalled();
      expect(clone.save).toHaveBeenCalledOnce();
      expect(zotero.Items.trash).toHaveBeenCalledWith([2]);
      expect(original.eraseTx).not.toHaveBeenCalled();
      expect(
        JSON.parse(zotero.Prefs.get("extensions.test.reviewJournal")),
      ).toEqual([]);
      expect(
        mocks.post.mock.calls.map(([request]: any[]) => request.action),
      ).toContain("attachment-repair-complete");
      expect(pathsSeen.length).toBeGreaterThan(0);
      expect(pathsSeen.every((value) => path.win32.isAbsolute(value))).toBe(
        true,
      );

      stopAutoSync();
      vi.useFakeTimers();
      mocks.post.mockClear();
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    {
                      itemkey: "ABC",
                      libraryURI: "library",
                      citekey: "Cite2024",
                    },
                  ],
                }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      mocks.post.mockImplementation(async (request: any) =>
        request.action === "sync"
          ? { results: [{ citekey: "Cite2024", status: "updated" }] }
          : { success: true },
      );
      startAutoSync();
      await vi.advanceTimersByTimeAsync(5000);
      const sync = mocks.post.mock.calls
        .map(([request]: any[]) => request)
        .find((request: any) => request.action === "sync");
      expect(sync.data[0].attachments).toEqual([
        expect.objectContaining({
          itemkey: "NEW",
          path: destination,
          mode: "linked",
        }),
      ]);
      expect((globalThis as any).IOUtils.copy).toHaveBeenCalledTimes(2);
      expect(original.eraseTx).not.toHaveBeenCalled();
    } finally {
      stopAutoSync();
      vi.useRealTimers();
      delete (globalThis as any).PathUtils;
      delete (globalThis as any).IOUtils;
    }
  });
  it("reports an invalid citation key without preventing the initial scan from completing", async () => {
    vi.useFakeTimers();
    try {
      const zotero = (globalThis as any).Zotero;
      const { CitationKeyValidationError } =
        await import("../src/modules/obsidianPayload");
      zotero.HTTP.request.mockImplementation(
        async (_method: string, url: string) => ({
          responseText: JSON.stringify(
            url.includes("identities")
              ? {
                  success: true,
                  identities: [
                    {
                      itemkey: "ABC",
                      libraryURI: "library",
                      citekey: "old",
                      notePath: "ABC.md",
                    },
                  ],
                }
              : { success: true, requests: [], pending: [] },
          ),
        }),
      );
      mocks.payload.mockRejectedValue(
        new CitationKeyValidationError("Invalid citation key"),
      );
      mocks.post.mockResolvedValue({ success: true });
      startAutoSync();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mocks.report).toHaveBeenLastCalledWith([
        expect.objectContaining({ itemkey: "ABC", kind: "invalid-citekey" }),
      ]);
      expect(mocks.post.mock.calls.at(-1)![0]).toMatchObject({
        action: "initial-review-scan-end",
        status: "complete",
      });
    } finally {
      stopAutoSync();
      vi.useRealTimers();
    }
  });
});
