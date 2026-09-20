/**
 * Shared actions invoked from item context menus and keyboard shortcuts.
 */

import { getItemPayload } from "./obsidianPayload";
import { getObsidianTagName, syncObsidianTags } from "./obsidianTagSync";
import { regenBibtexKey } from "./regenBibtex";
import { ensureObsidianConnection, postToObsidian } from "./obsidianConnection";
import { toggleLeftPane, toggleRightPane } from "../utils/paneUtils";

declare const Zotero: any;
declare const addon: any;

function getMainWindow(): any {
  return typeof Zotero.getMainWindow === "function"
    ? Zotero.getMainWindow()
    : null;
}

function showAlert(win: any, title: string, message: string): void {
  const targetWin = win || getMainWindow();
  if (targetWin && typeof targetWin.focus === "function") {
    try {
      targetWin.focus();
    } catch {
      /* ignore */
    }
  }
  Zotero.alert(targetWin, title, message);
}

export function getSelectedItems(): any[] {
  const pane =
    (typeof Zotero.getActiveZoteroPane === "function"
      ? Zotero.getActiveZoteroPane()
      : null) ?? getMainWindow()?.ZoteroPane;
  return pane?.getSelectedItems?.() ?? [];
}

export function regularItems(items: any[]): any[] {
  return (Array.isArray(items) ? items : []).filter((item: any) =>
    item?.isRegularItem?.(),
  );
}

async function tagItem(item: any): Promise<void> {
  item.addTag(getObsidianTagName(addon));
  await item.saveTx();
}

export function paneTogglesEnabled(): boolean {
  const show = Zotero.Prefs.get(
    addon.data.config.prefsPrefix + ".showPaneToggles",
    true,
  );
  return !(show === false || show === "false");
}

export function toggleLeftPaneAction(): void {
  toggleLeftPane();
}

export function toggleRightPaneAction(): void {
  toggleRightPane();
}

function confirmOverwrite(win: any, citekey: string): number | null {
  const Services = (globalThis as any).Services;
  if (!Services?.prompt) return null;
  if (win && typeof win.focus === "function") {
    try {
      win.focus();
    } catch {
      /* ignore */
    }
  }
  const flags =
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1 +
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_2;
  return Services.prompt.confirmEx(
    win,
    "Overwrite Note?",
    `The note for '${citekey}' already exists in Obsidian. Do you want to overwrite it?`,
    flags,
    "Overwrite",
    "Skip",
    "Cancel",
    null,
    {},
  );
}

export async function createLitNotes(items: any[]): Promise<void> {
  const targets = regularItems(items);
  if (!targets.length) return;
  const win = getMainWindow();

  try {
    const conn = await ensureObsidianConnection({
      progressMessage: "Launching Obsidian for literature note...",
    });
    if (!conn.ready) {
      // Connection failure is already shown non-intrusively in the
      // ProgressWindow affixed to the Zotero window.
      return;
    }

    for (const item of targets) {
      const payload = await getItemPayload(item);
      let json = await postToObsidian({ action: "create", data: [payload] });
      if (!json) continue;

      if (json.success) {
        await tagItem(item);
        continue;
      }

      if (json.error === "exists") {
        const result = confirmOverwrite(win, payload.citekey);
        if (result === null) {
          showAlert(
            win,
            "File Exists",
            `The note for '${payload.citekey}' already exists.`,
          );
        } else if (result === 0) {
          json = await postToObsidian({
            action: "create",
            data: [payload],
            force: true,
          });
          if (json && json.success) {
            await tagItem(item);
          } else {
            showAlert(
              win,
              "Obsidian Plugin Error",
              json?.error || "Unknown error",
            );
          }
        } else if (result === 2) {
          break;
        }
      } else {
        showAlert(win, "Obsidian Plugin Error", json.error || "Unknown error");
      }
    }
  } catch (err) {
    Zotero.logError(err as any);
    showAlert(win, "Error", String(err));
  }
}

export async function openLitNote(items: any[]): Promise<void> {
  const targets = regularItems(items);
  if (!targets.length) return;
  const win = getMainWindow();

  try {
    const payload = await getItemPayload(targets[0]);
    if (!payload.citekey) {
      showAlert(win, "Error", "No citekey found for item");
      return;
    }

    const conn = await ensureObsidianConnection({
      progressMessage: "Launching Obsidian to open note...",
    });
    if (!conn.ready) {
      // Connection failure is already shown non-intrusively in the
      // ProgressWindow affixed to the Zotero window.
      return;
    }

    const json = await postToObsidian({
      action: "open",
      citekey: payload.citekey,
    });
    if (json && !json.success) {
      if (json.error && json.error.includes("not found")) {
        showAlert(
          win,
          "Note Missing",
          `The note for '${payload.citekey}' does not exist in the Obsidian vault.`,
        );
      } else {
        showAlert(win, "Obsidian Plugin Error", json.error || "Unknown error");
      }
    }
  } catch (err) {
    Zotero.logError(err as any);
    showAlert(win, "Error", String(err));
  }
}

export async function regenerateCitationKeys(items: any[]): Promise<void> {
  const targets = regularItems(items);
  if (!targets.length) return;
  const win = getMainWindow();
  try {
    await regenBibtexKey(targets);
  } catch (e) {
    Zotero.warn("Menu Error: " + String(e));
    showAlert(win, "Error", String(e));
  }
}

export async function syncHasNoteIndicators(): Promise<void> {
  const win = getMainWindow();
  try {
    await syncObsidianTags(addon, true);
  } catch (e) {
    Zotero.warn("Menu Error: " + String(e));
    showAlert(win, "Error", String(e));
  }
}
