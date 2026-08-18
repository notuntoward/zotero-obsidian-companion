export async function regenBibtexKey(items: any[]) {
  if (!(Zotero as any).BetterBibTeX) {
    (Zotero as any).warn('Better BibTeX is not installed. Cannot regenerate keys.');
    return;
  }

  await (Zotero as any).BetterBibTeX.ready;

  const selectedItems = Array.isArray(items) ? items : (items ? [items] : []);
  if (!selectedItems.length) {
    return;
  }

  const Services = (globalThis as any).Services;

  for (const item of selectedItems) {
    if (!item.isRegularItem()) continue;

    await item.reload();
    const oldKey = item.getField('citationKey') || '';

    // `propose()` is synchronous and returns a string (or falsy if no key).
    const proposedKey = (Zotero as any).BetterBibTeX.KeyManager.propose(item) || '';

    // Show the proposed key in a modal prompt
    const keyRef = { value: proposedKey };
    const accepted = Services.prompt.prompt(
      null,
      'Edit Citation Key',
      `${item.getField('title')}\n\nProposed key:`,
      keyRef,
      null,
      {}
    );

    if (!accepted) {
      break;
    }

    const finalKey = keyRef.value;
    if (finalKey && finalKey !== oldKey) {
      item.setField('citationKey', finalKey);
      await item.saveTx({ skipDateModifiedUpdate: true });
    }

    // Give BBT's background scheduler a moment to breathe
    await Zotero.Promise.delay(100);
  }
}
