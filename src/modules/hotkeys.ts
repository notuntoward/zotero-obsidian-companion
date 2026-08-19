import Addon from "../addon";
import { KeyModifier } from "zotero-plugin-toolkit";
import { syncObsidianTags } from "./obsidianTagSync";
import { regenBibtexKey } from "./regenBibtex";

export function registerHotkeys() {
  addon.data.ztoolkit.Keyboard.register(async (event, options) => {
    if (options.type !== "keydown") return;

    const target = event.target as HTMLElement;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    const shortcut = new KeyModifier(event);

    // Ignore lone modifiers
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;

    const prefs = [
      { key: "hotkeyCreateLitNote", action: handleCreateLitNote },
      { key: "hotkeyOpenLitNote", action: handleOpenLitNote },
      { key: "hotkeySyncTags", action: handleSyncTags },
      { key: "hotkeyToggleLeftPane", action: handleToggleLeftPane },
      { key: "hotkeyToggleRightPane", action: handleToggleRightPane },
      { key: "hotkeyRegenBibtexKey", action: handleRegenBibtexKey },
    ];

    for (const pref of prefs) {
      const savedHotkeyStr = String(
        (Zotero as any).Prefs.get("zoteroobsidian." + pref.key) || "",
      );
      if (savedHotkeyStr) {
        // Use ztoolkit's robust equality check
        const savedShortcut = new KeyModifier(savedHotkeyStr);
        if (savedShortcut.equals(shortcut)) {
          event.preventDefault();
          event.stopPropagation();
          await pref.action();
          return;
        }
      }
    }
  });
}

async function handleCreateLitNote() {
  const win = (Zotero as any).getMainWindow();
  if (!win) return;
  const items = win.ZoteroPane.getSelectedItems();
  if (!items || items.length === 0) return;
  const menuItemId = `${addon.data.config.addonRef}-itemmenu-create-lit-note`;
  const menuItem = win.document.getElementById(menuItemId);
  if (menuItem) {
    menuItem.doCommand();
  } else {
    win.ZoteroPane.doCommand("zotero-obsidian-companion-create-lit-note");
  }
}

async function handleSyncTags() {
  await syncObsidianTags(addon, true);
}

async function handleToggleLeftPane() {
  const win = (Zotero as any).getMainWindow();
  if (!win) return;
  const doc = win.document;
  const leftPane = doc.getElementById("zotero-collections-pane");
  if (leftPane) {
    if (leftPane.hasAttribute("hidden")) {
      leftPane.removeAttribute("hidden");
      leftPane.removeAttribute("collapsed");
    } else if (leftPane.hasAttribute("collapsed")) {
      leftPane.removeAttribute("collapsed");
    } else {
      leftPane.setAttribute("hidden", "true");
    }
  }
}

async function handleToggleRightPane() {
  const win = (Zotero as any).getMainWindow();
  if (!win) return;
  const doc = win.document;
  const rightPane = doc.getElementById("zotero-item-pane");
  if (rightPane) {
    if (rightPane.hasAttribute("hidden")) {
      rightPane.removeAttribute("hidden");
      rightPane.removeAttribute("collapsed");
    } else if (rightPane.hasAttribute("collapsed")) {
      rightPane.removeAttribute("collapsed");
    } else {
      rightPane.setAttribute("hidden", "true");
    }
  }
}

async function handleRegenBibtexKey() {
  const win = (Zotero as any).getMainWindow();
  if (!win) return;
  const items = win.ZoteroPane.getSelectedItems();
  if (!items || items.length === 0) return;
  await regenBibtexKey(items);
}

async function handleOpenLitNote() {
  const win = (Zotero as any).getMainWindow();
  if (!win) return;
  const menuItemId = `${addon.data.config.addonRef}-itemmenu-open-lit-note`;
  const menuItem = win.document.getElementById(menuItemId);
  if (menuItem) {
    menuItem.doCommand();
  }
}
