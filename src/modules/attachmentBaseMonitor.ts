import {
  getObsidianProcessState,
  isObsidianServerReady,
  postToObsidian,
} from "./obsidianConnection";
import { showDismissibleNotice } from "../utils/progressNotice";

declare const Zotero: any;
declare const addon: any;

let observer: symbol | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let lastWarning = "";
let dismissWarning: (() => void) | undefined;
let validatedBaseDirectory = "";
let validationState: "pending" | "valid" | "invalid" = "pending";

function setWarning(warning: string): void {
  if (warning === lastWarning) return;
  dismissWarning?.();
  dismissWarning = undefined;
  lastWarning = "";
  if (!warning) return;
  Zotero.logError(`[Obsidian attachment check] ${warning}`);
  dismissWarning = showDismissibleNotice(warning, {
    type: "fail",
    timeoutMs: 15000,
  });
  if (dismissWarning) lastWarning = warning;
}

function waitForServer(current: number): void {
  timer = setTimeout(async () => {
    let ready = false;
    try {
      ready = await isObsidianServerReady();
    } catch (error) {
      Zotero.logError(
        `[Obsidian attachment check] Server readiness failed: ${error}`,
      );
    }
    if (!addon.data.alive || current !== generation) return;
    if (ready) {
      setWarning("");
      void check();
    } else {
      waitForServer(current);
    }
  }, 5000);
}

async function check(): Promise<void> {
  const current = ++generation;
  if (timer) clearTimeout(timer);
  timer = undefined;
  let connectionFailed = false;
  try {
    const preference = Zotero.Prefs.get("baseAttachmentPath");
    if (preference !== undefined && typeof preference !== "string")
      throw new Error("Zotero returned an invalid base directory setting");
    const baseDirectory = preference || "";
    validatedBaseDirectory = "";
    validationState = "pending";
    const result = await postToObsidian({
      action: "check-attachment-base",
      baseDirectory,
    });
    if (!addon.data.alive || current !== generation) return;
    if (result?.success && result.relationship === "inside") {
      validatedBaseDirectory = baseDirectory;
      validationState = "valid";
    } else if (result?.success) {
      validationState = "invalid";
    } else if (!result?.connectionError) {
      validationState = "invalid";
    }
    let warning = "";
    if (result?.connectionError) {
      connectionFailed = true;
      const state = await getObsidianProcessState();
      if (!addon.data.alive || current !== generation) return;
      warning =
        state === "stopped"
          ? "Open Obsidian to check Zotero's Linked Attachment Base Directory. Obsidian is not running; the check will retry automatically."
          : state === "running"
            ? "Open the intended vault and check that Perplexity Saver is enabled. Obsidian is running, but its local server is not responding; the check will retry automatically."
            : "Open Obsidian and check that Perplexity Saver is enabled. Its local server did not respond, and the Obsidian process state could not be determined; the check will retry automatically.";
      Zotero.debug(
        `[Obsidian attachment check] Local request failed: ${result.error}`,
      );
    } else if (!result?.success) {
      warning = `Check Zotero's Linked Attachment Base Directory and the open Obsidian vault. The directory check failed: ${result?.error || "invalid response"}. The check will retry automatically.`;
    } else if (
      result.relationship === "outside" &&
      typeof result.vaultPath === "string"
    ) {
      warning = `Check each relative linked attachment in Zotero. The Linked Attachment Base Directory (${baseDirectory}) is outside the open Obsidian vault (${result.vaultPath}), so linked files may resolve outside the vault. This setting does not affect stored attachments or move files.`;
    } else if (!["inside", "unset"].includes(result.relationship)) {
      warning =
        "Check that Perplexity Saver is up to date in Obsidian. It returned an unrecognized attachment-directory result; the check will retry automatically.";
    }
    setWarning(warning);
  } catch (error) {
    if (!addon.data.alive || current !== generation) return;
    validationState = "pending";
    const warning = `Check Zotero's Linked Attachment Base Directory and try again. The check failed: ${error instanceof Error ? error.message : String(error)}. The check will retry automatically.`;
    setWarning(warning);
  } finally {
    if (addon.data.alive && current === generation) {
      if (timer) clearTimeout(timer);
      if (connectionFailed) waitForServer(current);
      else
        timer = setTimeout(() => {
          void check();
        }, 60000);
    }
  }
}

export function startAttachmentBaseMonitor(): void {
  observer = Zotero.Prefs.registerObserver("baseAttachmentPath", () => {
    void check();
  });
  void check();
}

export function stopAttachmentBaseMonitor(): void {
  generation++;
  if (observer) Zotero.Prefs.unregisterObserver(observer);
  observer = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  setWarning("");
  validatedBaseDirectory = "";
  validationState = "pending";
}

export function getValidatedAttachmentBaseDirectory(): string {
  return validatedBaseDirectory;
}

export function getAttachmentBaseValidationState():
  "pending" | "valid" | "invalid" {
  return validationState;
}
