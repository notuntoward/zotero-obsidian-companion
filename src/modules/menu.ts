/**
 * Item context menu, registered through Zotero's native plugin menu API.
 *
 * The toolkit's own menu helper was removed in stable releases in favor of
 * Zotero 8+'s Zotero.MenuManager, so use that rather than injecting DOM.
 */

import {
  createLitNotes,
  openLitNote,
  regenerateCitationKeys,
  regularItems,
  syncHasNoteIndicators,
  toggleLeftPaneAction,
  toggleRightPaneAction,
  paneTogglesEnabled,
} from "./actions";

declare const Zotero: any;
declare const addon: any;

function l10nId(id: string): string {
  return `${addon.data.config.addonRef}-${id}`;
}

function selectedRegularItems(context: any): any[] {
  return regularItems(context?.items);
}

function hasRegularItem(context: any): boolean {
  return selectedRegularItems(context).length > 0;
}

export function registerItemMenu(): void {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`;

  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonRef}-itemmenu`,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: l10nId("menu-obsidian"),
        icon: menuIcon,
        menus: [
          {
            menuType: "menuitem",
            l10nID: l10nId("menu-create-lit-note"),
            onShowing: (_event: any, context: any) =>
              context.setVisible(hasRegularItem(context)),
            onCommand: (_event: any, context: any) => {
              void createLitNotes(selectedRegularItems(context));
            },
          },
          {
            menuType: "menuitem",
            l10nID: l10nId("menu-open-lit-note"),
            onShowing: (_event: any, context: any) =>
              context.setVisible(hasRegularItem(context)),
            onCommand: (_event: any, context: any) => {
              void openLitNote(selectedRegularItems(context));
            },
          },
          {
            menuType: "menuitem",
            l10nID: l10nId("menu-regen-citation-key"),
            onShowing: (_event: any, context: any) =>
              context.setVisible(hasRegularItem(context)),
            onCommand: (_event: any, context: any) => {
              void regenerateCitationKeys(selectedRegularItems(context));
            },
          },
          {
            menuType: "menuitem",
            l10nID: l10nId("menu-sync-tags"),
            // Syncs the whole library, so it does not depend on selection.
            onCommand: () => {
              void syncHasNoteIndicators();
            },
          },
        ],
      },
      {
        menuType: "menuitem",
        l10nID: l10nId("menu-toggle-left-pane"),
        onShowing: (_event: any, context: any) =>
          context.setVisible(paneTogglesEnabled()),
        onCommand: () => toggleLeftPaneAction(),
      },
      {
        menuType: "menuitem",
        l10nID: l10nId("menu-toggle-right-pane"),
        onShowing: (_event: any, context: any) =>
          context.setVisible(paneTogglesEnabled()),
        onCommand: () => toggleRightPaneAction(),
      },
    ],
  });
}
