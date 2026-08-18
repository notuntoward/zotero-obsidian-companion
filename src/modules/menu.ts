
import { getString } from "../utils/locale";
import { getItemPayload } from "./obsidianPayload";

async function postToObsidian(payload: any): Promise<any> {
  try {
    let fetchFn = typeof fetch !== "undefined" ? fetch : null;
    if (!fetchFn) {
      const win = Zotero.getMainWindow();
      if (win && win.fetch) {
        fetchFn = win.fetch;
      }
    }
    if (!fetchFn) {
      throw new Error("Fetch API not found in this context.");
    }
    const res = await fetchFn("http://127.0.0.1:27124/lit-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    ztoolkit.log("Failed to post to Obsidian:", err);
    const win = Zotero.getMainWindow();
    if (win) Zotero.alert(win, "Connection Error", "Could not connect to Obsidian. Is the Perplexity Saver plugin running on port 27124? Error: " + String(err));
    return null;
  }
}

export function registerItemMenu(): void {

  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-test-sync`,
    label: "Test Sync Alert",
    commandListener: () => {
      Zotero.alert(Zotero.getMainWindow() as any, "Test", "Sync alert works");
    }
  });

  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-test-async`,
    label: "Test Async Alert",
    commandListener: () => {
      (async () => {
        Zotero.alert(Zotero.getMainWindow() as any, "Test", "Async alert works");
      })();
    }
  });

  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-test-pane`,
    label: "Test Pane Logic",
    commandListener: () => {
      try {
          let pane = undefined;
          if (typeof Zotero.getActiveZoteroPane === "function") {
            pane = Zotero.getActiveZoteroPane();
          }
          if (!pane) {
            const win = Zotero.getMainWindow();
            pane = win ? (win as any).ZoteroPane : null;
          }
          if (!pane) {
            throw new Error("Could not find ZoteroPane");
          }

          const items = pane.getSelectedItems();
          Zotero.alert(Zotero.getMainWindow() as any, "Test", "Selected items count: " + items.length);
      } catch (err) {
          Zotero.alert(Zotero.getMainWindow() as any, "Test", "Pane logic failed: " + String(err));
      }
    }
  });

  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`;
  
  // Sync Obsidian Tags
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-sync-obsidian-tags`,
    label: "Sync Obsidian Tags",
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
    },
    icon: menuIcon,
  });

  // Create Lit Note
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-create-lit-note`,
    label: "Create Lit Note in Obsidian",
    commandListener: () => {
      (async () => {
        try {
          // Zotero 7 compatibility for getting the active pane
          let pane = undefined;
          if (typeof Zotero.getActiveZoteroPane === "function") {
            pane = Zotero.getActiveZoteroPane();
          }
          if (!pane) {
            const win = Zotero.getMainWindow();
            pane = win ? (win as any).ZoteroPane : null;
          }
          if (!pane) {
            throw new Error("Could not find ZoteroPane");
          }

          const items = pane.getSelectedItems().filter((item: any) => item.isRegularItem());
          if (!items.length) {
            const win = Zotero.getMainWindow();
            if (win) Zotero.alert(win, "Info", "No regular items selected.");
            return;
          }
          
          const Services = (globalThis as any).Services;
          const win = Zotero.getMainWindow();

          for (const item of items) {
            const payload = await getItemPayload(item);
            
            let json = await postToObsidian({
              action: "create",
              data: [payload]
            });

            if (!json) continue; // Connection error already shown
            
            if (json.success) {
              const tagName = String((Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".obsidianTagName") || "obsLitNote");
              item.addTag(tagName);
              await item.saveTx();
            }
            if (!json.success) {
              if (json.error === "exists") {
                if (Services && Services.prompt) {
                  const flags = (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0) +
                               (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1) +
                               (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_2);
                  const result = Services.prompt.confirmEx(
                    win,
                    "Overwrite Note?",
                    `The note for '${payload.citekey}' already exists in Obsidian. Do you want to overwrite it?`,
                    flags,
                    "Overwrite",
                    "Skip",
                    "Cancel",
                    null,
                    {}
                  );
                  
                  if (result === 0) { // Overwrite
                    json = await postToObsidian({
                      action: "create",
                      data: [payload],
                      force: true
                    });
                    if (json && !json.success) {
                      Zotero.alert(win, "Obsidian Plugin Error", json.error || "Unknown error");
                    } else if (json && json.success) {
                      const tagName = String((Zotero as any).Prefs.get(addon.data.config.prefsPrefix + ".obsidianTagName") || "obsLitNote");
                      item.addTag(tagName);
                      await item.saveTx();
                    }
                  } else if (result === 2) { // Cancel (stop processing entirely)
                    break;
                  }
                } else {
                  Zotero.alert(win as any, "File Exists", `The note for '${payload.citekey}' already exists.`);
                }
              } else {
                Zotero.alert(win as any, "Obsidian Plugin Error", json.error || "Unknown error");
              }
            }
          }
        } catch (err) {
          ztoolkit.log("Payload error", err);
          const win = Zotero.getMainWindow();
          if (win) Zotero.alert(win as any, "Error", String(err));
        }
      })();
    },
    icon: menuIcon,
  });

  // Open Lit Note
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-open-lit-note`,
    label: "Open Lit Note in Obsidian",
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
          if (!pane) {
            throw new Error("Could not find ZoteroPane");
          }

          const items = pane.getSelectedItems().filter((item: any) => item.isRegularItem());
          if (!items.length) {
            const win = Zotero.getMainWindow();
            if (win) Zotero.alert(win, "Info", "No regular items selected.");
            return;
          }
          
          const win = Zotero.getMainWindow();
          const payload = await getItemPayload(items[0]);
          if (payload.citekey) {
            const json = await postToObsidian({
              action: "open",
              citekey: payload.citekey
            });
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
    },
    icon: menuIcon,
  });

  // Toggle Left Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-left-pane`,
    label: "Toggle Left Pane",
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

  // Toggle Right Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-right-pane`,
    label: "Toggle Right Pane",
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
