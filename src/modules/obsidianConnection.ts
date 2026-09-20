/**
 * Centralized Obsidian connection, process detection, auto-launch, and communication service.
 */

declare const Zotero: any;
declare const addon: any;

export interface ConnectionOptions {
  progressMessage?: string;
  maxWaitMs?: number;
}

const OBSIDIAN_OPEN_URI = "obsidian://open";
const OBSIDIAN_SERVER_URL = "http://127.0.0.1:27124/lit-notes";

/**
 * Obsidian is an Electron app and can take a while to cold start and load its
 * vault, so allow well beyond the old 15s before giving up.
 */
const DEFAULT_MAX_WAIT_MS = 60000;
const POLL_INTERVAL_MS = 600;
const SERVER_CHECK_TIMEOUT_MS = 1000;
/** Zotero's subprocess helper has no timeout, so bound it here. */
const SUBPROCESS_TIMEOUT_MS = 10000;
const FAILURE_NOTICE_MS = 12000;
const SUCCESS_NOTICE_MS = 1500;

function getServices(): any {
  const globalServices = (globalThis as any).Services;
  if (globalServices) return globalServices;
  try {
    const ChromeUtils = (globalThis as any).ChromeUtils;
    if (ChromeUtils?.importESModule) {
      return ChromeUtils.importESModule(
        "resource://gre/modules/Services.sys.mjs",
      )?.Services;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Reject if a promise does not settle within `ms`. Used to guard the
 * timeout-less Zotero subprocess helper so a hung child cannot wedge the
 * connection lock forever.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Check if the Perplexity Saver HTTP server is responding on port 27124.
 */
export async function isObsidianServerReady(): Promise<boolean> {
  try {
    const resp = await Zotero.HTTP.request("GET", OBSIDIAN_SERVER_URL, {
      timeout: SERVER_CHECK_TIMEOUT_MS,
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

/**
 * Inspect the OS process table to determine if Obsidian is currently running.
 */
export async function isObsidianProcessRunning(): Promise<boolean> {
  try {
    if (typeof Zotero?.Utilities?.Internal?.subprocess === "function") {
      if (Zotero.isWin) {
        const output = await withTimeout(
          Zotero.Utilities.Internal.subprocess("tasklist", [
            "/fi",
            "IMAGENAME eq Obsidian.exe",
            "/nh",
          ]),
          SUBPROCESS_TIMEOUT_MS,
          "tasklist",
        );
        return (
          typeof output === "string" &&
          output.toLowerCase().includes("obsidian.exe")
        );
      } else if (Zotero.isMac) {
        const output = await withTimeout(
          Zotero.Utilities.Internal.subprocess("pgrep", ["-x", "Obsidian"]),
          SUBPROCESS_TIMEOUT_MS,
          "pgrep",
        );
        return typeof output === "string" && output.trim().length > 0;
      } else {
        const output = await withTimeout(
          Zotero.Utilities.Internal.subprocess("pgrep", ["-i", "obsidian"]),
          SUBPROCESS_TIMEOUT_MS,
          "pgrep",
        );
        return typeof output === "string" && output.trim().length > 0;
      }
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] process check error: ${e}`);
  }

  return false;
}

/**
 * Ask the OS to open the obsidian:// URI through the platform shell. This
 * bypasses Gecko's external-protocol machinery entirely and is the most
 * reliable way to launch Obsidian on every platform.
 */
async function launchViaSubprocess(): Promise<boolean> {
  const subprocess = Zotero?.Utilities?.Internal?.subprocess;
  if (typeof subprocess !== "function") return false;

  try {
    let call: Promise<unknown>;
    if (Zotero.isWin) {
      call = subprocess("cmd.exe", ["/c", "start", "", OBSIDIAN_OPEN_URI]);
    } else if (Zotero.isMac) {
      call = subprocess("open", [OBSIDIAN_OPEN_URI]);
    } else if (Zotero.isLinux) {
      call = subprocess("xdg-open", [OBSIDIAN_OPEN_URI]);
    } else {
      return false;
    }
    await withTimeout(call, SUBPROCESS_TIMEOUT_MS, "launch Obsidian");
    return true;
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] subprocess launch failed: ${e}`);
    return false;
  }
}

/**
 * Hand the URI straight to the external protocol service with a system
 * principal. Zotero's own launchURL() did not pass a triggering principal
 * before 10.0.3, which made non-HTTP schemes silently fail with
 * NS_ERROR_ILLEGAL_VALUE, so call the service ourselves as a fallback.
 * loadURI() does not raise the "open with?" prompt, so no global
 * protocol-handler preferences need to be changed.
 */
function launchViaProtocolService(): boolean {
  try {
    const Services = getServices();
    const Components = (globalThis as any).Components;
    if (
      !Services?.io?.newURI ||
      !Services?.scriptSecurityManager?.getSystemPrincipal ||
      !Components?.classes
    ) {
      return false;
    }
    const svc = Components.classes[
      "@mozilla.org/uriloader/external-protocol-service;1"
    ]?.getService(Components.interfaces.nsIExternalProtocolService);
    if (typeof svc?.loadURI !== "function") return false;

    const uri = Services.io.newURI(OBSIDIAN_OPEN_URI, null, null);
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    svc.loadURI(uri, principal);
    return true;
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] loadURI launch failed: ${e}`);
    return false;
  }
}

/**
 * Launch Obsidian via its registered URI protocol handler.
 *
 * Tries, in order: the OS shell, the Gecko external protocol service with an
 * explicit system principal, and finally the legacy Zotero.launchURL().
 */
export async function launchObsidian(): Promise<void> {
  if (await launchViaSubprocess()) return;
  if (launchViaProtocolService()) return;

  try {
    if (typeof Zotero?.launchURL === "function") {
      Zotero.launchURL(OBSIDIAN_OPEN_URI);
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] launchURL failed: ${e}`);
  }
}

// --- Progress notices -------------------------------------------------------
//
// Every operation shows at most one progress window, updates it in place, and
// always hands it off to an auto-close timer so a stale notice can never stay
// affixed to the Zotero window.

let currentNotice: any = null;

function getProgressWindowClass(): any {
  return addon?.data?.ztoolkit?.ProgressWindow ?? null;
}

function focusZoteroWindow(): void {
  try {
    const win = Zotero?.getMainWindow?.();
    if (win && typeof win.focus === "function") win.focus();
  } catch {
    /* ignore */
  }
}

/** True once the addon has been shut down or unloaded. */
function isCancelled(): boolean {
  return addon?.data?.alive === false;
}

function closeNotice(): void {
  const notice = currentNotice;
  currentNotice = null;
  if (!notice) return;
  try {
    if (typeof notice.close === "function") {
      notice.close();
    } else if (typeof notice.win?.close === "function") {
      notice.win.close();
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] closeNotice error: ${e}`);
  }
}

function startNotice(message: string): void {
  closeNotice();
  try {
    const ProgressWindow = getProgressWindowClass();
    if (!ProgressWindow) return;

    const notice = new ProgressWindow("Obsidian", {
      closeOnClick: true,
    });
    notice.createLine({ text: message, progress: 0 });
    // -1 keeps the window open until finishNotice() dismisses it.
    notice.show(-1);
    currentNotice = notice;
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] startNotice error: ${e}`);
    currentNotice = null;
  }
}

function updateNotice(message: string, progress?: number): void {
  if (!currentNotice || typeof currentNotice.changeLine !== "function") return;
  try {
    currentNotice.changeLine(
      typeof progress === "number"
        ? { text: message, progress }
        : { text: message },
    );
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] updateNotice error: ${e}`);
  }
}

/**
 * Turn the current notice into its final state and schedule its dismissal.
 * The window reference is dropped immediately so the next operation always
 * starts from a clean slate.
 */
function finishNotice(
  message: string,
  type: "success" | "fail",
  details: string | undefined,
  autoCloseMs: number,
): void {
  const notice = currentNotice;
  currentNotice = null;

  if (!notice) {
    showTransientNotice(message, type, details, autoCloseMs);
    return;
  }

  try {
    if (typeof notice.changeLine === "function") {
      notice.changeLine({ text: message, type, progress: 100 });
    }
    if (details && typeof notice.addDescription === "function") {
      try {
        notice.addDescription(details);
      } catch {
        /* ignore */
      }
    }
    if (typeof notice.startCloseTimer === "function") {
      notice.startCloseTimer(autoCloseMs);
    } else if (typeof notice.win?.startCloseTimer === "function") {
      notice.win.startCloseTimer(autoCloseMs);
    } else {
      setTimeout(() => {
        try {
          notice.close?.();
        } catch {
          /* ignore */
        }
      }, autoCloseMs);
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] finishNotice error: ${e}`);
  }
}

/** Show a self-dismissing notice when no progress window is currently open. */
function showTransientNotice(
  message: string,
  type: "success" | "fail",
  details: string | undefined,
  autoCloseMs: number,
): void {
  try {
    const ProgressWindow = getProgressWindowClass();
    if (!ProgressWindow) return;

    const notice = new ProgressWindow("Obsidian", {
      closeOnClick: true,
      closeTime: autoCloseMs,
    });
    notice.createLine({ text: message, type, progress: 100 });
    if (details && typeof notice.addDescription === "function") {
      try {
        notice.addDescription(details);
      } catch {
        /* ignore */
      }
    }
    notice.show(autoCloseMs);
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] showTransientNotice error: ${e}`);
  }
}

let activeConnectionPromise: Promise<{
  ready: boolean;
  error?: string;
}> | null = null;

/**
 * Ensure Obsidian and the Perplexity Saver plugin server are ready.
 * If Obsidian is closed, it automatically launches Obsidian, displays a single
 * progress indicator, and polls until the server answers.
 */
export function ensureObsidianConnection(
  options: ConnectionOptions = {},
): Promise<{ ready: boolean; error?: string }> {
  // Concurrency lock: reuse an ongoing attempt so parallel callers can't
  // spawn duplicate notices or duplicate launches.
  if (activeConnectionPromise) {
    return activeConnectionPromise;
  }

  activeConnectionPromise = (async () => {
    try {
      // 1. Fast check: is the server already up and responsive?
      if (await isObsidianServerReady()) {
        closeNotice();
        return { ready: true };
      }

      const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
      const totalSteps = Math.max(1, Math.ceil(maxWait / POLL_INTERVAL_MS));
      const deadline = Date.now() + maxWait;

      // 2. If Obsidian is already running, wait the same budget for the
      //    plugin to finish loading rather than launching a second instance.
      if (await isObsidianProcessRunning()) {
        startNotice(
          "Obsidian is running. Waiting for the Perplexity Saver plugin...",
        );

        for (let step = 1; step <= totalSteps; step++) {
          await Zotero.Promise.delay(POLL_INTERVAL_MS);

          if (isCancelled()) {
            closeNotice();
            return { ready: false, error: "Obsidian connection cancelled." };
          }

          if (await isObsidianServerReady()) {
            finishNotice(
              "Obsidian connected.",
              "success",
              undefined,
              SUCCESS_NOTICE_MS,
            );
            return { ready: true };
          }

          // Stop on wall-clock time so a slow HTTP check cannot stretch the
          // wait far beyond the advertised timeout.
          if (Date.now() >= deadline) break;

          const progress = Math.min(95, Math.round((step / totalSteps) * 100));
          updateNotice(
            "Obsidian is running. Waiting for the Perplexity Saver plugin...",
            progress,
          );
        }

        const errMsg =
          "Obsidian is currently running, but the 'Perplexity Saver' plugin is not responding on port 27124.\n\nPlease ensure 'Perplexity Saver' is enabled in Obsidian Settings > Community Plugins.";
        finishNotice(
          "Could not reach the Obsidian plugin.",
          "fail",
          "Obsidian is running but the 'Perplexity Saver' plugin is not responding on port 27124. Enable it in Obsidian Settings > Community Plugins.",
          FAILURE_NOTICE_MS,
        );
        focusZoteroWindow();
        return { ready: false, error: errMsg };
      }

      // 3. Obsidian is not running: launch it and poll until the server answers.
      startNotice(
        options.progressMessage || "Obsidian is not running. Launching...",
      );

      if (isCancelled()) {
        closeNotice();
        return { ready: false, error: "Obsidian connection cancelled." };
      }

      await launchObsidian();

      let sawProcess = false;
      for (let step = 1; step <= totalSteps; step++) {
        await Zotero.Promise.delay(POLL_INTERVAL_MS);

        if (isCancelled()) {
          closeNotice();
          return { ready: false, error: "Obsidian connection cancelled." };
        }

        if (await isObsidianServerReady()) {
          finishNotice(
            "Obsidian connected.",
            "success",
            undefined,
            SUCCESS_NOTICE_MS,
          );
          return { ready: true };
        }

        // Stop on wall-clock time so a slow HTTP check cannot stretch the
        // wait far beyond the advertised timeout.
        if (Date.now() >= deadline) break;

        // Latch once the process appears so we stop spawning tasklist/pgrep.
        if (!sawProcess && step % 5 === 0) {
          sawProcess = await isObsidianProcessRunning();
        }

        const progress = Math.min(95, Math.round((step / totalSteps) * 100));
        updateNotice(
          sawProcess
            ? "Obsidian started. Waiting for the Perplexity Saver plugin..."
            : options.progressMessage || "Launching Obsidian...",
          progress,
        );
      }

      const seconds = Math.round(maxWait / 1000);
      const timeoutMsg = `Obsidian was launched, but the 'Perplexity Saver' plugin did not respond on port 27124 within ${seconds} seconds.\n\nPlease ensure 'Perplexity Saver' is enabled in your vault's Community Plugins settings.`;
      finishNotice(
        "Could not connect to Obsidian.",
        "fail",
        `The 'Perplexity Saver' plugin did not respond within ${seconds} seconds. Check that it is enabled in your vault's Community Plugins settings.`,
        FAILURE_NOTICE_MS,
      );
      focusZoteroWindow();
      return { ready: false, error: timeoutMsg };
    } catch (e) {
      Zotero.debug(`[zoteroobsidian] ensureObsidianConnection error: ${e}`);
      finishNotice(
        "Obsidian connection failed.",
        "fail",
        String(e),
        FAILURE_NOTICE_MS,
      );
      return { ready: false, error: String(e) };
    } finally {
      activeConnectionPromise = null;
    }
  })();

  return activeConnectionPromise;
}

/**
 * Send an action payload to Obsidian's Perplexity Saver HTTP server.
 */
export async function postToObsidian(payload: any): Promise<any> {
  try {
    const resp = await Zotero.HTTP.request(
      "POST",
      "http://127.0.0.1:27124/lit-note",
      {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        // Obsidian may hold this request open while the user answers a modal
        // (e.g. note already exists), so allow well beyond the old 10s.
        timeout: 120000,
      },
    );

    if (resp.status >= 200 && resp.status < 300) {
      try {
        return JSON.parse(resp.responseText);
      } catch {
        return { success: false, error: "Invalid JSON response from Obsidian" };
      }
    } else {
      let errStr = resp.statusText;
      try {
        errStr = JSON.parse(resp.responseText).error || errStr;
      } catch {
        /* ignore */
      }
      return { success: false, error: `HTTP ${resp.status}: ${errStr}` };
    }
  } catch (err: any) {
    const msg = String(err?.message || err);
    return { success: false, error: msg };
  }
}
