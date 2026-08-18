import { getString } from "../utils/locale";
import { getItemPayload } from "./obsidianPayload";
import Addon from "../addon";
import { ZoteroToolkit } from "zotero-plugin-toolkit";

async function postToObsidian(payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      // Use the localhost URL format required by Obsidian
      xhr.open("POST", "http://127.0.0.1:27124/litnote", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");

      xhr.timeout = 5000;
      
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch(e) {
            resolve({ success: false, error: "Invalid JSON response" });
          }
        } else {
          let errStr = xhr.statusText;
          try { errStr = JSON.parse(xhr.responseText).error || errStr; } catch(e){}
          resolve({ success: false, error: `HTTP ${xhr.status}: ${errStr}` });
        }
      };
      
      xhr.onerror = function() {
        resolve({ success: false, error: "Connection to Obsidian failed. Is Obsidian open?" });
      };
      
      xhr.ontimeout = function() {
        resolve({ success: false, error: "Connection timed out." });
      };

      xhr.send(JSON.stringify(payload));
    } catch(err) {
      resolve({ success: false, error: String(err) });
    }
  });
}

export function registerItemMenu(ztoolkit: ZoteroToolkit) {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`;

  // 1. Obsidian Sub-Menu
  ztoolkit.Menu.register("item", {
    tag: "menu",
    id: `${addon.data.config.addonRef}-itemmenu-obsidian-submenu`,
    label: "Obsidian",
    icon: menuIcon,
    children: [
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-create-lit-note`,
        label: "Create Lit Note",
        icon: menuIcon,
        commandListener: () => {
          (async () => {
            try {
              let pane = undefined;
              if (typeof Zotero.getActiveZoteroPane === "function") {
                pane = Zotero.getActiveZoteroPane();
              }
              if (!pane) {
                const win = Zotero.getMainWindow();
                pane = win ? (win as any).ZoteroPane : null;
              }
              if (!pane) throw new Error("Could not find ZoteroPane");

              const items = pane.getSelectedItems().filter((item: any) => item.isRegularItem());
              if (!items.length) return;
              
              const Services = (globalThis as any).Services;
              const win = Zotero.getMainWindow();

              for (const item of items) {
                const payload = await getItemPayload(item);
                let json = await postToObsidian({ action: "create", data: [payload] });
                if (!json) continue;
                
                if (json.success) {
                  const tagName = String((Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".obsidianTagName", true) || "obsLitNote");
                  item.addTag(tagName);
                  await item.saveTx();
                } else if (json.error === "exists") {
                  if (Services && Services.prompt) {
                    const flags = (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0) +
                                 (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1) +
                                 (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_2);
                    const result = Services.prompt.confirmEx(
                      win, "Overwrite Note?", `The note for '${payload.citekey}' already exists in Obsidian. Do you want to overwrite it?`,
                      flags, "Overwrite", "Skip", "Cancel", null, {}
                    );
                    
                    if (result === 0) { // Overwrite
                      json = await postToObsidian({ action: "create", data: [payload], force: true });
                      if (json && !json.success) {
                        Zotero.alert(win, "Obsidian Plugin Error", json.error || "Unknown error");
                      } else if (json && json.success) {
                        const tagName = String((Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".obsidianTagName", true) || "obsLitNote");
                        item.addTag(tagName);
                        await item.saveTx();
                      }
                    } else if (result === 2) {
                      break;
                    }
                  } else {
                    Zotero.alert(win as any, "File Exists", `The note for '${payload.citekey}' already exists.`);
                  }
                } else {
                  Zotero.alert(win as any, "Obsidian Plugin Error", json.error || "Unknown error");
                }
              }
            } catch (err) {
              ztoolkit.log("Payload error", err);
              const win = Zotero.getMainWindow();
              if (win) Zotero.alert(win as any, "Error", String(err));
            }
          })();
        }
      },
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-open-lit-note`,
        label: "Open Lit Note",
        icon: menuIcon,
        commandListener: () => {
          (async () => {
            try {
              let pane = undefined;
              if (typeof Zotero.getActiveZoteroPane === "function") pane = Zotero.getActiveZoteroPane();
              if (!pane) {
                const win = Zotero.getMainWindow();
                pane = win ? (win as any).ZoteroPane : null;
              }
              if (!pane) throw new Error("Could not find ZoteroPane");

              const items = pane.getSelectedItems().filter((item: any) => item.isRegularItem());
              if (!items.length) return;
              
              const win = Zotero.getMainWindow();
              const payload = await getItemPayload(items[0]);
              if (payload.citekey) {
                const json = await postToObsidian({ action: "open", citekey: payload.citekey });
                if (json && !json.success) {
                  if (json.error && json.error.includes("not found")) {
                     Zotero.alert(win as any, "Note Missing", `The note for '${payload.citekey}' does not exist in the Obsidian vault.`);
                  } else {
                     Zotero.alert(win as any, "Obsidian Plugin Error", json.error || "Unknown error");
                  }
                }
              } else {
                if (win) Zotero.alert(win as any, "Error", "No citekey found for item");
              }
            } catch (err) {
              ztoolkit.log("Payload error", err);
              const win = Zotero.getMainWindow();
              if (win) Zotero.alert(win as any, "Error", String(err));
            }
          })();
        }
      },
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-sync-obsidian-tags`,
        label: "Has Lit Note?",
        icon: menuIcon,
        commandListener: () => {
          (async () => {
            const win = (Zotero as any).getMainWindow();
            try {
              const { syncObsidianTags } = require("./obsidianTagSync");
              await syncObsidianTags(addon, true);
            } catch(e) {
              if (win) (Zotero as any).alert(win, "Error", String(e));
            }
          })();
        }
      }
    ]
  });

  // 2. Toggle Left Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-left-pane`,
    label: "Toggle Left Pane",
    isHidden: () => {
      const show = (Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".showPaneToggles", true);
      return show === false || show === "false";
    },
    commandListener: () => {
      const win = Zotero.getMainWindow();
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
    },
  });

  // 3. Toggle Right Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-right-pane`,
    label: "Toggle Right Pane",
    isHidden: () => {
      const show = (Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".showPaneToggles", true);
      return show === false || show === "false";
    },
    commandListener: () => {
      const win = Zotero.getMainWindow();
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
    },
  });
}
