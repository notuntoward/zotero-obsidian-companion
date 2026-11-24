import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  dismiss: vi.fn(),
  monitor: vi.fn(),
  stopMonitor: vi.fn(),
}));
vi.mock("../src/modules/obsidianTagSync", () => ({
  syncObsidianTags: vi.fn(),
}));
vi.mock("../src/modules/menu", () => ({ registerItemMenu: vi.fn() }));
vi.mock("../src/utils/locale", () => ({
  getString: () => "ready",
  initLocale: vi.fn(),
}));
vi.mock("../src/modules/preferenceScript", () => ({
  registerPrefsScripts: vi.fn(),
}));
vi.mock("../src/utils/ztoolkit", () => ({ createZToolkit: () => ({}) }));
vi.mock("../src/modules/hotkeys", () => ({ registerHotkeys: vi.fn() }));
vi.mock("../src/utils/progressNotice", () => ({
  showDismissibleNotice: mocks.show,
}));
vi.mock("../src/modules/autoSync", () => ({
  startAutoSync: vi.fn(),
  stopAutoSync: vi.fn(),
}));
vi.mock("../src/modules/attachmentBaseMonitor", () => ({
  startAttachmentBaseMonitor: mocks.monitor,
  stopAttachmentBaseMonitor: mocks.stopMonitor,
}));
import hooks from "../src/hooks";

describe("startup notices", () => {
  const win = {
    MozXULElement: { insertFTLIfNeeded: vi.fn() },
  } as unknown as Window;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.show.mockReturnValue(mocks.dismiss);
    (globalThis as any).addon = {
      data: { alive: true, config: { addonID: "test", addonRef: "test" } },
    };
    (globalThis as any).rootURI = "";
    (globalThis as any).ztoolkit = { unregisterAll: vi.fn() };
    (globalThis as any).Zotero = {
      initializationPromise: Promise.resolve(),
      unlockPromise: Promise.resolve(),
      uiReadyPromise: Promise.resolve(),
      PreferencePanes: { register: vi.fn() },
      getMainWindows: () => [win],
      debug: vi.fn(),
    };
  });
  afterEach(() => hooks.onShutdown());

  it("replaces the ready notice when the connection warning is shown", async () => {
    await hooks.onStartup();
    expect(mocks.show).toHaveBeenCalledWith("ready");
    expect(mocks.dismiss).not.toHaveBeenCalled();
    const warningShown = mocks.monitor.mock.calls[0][0];
    warningShown();
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    await hooks.onMainWindowLoad(win);
    expect(mocks.show).toHaveBeenCalledOnce();
  });

  it("keeps the normal ready notice when there is no connection warning", async () => {
    await hooks.onStartup();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
