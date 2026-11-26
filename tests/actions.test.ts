import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  showAlert: vi.fn(),
  showNotice: vi.fn(),
  getMainWindow: vi.fn(() => ({ focus: vi.fn() })),
  postToObsidian: vi.fn(),
  ensureObsidianConnection: vi.fn(),
  getItemPayload: vi.fn(),
  getNoteIdentities: vi.fn(),
  findNoteIdentity: vi.fn(),
  addCitationKeyCheck: vi.fn(),
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
vi.mock("../src/utils/progressNotice", () => ({
  showNotice: mocks.showNotice,
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  ensureObsidianConnection: mocks.ensureObsidianConnection,
  postToObsidian: mocks.postToObsidian,
}));
vi.mock("../src/modules/obsidianPayload", () => ({
  getItemPayload: mocks.getItemPayload,
}));
vi.mock("../src/modules/citationKeyCheck", () => ({
  getNoteIdentities: mocks.getNoteIdentities,
  findNoteIdentity: mocks.findNoteIdentity,
  addCitationKeyCheck: mocks.addCitationKeyCheck,
  checkCitationKey: vi.fn(),
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
  updateLitNotes,
  regularItems,
  copyItemKeys,
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
    mocks.addCitationKeyCheck.mockReset();
    (globalThis as any).Zotero = {
      BetterBibTeX: {},
      logError: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      Prefs: { get: vi.fn(), set: vi.fn() },
    };
    (globalThis as any).addon = {
      data: { config: { prefsPrefix: "extensions.zotero.zoteroobsidian" } },
    };
    mocks.getMainWindow.mockReturnValue({ focus: vi.fn() });
    mocks.showNotice.mockReturnValue(true);
    mocks.getObsidianTagName.mockReturnValue("obsLitNote");
    mocks.ensureObsidianConnection.mockResolvedValue({ ready: true });
    mocks.getNoteIdentities.mockResolvedValue([]);
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

  describe("copyItemKeys", () => {
    it("copies regular items' keys, one per line", () => {
      const addText = vi.fn().mockReturnThis();
      const copy = vi.fn();
      (globalThis as any).addon.data.ztoolkit = {
        Clipboard: vi.fn(function () {
          return { addText, copy };
        }),
      };
      copyItemKeys([
        { ...mkItem("a"), key: "J77PYLT4" },
        { ...mkItem("b", false), key: "ATTACH01" },
        { ...mkItem("c"), key: "RY5DLRZZ" },
      ]);
      expect(addText).toHaveBeenCalledWith(
        "J77PYLT4\nRY5DLRZZ",
        "text/unicode",
      );
      expect(copy).toHaveBeenCalled();
      expect(mocks.showNotice).toHaveBeenCalledWith(
        "Copied 2 Zotero item keys",
      );
    });
  });

  it("sends metadata updates in one batch and reports missing notes", async () => {
    mocks.postToObsidian.mockResolvedValue({
      success: true,
      results: [{ citekey: "a", status: "missing" }],
    });
    await updateLitNotes([mkItem("a")]);
    expect(mocks.postToObsidian).toHaveBeenCalledWith({
      action: "update",
      data: [{ citekey: "a", title: "Title a" }],
    });
    expect(mocks.showAlert.mock.calls[0][2]).toContain(
      "literature note not found",
    );
  });

  it("checks the note citation key before sending a manual update", async () => {
    const item = mkItem("a");
    const identity = { itemkey: "ABC", citekey: "note" };
    mocks.getNoteIdentities.mockResolvedValue([identity]);
    mocks.findNoteIdentity.mockReturnValue(identity);
    mocks.addCitationKeyCheck.mockImplementation(
      async (_item: any, payload: any) => {
        payload.citationKeyCheck = { citekey: "note", matches: [] };
      },
    );
    mocks.postToObsidian.mockResolvedValue({
      success: true,
      results: [{ citekey: "a", status: "missing" }],
    });
    await updateLitNotes([item]);
    expect(mocks.addCitationKeyCheck).toHaveBeenCalledWith(
      item,
      expect.anything(),
      identity,
    );
    expect(
      mocks.postToObsidian.mock.calls[0][0].data[0].citationKeyCheck,
    ).toEqual({ citekey: "note", matches: [] });
  });

  it("recommends BBT once across create and open without blocking either", async () => {
    const zotero = (globalThis as any).Zotero;
    delete zotero.BetterBibTeX;
    let shown = false;
    zotero.Prefs.get.mockImplementation(() => shown);
    zotero.Prefs.set.mockImplementation(() => {
      shown = true;
    });
    mocks.postToObsidian.mockResolvedValue({ success: true, results: [] });

    await createLitNotes([mkItem("a")]);
    await openLitNote([mkItem("a")]);

    expect(mocks.showNotice).toHaveBeenCalledOnce();
    expect(mocks.showNotice.mock.calls[0][0]).toContain(
      "Better BibTeX is not active",
    );
    expect(zotero.Prefs.set).toHaveBeenCalledWith(
      "extensions.zotero.zoteroobsidian.betterBibTeXNoticeShown",
      true,
      true,
    );
    expect(mocks.postToObsidian).toHaveBeenCalledTimes(2);
  });

  it("does not consume the BBT notice if it could not be displayed", async () => {
    const zotero = (globalThis as any).Zotero;
    delete zotero.BetterBibTeX;
    mocks.showNotice.mockReturnValue(false);
    mocks.postToObsidian.mockResolvedValue({ success: true, results: [] });

    await openLitNote([mkItem("a")]);

    expect(mocks.showNotice).toHaveBeenCalledOnce();
    expect(zotero.Prefs.set).not.toHaveBeenCalled();
    expect(mocks.postToObsidian).toHaveBeenCalledOnce();
  });

  it("does not recommend BBT when it is active", async () => {
    mocks.postToObsidian.mockResolvedValue({ success: true, results: [] });
    await createLitNotes([mkItem("a")]);
    expect(mocks.showNotice).not.toHaveBeenCalled();
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

    it("reconciles has-note indicators across the library after creating a note", async () => {
      mocks.postToObsidian.mockResolvedValue({
        success: true,
        results: [{ citekey: "a", status: "created" }],
      });

      await createLitNotes([mkItem("a")]);

      expect(mocks.syncObsidianTags).toHaveBeenCalledOnce();
      expect(mocks.syncObsidianTags).toHaveBeenCalledWith(
        (globalThis as any).addon,
      );
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
      expect(mocks.syncObsidianTags).not.toHaveBeenCalled();
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
