import { syncObsidianTags } from "./modules/obsidianTagSync";
import { registerItemMenu } from "./modules/menu";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { registerHotkeys } from "./modules/hotkeys";
import { showDismissibleNotice } from "./utils/progressNotice";
import { startAutoSync, stopAutoSync } from "./modules/autoSync";
import {
  startAttachmentBaseMonitor,
  stopAttachmentBaseMonitor,
} from "./modules/attachmentBaseMonitor";

let dismissStartupNotice: (() => void) | undefined;
let connectionWarningShown = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/settings-icon.svg`,
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Registered once for the whole app; Zotero's native menu API handles all
  // main windows and removes the menu automatically on shutdown.
  registerItemMenu();

  startAttachmentBaseMonitor(() => {
    connectionWarningShown = true;
    dismissStartupNotice?.();
    dismissStartupNotice = undefined;
  });
  startAutoSync();
  try {
    await syncObsidianTags(addon);
  } catch (e) {
    Zotero.debug("Tag sync error: " + e);
  }
}

async function onMainWindowLoad(win: Window): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerHotkeys();

  if (!connectionWarningShown) {
    dismissStartupNotice?.();
    dismissStartupNotice = showDismissibleNotice(getString("startup-finish"));
  }
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  stopAttachmentBaseMonitor();
  stopAutoSync();
  dismissStartupNotice?.();
  dismissStartupNotice = undefined;
  connectionWarningShown = false;
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
