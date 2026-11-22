import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCitationKeyCheck,
  checkCitationKey,
  findNoteIdentity,
} from "../src/modules/citationKeyCheck";

function item(
  id: number,
  libraryID: number,
  key: string,
  citekey: string,
  title = key,
) {
  return {
    id,
    libraryID,
    key,
    isRegularItem: () => true,
    getField: (field: string) => (field === "citationKey" ? citekey : title),
  };
}

describe("citation-key duplicate checking", () => {
  const target = item(1, 1, "TARGET", "other");
  beforeEach(() => {
    (globalThis as any).Zotero = {
      Libraries: {
        getAll: () => [
          { libraryID: 1, libraryType: "user" },
          { libraryID: 2, libraryType: "group" },
        ],
      },
      URI: { getLibraryURI: (id: number) => `library-${id}` },
      Items: {
        getAll: vi.fn(async (id: number) => (id === 1 ? [target] : [])),
        loadDataTypes: vi.fn(),
      },
    };
  });

  it("excludes the current item and reports matching items from each library", async () => {
    const z = (globalThis as any).Zotero;
    z.Items.getAll.mockImplementation(async (id: number) =>
      id === 1
        ? [target, item(2, 1, "A", "note", "Same library")]
        : [item(3, 2, "B", "note", "Group item")],
    );
    expect((await checkCitationKey(target, "note")).matches).toEqual(
      expect.arrayContaining([
        {
          title: "Same library",
          citekey: "note",
          libraryURI: "library-1",
          itemkey: "A",
        },
        {
          title: "Group item",
          citekey: "note",
          libraryURI: "library-2",
          itemkey: "B",
        },
      ]),
    );
    expect((await checkCitationKey(target, "other")).matches).toEqual([]);
  });

  it("finds Better BibTeX shadow keys and case-insensitive matches", async () => {
    const z = (globalThis as any).Zotero;
    z.BetterBibTeX = {
      ready: Promise.resolve(),
      KeyManager: {
        started: true,
        get: (id: number) => (id === 2 ? { citationKey: "NOTE" } : undefined),
      },
    };
    z.Prefs = { get: () => true };
    z.Items.getAll
      .mockResolvedValueOnce([target, item(2, 1, "A", "")])
      .mockResolvedValueOnce([]);
    expect((await checkCitationKey(target, "note")).matches[0].citekey).toBe(
      "NOTE",
    );
  });

  it("surfaces a failed lookup rather than claiming there are no matches", async () => {
    const z = (globalThis as any).Zotero;
    z.Items.loadDataTypes.mockRejectedValue(new Error("unavailable"));
    await expect(checkCitationKey(target, "note")).rejects.toThrow(
      "unavailable",
    );
  });

  it("selects a unique note identity and checks its citation key", async () => {
    const payload = {
      title: "Work",
      citekey: "other",
      itemkey: "TARGET",
      libraryURI: "library-1",
    };
    const identity = findNoteIdentity(payload, [
      { itemkey: "TARGET", citekey: "note" },
    ]);
    await addCitationKeyCheck(target, payload, identity);
    expect(payload).toMatchObject({
      citationKeyCheck: { citekey: "note", matches: [] },
    });
    expect(
      findNoteIdentity(payload, [
        { itemkey: "TARGET", citekey: "one" },
        { itemkey: "TARGET", citekey: "two" },
      ]),
    ).toBeUndefined();
  });
});
