import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  payload: vi.fn(),
  key: vi.fn(),
  check: vi.fn(),
  attachmentPaths: vi.fn(),
}));
vi.mock("../src/modules/attachmentReferences", () => ({
  enumerateZoteroAttachmentPaths: mocks.attachmentPaths,
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  postToObsidian: mocks.post,
}));
vi.mock("../src/modules/obsidianPayload", () => ({
  getCiteKey: mocks.key,
  getSyncPayload: mocks.payload,
  getItemPayload: mocks.payload,
}));
vi.mock("../src/modules/citationKeyCheck", () => ({
  checkCitationKey: mocks.check,
}));
import { resolveNoteKeyChoices } from "../src/modules/resolveNoteKeys";

function fixture() {
  const item = {
    key: "ABC",
    libraryID: 1,
    citationKey: "zotero",
    attachments: [{ itemkey: "ATT1", path: "before.pdf" }],
    reload: vi.fn().mockResolvedValue(undefined),
    saveTx: vi.fn().mockResolvedValue(undefined),
    setField: vi.fn(function (this: any, _field: string, value: string) {
      this.citationKey = value;
    }),
  };
  const pair = {
    item,
    payload: {
      citekey: "zotero",
      itemkey: "ABC",
      libraryURI: "library",
      citationKeyCheck: { citekey: "note", matches: [] },
    },
  };
  return { item, pair };
}

describe("citation-key reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = {
      URI: { getLibraryURI: () => "library" },
      Promise: { delay: vi.fn().mockResolvedValue(undefined) },
    };
    mocks.key.mockImplementation(async (item: any) => item.citationKey);
    mocks.check.mockResolvedValue({ citekey: "note", matches: [] });
    mocks.payload.mockImplementation(async (item: any) => ({
      citekey: item.citationKey,
      itemkey: item.key,
      libraryURI: "library",
      attachments: item.attachments,
    }));
  });

  it("reports the original connection error instead of hiding it", async () => {
    const { pair } = fixture();
    await expect(
      resolveNoteKeyChoices("sync", [pair], { error: "Connection refused" }),
    ).rejects.toThrow("Connection refused");
  });

  it("rechecks the Zotero payload before applying a prepared note update", async () => {
    const { item, pair } = fixture();
    mocks.post.mockResolvedValue({
      results: [{ citekey: "zotero", status: "updated" }],
    });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [{ citekey: "zotero", status: "prepared", token: "token" }],
    });
    expect(result[0].status).toBe("updated");
    expect(item.setField).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "apply-sync",
      token: "token",
      data: [expect.objectContaining({ citekey: "zotero" })],
    });
  });

  it("checks Zotero file references before applying duplicate cleanup", async () => {
    const { pair } = fixture();
    mocks.attachmentPaths.mockResolvedValue(["C:\\vault\\survivor.pdf"]);
    mocks.post.mockResolvedValue({
      results: [{ citekey: "zotero", status: "updated" }],
    });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "prepared",
          token: "token",
          needsAttachmentCheck: true,
        },
      ],
    });
    expect(result[0].status).toBe("updated");
    expect(mocks.attachmentPaths).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply-sync",
        zoteroAttachmentPaths: ["C:\\vault\\survivor.pdf"],
      }),
    );
  });

  it("does not apply duplicate cleanup when Zotero references cannot be checked", async () => {
    const { pair } = fixture();
    mocks.attachmentPaths.mockRejectedValue(new Error("Library unavailable"));
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "prepared",
          token: "token",
          needsAttachmentCheck: true,
        },
      ],
    });
    expect(result[0].status).toBe("error");
    expect(result[0].error).toContain("Library unavailable");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("saves the chosen note key and waits for attachment changes before continuing", async () => {
    const { item, pair } = fixture();
    const delay = (globalThis as any).Zotero.Promise.delay;
    delay.mockImplementationOnce(async () => {
      item.attachments = [{ itemkey: "ATT1", path: "after.pdf" }];
    });
    mocks.post
      .mockResolvedValueOnce({
        results: [
          { citekey: "zotero", status: "skipped", noteCitekey: "note" },
        ],
      })
      .mockResolvedValueOnce({
        results: [{ citekey: "note", status: "prepared", token: "token" }],
      })
      .mockResolvedValueOnce({
        results: [{ citekey: "note", status: "updated" }],
      });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "verify-token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].status).toBe("updated");
    expect(item.setField).toHaveBeenCalledWith("citationKey", "note");
    expect(delay).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1][0].data[0].attachments).toEqual([
      { itemkey: "ATT1", path: "after.pdf" },
    ]);
    expect(mocks.post.mock.calls[1][0].data[0].zoteroChanges).toEqual({
      previousCitekey: "zotero",
      attachmentMoves: [
        { itemkey: "ATT1", from: "before.pdf", to: "after.pdf" },
      ],
    });
    expect(mocks.post.mock.calls[2][0].data[0].zoteroChanges).toEqual(
      mocks.post.mock.calls[1][0].data[0].zoteroChanges,
    );
    expect(mocks.post.mock.calls[2][0].action).toBe("apply-sync");
  });

  it("does not infer a move from attachments with different Zotero item keys", async () => {
    const { item, pair } = fixture();
    const delay = (globalThis as any).Zotero.Promise.delay;
    delay.mockImplementationOnce(async () => {
      item.attachments = [{ itemkey: "DIFFERENT", path: "after.pdf" }];
    });
    mocks.post
      .mockResolvedValueOnce({
        results: [{ status: "skipped", noteCitekey: "note" }],
      })
      .mockResolvedValueOnce({
        results: [{ status: "skipped", citekey: "note" }],
      });
    await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(
      mocks.post.mock.calls[1][0].data[0].zoteroChanges.attachmentMoves,
    ).toEqual([]);
  });

  it("does not overwrite a Zotero key changed while the user was deciding", async () => {
    const { item, pair } = fixture();
    item.citationKey = "changed";
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "verify-token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].status).toBe("error");
    expect(result[0].error).toContain("changed while the decision was pending");
    expect(item.setField).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not change Zotero if the selected note changed before validation", async () => {
    const { item, pair } = fixture();
    mocks.post.mockResolvedValueOnce({
      results: [
        { citekey: "zotero", status: "error", error: "The note changed" },
      ],
    });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].error).toContain("The note changed");
    expect(item.setField).not.toHaveBeenCalled();
  });

  it("does not save when another item starts using the citation key during validation", async () => {
    const { item, pair } = fixture();
    mocks.post.mockResolvedValueOnce({
      results: [{ citekey: "zotero", status: "skipped", noteCitekey: "note" }],
    });
    mocks.check
      .mockResolvedValueOnce({ citekey: "note", matches: [] })
      .mockResolvedValueOnce({
        citekey: "note",
        matches: [
          {
            title: "Other",
            citekey: "note",
            itemkey: "OTHER",
            libraryURI: "library",
          },
        ],
      });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].error).toContain("matches changed before saving");
    expect(item.setField).not.toHaveBeenCalled();
  });

  it("does not overwrite a Zotero citation key changed during the final duplicate check", async () => {
    const { item, pair } = fixture();
    mocks.post.mockResolvedValueOnce({
      results: [{ citekey: "zotero", status: "skipped", noteCitekey: "note" }],
    });
    mocks.check
      .mockResolvedValueOnce({ citekey: "note", matches: [] })
      .mockImplementationOnce(async () => {
        item.citationKey = "changed";
        return { citekey: "note", matches: [] };
      });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].error).toContain("changed before saving");
    expect(item.setField).not.toHaveBeenCalled();
  });

  it("does not proceed when Zotero does not retain the selected key", async () => {
    const { item, pair } = fixture();
    item.saveTx.mockImplementationOnce(async () => {
      item.citationKey = "regenerated";
    });
    mocks.post.mockResolvedValueOnce({
      results: [{ citekey: "zotero", status: "skipped", noteCitekey: "note" }],
    });
    const result = await resolveNoteKeyChoices("sync", [pair], {
      results: [
        {
          citekey: "zotero",
          status: "set-zotero-key",
          token: "verify-token",
          noteCitekey: "note",
          expectedZoteroKey: "zotero",
        },
      ],
    });
    expect(result[0].status).toBe("error");
    expect(result[0].error).toContain("did not retain");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
