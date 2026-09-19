/**
 * Centralized Obsidian connection, process detection, auto-launch, and communication service.
 */

declare const Zotero: any;
declare const addon: any;

export interface ConnectionOptions {
  progressMessage?: string;
  maxWaitMs?: number;
}

/**
 * Check if the Perplexity Saver HTTP server is responding on port 27124.
 */
export async function isObsidianServerReady(): Promise<boolean> {
  try {
    const resp = await Zotero.HTTP.request(
      "GET",
      "http://127.0.0.1:27124/lit-notes",
      { timeout: 1000 },
    );
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
    if (Zotero.isWin) {
      const output = await Zotero.Utilities.Internal.subprocess("tasklist", [
        "/fi",
        "IMAGENAME eq Obsidian.exe",
        "/nh",
      ]);
      return (
        typeof output === "string" &&
        output.toLowerCase().includes("obsidian.exe")
      );
    } else if (Zotero.isMac) {
      const output = await Zotero.Utilities.Internal.subprocess("pgrep", [
        "-x",
        "Obsidian",
      ]);
      return typeof output === "string" && output.trim().length > 0;
    } else {
      // Linux
      const output = await Zotero.Utilities.Internal.subprocess("pgrep", [
        "-i",
        "obsidian",
      ]);
      return typeof output === "string" && output.trim().length > 0;
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] Process check error: ${e}`);
    return false;
  }
}

/**
 * Request the operating system to launch Obsidian via its registered URI protocol handler.
 * Configures Zotero's handler service to avoid confirmation prompts and launches via OS shell.
 */
export async function launchObsidian(): Promise<void> {
  // 1. Tell Zotero's handler service not to ask before handling obsidian:// URIs
  try {
    const Components = (globalThis as any).Components;
    if (Components && Components.classes) {
      const eps = Components.classes[
        "@mozilla.org/uriloader/external-protocol-service;1"
      ]?.getService(Components.interfaces.nsIExternalProtocolService);
      const hs = Components.classes[
        "@mozilla.org/uriloader/handler-service;1"
      ]?.getService(Components.interfaces.nsIHandlerService);
      if (eps && hs) {
        const handlerInfo = eps.getProtocolHandlerInfo("obsidian");
        handlerInfo.preferredAction =
          Components.interfaces.nsIHandlerInfo.useSystemDefault;
        handlerInfo.alwaysAskBeforeHandling = false;
        hs.store(handlerInfo);
      }
    }
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] Handler service config error: ${e}`);
  }

  // 2. Launch via OS shell directly to avoid browser security confirmation dialogs
  try {
    if (Zotero.isWin) {
      await Zotero.Utilities.Internal.subprocess("cmd.exe", [
        "/c",
        "start",
        "",
        "obsidian://open",
      ]);
      return;
    } else if (Zotero.isMac) {
      await Zotero.Utilities.Internal.subprocess("open", ["obsidian://open"]);
      return;
    } else if (Zotero.isLinux) {
      await Zotero.Utilities.Internal.subprocess("xdg-open", [
        "obsidian://open",
      ]);
      return;
    }
  } catch (e) {
    Zotero.debug(
      `[zoteroobsidian] Shell launch error, falling back to launchURL: ${e}`,
    );
  }

  // 3. Fallback to standard Zotero.launchURL
  try {
    Zotero.launchURL("obsidian://open");
  } catch (e) {
    Zotero.debug(`[zoteroobsidian] Failed to launch Obsidian via URI: ${e}`);
  }
}

/**
 * Ensure Obsidian and the Perplexity Saver plugin server are ready.
 * If Obsidian is closed, it automatically launches Obsidian, displays a progress indicator,
 * and polls until the server answers.
 */
export async function ensureObsidianConnection(
  options: ConnectionOptions = {},
): Promise<{ ready: boolean; error?: string }> {
  // 1. Fast check: is Obsidian server already running and responsive?
  if (await isObsidianServerReady()) {
    return { ready: true };
  }

  // 2. Check if the Obsidian process is active on the OS
  const isRunning = await isObsidianProcessRunning();

  if (!isRunning) {
    // Obsidian is closed: launch it and wait for it to be ready
    const maxWait = options.maxWaitMs ?? 15000;
    const interval = 600;
    const totalSteps = Math.ceil(maxWait / interval);

    let pw: any = null;
    try {
      const toolkit = addon?.data?.ztoolkit;
      if (toolkit && toolkit.ProgressWindow) {
        pw = new toolkit.ProgressWindow("Obsidian", {
          closeOnClick: true,
        });
        pw.createLine({
          text:
            options.progressMessage ||
            "Obsidian is not running. Launching Obsidian...",
          progress: 0,
        }).show(-1);
      }
    } catch (e) {
      Zotero.debug(`[zoteroobsidian] ProgressWindow error: ${e}`);
    }

    await launchObsidian();

    for (let step = 1; step <= totalSteps; step++) {
      await Zotero.Promise.delay(interval);

      if (pw && typeof pw.changeLine === "function") {
        const progressPercent = Math.min(
          95,
          Math.round((step / totalSteps) * 100),
        );
        pw.changeLine({
          text:
            options.progressMessage ||
            "Waiting for Obsidian and Perplexity Saver to start...",
          progress: progressPercent,
        });
      }

      if (await isObsidianServerReady()) {
        if (pw) {
          if (typeof pw.changeLine === "function") {
            pw.changeLine({
              text: "Obsidian connected.",
              type: "success",
              progress: 100,
            });
          }
          if (typeof pw.show === "function") {
            pw.show(1200);
          } else {
            setTimeout(() => {
              try {
                if (typeof pw?.win?.close === "function") {
                  pw.win.close();
                } else if (typeof pw?.close === "function") {
                  pw.close();
                }
              } catch {
                /* ignore */
              }
            }, 1200);
          }
        }
        return { ready: true };
      }
    }

    // Timed out
    try {
      if (typeof pw?.win?.close === "function") {
        pw.win.close();
      } else if (typeof pw?.close === "function") {
        pw.close();
      }
    } catch {
      /* ignore */
    }

    return {
      ready: false,
      error:
        "Obsidian was launched, but the 'Perplexity Saver' plugin did not respond on port 27124 within 15 seconds.\n\nPlease ensure 'Perplexity Saver' is enabled in your vault's Community Plugins settings.",
    };
  }

  // 3. Process is already running, but port 27124 was not responding yet.
  // Give it a brief grace period (2.5s) in case it is currently starting up
  for (let i = 0; i < 5; i++) {
    await Zotero.Promise.delay(500);
    if (await isObsidianServerReady()) {
      return { ready: true };
    }
  }

  return {
    ready: false,
    error:
      "Obsidian is currently running, but the 'Perplexity Saver' plugin is not responding on port 27124.\n\nPlease ensure the 'Perplexity Saver' plugin is installed and enabled in your Obsidian vault's Community Plugins settings.",
  };
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
        timeout: 10000,
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
