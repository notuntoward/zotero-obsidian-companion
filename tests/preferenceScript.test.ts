import { describe, expect, it, vi } from "vitest";

vi.mock("zotero-plugin-toolkit", () => ({ KeyModifier: vi.fn() }));

import { registerPrefsScripts } from "../src/modules/preferenceScript";

describe("Better BibTeX status", () => {
  it.each([
    [true, "Better BibTeX: active"],
    [false, "Better BibTeX: not active"],
  ])("reports whether BBT is active (%s)", (active, expected) => {
    const status = { textContent: "" };
    (globalThis as any).addon = {
      data: { config: { addonRef: "zoteroobsidian" } },
    };
    (globalThis as any).Zotero = { BetterBibTeX: active ? {} : undefined };
    const win = {
      document: {
        getElementById: (id: string) =>
          id === "zotero-prefpane-zoteroobsidian-betterBibTeXStatus"
            ? status
            : null,
      },
    };
    registerPrefsScripts(win as unknown as Window);
    expect(status.textContent).toContain(expected);
  });
});
