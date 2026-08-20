import Addon from "../addon";
import { getCiteKey } from "./obsidianPayload";

export async function syncObsidianTags(
  addon: Addon,
  isManual: boolean = false,
) {
  try {
    addon.data.ztoolkit.log("Starting Obsidian tag sync...");

    const req = await (Zotero as any).HTTP.request(
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
    const tagName = String(
      (Zotero as any).Prefs.get(
        addon.data.config.prefsPrefix + ".obsidianTagName",
      ) || "obsLitNote",
    );

    // Set tag color globally for the user library
    try {
      await (Zotero as any).Tags.setColor(
        (Zotero as any).Libraries.userLibraryID,
        tagName,
        "#5cb85c",
      );
    } catch (e) {
      addon.data.ztoolkit.log("Failed to set tag color: " + e);
    }

    const items = await (Zotero as any).Items.getAll(
      (Zotero as any).Libraries.userLibraryID,
      false,
      false,
    );
    let added = 0;
    let removed = 0;

    let pw: any = null;
    if (isManual) {
      pw = new addon.data.ztoolkit.ProgressWindow("Obsidian Tag Sync", {
        closeOnClick: true,
      });
      pw.createLine({
        text: "Checking tags...",
        progress: 0,
      }).show(-1);
    }

    let i = 0;
    const total = items.length;

    for (const item of items) {
      if (item.isRegularItem()) {
        const citekey = await getCiteKey(item);
        const hasNote = obsCitekeys.has(citekey);
        const hasTag = item.hasTag(tagName);

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
        text: `Sync complete! Tags added: ${added}, Tags removed: ${removed}`,
        type: "success",
        progress: 100,
      }).show(3000);
    } else if (added > 0 || removed > 0) {
      // Show a disappearing notification automatically if things changed
      new addon.data.ztoolkit.ProgressWindow("Obsidian Tag Sync", {
        closeOnClick: true,
      })
        .createLine({
          text: `Tags added: ${added}, Tags removed: ${removed}`,
          type: "success",
          progress: 100,
        })
        .show(3000);
    }
  } catch (e) {
    addon.data.ztoolkit.log("Error in syncObsidianTags: " + e);
    if (isManual) {
      const win = (Zotero as any).getMainWindow();
      if (win) {
        let msg = String(e);
        let title = "Sync Error";
        if (
          msg.includes("fetch failed") ||
          msg.includes("Failed to fetch") ||
          msg.includes("NetworkError") ||
          msg.includes("Error connecting to server")
        ) {
          msg =
            "Connection to Obsidian failed.\n\nPlease ensure:\n1. Obsidian is currently running.\n2. The 'Perplexity Saver' plugin is installed and enabled in your Obsidian vault.";
          title = "Connection Error";
        }
        (Zotero as any).alert(win, title, msg);
      }
    }
  }
}
