import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  notice: vi.fn(),
  dismiss: vi.fn(),
  ready: vi.fn(),
  processState: vi.fn(),
}));
vi.mock("../src/modules/obsidianConnection", () => ({
  postToObsidian: mocks.post,
  isObsidianServerReady: mocks.ready,
  getObsidianProcessState: mocks.processState,
}));
vi.mock("../src/utils/progressNotice", () => ({
  showDismissibleNotice: mocks.notice,
}));
import {
  getValidatedAttachmentBaseDirectory,
  getAttachmentBaseValidationState,
  startAttachmentBaseMonitor,
  stopAttachmentBaseMonitor,
} from "../src/modules/attachmentBaseMonitor";

describe("linked attachment base monitor", () => {
  let base: string;
  let changed: () => void;
  const token = Symbol("observer");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.notice.mockReturnValue(mocks.dismiss);
    mocks.ready.mockReset().mockResolvedValue(false);
    base = "C:\\outside";
    (globalThis as any).addon = { data: { alive: true } };
    (globalThis as any).Zotero = {
      Prefs: {
        get: vi.fn(() => base),
        registerObserver: vi.fn((_name: string, fn: () => void) => {
          changed = fn;
          return token;
        }),
        unregisterObserver: vi.fn(),
      },
      logError: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    stopAttachmentBaseMonitor();
    vi.useRealTimers();
  });

  it("checks on startup and immediately on preference changes", async () => {
    mocks.post.mockResolvedValue({
      success: true,
      relationship: "outside",
      vaultPath: "C:\\vault",
    });
    startAttachmentBaseMonitor();
    expect(mocks.post).toHaveBeenCalledWith({
      action: "check-attachment-base",
      baseDirectory: base,
    });
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());
    expect(getAttachmentBaseValidationState()).toBe("invalid");
    expect(mocks.notice.mock.calls[0][0]).toContain(
      "does not affect stored attachments or move files",
    );
    base = "C:\\vault";
    mocks.post.mockResolvedValue({ success: true, relationship: "inside" });
    changed();
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "check-attachment-base",
      baseDirectory: base,
    });
    await Promise.resolve();
    expect(getValidatedAttachmentBaseDirectory()).toBe(base);
    expect(getAttachmentBaseValidationState()).toBe("valid");
    expect(mocks.notice).toHaveBeenCalledOnce();
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    stopAttachmentBaseMonitor();
    expect(getValidatedAttachmentBaseDirectory()).toBe("");
    expect(getAttachmentBaseValidationState()).toBe("pending");
    expect(
      (globalThis as any).Zotero.Prefs.unregisterObserver,
    ).toHaveBeenCalledWith(token);
  });

  it.each([
    ["stopped", "Open Obsidian", "Obsidian is not running"],
    ["running", "Open the intended vault", "Obsidian is running"],
    ["unknown", "Open Obsidian", "process state could not be determined"],
  ])(
    "gives action-first guidance when the local server fails and Obsidian is %s",
    async (state, action, diagnosis) => {
      mocks.post.mockResolvedValue({
        success: false,
        connectionError: true,
        error: "Error connecting to server. Check your Internet connection.",
      });
      mocks.processState.mockResolvedValue(state);
      startAttachmentBaseMonitor();
      await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());
      const message = mocks.notice.mock.calls[0][0];
      expect(message.startsWith(action)).toBe(true);
      expect(message).toContain(diagnosis);
      expect(message).not.toContain("Internet");
      expect(message).toContain("retry automatically");
    },
  );

  it("dismisses the connection warning when the server becomes available", async () => {
    mocks.post
      .mockResolvedValueOnce({
        success: false,
        connectionError: true,
        error: "offline",
      })
      .mockResolvedValueOnce({ success: true, relationship: "inside" });
    mocks.processState.mockResolvedValue("stopped");
    mocks.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    startAttachmentBaseMonitor();
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(getAttachmentBaseValidationState()).toBe("valid");
    expect(mocks.notice).toHaveBeenCalledOnce();
  });

  it("replaces a connection warning with a real directory warning", async () => {
    mocks.post
      .mockResolvedValueOnce({
        success: false,
        connectionError: true,
        error: "offline",
      })
      .mockResolvedValueOnce({
        success: true,
        relationship: "outside",
        vaultPath: "C:\\vault",
      });
    mocks.processState.mockResolvedValue("stopped");
    mocks.ready.mockResolvedValue(true);
    startAttachmentBaseMonitor();
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    expect(mocks.notice).toHaveBeenCalledTimes(2);
    expect(mocks.notice.mock.calls[1][0]).toContain(
      "outside the open Obsidian vault",
    );
    expect(getAttachmentBaseValidationState()).toBe("invalid");
  });

  it("does not dismiss a newer warning when an old readiness check completes", async () => {
    let resolveReady!: (value: boolean) => void;
    mocks.post
      .mockResolvedValueOnce({
        success: false,
        connectionError: true,
        error: "offline",
      })
      .mockResolvedValueOnce({
        success: true,
        relationship: "outside",
        vaultPath: "C:\\vault",
      });
    mocks.processState.mockResolvedValue("stopped");
    mocks.ready.mockReturnValue(
      new Promise((resolve) => {
        resolveReady = resolve;
      }),
    );
    startAttachmentBaseMonitor();
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000);
    changed();
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledTimes(2));
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    resolveReady(true);
    await Promise.resolve();
    expect(mocks.dismiss).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("preserves a server diagnosis without treating it as a stopped process", async () => {
    mocks.post.mockResolvedValue({
      success: false,
      error: "The configured path is not a directory",
    });
    startAttachmentBaseMonitor();
    await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledOnce());
    expect(mocks.notice.mock.calls[0][0]).toMatch(
      /^Check Zotero's Linked Attachment Base Directory/,
    );
    expect(mocks.notice.mock.calls[0][0]).toContain("not a directory");
    expect(mocks.processState).not.toHaveBeenCalled();
  });

  it("ignores a stale process diagnosis after the preference changes", async () => {
    let resolveState!: (value: string) => void;
    mocks.post
      .mockResolvedValueOnce({
        success: false,
        connectionError: true,
        error: "offline",
      })
      .mockResolvedValueOnce({ success: true, relationship: "inside" });
    mocks.processState.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );
    startAttachmentBaseMonitor();
    await Promise.resolve();
    base = "C:\\vault";
    changed();
    await Promise.resolve();
    resolveState("stopped");
    await Promise.resolve();
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it("retries when Obsidian is unavailable and ignores stale responses", async () => {
    let resolveOld!: (result: unknown) => void;
    mocks.post
      .mockReset()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce({ success: false, error: "offline" })
      .mockResolvedValueOnce({ success: true, relationship: "inside" });
    startAttachmentBaseMonitor();
    base = "C:\\vault";
    changed();
    await Promise.resolve();
    expect(mocks.notice.mock.calls[0][0]).toContain("offline");
    resolveOld({
      success: true,
      relationship: "outside",
      vaultPath: "C:\\vault",
    });
    await Promise.resolve();
    expect(mocks.notice).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenLastCalledWith({
      action: "check-attachment-base",
      baseDirectory: base,
    });
  });
});
