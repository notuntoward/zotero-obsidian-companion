/**
 * Progress-window presentation helpers.
 *
 * Zotero's progress window hard-codes `min-width: 300px` on the window and a
 * fixed `width: 250px` on each item label. For a short, one-line notice that
 * leaves a lot of empty space around the text, which reads as a stray border.
 * Tighten those two rules (and the content padding) so simple notices look
 * deliberate and unobtrusive.
 *
 * The progress window is its own chrome document, so the style is injected
 * there rather than into the main window.
 */

declare const Zotero: any;
declare const addon: any;

const COMPACT_STYLE_ID = "zoteroobsidian-progress-compact";

const COMPACT_CSS = [
  "#zotero-progress { min-width: 0 !important; }",
  "#zotero-progress-text-box { padding: 8px 10px !important; }",
  "#zotero-progress-text-headline { margin-bottom: 0 !important; }",
  ".zotero-progress-item-label { width: auto !important; max-width: 340px !important; }",
].join("\n");

function compactProgressWindow(win: any): void {
  try {
    const doc = win?.document;
    if (!doc || doc.getElementById(COMPACT_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = COMPACT_STYLE_ID;
    style.textContent = COMPACT_CSS;
    doc.documentElement.appendChild(style);
    win.sizeToContent?.();
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] compactProgressWindow error: ${e}`);
  }
}

/**
 * Wait for a toolkit progress line to be attached to its window, then tighten
 * that window. Safe to call fire-and-forget.
 */
export function applyCompactProgressStyle(line: any): void {
  const startedAt = Date.now();
  const poll = () => {
    const win = line?._image?.ownerDocument?.defaultView;
    if (win) {
      compactProgressWindow(win);
      return;
    }
    if (Date.now() - startedAt < 2000) {
      setTimeout(poll, 50);
    }
  };
  setTimeout(poll, 0);
}

/**
 * Show a single-line, self-dismissing notice. Keeps the plugin's success/fail
 * icon and tightens the window so it hugs the text.
 */
export function showNotice(
  message: string,
  options: {
    type?: "success" | "fail";
    headline?: string;
    timeoutMs?: number;
  } = {},
): void {
  try {
    const ProgressWindow = addon?.data?.ztoolkit?.ProgressWindow;
    if (!ProgressWindow) return;
    const pw = new ProgressWindow(
      options.headline ?? addon.data.config.addonName,
      {
        closeOnClick: true,
      },
    );
    pw.createLine({
      text: message,
      type: options.type ?? "success",
      progress: 100,
    }).show(-1);
    applyCompactProgressStyle(pw.lines?.[0]);
    pw.startCloseTimer(options.timeoutMs ?? 3000);
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] showNotice error: ${e}`);
  }
}
