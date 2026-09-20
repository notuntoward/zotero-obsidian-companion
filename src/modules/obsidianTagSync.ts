import Addon from "../addon";
import { getCiteKey } from "./obsidianPayload";
import {
  ensureObsidianConnection,
  isObsidianServerReady,
} from "./obsidianConnection";
import { applyCompactProgressStyle } from "../utils/progressNotice";
import { showAlert } from "../utils/alert";

declare const Zotero: any;

/**
 * Resolve the configured Obsidian tag name. Shared by note creation and
 * has-note tag syncing so both always agree on the tag.
 */
export function getObsidianTagName(addon: Addon): string {
  return String(
    Zotero.Prefs.get(
      addon.data.config.prefsPrefix + ".obsidianTagName",
      true,
    ) || "obsLitNote",
  );
}

export async function syncObsidianTags(
  addon: Addon,
  isManual: boolean = false,
) {
  try {
    addon.data.ztoolkit.log("Starting Obsidian tag sync...");

    if (isManual) {
      const conn = await ensureObsidianConnection({
        progressMessage: "Launching Obsidian to sync tags...",
      });
      if (!conn.ready) {
        // Connection failure is already shown non-intrusively in ProgressWindow affixed to Zotero
        return;
      }
    } else {
      // In background mode, skip silently if Obsidian is not already open
      const ready = await isObsidianServerReady();
      if (!ready) {
        addon.data.ztoolkit.log(
          "Obsidian server is not responding; skipping background tag sync.",
        );
        return;
      }
    }

    const req = await Zotero.HTTP.request(
      "GET",
      "http://127.0.0.1:27124/lit-notes",
    );
    if (req.status !== 200) {
      addon.data.ztoolkit.log(
        "Failed to fetch lit-notes from Obsidian, status: " + req.status,
      );
      return;
    }
    const data = JSON.parse(req.responseText);
    if (!data.success || !Array.isArray(data.citekeys)) {
      addon.data.ztoolkit.log("Invalid payload from Obsidian /lit-notes");
      return;
    }

    const obsCitekeys = new Set(data.citekeys);

    // Get setting
    const tagName = getObsidianTagName(addon);

    // Set tag color globally for the user library
    try {
      await Zotero.Tags.setColor(
        Zotero.Libraries.userLibraryID,
        tagName,
        "#5cb85c",
      );
    } catch (e) {
      addon.data.ztoolkit.log("Failed to set tag color: " + e);
    }

    const items = await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
      false,
      false,
    );
    let added = 0;
    let removed = 0;
    let itemsWithNotes = 0;

    let pw: any = null;
    if (isManual) {
      pw = new addon.data.ztoolkit.ProgressWindow("Obsidian Tag Sync", {
        closeOnClick: true,
      });
      pw.createLine({
        text: "Checking tags...",
        progress: 0,
      }).show(-1);
      applyCompactProgressStyle(pw.lines?.[0]);
    }

    let i = 0;
    const total = items.length;

    for (const item of items) {
      if (item.isRegularItem()) {
        const citekey = await getCiteKey(item);
        const hasNote = obsCitekeys.has(citekey);
        const hasTag = item.hasTag(tagName);
        if (hasNote) itemsWithNotes++;

        if (hasNote && !hasTag) {
          item.addTag(tagName);
          await item.saveTx();
          added++;
        } else if (!hasNote && hasTag) {
          item.removeTag(tagName);
          await item.saveTx();
          removed++;
        }
      }

      i++;
      if (isManual && i % 50 === 0) {
        pw.changeLine({
          text: `Checking items: ${i} of ${total}`,
          progress: (i / total) * 100,
        });
      }
    }

    addon.data.ztoolkit.log(
      `Obsidian tag sync complete. Added: ${added}, Removed: ${removed}, Total checked: ${items.length}, Citekeys from Obsidian: ${obsCitekeys.size}`,
    );

    if (isManual) {
      pw.changeLine({
        text: `Sync complete! ${itemsWithNotes} of ${total} items have notes. (Added: ${added}, Removed: ${removed})`,
        type: "success",
        progress: 100,
      }).show(8000);
    } else if (added > 0 || removed > 0) {
      // Show a disappearing notification automatically if things changed
      const notice: any = new addon.data.ztoolkit.ProgressWindow(
        "Obsidian Tag Sync",
        {
          closeOnClick: true,
        },
      ).createLine({
        text: `${itemsWithNotes} items have notes. (Added: ${added}, Removed: ${removed})`,
        type: "success",
        progress: 100,
      });
      notice.show(8000);
      applyCompactProgressStyle(notice.lines?.[0]);
    }
  } catch (e) {
    addon.data.ztoolkit.log("Error in syncObsidianTags: " + e);
    if (isManual) {
      showAlert(Zotero.getMainWindow(), "Sync Error", String(e));
    }
  }
}
