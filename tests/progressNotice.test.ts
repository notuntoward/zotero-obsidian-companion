import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyCompactProgressStyle,
  resizeCompactProgressWindow,
  pluginIconUrl,
  showDismissibleNotice,
  showInWindowNotice,
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
    (globalThis as any).Zotero = {
      debug: vi.fn(),
      ProgressWindowSet: { tile: vi.fn() },
    };
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

    it("retiles and keeps a resized notice inside its monitor's work area", () => {
      const { line, win, sizeToContent } = makeWindowForLine();
      const tile = vi.fn();
      (globalThis as any).Zotero.ProgressWindowSet = { tile };
      Object.assign(win, {
        screen: {
          availLeft: -1920,
          availTop: 0,
          availWidth: 1920,
          availHeight: 1040,
        },
        screenX: -100,
        screenY: 1000,
        outerWidth: 400,
        outerHeight: 160,
        moveTo: vi.fn(),
      });
      resizeCompactProgressWindow(line);
      expect(tile).toHaveBeenCalledWith(win);
      expect(sizeToContent.mock.invocationCallOrder[0]).toBeLessThan(
        tile.mock.invocationCallOrder[0],
      );
      expect(win.moveTo).toHaveBeenCalledWith(-400, 880);
    });

    it("does not move a notice that remains within its monitor", () => {
      const { line, win } = makeWindowForLine();
      Object.assign(win, {
        screen: {
          availLeft: 1920,
          availTop: 0,
          availWidth: 1920,
          availHeight: 1040,
        },
        screenX: 3000,
        screenY: 700,
        outerWidth: 400,
        outerHeight: 160,
        moveTo: vi.fn(),
      });
      resizeCompactProgressWindow(line);
      expect(
        (globalThis as any).Zotero.ProgressWindowSet.tile,
      ).toHaveBeenCalledWith(win);
      expect(win.moveTo).not.toHaveBeenCalled();
    });

    it("does nothing when the window is not yet available", () => {
      expect(() => resizeCompactProgressWindow({})).not.toThrow();
      expect(() => resizeCompactProgressWindow(undefined)).not.toThrow();
    });
  });

  describe("showInWindowNotice", () => {
    it("shows a dismissible warning once the main window is ready", async () => {
      vi.useFakeTimers();
      try {
        const elements: any[] = [];
        const doc = {
          createElementNS: vi.fn((_ns: string, tag: string) => {
            const el: any = {
              tag,
              style: {},
              children: [],
              setAttribute: vi.fn(),
              appendChild(child: any) {
                this.children.push(child);
              },
              addEventListener: vi.fn(),
              remove: vi.fn(),
            };
            elements.push(el);
            return el;
          }),
          documentElement: { appendChild: vi.fn() },
        };
        let win: any = null;
        (globalThis as any).Zotero.getMainWindow = vi.fn(() => win);
        const shown = vi.fn();
        const dismiss = showInWindowNotice("Connection unavailable", shown);
        expect(shown).not.toHaveBeenCalled();
        win = { document: doc, closed: false };
        await vi.advanceTimersByTimeAsync(500);
        expect(shown).toHaveBeenCalledOnce();
        expect(doc.documentElement.appendChild).toHaveBeenCalledWith(
          elements[0],
        );
        expect(
          elements.some((el) => el.textContent === "Connection unavailable"),
        ).toBe(true);
        expect(elements[0].setAttribute).toHaveBeenCalledWith("role", "alert");
        const button = elements.find((el) => el.tag === "button");
        const onClick = button.addEventListener.mock.calls.find(
          (call: any[]) => call[0] === "click",
        )[1];
        onClick();
        dismiss();
        expect(elements[0].remove).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a pending warning before a window becomes available", async () => {
      vi.useFakeTimers();
      try {
        (globalThis as any).Zotero.getMainWindow = vi.fn(() => null);
        const shown = vi.fn();
        const dismiss = showInWindowNotice("Waiting", shown);
        dismiss();
        await vi.advanceTimersByTimeAsync(1000);
        expect(shown).not.toHaveBeenCalled();
        expect((globalThis as any).Zotero.getMainWindow).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
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

    it("does not start a native close timer for a manually timed notice", () => {
      const notice = {
        createLine: vi.fn().mockReturnThis(),
        show: vi.fn(),
        startCloseTimer: vi.fn(),
        close: vi.fn(),
        lines: [{}],
      };
      (globalThis as any).addon.data.ztoolkit.ProgressWindow = vi.fn(
        function () {
          return notice;
        },
      );
      const dismiss = showDismissibleNotice("Waiting", { timeoutMs: 0 });
      expect(notice.show).toHaveBeenCalledWith(-1);
      expect(notice.startCloseTimer).not.toHaveBeenCalled();
      dismiss?.();
      expect(notice.close).toHaveBeenCalledOnce();
    });

    it("dismisses only the notice returned by the helper", () => {
      const notices: any[] = [];
      (globalThis as any).addon.data.ztoolkit.ProgressWindow = vi.fn(
        function () {
          const notice = {
            createLine: vi.fn().mockReturnThis(),
            show: vi.fn(),
            startCloseTimer: vi.fn(),
            close: vi.fn(),
            lines: [{}],
          };
          notices.push(notice);
          return notice;
        },
      );
      const dismiss = showDismissibleNotice("Waiting", { timeoutMs: 15000 });
      showNotice("Other");
      expect(dismiss).toBeTypeOf("function");
      dismiss?.();
      expect(notices[0].close).toHaveBeenCalledOnce();
      expect(notices[1].close).not.toHaveBeenCalled();
    });

    it("does nothing (and does not throw) when the toolkit is unavailable", () => {
      (globalThis as any).addon.data.ztoolkit = {};
      expect(() => showNotice("hello")).not.toThrow();
    });
  });
});
