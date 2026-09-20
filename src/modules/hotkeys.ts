import { KeyModifier } from "zotero-plugin-toolkit";
import {
  createLitNotes,
  openLitNote,
  regenerateCitationKeys,
  syncHasNoteIndicators,
  toggleLeftPaneAction,
  toggleRightPaneAction,
  getSelectedItems,
} from "./actions";

declare const Zotero: any;
declare const addon: any;

export function registerHotkeys() {
  addon.data.ztoolkit.Keyboard.register(
    async (event: KeyboardEvent, options: { type: string }) => {
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
    },
  );
}

async function handleCreateLitNote() {
  await createLitNotes(getSelectedItems());
}

async function handleOpenLitNote() {
  await openLitNote(getSelectedItems());
}

async function handleSyncTags() {
  await syncHasNoteIndicators();
}

async function handleToggleLeftPane() {
  toggleLeftPaneAction();
}

async function handleToggleRightPane() {
  toggleRightPaneAction();
}

async function handleRegenBibtexKey() {
  await regenerateCitationKeys(getSelectedItems());
}
