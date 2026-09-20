import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyCompactProgressStyle,
  resizeCompactProgressWindow,
  pluginIconUrl,
  showNotice,
} from "../src/utils/progressNotice";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Zotero's progress window is a XUL/XHTML hybrid document whose default
 * (unprefixed) namespace is XUL. A plain `document.createElement("style")`
 * there creates a XUL-namespaced element that Gecko's style engine ignores,
 * so this fake document fails any call that isn't namespace-qualified.
 */
function makeFakeProgressWindowDoc() {
  const byId = new Map<string, any>();
  const styleEls: any[] = [];

  const doc: any = {
    createElementNS: vi.fn((ns: string, tag: string) => {
      const el: any = {
        ns,
        tag,
        textContent: "",
        setAttribute(key: string, value: string) {
          if (key === "id") byId.set(value, el);
        },
      };
      styleEls.push(el);
      return el;
    }),
    createElement: vi.fn(() => {
      throw new Error(
        "createElement() is not namespace-aware in this document; use createElementNS()",
      );
    }),
    getElementById: vi.fn((id: string) => byId.get(id) ?? null),
    documentElement: { appendChild: vi.fn() },
  };

  return { doc, styleEls };
}

function makeWindowForLine() {
  const { doc, styleEls } = makeFakeProgressWindowDoc();
  const sizeToContent = vi.fn();
  const win: any = {
    document: doc,
    sizeToContent,
    setTimeout: (cb: () => void) => {
      cb();
      return 0;
    },
  };
  doc.defaultView = win;
  const line: any = { _image: { ownerDocument: doc } };
  return { doc, win, line, styleEls, sizeToContent };
}

describe("progressNotice", () => {
  beforeEach(() => {
    (globalThis as any).Zotero = { debug: vi.fn() };
    (globalThis as any).addon = {
      data: {
        config: { addonRef: "zoteroobsidian", addonName: "Obsidian" },
        ztoolkit: {},
      },
    };
  });

  describe("pluginIconUrl", () => {
    it("builds a chrome icon URL from the addon ref", () => {
      expect(pluginIconUrl()).toBe(
        "chrome://zoteroobsidian/content/icons/favicon.svg",
      );
    });

    it("returns an empty string instead of throwing when config is missing", () => {
      (globalThis as any).addon = { data: {} };
      expect(() => pluginIconUrl()).not.toThrow();
      expect(pluginIconUrl()).toBe("");
    });
  });

  describe("applyCompactProgressStyle", () => {
    it("injects the compact style with the XHTML namespace, not a bare createElement", async () => {
      const { doc, line, styleEls, sizeToContent } = makeWindowForLine();

      applyCompactProgressStyle(line);
      // let the internal setTimeout(poll, 0) run
      await new Promise((r) => setTimeout(r, 0));

      expect(doc.createElementNS).toHaveBeenCalledWith(XHTML_NS, "style");
      expect(doc.createElement).not.toHaveBeenCalled();
      expect(styleEls).toHaveLength(1);
      expect(styleEls[0].textContent).toContain("min-width: 0");
      expect(doc.documentElement.appendChild).toHaveBeenCalledWith(styleEls[0]);
      expect(sizeToContent).toHaveBeenCalled();
    });

    it("does not inject the style twice into the same document", async () => {
      const { doc, line } = makeWindowForLine();

      applyCompactProgressStyle(line);
      await new Promise((r) => setTimeout(r, 0));
      applyCompactProgressStyle(line);
      await new Promise((r) => setTimeout(r, 0));

      expect(doc.createElementNS).toHaveBeenCalledTimes(1);
    });

    it("keeps polling until the window becomes available", async () => {
      let win: any = null;
      const line: any = {
        get _image() {
          return { ownerDocument: { defaultView: win } };
        },
      };

      applyCompactProgressStyle(line);
      await new Promise((r) => setTimeout(r, 10));

      const { win: readyWin, doc } = makeWindowForLine();
      win = readyWin;
      await new Promise((r) => setTimeout(r, 60));

      expect(doc.createElementNS).toHaveBeenCalledWith(XHTML_NS, "style");
    });
  });

  describe("resizeCompactProgressWindow", () => {
    it("re-measures the window when it is available", () => {
      const { line, sizeToContent } = makeWindowForLine();
      resizeCompactProgressWindow(line);
      expect(sizeToContent).toHaveBeenCalled();
    });

    it("does nothing when the window is not yet available", () => {
      expect(() => resizeCompactProgressWindow({})).not.toThrow();
      expect(() => resizeCompactProgressWindow(undefined)).not.toThrow();
    });
  });

  describe("showNotice", () => {
    it("shows a success-styled, self-dismissing line with the plugin headline", () => {
      const notice: any = {
        createLine: vi.fn().mockReturnThis(),
        show: vi.fn(),
        startCloseTimer: vi.fn(),
        lines: [{}],
      };
      const ProgressWindow = vi.fn(function () {
        return notice;
      });
      (globalThis as any).addon.data.ztoolkit.ProgressWindow = ProgressWindow;

      showNotice("All good");

      expect(ProgressWindow).toHaveBeenCalledWith("Obsidian", {
        closeOnClick: true,
      });
      expect(notice.createLine).toHaveBeenCalledWith({
        text: "All good",
        type: "success",
        progress: 100,
      });
      expect(notice.show).toHaveBeenCalledWith(-1);
      expect(notice.startCloseTimer).toHaveBeenCalledWith(3000);
    });

    it("does nothing (and does not throw) when the toolkit is unavailable", () => {
      (globalThis as any).addon.data.ztoolkit = {};
      expect(() => showNotice("hello")).not.toThrow();
    });
  });
});
