import { focusMainWindow, getMainWindow, showAlert } from "../utils/alert";

export async function regenBibtexKey(items: any[]) {
  if (!(Zotero as any).BetterBibTeX) {
    showAlert(
      getMainWindow(),
      "Obsidian",
      "Better BibTeX is not installed. Cannot regenerate keys.",
    );
    return;
  }

  await (Zotero as any).BetterBibTeX.ready;

  const selectedItems = Array.isArray(items) ? items : items ? [items] : [];
  if (!selectedItems.length) {
    return;
  }

  const win = getMainWindow();
  const Services = (globalThis as any).Services;

  for (const item of selectedItems) {
    if (!item.isRegularItem()) continue;

    await item.reload();
    const oldKey = item.getField("citationKey") || "";

    // propose() is synchronous and returns a string (or falsy if no key).
    const proposedKey =
      (Zotero as any).BetterBibTeX.KeyManager.propose(item) || "";

    let finalKey = "";
    if (win && Services?.prompt) {
      focusMainWindow(win);
      const input = { value: proposedKey };
      const confirmed = Services.prompt.prompt(
        win,
        "Edit Citation Key",
        `${item.getField("title")}\n\nProposed key:`,
        input,
        null,
        {},
      );
      if (!confirmed) {
        break; // user cancelled
      }
      finalKey = input.value;
    } else {
      finalKey = proposedKey; // fallback silently if no UI
    }

    if (finalKey && finalKey !== oldKey) {
      item.setField("citationKey", finalKey);
      await item.saveTx({ skipDateModifiedUpdate: true });
    }

    // Give BBT's background scheduler a moment to breathe
    await Zotero.Promise.delay(100);
  }
}
