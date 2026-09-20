import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  showAlert: vi.fn(),
  getMainWindow: vi.fn(() => ({ focus: vi.fn() })),
  postToObsidian: vi.fn(),
  ensureObsidianConnection: vi.fn(),
  getItemPayload: vi.fn(),
  getObsidianTagName: vi.fn(() => "obsLitNote"),
  syncObsidianTags: vi.fn(),
  regenBibtexKey: vi.fn(),
  toggleLeftPane: vi.fn(),
  toggleRightPane: vi.fn(),
}));

vi.mock("../src/utils/alert", () => ({
  getMainWindow: mocks.getMainWindow,
  showAlert: mocks.showAlert,
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  ensureObsidianConnection: mocks.ensureObsidianConnection,
  postToObsidian: mocks.postToObsidian,
}));
vi.mock("../src/modules/obsidianPayload", () => ({
  getItemPayload: mocks.getItemPayload,
}));
vi.mock("../src/modules/obsidianTagSync", () => ({
  getObsidianTagName: mocks.getObsidianTagName,
  syncObsidianTags: mocks.syncObsidianTags,
}));
vi.mock("../src/modules/regenBibtex", () => ({
  regenBibtexKey: mocks.regenBibtexKey,
}));
vi.mock("../src/utils/paneUtils", () => ({
  toggleLeftPane: mocks.toggleLeftPane,
  toggleRightPane: mocks.toggleRightPane,
}));

import {
  createLitNotes,
  openLitNote,
  regenerateCitationKeys,
  regularItems,
} from "../src/modules/actions";

const mkItem = (citekey: string, regular = true) => ({
  citekey,
  isRegularItem: () => regular,
  addTag: vi.fn(),
  saveTx: vi.fn().mockResolvedValue(undefined),
});

describe("actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = {
      logError: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      Prefs: { get: vi.fn() },
    };
    (globalThis as any).addon = {
      data: { config: { prefsPrefix: "extensions.zotero.zoteroobsidian" } },
    };
    mocks.getMainWindow.mockReturnValue({ focus: vi.fn() });
    mocks.getObsidianTagName.mockReturnValue("obsLitNote");
    mocks.ensureObsidianConnection.mockResolvedValue({ ready: true });
    mocks.getItemPayload.mockImplementation(async (item: any) => ({
      citekey: item.citekey,
      title: `Title ${item.citekey}`,
    }));
  });

  describe("regularItems", () => {
    it("keeps only regular items", () => {
      const regular = mkItem("a");
      const attachment = mkItem("b", false);
      expect(regularItems([regular, attachment])).toEqual([regular]);
    });
  });

  describe("createLitNotes", () => {
    it("sends one batched create request and tags every note that now exists", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: true,
        results: [
          { citekey: "a", status: "created" },
          { citekey: "b", status: "skipped" },
          { citekey: "c", status: "overwritten" },
        ],
      });

      const items = [mkItem("a"), mkItem("b"), mkItem("c")];
      await createLitNotes(items);

      expect(mocks.postToObsidian).toHaveBeenCalledTimes(1);
      const body = mocks.postToObsidian.mock.calls[0][0];
      expect(body.action).toBe("create");
      expect(body.data.map((p: any) => p.citekey)).toEqual(["a", "b", "c"]);

      expect(items[0].addTag).toHaveBeenCalledWith("obsLitNote");
      expect(items[1].addTag).not.toHaveBeenCalled();
      expect(items[2].addTag).toHaveBeenCalledWith("obsLitNote");
      expect(mocks.showAlert).not.toHaveBeenCalled();
    });

    it("reports error results in a single alert", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: false,
        results: [
          { citekey: "a", status: "error", error: "vault write failed" },
        ],
      });

      await createLitNotes([mkItem("a")]);

      expect(mocks.showAlert).toHaveBeenCalledTimes(1);
      expect(mocks.showAlert.mock.calls[0][2]).toContain("vault write failed");
    });

    it("surfaces a legacy { success:false, error } reply", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: false,
        error: "exists",
      });

      await createLitNotes([mkItem("a")]);

      expect(mocks.showAlert).toHaveBeenCalledTimes(1);
      expect(mocks.showAlert.mock.calls[0][2]).toContain("exists");
    });

    it("does not post when the connection is not ready", async () => {
      mocks.ensureObsidianConnection.mockResolvedValue({
        ready: false,
        error: "timeout",
      });

      await createLitNotes([mkItem("a")]);

      expect(mocks.postToObsidian).not.toHaveBeenCalled();
    });

    it("does nothing when there are no regular items", async () => {
      await createLitNotes([mkItem("a", false)]);
      expect(mocks.ensureObsidianConnection).not.toHaveBeenCalled();
      expect(mocks.postToObsidian).not.toHaveBeenCalled();
    });
  });

  describe("openLitNote", () => {
    it("sends one batched open request containing every payload", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: true,
        results: [
          { citekey: "a", status: "opened" },
          { citekey: "b", status: "missing" },
        ],
      });

      await openLitNote([mkItem("a"), mkItem("b")]);

      expect(mocks.postToObsidian).toHaveBeenCalledTimes(1);
      const body = mocks.postToObsidian.mock.calls[0][0];
      expect(body.action).toBe("open");
      expect(body.data.map((p: any) => p.citekey)).toEqual(["a", "b"]);
      expect(mocks.showAlert).not.toHaveBeenCalled();
    });

    it("alerts on error results only", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: false,
        results: [
          { citekey: "a", status: "missing" },
          { citekey: "b", status: "error", error: "boom" },
        ],
      });

      await openLitNote([mkItem("a"), mkItem("b")]);

      expect(mocks.showAlert).toHaveBeenCalledTimes(1);
      expect(mocks.showAlert.mock.calls[0][2]).toContain("boom");
    });
  });

  describe("regenerateCitationKeys", () => {
    it("delegates regular items to regenBibtexKey", async () => {
      const item = mkItem("a");
      await regenerateCitationKeys([item, mkItem("b", false)]);
      expect(mocks.regenBibtexKey).toHaveBeenCalledWith([item]);
    });
  });
});
