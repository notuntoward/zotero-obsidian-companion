import { getString } from "../utils/locale";
import { getItemPayload } from "./obsidianPayload";
import { syncObsidianTags } from "./obsidianTagSync";
import { regenBibtexKey } from "./regenBibtex";
import { ensureObsidianConnection, postToObsidian } from "./obsidianConnection";
import { toggleLeftPane, toggleRightPane } from "../utils/paneUtils";
import Addon from "../addon";
import { ZoteroToolkit } from "zotero-plugin-toolkit";

declare const Zotero: any;
declare const addon: any;

function getActiveZoteroPane(): any {
  if (typeof Zotero.getActiveZoteroPane === "function") {
    return Zotero.getActiveZoteroPane();
  }
  const win = Zotero.getMainWindow();
  return win ? (win as any).ZoteroPane : null;
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

        commandListener: () => {
          (async () => {
            try {
              const pane = getActiveZoteroPane();
              if (!pane) throw new Error("Could not find ZoteroPane");

              const items = pane
                .getSelectedItems()
                .filter((item: any) => item.isRegularItem());
              if (!items.length) return;

              const win = Zotero.getMainWindow();
              const Services = (globalThis as any).Services;

              const conn = await ensureObsidianConnection({
                progressMessage: "Launching Obsidian for literature note...",
              });
              if (!conn.ready) {
                Zotero.alert(
                  win as any,
                  "Connection Error",
                  conn.error || "Connection to Obsidian failed.",
                );
                return;
              }

              for (const item of items) {
                const payload = await getItemPayload(item);
                let json = await postToObsidian({
                  action: "create",
                  data: [payload],
                });
                if (!json) continue;

                if (json.success) {
                  const tagName = String(
                    Zotero.Prefs.get(
                      addon.data.config.prefsPrefix + ".obsidianTagName",
                      true,
                    ) || "obsLitNote",
                  );
                  item.addTag(tagName);
                  await item.saveTx();
                } else if (json.error === "exists") {
                  if (Services && Services.prompt) {
                    const flags =
                      Services.prompt.BUTTON_TITLE_IS_STRING *
                        Services.prompt.BUTTON_POS_0 +
                      Services.prompt.BUTTON_TITLE_IS_STRING *
                        Services.prompt.BUTTON_POS_1 +
                      Services.prompt.BUTTON_TITLE_IS_STRING *
                        Services.prompt.BUTTON_POS_2;
                    const result = Services.prompt.confirmEx(
                      win,
                      "Overwrite Note?",
                      `The note for '${payload.citekey}' already exists in Obsidian. Do you want to overwrite it?`,
                      flags,
                      "Overwrite",
                      "Skip",
                      "Cancel",
                      null,
                      {},
                    );

                    if (result === 0) {
                      // Overwrite
                      json = await postToObsidian({
                        action: "create",
                        data: [payload],
                        force: true,
                      });
                      if (json && !json.success) {
                        Zotero.alert(
                          win,
                          "Obsidian Plugin Error",
                          json.error || "Unknown error",
                        );
                      } else if (json && json.success) {
                        const tagName = String(
                          Zotero.Prefs.get(
                            addon.data.config.prefsPrefix + ".obsidianTagName",
                            true,
                          ) || "obsLitNote",
                        );
                        item.addTag(tagName);
                        await item.saveTx();
                      }
                    } else if (result === 2) {
                      break;
                    }
                  } else {
                    Zotero.alert(
                      win as any,
                      "File Exists",
                      `The note for '${payload.citekey}' already exists.`,
                    );
                  }
                } else {
                  Zotero.alert(
                    win as any,
                    "Obsidian Plugin Error",
                    json.error || "Unknown error",
                  );
                }
              }
            } catch (err) {
              ztoolkit.log(err as any);
              const win = Zotero.getMainWindow();
              if (win) Zotero.alert(win as any, "Error", String(err));
            }
          })();
        },
      },
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-open-lit-note`,
        label: "Open Lit Note",

        commandListener: () => {
          (async () => {
            try {
              const pane = getActiveZoteroPane();
              if (!pane) throw new Error("Could not find ZoteroPane");

              const items = pane
                .getSelectedItems()
                .filter((item: any) => item.isRegularItem());
              if (!items.length) return;

              const win = Zotero.getMainWindow();
              const payload = await getItemPayload(items[0]);
              if (payload.citekey) {
                const conn = await ensureObsidianConnection({
                  progressMessage: "Launching Obsidian to open note...",
                });
                if (!conn.ready) {
                  Zotero.alert(
                    win as any,
                    "Connection Error",
                    conn.error || "Connection to Obsidian failed.",
                  );
                  return;
                }

                const json = await postToObsidian({
                  action: "open",
                  citekey: payload.citekey,
                });
                if (json && !json.success) {
                  if (json.error && json.error.includes("not found")) {
                    Zotero.alert(
                      win as any,
                      "Note Missing",
                      `The note for '${payload.citekey}' does not exist in the Obsidian vault.`,
                    );
                  } else {
                    Zotero.alert(
                      win as any,
                      "Obsidian Plugin Error",
                      json.error || "Unknown error",
                    );
                  }
                }
              } else {
                if (win)
                  Zotero.alert(
                    win as any,
                    "Error",
                    "No citekey found for item",
                  );
              }
            } catch (err) {
              ztoolkit.log(err as any);
              const win = Zotero.getMainWindow();
              if (win) Zotero.alert(win as any, "Error", String(err));
            }
          })();
        },
      },
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-regen-bibtex-key`,
        label: "Regen Citation Key",

        commandListener: () => {
          (async () => {
            const win = Zotero.getMainWindow();
            try {
              const pane = getActiveZoteroPane();
              if (!pane) throw new Error("Could not find ZoteroPane");

              const items = pane
                .getSelectedItems()
                .filter((item: any) => item.isRegularItem());
              if (!items.length) return;

              await regenBibtexKey(items);
            } catch (e) {
              Zotero.warn("Menu Error: " + String(e));
              const Services = (globalThis as any).Services;
              if (win && Services && Services.prompt)
                Services.prompt.alert(win, "Error", String(e));
            }
          })();
        },
      },
      {
        tag: "menuitem",
        id: `${addon.data.config.addonRef}-itemmenu-sync-obsidian-tags`,
        label: "Sync Has-note Indicators",

        commandListener: () => {
          (async () => {
            const win = Zotero.getMainWindow();
            try {
              await syncObsidianTags(addon, true);
            } catch (e) {
              Zotero.warn("Menu Error: " + String(e));
              const Services = (globalThis as any).Services;
              if (win && Services && Services.prompt)
                Services.prompt.alert(win, "Error", String(e));
            }
          })();
        },
      },
    ],
  });

  // 2. Toggle Left Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-left-pane`,
    label: "Toggle Left Pane",
    isHidden: () => {
      const show = Zotero.Prefs.get(
        addon.data.config.prefsPrefix + ".showPaneToggles",
        true,
      );
      return show === false || show === "false";
    },
    commandListener: () => {
      toggleLeftPane();
    },
  });

  // 3. Toggle Right Pane
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `${addon.data.config.addonRef}-itemmenu-toggle-right-pane`,
    label: "Toggle Right Pane",
    isHidden: () => {
      const show = Zotero.Prefs.get(
        addon.data.config.prefsPrefix + ".showPaneToggles",
        true,
      );
      return show === false || show === "false";
    },
    commandListener: () => {
      toggleRightPane();
    },
  });
}
