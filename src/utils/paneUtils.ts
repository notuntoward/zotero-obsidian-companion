/**
 * Utilities for toggling Zotero interface panes.
 */

declare const Zotero: any;

function togglePaneById(win: any, id: string): void {
  const pane = win?.document?.getElementById(id);
  if (!pane) return;
  if (pane.hasAttribute("hidden")) {
    pane.removeAttribute("hidden");
    pane.removeAttribute("collapsed");
  } else if (pane.hasAttribute("collapsed")) {
    pane.removeAttribute("collapsed");
  } else {
    pane.setAttribute("hidden", "true");
  }
}

export function toggleLeftPane(win?: Window): void {
  const targetWin = win || Zotero.getMainWindow();
  if (!targetWin) return;
  togglePaneById(targetWin, "zotero-collections-pane");
}

export function toggleRightPane(win?: Window): void {
  const targetWin = win || Zotero.getMainWindow();
  if (!targetWin) return;
  // Prefer Zotero's own item-pane toggle when available so its layout
  // constraints stay in sync; fall back to direct DOM toggling otherwise.
  const zoteroPane = (targetWin as any).ZoteroPane;
  if (zoteroPane && typeof zoteroPane.toggleItemPane === "function") {
    zoteroPane.toggleItemPane();
    return;
  }
  togglePaneById(targetWin, "zotero-item-pane");
}
