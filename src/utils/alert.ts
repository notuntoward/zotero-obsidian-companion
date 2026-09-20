/**
 * Shared Zotero window/dialog helpers.
 */

declare const Zotero: any;

export function getMainWindow(): any {
  return typeof Zotero.getMainWindow === "function"
    ? Zotero.getMainWindow()
    : null;
}

/**
 * Focus a Zotero window (main window by default) so a modal alert is raised
 * rather than left behind another application's window.
 */
export function focusMainWindow(win?: any): any {
  const target = win || getMainWindow();
  if (target && typeof target.focus === "function") {
    try {
      target.focus();
    } catch {
      /* ignore */
    }
  }
  return target;
}

/** Show a Zotero-native alert, focusing its window first. */
export function showAlert(win: any, title: string, message: string): void {
  Zotero.alert(focusMainWindow(win), title, message);
}
