/**
 * Progress-window presentation helpers.
 *
 * Zotero's progress window hard-codes `min-width: 300px` on the window and a
 * fixed `width: 250px` on each item label. For a short, one-line notice that
 * leaves a lot of empty space around the text; for a longer one, the fixed
 * label width wraps the text and the window is not resized to fit the wrap.
 * Both show up as an oddly-bordered or truncated popup.
 *
 * The progress window document is a XUL/XHTML hybrid (default namespace is
 * XUL, not HTML), so a plain `document.createElement("style")` creates a
 * namespace-less element that Gecko's style engine silently ignores. Any
 * injected stylesheet MUST be created with the XHTML namespace explicitly.
 */

declare const Zotero: any;
declare const addon: any;

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const COMPACT_STYLE_ID = "zoteroobsidian-progress-compact";

const COMPACT_CSS = [
  "#zotero-progress { min-width: 0 !important; }",
  "#zotero-progress-text-box { padding: 8px 10px !important; }",
  "#zotero-progress-text-headline { margin-bottom: 4px !important; }",
  ".zotero-progress-item-label {",
  "  width: auto !important;",
  "  min-width: 120px !important;",
  "  max-width: 480px !important;",
  "  white-space: normal !important;",
  "  overflow-wrap: anywhere !important;",
  "}",
].join("\n");

/** Return the plugin's own icon, used for notices that are not success/fail. */
export function pluginIconUrl(): string {
  const addonRef = addon?.data?.config?.addonRef;
  return addonRef ? `chrome://${addonRef}/content/icons/favicon.svg` : "";
}

function sizeAndPositionWindow(win: any): void {
  win.sizeToContent();
  Zotero.ProgressWindowSet.tile(win);
  const screen = win.screen;
  if (!screen) return;
  const { availLeft, availTop, availWidth, availHeight } = screen;
  if (
    ![
      availLeft,
      availTop,
      availWidth,
      availHeight,
      win.screenX,
      win.screenY,
      win.outerWidth,
      win.outerHeight,
    ].every(Number.isFinite) ||
    availWidth <= 0 ||
    availHeight <= 0
  )
    return;
  const x = Math.max(
    availLeft,
    Math.min(win.screenX, availLeft + availWidth - win.outerWidth),
  );
  const y = Math.max(
    availTop,
    Math.min(win.screenY, availTop + availHeight - win.outerHeight),
  );
  if (x !== win.screenX || y !== win.screenY) win.moveTo(x, y);
}

function resizeWindow(win: any): void {
  try {
    sizeAndPositionWindow(win);
    // Text wrapping at the new width can take an extra layout pass to settle.
    win?.setTimeout?.(() => {
      try {
        sizeAndPositionWindow(win);
      } catch (e) {
        Zotero.debug(`[zoteroobsidian] resize progress window error: ${e}`);
      }
    }, 0);
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] resize progress window error: ${e}`);
  }
}

function compactProgressWindow(win: any): void {
  try {
    const doc = win?.document;
    if (!doc) return;
    if (!doc.getElementById(COMPACT_STYLE_ID)) {
      // Must be created in the XHTML namespace: this document's default
      // (unprefixed) namespace is XUL, and a XUL "style" element is not a
      // stylesheet as far as Gecko's style engine is concerned.
      const style = doc.createElementNS(XHTML_NS, "style");
      style.setAttribute("id", COMPACT_STYLE_ID);
      style.textContent = COMPACT_CSS;
      (doc.documentElement || doc).appendChild(style);
    }
    resizeWindow(win);
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
 * Re-measure an already-compacted progress window, e.g. after its text
 * changed to something longer or shorter. No-ops until the window is ready.
 */
export function resizeCompactProgressWindow(line: any): void {
  const win = line?._image?.ownerDocument?.defaultView;
  if (win) resizeWindow(win);
}

/** Show a connection warning inside Zotero, avoiding the native progress window frame. */
export function showInWindowNotice(
  message: string,
  onShown: () => void,
): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let notice: HTMLElement | undefined;
  let cancelled = false;

  const dismiss = () => {
    cancelled = true;
    if (retry) clearTimeout(retry);
    notice?.remove();
    notice = undefined;
  };
  const show = () => {
    if (cancelled) return;
    try {
      const win: Window | null = Zotero.getMainWindow();
      if (!win || win.closed || !win.document.documentElement) {
        retry = setTimeout(show, 500);
        return;
      }
      const doc = win.document;
      notice = doc.createElementNS(XHTML_NS, "div");
      notice.setAttribute("role", "alert");
      notice.style.cssText =
        "position:fixed;z-index:2147483647;right:24px;bottom:35px;" +
        "max-width:min(354px,calc(100vw - 48px));box-sizing:border-box;" +
        "padding:16px;border:1px solid var(--theme-border-color, #bbb);" +
        "border-radius:6px;background:var(--material-background, #fff);" +
        "color:var(--fill-primary, #111);font:message-box;line-height:1.4;" +
        "box-shadow:0 3px 12px rgba(0,0,0,.2)";
      const heading = doc.createElementNS(XHTML_NS, "div");
      heading.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px";
      const title = doc.createElementNS(XHTML_NS, "strong");
      title.textContent = "Obsidian connection";
      const button = doc.createElementNS(XHTML_NS, "button");
      button.textContent = "Close";
      button.addEventListener("click", dismiss);
      heading.appendChild(title);
      heading.appendChild(button);
      const text = doc.createElementNS(XHTML_NS, "div");
      text.textContent = message;
      notice.appendChild(heading);
      notice.appendChild(text);
      doc.documentElement.appendChild(notice);
      onShown();
    } catch (error) {
      Zotero.logError(
        `[Obsidian attachment check] Unable to show connection warning: ${error}`,
      );
      dismiss();
    }
  };
  show();
  return dismiss;
}

type NoticeOptions = {
  type?: "success" | "fail";
  headline?: string;
  timeoutMs?: number;
};

export function showDismissibleNotice(
  message: string,
  options: NoticeOptions = {},
): (() => void) | undefined {
  try {
    const ProgressWindow = addon?.data?.ztoolkit?.ProgressWindow;
    if (!ProgressWindow) return undefined;
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
    const timeoutMs = options.timeoutMs ?? 3000;
    if (timeoutMs > 0) pw.startCloseTimer(timeoutMs);
    return () => {
      try {
        pw.close();
      } catch (e) {
        Zotero.debug(`[zoteroobsidian] close notice error: ${e}`);
      }
    };
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] showNotice error: ${e}`);
    return undefined;
  }
}

/** Show a single-line, self-dismissing notice. */
export function showNotice(
  message: string,
  options: NoticeOptions = {},
): boolean {
  return Boolean(showDismissibleNotice(message, options));
}
