/**
 * Utilities for toggling Zotero interface panes.
 */

export function toggleLeftPane(win?: Window): void {
  const targetWin = win || (Zotero as any).getMainWindow();
  if (!targetWin) return;
  const leftPane = targetWin.document.getElementById("zotero-collections-pane");
  if (leftPane) {
    if (leftPane.hasAttribute("hidden")) {
      leftPane.removeAttribute("hidden");
      leftPane.removeAttribute("collapsed");
    } else if (leftPane.hasAttribute("collapsed")) {
      leftPane.removeAttribute("collapsed");
    } else {
      leftPane.setAttribute("hidden", "true");
    }
  }
}

export function toggleRightPane(win?: Window): void {
  const targetWin = win || (Zotero as any).getMainWindow();
  if (!targetWin) return;
  const rightPane = targetWin.document.getElementById("zotero-item-pane");
  if (rightPane) {
    if (rightPane.hasAttribute("hidden")) {
      rightPane.removeAttribute("hidden");
      rightPane.removeAttribute("collapsed");
    } else if (rightPane.hasAttribute("collapsed")) {
      rightPane.removeAttribute("collapsed");
    } else {
      rightPane.setAttribute("hidden", "true");
    }
  }
}
