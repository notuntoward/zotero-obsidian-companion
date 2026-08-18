import Addon from "../addon";
import { KeyModifier } from "zotero-plugin-toolkit";

export function registerPrefsScripts(_window: Window): void {
  addon.data.prefs = {
    window: _window,
    columns: [],
    rows: [],
  };

  const doc = _window.document;
  const prefs = [
    "hotkeyCreateLitNote",
    "hotkeyOpenLitNote",
    "hotkeySyncTags",
    "hotkeyToggleLeftPane",
    "hotkeyToggleRightPane",
  ];

  for (const pref of prefs) {
    const inputId = `zotero-prefpane-${addon.data.config.addonRef}-${pref}`;
    const warnId = `zotero-prefpane-${addon.data.config.addonRef}-warn${pref.replace('hotkey', '')}`;
    const input = doc.getElementById(inputId) as HTMLInputElement;
    const warn = doc.getElementById(warnId) as HTMLElement;

    if (!input || !warn) continue;

    // Manual initialization
    const saved = (Zotero as any).Prefs.get("zoteroobsidian." + pref);
    if (saved) {
      input.value = String(saved);
    }

    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Backspace' || e.key === 'Escape') {
        input.value = "";
        (Zotero as any).Prefs.set("zoteroobsidian." + pref, "");
        warn.hidden = true;
        return;
      }

      const mod = new KeyModifier(e as any);
      const hotkeyString = mod.getLocalized();
      input.value = hotkeyString;
      (Zotero as any).Prefs.set("zoteroobsidian." + pref, hotkeyString);

      const conflict = checkConflict(hotkeyString);
      if (conflict) {
        warn.textContent = `Conflicts with: ${conflict}`;
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    });
  }
}

function checkConflict(hotkeyString: string): string | null {
  const win = (Zotero as any).getMainWindow();
  if (!win) return null;
  const keys = win.document.querySelectorAll("key");
  for (const key of Array.from(keys)) {
    const modifiers = (key as Element).getAttribute("modifiers") || "";
    const keycode = (key as Element).getAttribute("key") || (key as Element).getAttribute("keycode") || "";
    
    const zoteroModStr = modifiers.toLowerCase();
    const hasCtrl = zoteroModStr.includes("control") || zoteroModStr.includes("accel");
    const hasAlt = zoteroModStr.includes("alt");
    const hasShift = zoteroModStr.includes("shift");
    const hasMeta = zoteroModStr.includes("meta");

    const myModStr = hotkeyString.toLowerCase();
    const myHasCtrl = myModStr.includes("ctrl") || myModStr.includes("accel");
    const myHasAlt = myModStr.includes("alt");
    const myHasShift = myModStr.includes("shift");
    const myHasMeta = myModStr.includes("meta");

    if (hasCtrl === myHasCtrl && hasAlt === myHasAlt && hasShift === myHasShift && hasMeta === myHasMeta) {
       let keyLetter = keycode.replace('VK_', '').toLowerCase();
       let myKeyLetter = hotkeyString.split('+').pop()?.trim().toLowerCase();
       if (keyLetter === myKeyLetter) {
         return (key as Element).getAttribute("id") || "Unknown Command";
       }
    }
  }
  return null;
}
