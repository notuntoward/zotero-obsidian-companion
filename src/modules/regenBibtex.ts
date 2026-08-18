export async function regenBibtexKey(items: any[]) {
  if (!(Zotero as any).BetterBibTeX) {
    const win = (Zotero as any).getMainWindow();
    if (win) {
      win.alert('Better BibTeX is not installed. Cannot regenerate keys.');
    }
    return;
  }

  await (Zotero as any).BetterBibTeX.ready;

  const selectedItems = Array.isArray(items) ? items : (items ? [items] : []);
  if (!selectedItems.length) {
    return;
  }

  const win = (Zotero as any).getMainWindow();

  for (const item of selectedItems) {
    if (!item.isRegularItem()) continue;

    await item.reload();
    const oldKey = item.getField('citationKey') || '';

    // propose() is synchronous and returns a string (or falsy if no key).
    const proposedKey = (Zotero as any).BetterBibTeX.KeyManager.propose(item) || '';

    let finalKey = "";
    if (win && win.prompt) {
      const response = win.prompt(
        "Edit Citation Key\n\n" + item.getField('title') + "\n\nProposed key:",
        proposedKey
      );
      if (response === null) {
        break; // user cancelled
      }
      finalKey = response;
    } else {
      finalKey = proposedKey; // fallback silently if no UI
    }

    if (finalKey && finalKey !== oldKey) {
      item.setField('citationKey', finalKey);
      await item.saveTx({ skipDateModifiedUpdate: true });
    }

    // Give BBT's background scheduler a moment to breathe
    await Zotero.Promise.delay(100);
  }
}
