import { describe, it, expect, vi, beforeEach } from "vitest";
import { toggleLeftPane, toggleRightPane } from "../src/utils/paneUtils";

describe("paneUtils", () => {
  let mockDoc: any;
  let mockWin: any;
  let leftPaneEl: any;
  let rightPaneEl: any;

  beforeEach(() => {
    const createMockEl = () => {
      const attrs = new Map<string, string>();
      return {
        hasAttribute: vi.fn((k: string) => attrs.has(k)),
        getAttribute: vi.fn((k: string) => attrs.get(k)),
        setAttribute: vi.fn((k: string, v: string) => attrs.set(k, v)),
        removeAttribute: vi.fn((k: string) => attrs.delete(k)),
        _attrs: attrs,
      };
    };

    leftPaneEl = createMockEl();
    rightPaneEl = createMockEl();

    mockDoc = {
      getElementById: vi.fn((id: string) => {
        if (id === "zotero-collections-pane") return leftPaneEl;
        if (id === "zotero-item-pane") return rightPaneEl;
        return null;
      }),
    };

    mockWin = {
      document: mockDoc,
    };

    (globalThis as any).Zotero = {
      getMainWindow: vi.fn(() => mockWin),
    };
  });

  describe("toggleLeftPane", () => {
    it("removes hidden and collapsed attributes if hidden", () => {
      leftPaneEl.setAttribute("hidden", "true");
      leftPaneEl.setAttribute("collapsed", "true");

      toggleLeftPane(mockWin);

      expect(leftPaneEl.removeAttribute).toHaveBeenCalledWith("hidden");
      expect(leftPaneEl.removeAttribute).toHaveBeenCalledWith("collapsed");
      expect(leftPaneEl.hasAttribute("hidden")).toBe(false);
    });

    it("removes collapsed attribute if collapsed", () => {
      leftPaneEl.setAttribute("collapsed", "true");

      toggleLeftPane(mockWin);

      expect(leftPaneEl.removeAttribute).toHaveBeenCalledWith("collapsed");
      expect(leftPaneEl.hasAttribute("collapsed")).toBe(false);
    });

    it("sets hidden attribute if visible", () => {
      toggleLeftPane(mockWin);

      expect(leftPaneEl.setAttribute).toHaveBeenCalledWith("hidden", "true");
      expect(leftPaneEl.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("toggleRightPane", () => {
    it("removes hidden and collapsed attributes if hidden", () => {
      rightPaneEl.setAttribute("hidden", "true");
      rightPaneEl.setAttribute("collapsed", "true");

      toggleRightPane(mockWin);

      expect(rightPaneEl.removeAttribute).toHaveBeenCalledWith("hidden");
      expect(rightPaneEl.removeAttribute).toHaveBeenCalledWith("collapsed");
      expect(rightPaneEl.hasAttribute("hidden")).toBe(false);
    });

    it("sets hidden attribute if visible", () => {
      toggleRightPane(mockWin);

      expect(rightPaneEl.setAttribute).toHaveBeenCalledWith("hidden", "true");
      expect(rightPaneEl.hasAttribute("hidden")).toBe(true);
    });

    it("prefers ZoteroPane.toggleItemPane when the native API is available", () => {
      const toggleItemPane = vi.fn();
      mockWin.ZoteroPane = { toggleItemPane };

      toggleRightPane(mockWin);

      expect(toggleItemPane).toHaveBeenCalledTimes(1);
      expect(rightPaneEl.setAttribute).not.toHaveBeenCalled();
      expect(rightPaneEl.removeAttribute).not.toHaveBeenCalled();
    });
  });
});
