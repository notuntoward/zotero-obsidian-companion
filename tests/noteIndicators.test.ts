import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ identities: vi.fn() }));
vi.mock("../src/modules/citationKeyCheck", () => ({
  getIndicatorIdentities: mocks.identities,
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  ensureObsidianConnection: vi.fn(),
}));
vi.mock("../src/utils/progressNotice", () => ({ showNotice: vi.fn() }));
vi.mock("../src/utils/locale", () => ({
  getString: () => "Obsidian literature note",
}));

import {
  indicatorForItem,
  refreshNoteIndicators,
  registerNoteIndicator,
  startNoteIndicators,
  stopNoteIndicators,
} from "../src/modules/noteIndicators";

const item = (libraryID: number, key: string) => ({
  libraryID,
  key,
  isRegularItem: () => true,
});

describe("literature note indicators", () => {
  let preferences: Map<string, string>;

  beforeEach(() => {
    stopNoteIndicators();
    vi.clearAllMocks();
    preferences = new Map([["test.indicatorColor", "#C99700"]]);
    (globalThis as any).addon = {
      data: { alive: true, config: { addonID: "test", prefsPrefix: "test" } },
    };
    (globalThis as any).Zotero = {
      Libraries: {
        getAll: () => [
          { libraryID: 1, libraryType: "user" },
          { libraryID: 2, libraryType: "group" },
        ],
      },
      URI: { getLibraryURI: (id: number) => `library-${id}` },
      ItemTreeManager: {
        registerColumn: vi.fn(() => "registered"),
        refreshColumns: vi.fn(),
      },
      Prefs: {
        get: vi.fn((key: string) => preferences.get(key)),
        set: vi.fn((key: string, value: string) => preferences.set(key, value)),
      },
      debug: vi.fn(),
    };
  });

  it("uses library and item identity and marks legacy or duplicate notes uncertain", async () => {
    mocks.identities.mockResolvedValue({
      identities: [
        { itemkey: "A", libraryURI: "library-1", citekey: "renamed" },
        { itemkey: "B", libraryURI: "library-1" },
        { itemkey: "B", libraryURI: "library-1" },
        { itemkey: "C" },
      ],
      unidentifiedNotes: 0,
    });
    expect(indicatorForItem(item(1, "A"))).toBe("unknown");
    await refreshNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("note");
    expect(indicatorForItem(item(2, "A"))).toBe("");
    expect(indicatorForItem(item(1, "B"))).toBe("uncertain");
    expect(indicatorForItem(item(2, "C"))).toBe("uncertain");
    expect(indicatorForItem(item(3, "A"))).toBe("unknown");
  });

  it("swaps a complete snapshot at once and shows stale matches after disconnection", async () => {
    mocks.identities.mockResolvedValueOnce({
      identities: [{ itemkey: "A", libraryURI: "library-1" }],
      unidentifiedNotes: 0,
    });
    await refreshNoteIndicators();
    let finish!: (value: unknown) => void;
    mocks.identities.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = refreshNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("note");
    expect(indicatorForItem(item(1, "B"))).toBe("");
    finish({
      identities: [{ itemkey: "B", libraryURI: "library-1" }],
      unidentifiedNotes: 0,
    });
    await pending;
    expect(indicatorForItem(item(1, "A"))).toBe("");
    expect(indicatorForItem(item(1, "B"))).toBe("note");
    mocks.identities.mockRejectedValueOnce(new Error("offline"));
    await expect(refreshNoteIndicators()).rejects.toThrow("offline");
    expect(indicatorForItem(item(1, "B"))).toBe("stale-note");
    expect(indicatorForItem(item(1, "A"))).toBe("");
  });

  it("restores the last complete snapshot across restarts and replaces it on reconnect", async () => {
    mocks.identities.mockResolvedValueOnce({
      identities: [
        { itemkey: "A", libraryURI: "library-1", citekey: "not stored" },
        { itemkey: "legacy" },
      ],
      unidentifiedNotes: 1,
    });
    await refreshNoteIndicators();
    expect(JSON.parse(preferences.get("test.indicatorSnapshot")!)).toEqual({
      identities: [
        { itemkey: "A", libraryURI: "library-1" },
        { itemkey: "legacy" },
      ],
      unidentifiedNotes: 1,
    });
    stopNoteIndicators();
    let finish!: (value: unknown) => void;
    mocks.identities.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    startNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("stale-note");
    expect(indicatorForItem(item(2, "A"))).toBe("unknown");
    expect(indicatorForItem(item(1, "legacy"))).toBe("uncertain");
    finish({
      identities: [{ itemkey: "B", libraryURI: "library-1" }],
      unidentifiedNotes: 0,
    });
    await refreshNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("");
    expect(indicatorForItem(item(1, "B"))).toBe("note");
    stopNoteIndicators();
  });

  it("logs an invalid cache and keeps the status unknown", async () => {
    preferences.set("test.indicatorSnapshot", '{"identities":"invalid"}');
    let finish!: (value: unknown) => void;
    mocks.identities.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    startNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("unknown");
    expect((globalThis as any).Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("indicator cache could not be read"),
    );
    finish({ identities: [], unidentifiedNotes: 0 });
    await refreshNoteIndicators();
    stopNoteIndicators();
  });

  it("keeps live results and retries if saving the cache fails", async () => {
    const prefs = (globalThis as any).Zotero.Prefs;
    prefs.set.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    mocks.identities.mockResolvedValue({
      identities: [{ itemkey: "A", libraryURI: "library-1" }],
      unidentifiedNotes: 0,
    });
    await refreshNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("note");
    expect((globalThis as any).Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining("indicator cache could not be saved"),
    );
    await refreshNoteIndicators();
    expect(preferences.has("test.indicatorSnapshot")).toBe(true);
  });

  it("does not claim absence while an unidentified legacy note exists", async () => {
    mocks.identities.mockResolvedValue({
      identities: [{ itemkey: "A", libraryURI: "library-1" }],
      unidentifiedNotes: 1,
    });

    await refreshNoteIndicators();
    expect(indicatorForItem(item(1, "A"))).toBe("note");
    expect(indicatorForItem(item(1, "other"))).toBe("unknown");
  });

  it("rechecks after an in-flight scan when a note is created", async () => {
    let finish!: (value: unknown) => void;
    mocks.identities
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce({
        identities: [{ itemkey: "A", libraryURI: "library-1" }],
        unidentifiedNotes: 0,
      });
    const first = refreshNoteIndicators();
    const afterCreate = refreshNoteIndicators(true);
    finish({ identities: [], unidentifiedNotes: 0 });
    await Promise.all([first, afterCreate]);
    expect(mocks.identities).toHaveBeenCalledTimes(2);
    expect(indicatorForItem(item(1, "A"))).toBe("note");
  });

  it("registers the movable column and renders the selected diamond color", () => {
    registerNoteIndicator();
    const options = (globalThis as any).Zotero.ItemTreeManager.registerColumn
      .mock.calls[0][0];
    const elements: any[] = [];
    const doc = {
      createElement: () => {
        const element = {
          className: "",
          textContent: "",
          title: "",
          style: {},
          setAttribute: vi.fn(),
          append: vi.fn(),
        };
        elements.push(element);
        return element;
      },
    };
    options.renderCell(0, "note", { className: "test" }, true, doc);
    expect(elements[0].style.textAlign).toBe("center");
    expect(elements[0].style.paddingInlineEnd).toBe("0px");
    expect(elements[1].className).toBe("cell-text");
    expect(elements[1].style.textAlign).toBe("center");
    expect(elements[1].textContent).toBe("◆");
    expect(elements[1].style.color).toBe("#C99700");
    expect(elements[1].style.fontSize).toBe("1.5em");
    expect((globalThis as any).Zotero.Prefs.get).toHaveBeenLastCalledWith(
      "test.indicatorColor",
      true,
    );
    (globalThis as any).Zotero.Prefs.get = () => "#D6249F";
    options.renderCell(1, "note", { className: "test" }, false, doc);
    expect(elements[2].style.textAlign).toBe("center");
    expect(elements[2].style.paddingInlineEnd).toBeUndefined();
    expect(elements[3].style.textAlign).toBe("center");
    expect(elements[3].style.color).toBe("#D6249F");
    options.renderCell(2, "unknown", { className: "test" }, true, doc);
    expect(elements[5].textContent).toBe("?");
    expect(elements[5].style.textAlign).toBe("center");
    options.renderCell(3, "", { className: "test" }, false, doc);
    expect(elements[6].append).not.toHaveBeenCalled();
    options.renderCell(4, "stale-note", { className: "test" }, true, doc);
    expect(elements[8].textContent).toBe("◇");
    expect(elements[8].style.color).toBe("#D6249F");
    expect(elements[8].style.fontSize).toBe("1.5em");
    expect(options.zoteroPersist).toContain("width");
  });
});
