import { getSyncPayload } from "./obsidianPayload";
import { isObsidianServerReady, postToObsidian } from "./obsidianConnection";
import { resolveNoteKeyChoices } from "./resolveNoteKeys";
import { addCitationKeyCheck, getNoteIdentities } from "./citationKeyCheck";
import type { NoteIdentity } from "./citationKeyCheck";
import { moveReviewedAttachments } from "./attachmentMover";
import type { AttachmentMoveRequest } from "./attachmentMover";
import { getAttachmentBaseValidationState } from "./attachmentBaseMonitor";
import { showNotice } from "../utils/progressNotice";
import { showNoteMatchReport, closeNoteMatchReport } from "./noteMatchReport";
import type { NoteMatchIssue } from "./noteMatchReport";

declare const Zotero: any;
declare const addon: any;

const blocked = new Map<string, string>();
const deferred = new Map<string, { payload: string; citekey: string }>();
const observed = new Map<string, { snapshot: string; since: number }>();
const pendingBlocked = new Map<string, string>();
const SETTLE_MS = 2000;
let lastWarning = "";
let lastReport = "";
let observerID: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let requested = false;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let reviewPolling = false;

function isAttachmentMoveRequest(
  value: unknown,
): value is AttachmentMoveRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.baseDirectory === "string" &&
    Array.isArray(request.linkNoteFiles) &&
    request.linkNoteFiles.every(
      (entry: unknown) => typeof entry === "string",
    ) &&
    Array.isArray(request.attachments) &&
    request.attachments.length > 0 &&
    request.attachments.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const attachment = entry as Record<string, unknown>;
      return (
        typeof attachment.itemkey === "string" &&
        (attachment.mode === "linked" || attachment.mode === "stored") &&
        typeof attachment.basename === "string" &&
        typeof attachment.sourcePath === "string" &&
        typeof attachment.destinationPath === "string" &&
        ["move", "newest", "keep-destination", "trash"].includes(
          attachment.resolution as string,
        ) &&
        typeof attachment.conflict === "boolean" &&
        typeof attachment.identical === "boolean" &&
        typeof attachment.sourceMtime === "number" &&
        (attachment.destinationMtime === undefined ||
          typeof attachment.destinationMtime === "number")
      );
    })
  );
}

function warn(message: string): void {
  Zotero.logError(`[Obsidian sync] ${message}`);
  if (lastWarning !== message) {
    showNotice(`Literature note sync: ${message}`, {
      type: "fail",
      timeoutMs: 12000,
    });
    lastWarning = message;
  }
}

export async function syncExistingNotesOnce(): Promise<void> {
  if (!addon.data.alive || !(await isObsidianServerReady())) return;
  const identities = await getNoteIdentities();
  const libraries = Zotero.Libraries.getAll().filter(
    (library: any) =>
      library.libraryType === "user" || library.libraryType === "group",
  );
  const payloads = [];
  const items: any[] = [];
  const identifiers: string[] = [];
  const snapshots: string[] = [];
  const issues: NoteMatchIssue[] = [];
  for (const identity of identities) {
    if (!addon.data.alive) return;
    if (!identity.itemkey) continue;
    const id = `${identity.libraryURI || "legacy"}:${identity.itemkey}`;
    if (identifiers.includes(id)) continue;
    const candidates = [];
    const checkedLibraries: string[] = [];
    const matchingLibraries: string[] = [];
    for (const library of libraries) {
      const uri = Zotero.URI.getLibraryURI(library.libraryID);
      if (identity.libraryURI && identity.libraryURI !== uri) continue;
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library.libraryID,
        identity.itemkey,
      );
      const name = String(
        library.name || `Zotero library ${library.libraryID}`,
      );
      checkedLibraries.push(name);
      if (item && item.isRegularItem() && !item.deleted) {
        candidates.push(item);
        matchingLibraries.push(name);
      }
    }
    if (candidates.length !== 1) {
      issues.push({
        notePath: identity.notePath,
        itemkey: identity.itemkey,
        checkedLibraries,
        matchingLibraries,
        ...(identity.libraryURI && !checkedLibraries.length
          ? { unavailableLibrary: identity.libraryURI }
          : {}),
        kind: candidates.length === 0 ? "missing" : "ambiguous",
      });
      continue;
    }
    let payload;
    try {
      payload = await getSyncPayload(candidates[0]);
    } catch (error) {
      warn(
        `Could not read Zotero item ${identity.itemkey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!payload.citekey) {
      warn(`Zotero item ${identity.itemkey} has no citation key.`);
      continue;
    }
    const snapshot = JSON.stringify({ identity, payload });
    const retained = deferred.get(id);
    if (
      retained?.payload === JSON.stringify(payload) &&
      retained.citekey === identity.citekey
    )
      continue;
    deferred.delete(id);
    if (blocked.get(id) === snapshot) continue;
    blocked.delete(id);
    const previous = observed.get(id);
    if (!previous || previous.snapshot !== snapshot) {
      observed.set(id, { snapshot, since: Date.now() });
      continue;
    }
    if (Date.now() - previous.since < SETTLE_MS) continue;
    try {
      await addCitationKeyCheck(candidates[0], payload, identity);
    } catch (error) {
      warn(
        `Could not check the Obsidian citation key for ${identity.itemkey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    identifiers.push(id);
    snapshots.push(snapshot);
    items.push(candidates[0]);
    payloads.push(payload);
  }
  issues.sort(
    (a, b) =>
      (a.notePath || "").localeCompare(b.notePath || "") ||
      a.itemkey.localeCompare(b.itemkey),
  );
  const report = JSON.stringify(issues);
  if (report !== lastReport) {
    try {
      showNoteMatchReport(issues);
      lastReport = report;
    } catch (error) {
      warn(
        `Could not show the Obsidian note report: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!payloads.length || !addon.data.alive) return;
  const result = await postToObsidian({ action: "sync", data: payloads });
  const entries = await resolveNoteKeyChoices(
    "sync",
    payloads.map((payload, i) => ({ item: items[i], payload })),
    result,
  );
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.status === "error")
      warn(
        `${entry.citekey || identifiers[i]}: ${entry.error || "unknown error"}`,
      );
    if (entry.status === "skipped" || entry.status === "pending-review")
      blocked.set(identifiers[i], snapshots[i]);
    if (entry.status === "pending-review") {
      pendingBlocked.set(
        identifiers[i],
        JSON.stringify([payloads[i].libraryURI, payloads[i].itemkey]),
      );
    }
    if (entry.deferUntilChanged) {
      const current = await getSyncPayload(items[i]);
      const identity = JSON.parse(snapshots[i]).identity as NoteIdentity;
      const value = {
        payload: JSON.stringify(current),
        citekey: identity.citekey,
      };
      deferred.set(identifiers[i], value);
      deferred.set(`${current.libraryURI}:${current.itemkey}`, {
        ...value,
        citekey: current.citekey,
      });
    }
    if (
      entry.status !== "updated" &&
      entry.status !== "skipped" &&
      entry.status !== "pending-review" &&
      entry.status !== "error"
    )
      warn(
        `${entry.citekey || identifiers[i]}: unexpected sync result ${String(entry.status)}`,
      );
  }
}

export async function processReviewRequests(): Promise<boolean> {
  if (!addon.data.alive || !(await isObsidianServerReady())) return false;
  const response = await Zotero.HTTP.request(
    "GET",
    "http://127.0.0.1:27124/lit-note-review-requests?bulk=1",
    { timeout: 5000 },
  );
  const data = JSON.parse(response.responseText);
  if (!data.success || !Array.isArray(data.requests)) {
    throw new Error("Obsidian returned invalid review requests.");
  }
  if (!Array.isArray(data.pending))
    throw new Error("Obsidian returned invalid pending reviews.");
  const pending = new Set(
    data.pending.map((entry: any) =>
      JSON.stringify([entry.libraryURI, entry.itemkey]),
    ),
  );
  let rediscover = false;
  for (const [id, key] of pendingBlocked) {
    if (!pending.has(key)) {
      blocked.delete(id);
      pendingBlocked.delete(id);
      rediscover = true;
    }
  }
  if (rediscover) schedule(1500);
  const request = data.requests[0];
  if (!request) return false;
  if (
    typeof request.itemkey !== "string" ||
    typeof request.libraryURI !== "string" ||
    (request.operation !== undefined &&
      request.operation !== "library-uri" &&
      request.operation !== "library-recheck" &&
      request.operation !== "note-update" &&
      request.operation !== "attachment-move")
  ) {
    throw new Error("Obsidian returned an invalid review identity.");
  }
  try {
    const libraries = Zotero.Libraries.getAll().filter(
      (library: any) =>
        library.libraryType === "user" || library.libraryType === "group",
    );
    const candidates = [];
    for (const library of libraries) {
      if (
        request.operation !== "library-uri" &&
        request.operation !== "library-recheck" &&
        Zotero.URI.getLibraryURI(library.libraryID) !== request.libraryURI
      )
        continue;
      const candidate = await Zotero.Items.getByLibraryAndKeyAsync(
        library.libraryID,
        request.itemkey,
      );
      if (candidate && !candidate.deleted && candidate.isRegularItem())
        candidates.push(candidate);
    }
    if (!candidates.length)
      throw new Error("The Zotero item is missing or in the trash.");
    if (candidates.length !== 1)
      throw new Error(
        "The Zotero item key matches more than one library; review it individually.",
      );
    const item = candidates[0];
    await item.reload();
    const payload = await getSyncPayload(item);
    if (
      payload.itemkey !== request.itemkey ||
      payload.libraryURI !== request.libraryURI ||
      !payload.citekey
    ) {
      throw new Error(
        "The Zotero item identity or citation key is unavailable.",
      );
    }
    if (request.operation === "library-uri") {
      const result = await postToObsidian({
        action: "bulk-library-uri",
        data: [payload],
      });
      if (
        !Array.isArray(result.results) ||
        result.results.length !== 1 ||
        result.results[0].status !== "updated"
      ) {
        throw new Error(
          result.results?.[0]?.error ||
            result.error ||
            "The library URI was not added.",
        );
      }
      return true;
    }
    if (request.operation === "library-recheck") {
      const recheck = await postToObsidian({
        action: "review-recheck",
        data: [payload],
      });
      if (recheck.results?.[0]?.status === "waiting-index") return false;
      if (
        !Array.isArray(recheck.results) ||
        recheck.results.length !== 1 ||
        !["skipped", "pending-review"].includes(recheck.results[0].status)
      ) {
        throw new Error(
          recheck.error ||
            "The note could not be rechecked after adding its library URI.",
        );
      }
      return data.requests.length > 1;
    }
    if (request.operation === "attachment-move") {
      if (
        !isAttachmentMoveRequest(request.attachmentMove) ||
        (request.strategy !== "newest" && request.strategy !== "zotero")
      ) {
        throw new Error(
          "Obsidian returned an incomplete attachment move request.",
        );
      }
      const validatedBase = payload.linkedAttachmentBaseDirectoryValidated
        ? payload.linkedAttachmentBaseDirectory || ""
        : "";
      if (!validatedBase && getAttachmentBaseValidationState() === "pending")
        return false;
      if (!validatedBase)
        throw new Error(
          "Zotero's Linked Attachment Base Directory is no longer validated inside the vault.",
        );
      const { moved, linked } = await moveReviewedAttachments(
        item,
        request.attachmentMove,
        validatedBase,
        request.strategy,
      );
      if (
        moved.length !== request.attachmentMove.attachments.length ||
        linked.length !== request.attachmentMove.linkNoteFiles.length
      ) {
        throw new Error(
          "Not all reviewed Zotero attachments were moved or linked.",
        );
      }
      await item.reload();
      const updatedPayload = await getSyncPayload(item);
      const completed = await postToObsidian({
        action: "attachment-move-complete",
        data: [updatedPayload],
        moved,
        linked,
      });
      if (
        !Array.isArray(completed.results) ||
        completed.results.length !== 1 ||
        completed.results[0].status !== "updated"
      ) {
        throw new Error(
          completed.results?.[0]?.error ||
            completed.error ||
            "The attachment files moved, but Obsidian did not update the note links.",
        );
      }
      return data.requests.length > 1;
    }
    const identities = await getNoteIdentities();
    const matching = identities.filter(
      (identity) =>
        identity.itemkey === request.itemkey &&
        (!identity.libraryURI || identity.libraryURI === request.libraryURI),
    );
    if (matching.length !== 1)
      throw new Error("The matching Obsidian note is missing or ambiguous.");
    await addCitationKeyCheck(item, payload, matching[0]);
    const result = await postToObsidian({
      action:
        request.operation === "note-update"
          ? "bulk-review-sync"
          : "review-sync",
      data: [payload],
    });
    const [entry] = await resolveNoteKeyChoices(
      "review-sync",
      [{ item, payload }],
      result,
    );
    if (entry.status === "error")
      throw new Error(entry.error || "Review failed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = await postToObsidian({
      action: "review-failed",
      ...request,
      error: message,
    });
    if (!result.success)
      throw new Error(
        result.error || `Could not report review failure: ${message}`,
      );
    if (
      request.operation === "library-uri" ||
      request.operation === "library-recheck" ||
      request.operation === "attachment-move" ||
      request.operation === "note-update"
    )
      Zotero.logError(
        `[Obsidian sync] Bulk correction for ${request.itemkey}: ${message}`,
      );
    else warn(`Review of Zotero item ${request.itemkey}: ${message}`);
  }
  return data.requests.length > 1;
}

async function pollReviews(): Promise<void> {
  let more = false;
  try {
    more = await processReviewRequests();
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
  } finally {
    if (addon.data.alive && reviewPolling)
      reviewTimer = setTimeout(() => void pollReviews(), more ? 0 : 3000);
  }
}

function schedule(delay: number): void {
  if (!addon.data.alive) return;
  if (running) {
    requested = true;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void run();
  }, delay);
}

async function run(): Promise<void> {
  if (!addon.data.alive || running) return;
  running = true;
  requested = false;
  try {
    await syncExistingNotesOnce();
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
    schedule(requested ? 1500 : 60000);
  }
}

export function startAutoSync(): void {
  observerID = Zotero.Notifier.registerObserver(
    {
      notify(event: string, type: string) {
        if (
          type === "item" &&
          ["add", "modify", "delete", "trash", "move"].includes(event)
        )
          schedule(1500);
      },
    },
    ["item"],
    "obsidian-note-sync",
    10,
  );
  schedule(1500);
  reviewTimer = setTimeout(() => void pollReviews(), 1500);
  reviewPolling = true;
}

export function stopAutoSync(): void {
  reviewPolling = false;
  if (reviewTimer) clearTimeout(reviewTimer);
  reviewTimer = undefined;
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  blocked.clear();
  pendingBlocked.clear();
  deferred.clear();
  observed.clear();
  lastReport = "";
  closeNoteMatchReport();
}
