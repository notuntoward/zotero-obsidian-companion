import { describe, it, expect, vi, beforeEach } from "vitest";
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

  beforeEach(() => {
    mockZotero = {
      isWin: true,
      isMac: false,
      isLinux: false,
      HTTP: {
        request: vi.fn(),
      },
      Utilities: {
        Internal: {
          subprocess: vi.fn(),
        },
      },
      launchURL: vi.fn(),
      Promise: {
        delay: vi.fn().mockResolvedValue(undefined),
      },
      debug: vi.fn(),
    };

    mockAddon = {
      data: {
        ztoolkit: {
          ProgressWindow: vi.fn(function () {
            return {
              createLine: vi.fn().mockReturnValue({
                show: vi.fn(),
                change: vi.fn(),
              }),
              close: vi.fn(),
            };
          }),
        },
      },
    };

    (globalThis as any).Zotero = mockZotero;
    (globalThis as any).addon = mockAddon;
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
    it("calls Zotero.launchURL with obsidian://open", () => {
      launchObsidian();
      expect(mockZotero.launchURL).toHaveBeenCalledWith("obsidian://open");
    });
  });

  describe("ensureObsidianConnection", () => {
    it("returns ready: true immediately if server is already responsive", async () => {
      mockZotero.HTTP.request.mockResolvedValueOnce({ status: 200 });
      const res = await ensureObsidianConnection();
      expect(res.ready).toBe(true);
      expect(mockZotero.launchURL).not.toHaveBeenCalled();
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

      const res = await ensureObsidianConnection({ maxWaitMs: 3000 });
      expect(res.ready).toBe(true);
      expect(mockZotero.launchURL).toHaveBeenCalledWith("obsidian://open");
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
      expect(res.error).toContain(
        "Obsidian is currently running, but the 'Perplexity Saver' plugin is not responding",
      );
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
