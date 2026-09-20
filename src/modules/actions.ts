/**
 * Shared actions invoked from item context menus and keyboard shortcuts.
 */

import { getItemPayload } from "./obsidianPayload";
import { getObsidianTagName, syncObsidianTags } from "./obsidianTagSync";
import { regenBibtexKey } from "./regenBibtex";
import { ensureObsidianConnection, postToObsidian } from "./obsidianConnection";
import { toggleLeftPane, toggleRightPane } from "../utils/paneUtils";
import { getMainWindow, showAlert } from "../utils/alert";

declare const Zotero: any;
declare const addon: any;

type LitNoteStatus =
  | "created"
  | "overwritten"
  | "opened"
  | "skipped"
  | "missing"
  | "error";

interface LitNoteItemResult {
  citekey: string;
  status: LitNoteStatus;
  error?: string;
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

/**
 * Build a payload for every selected item. Returns null (after alerting) if any
 * payload cannot be built, so a batch is never partially created.
 */
async function buildPayloads(
  win: any,
  targets: any[],
): Promise<{ item: any; payload: any }[] | null> {
  const pairs: { item: any; payload: any }[] = [];
  for (const item of targets) {
    try {
      pairs.push({ item, payload: await getItemPayload(item) });
    } catch (e) {
      showAlert(win, "Error", String(e));
      return null;
    }
  }
  return pairs;
}

async function tagCreatedNotes(
  pairs: { item: any; payload: any }[],
  results: LitNoteItemResult[],
): Promise<void> {
  const itemByCitekey = new Map<string, any>();
  for (const { item, payload } of pairs) {
    if (payload.citekey) itemByCitekey.set(payload.citekey, item);
  }
  for (const result of results) {
    if (
      result.status === "created" ||
      result.status === "overwritten" ||
      result.status === "opened"
    ) {
      const item = itemByCitekey.get(result.citekey);
      if (!item) continue;
      try {
        await tagItem(item);
      } catch (e) {
        Zotero.logError(e as any);
      }
    }
  }
}

/** Extract error results for a single alert instead of one dialog per note. */
function collectErrors(json: any): string[] {
  const results = readResults(json);
  const errors = results
    .filter((r) => r.status === "error")
    .map((r) => `${r.citekey || "(unknown)"}: ${r.error || "Unknown error"}`);
  // Older Obsidian plugin builds reply with { success, error } and no results.
  if (!results.length && json && json.success === false && json.error) {
    errors.push(String(json.error));
  }
  return errors;
}

function readResults(json: any): LitNoteItemResult[] {
  return Array.isArray(json?.results) ? json.results : [];
}

/**
 * Create (or overwrite) lit notes for the selected items. Any decision about an
 * existing note is made in Obsidian's modal, so no Zotero dialog can be hidden
 * behind the Obsidian window.
 */
export async function createLitNotes(items: any[]): Promise<void> {
  const targets = regularItems(items);
  if (!targets.length) return;
  const win = getMainWindow();

  try {
    const pairs = await buildPayloads(win, targets);
    if (!pairs) return;

    const conn = await ensureObsidianConnection({
      progressMessage: "Launching Obsidian for literature note...",
    });
    if (!conn.ready) {
      // Connection failure is already shown non-intrusively in the
      // ProgressWindow affixed to the Zotero window.
      return;
    }

    const json = await postToObsidian({
      action: "create",
      data: pairs.map((p) => p.payload),
    });
    const results = readResults(json);
    await tagCreatedNotes(pairs, results);

    const errors = collectErrors(json);
    if (errors.length) {
      showAlert(win, "Obsidian Plugin Error", errors.join("\n"));
    }
  } catch (err) {
    Zotero.logError(err as any);
    showAlert(win, "Error", String(err));
  }
}

/**
 * Open (or, if missing, offer to create) lit notes for the selected items.
 * Missing-note decisions also happen in Obsidian.
 */
export async function openLitNote(items: any[]): Promise<void> {
  const targets = regularItems(items);
  if (!targets.length) return;
  const win = getMainWindow();

  try {
    const pairs = await buildPayloads(win, targets);
    if (!pairs) return;

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
      data: pairs.map((p) => p.payload),
    });

    const errors = collectErrors(json);
    if (errors.length) {
      showAlert(win, "Obsidian Plugin Error", errors.join("\n"));
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
