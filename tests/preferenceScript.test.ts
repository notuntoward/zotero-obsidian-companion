import { describe, expect, it, vi } from "vitest";

vi.mock("zotero-plugin-toolkit", () => ({ KeyModifier: vi.fn() }));
vi.mock("../src/modules/noteIndicators", () => ({
  currentIndicatorColor: vi.fn(() => "#C99700"),
  refreshIndicatorAppearance: vi.fn(),
}));
import { registerPrefsScripts } from "../src/modules/preferenceScript";
import {
  currentIndicatorColor,
  refreshIndicatorAppearance,
} from "../src/modules/noteIndicators";

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
        querySelectorAll: () => [],
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

describe("indicator color swatches", () => {
  it("loads the saved color and saves a changed selection before redrawing", () => {
    vi.mocked(currentIndicatorColor).mockReturnValue("#D6249F");
    const prefsSet = vi.fn();
    (globalThis as any).addon = {
      data: { config: { addonRef: "test", prefsPrefix: "extensions.test" } },
    };
    (globalThis as any).Zotero = { Prefs: { set: prefsSet } };
    class Swatch extends EventTarget {
      checked = false;
      constructor(public value: string) {
        super();
      }
    }
    const swatches = ["#C99700", "#D6249F"].map((value) => new Swatch(value));
    const win = {
      document: {
        querySelectorAll: () => swatches,
        getElementById: () => null,
      },
    };
    registerPrefsScripts(win as unknown as Window);
    expect(swatches.map((swatch) => swatch.checked)).toEqual([false, true]);

    swatches[0].checked = true;
    swatches[0].dispatchEvent(new Event("change"));
    expect(prefsSet).toHaveBeenCalledWith(
      "extensions.test.indicatorColor",
      "#C99700",
      true,
    );
    expect(prefsSet.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshIndicatorAppearance).mock.invocationCallOrder[0],
    );
  });
});
