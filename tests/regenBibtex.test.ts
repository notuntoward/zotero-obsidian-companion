import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focusMainWindow: vi.fn(),
  getMainWindow: vi.fn(),
  showAlert: vi.fn(),
  getCiteKey: vi.fn(),
}));

vi.mock("../src/utils/alert", () => ({
  focusMainWindow: mocks.focusMainWindow,
  getMainWindow: mocks.getMainWindow,
  showAlert: mocks.showAlert,
}));
vi.mock("../src/modules/obsidianPayload", () => ({
  getCiteKey: mocks.getCiteKey,
}));

import { regenBibtexKey } from "../src/modules/regenBibtex";

function fixture(initialKey = "old-key") {
  let savedKey = initialKey;
  let currentKey = initialKey;
  const item = {
    id: 1,
    isRegularItem: () => true,
    reload: vi.fn(async () => {
      currentKey = savedKey;
    }),
    getField: (field: string) =>
      field === "citationKey" ? currentKey : "A title",
    setField: vi.fn((_field: string, value: string) => {
      currentKey = value;
    }),
    saveTx: vi.fn(async () => {
      savedKey = currentKey;
    }),
  };
  return {
    item,
    readSavedKey: async () => {
      await item.reload();
      return currentKey;
    },
  };
}

describe("Regen Citation Key", () => {
  const win = { focus: vi.fn() };
  const prompt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMainWindow.mockReturnValue(win);
    mocks.getCiteKey.mockImplementation(async (item: any) =>
      item.getField("citationKey"),
    );
    prompt.mockReset();
    (globalThis as any).Services = { prompt: { prompt } };
    (globalThis as any).Zotero = {
      BetterBibTeX: {
        ready: Promise.resolve(),
        KeyManager: { propose: () => "proposed-key" },
      },
      Promise: { delay: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it("saves the confirmed key through the main-window dialog and re-reads it", async () => {
    const { item, readSavedKey } = fixture();
    prompt.mockImplementation(
      (
        owner: unknown,
        _title: string,
        _message: string,
        input: { value: string },
      ) => {
        expect(owner).toBe(win);
        input.value = "chosen-key";
        return true;
      },
    );

    await regenBibtexKey([item]);

    expect(mocks.focusMainWindow).toHaveBeenCalledWith(win);
    expect(prompt).toHaveBeenCalledOnce();
    expect(item.setField).toHaveBeenCalledWith("citationKey", "chosen-key");
    expect(item.saveTx).toHaveBeenCalledOnce();
    expect(await readSavedKey()).toBe("chosen-key");
  });

  it("preserves the saved key when the user cancels", async () => {
    const { item, readSavedKey } = fixture();
    prompt.mockImplementation(
      (
        _owner: unknown,
        _title: string,
        _message: string,
        input: { value: string },
      ) => {
        input.value = "unconfirmed-key";
        return false;
      },
    );

    await regenBibtexKey([item]);

    expect(item.setField).not.toHaveBeenCalled();
    expect(item.saveTx).not.toHaveBeenCalled();
    expect(await readSavedKey()).toBe("old-key");
  });
});
