import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isObsidianServerReady,
  isObsidianProcessRunning,
  launchObsidian,
  ensureObsidianConnection,
  postToObsidian,
} from "../src/modules/obsidianConnection";

describe("obsidianConnection", () => {
  let mockZotero: any;
  let mockAddon: any;
  let progressWindowInstances: any[];

  function createMockProgressWindow() {
    const instance: any = {
      createLine: vi.fn(),
      show: vi.fn(),
      changeLine: vi.fn(),
      addDescription: vi.fn(),
      startCloseTimer: vi.fn(),
      close: vi.fn(),
      win: { close: vi.fn(), startCloseTimer: vi.fn() },
    };
    instance.createLine.mockReturnValue(instance);
    instance.show.mockReturnValue(instance);
    instance.changeLine.mockReturnValue(instance);
    instance.addDescription.mockReturnValue(instance);
    instance.startCloseTimer.mockReturnValue(instance);
    instance.close.mockReturnValue(instance);
    progressWindowInstances.push(instance);
    return instance;
  }

  beforeEach(() => {
    progressWindowInstances = [];

    mockZotero = {
      isWin: true,
      isMac: false,
      isLinux: false,
      HTTP: {
        request: vi.fn(),
      },
      Utilities: {
        Internal: {
          subprocess: vi.fn().mockResolvedValue(""),
        },
      },
      launchURL: vi.fn(),
      Promise: {
        delay: vi.fn().mockResolvedValue(undefined),
      },
      debug: vi.fn(),
    };

    const ProgressWindow = vi.fn(function () {
      return createMockProgressWindow();
    });

    mockAddon = {
      data: {
        ztoolkit: {
          ProgressWindow,
        },
      },
    };

    (globalThis as any).Zotero = mockZotero;
    (globalThis as any).addon = mockAddon;
  });

  afterEach(() => {
    delete (globalThis as any).Services;
    delete (globalThis as any).Components;
  });

  describe("isObsidianServerReady", () => {
    it("returns true when HTTP request succeeds with status 200", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({ status: 200 });
      const ready = await isObsidianServerReady();
      expect(ready).toBe(true);
      expect(mockZotero.HTTP.request).toHaveBeenCalledWith(
        "GET",
        "http://127.0.0.1:27124/lit-notes",
        { timeout: 1000 },
      );
    });

    it("returns false when HTTP request rejects (e.g. port closed)", async () => {
      mockZotero.HTTP.request.mockRejectedValueOnce(
        new Error("Connection refused"),
      );
      const ready = await isObsidianServerReady();
      expect(ready).toBe(false);
    });

    it("returns false when HTTP request returns non-200 status", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({ status: 500 });
      const ready = await isObsidianServerReady();
      expect(ready).toBe(false);
    });
  });

  describe("isObsidianProcessRunning", () => {
    it("returns true on Windows when tasklist contains Obsidian.exe", async () => {
      mockZotero.isWin = true;
      mockZotero.Utilities.Internal.subprocess.mockResolvedValueOnce(
        "Obsidian.exe   12344 Console   1   54,000 K\n",
      );
      const running = await isObsidianProcessRunning();
      expect(running).toBe(true);
      expect(mockZotero.Utilities.Internal.subprocess).toHaveBeenCalledWith(
        "tasklist",
        ["/fi", "IMAGENAME eq Obsidian.exe", "/nh"],
      );
    });

    it("returns false on Windows when tasklist does not contain Obsidian.exe", async () => {
      mockZotero.isWin = true;
      mockZotero.Utilities.Internal.subprocess.mockResolvedValueOnce(
        "INFO: No tasks are running which match the specified criteria.\n",
      );
      const running = await isObsidianProcessRunning();
      expect(running).toBe(false);
    });

    it("returns true on macOS when pgrep returns PID", async () => {
      mockZotero.isWin = false;
      mockZotero.isMac = true;
      mockZotero.Utilities.Internal.subprocess.mockResolvedValueOnce("54321\n");
      const running = await isObsidianProcessRunning();
      expect(running).toBe(true);
      expect(mockZotero.Utilities.Internal.subprocess).toHaveBeenCalledWith(
        "pgrep",
        ["-x", "Obsidian"],
      );
    });

    it("returns true on Linux when pgrep returns PID", async () => {
      mockZotero.isWin = false;
      mockZotero.isMac = false;
      mockZotero.Utilities.Internal.subprocess.mockResolvedValueOnce("65432\n");
      const running = await isObsidianProcessRunning();
      expect(running).toBe(true);
      expect(mockZotero.Utilities.Internal.subprocess).toHaveBeenCalledWith(
        "pgrep",
        ["-i", "obsidian"],
      );
    });

    it("returns false when subprocess throws an error", async () => {
      mockZotero.Utilities.Internal.subprocess.mockRejectedValueOnce(
        new Error("Command failed"),
      );
      const running = await isObsidianProcessRunning();
      expect(running).toBe(false);
    });
  });

  describe("launchObsidian", () => {
    it("launches through the OS shell on Windows", async () => {
      mockZotero.isWin = true;
      await launchObsidian();
      expect(mockZotero.Utilities.Internal.subprocess).toHaveBeenCalledWith(
        "cmd.exe",
        ["/c", "start", "", "obsidian://open"],
      );
      expect(mockZotero.launchURL).not.toHaveBeenCalled();
    });

    it("falls back to the external protocol service with a system principal", async () => {
      mockZotero.Utilities.Internal.subprocess = undefined;
      const loadURI = vi.fn();
      (globalThis as any).Services = {
        io: { newURI: vi.fn(() => ({ spec: "obsidian://open" })) },
        scriptSecurityManager: {
          getSystemPrincipal: vi.fn(() => ({ isSystemPrincipal: true })),
        },
      };
      (globalThis as any).Components = {
        interfaces: { nsIExternalProtocolService: {}, nsIHandlerInfo: {} },
        classes: {
          "@mozilla.org/uriloader/external-protocol-service;1": {
            getService: () => ({ loadURI }),
          },
        },
      };

      await launchObsidian();

      expect(loadURI).toHaveBeenCalledTimes(1);
      expect(mockZotero.launchURL).not.toHaveBeenCalled();
    });

    it("falls back to Zotero.launchURL when no shell or service is available", async () => {
      mockZotero.Utilities.Internal.subprocess = undefined;
      await launchObsidian();
      expect(mockZotero.launchURL).toHaveBeenCalledWith("obsidian://open");
    });
  });

  describe("ensureObsidianConnection", () => {
    it("returns ready: true immediately if server is already responsive", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({ status: 200 });
      const res = await ensureObsidianConnection();
      expect(res.ready).toBe(true);
      expect(mockZotero.Utilities.Internal.subprocess).not.toHaveBeenCalled();
      expect(progressWindowInstances).toHaveLength(0);
    });

    it("launches Obsidian and polls until ready when process is not running", async () => {
      // 1. Initial check: not ready
      mockZotero.HTTP.request.mockRejectedValueOnce(
        new Error("Connection refused"),
      );
      // 2. Process check: not running
      mockZotero.Utilities.Internal.subprocess.mockResolvedValueOnce(
        "INFO: No tasks are running\n",
      );
      // 3. First poll check: ready!
      mockZotero.HTTP.request.mockResolvedValueOnce({ status: 200 });

      const res = await ensureObsidianConnection({
        maxWaitMs: 3000,
        progressMessage: "Launching Obsidian for literature note...",
      });
      expect(res.ready).toBe(true);
      expect(mockZotero.Utilities.Internal.subprocess).toHaveBeenCalledWith(
        "cmd.exe",
        ["/c", "start", "", "obsidian://open"],
      );

      const notice = progressWindowInstances.at(-1);
      expect(notice.createLine).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Launching Obsidian for literature note...",
        }),
      );
      // The window must stay open across the whole wait.
      expect(notice.show).toHaveBeenCalledWith(-1);
      expect(notice.changeLine).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Obsidian connected." }),
      );
      expect(notice.startCloseTimer).toHaveBeenCalledWith(1500);

      // Must not close unrelated progress windows.
      const ctorCall = mockAddon.data.ztoolkit.ProgressWindow.mock.calls.at(-1);
      expect(ctorCall[1]).not.toHaveProperty("closeOtherProgressWindows");
    });

    it("returns timeout error when auto-launch times out", async () => {
      // All HTTP requests fail
      mockZotero.HTTP.request.mockRejectedValue(
        new Error("Connection refused"),
      );
      // Process check: not running
      mockZotero.Utilities.Internal.subprocess.mockResolvedValue(
        "INFO: No tasks are running\n",
      );

      const res = await ensureObsidianConnection({ maxWaitMs: 1200 });
      expect(res.ready).toBe(false);
      expect(res.error).toContain(
        "Obsidian was launched, but the 'Perplexity Saver' plugin did not respond",
      );

      const notice = progressWindowInstances.at(-1);
      // A single failure notice that dismisses itself.
      expect(notice.changeLine).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Could not connect to Obsidian.",
          type: "fail",
        }),
      );
      expect(notice.startCloseTimer).toHaveBeenCalledWith(12000);
    });

    it("returns plugin-disabled error when process is running but server never responds", async () => {
      // All HTTP requests fail
      mockZotero.HTTP.request.mockRejectedValue(
        new Error("Connection refused"),
      );
      // Process check: running!
      mockZotero.Utilities.Internal.subprocess.mockResolvedValue(
        "Obsidian.exe   12344 Console   1   54,000 K\n",
      );

      const res = await ensureObsidianConnection();
      expect(res.ready).toBe(false);
      expect(mockZotero.launchURL).not.toHaveBeenCalled();
      expect(mockZotero.Utilities.Internal.subprocess).not.toHaveBeenCalledWith(
        "cmd.exe",
        expect.anything(),
      );
      expect(res.error).toContain(
        "Obsidian is currently running, but the 'Perplexity Saver' plugin is not responding",
      );
    });

    it("deduplicates concurrent ensureObsidianConnection calls to avoid double notices", async () => {
      mockZotero.HTTP.request.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { status: 200 };
      });

      const p1 = ensureObsidianConnection();
      const p2 = ensureObsidianConnection();

      expect(p1).toBe(p2);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.ready).toBe(true);
      expect(r2.ready).toBe(true);
    });

    it("stops polling and closes the notice when the addon is shut down", async () => {
      mockZotero.HTTP.request.mockRejectedValue(
        new Error("Connection refused"),
      );
      // Process check: running, so the grace branch is used.
      mockZotero.Utilities.Internal.subprocess.mockResolvedValue(
        "Obsidian.exe   12344 Console   1   54,000 K\n",
      );
      mockAddon.data.alive = false;

      const res = await ensureObsidianConnection({ maxWaitMs: 60000 });

      expect(res.ready).toBe(false);
      expect(res.error).toContain("cancelled");
      expect(progressWindowInstances.at(-1).close).toHaveBeenCalled();
    });
  });

  describe("postToObsidian", () => {
    it("posts payload and returns parsed JSON response", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({
        status: 200,
        responseText: JSON.stringify({ success: true, created: true }),
      });

      const res = await postToObsidian({ action: "create", data: [] });
      expect(res).toEqual({ success: true, created: true });
      expect(mockZotero.HTTP.request).toHaveBeenCalledWith(
        "POST",
        "http://127.0.0.1:27124/lit-note",
        expect.objectContaining({
          body: JSON.stringify({ action: "create", data: [] }),
        }),
      );
    });

    it("handles HTTP error status codes", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({
        status: 400,
        statusText: "Bad Request",
        responseText: JSON.stringify({ error: "Invalid data" }),
      });

      const res = await postToObsidian({ action: "create" });
      expect(res).toEqual({ success: false, error: "HTTP 400: Invalid data" });
    });
  });
});
