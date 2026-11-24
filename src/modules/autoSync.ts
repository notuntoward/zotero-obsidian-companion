import { getSyncPayload } from "./obsidianPayload";
import type { ZoteroItemPayload } from "./obsidianPayload";
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
import {
  readReviewJournal,
  writeReviewJournal,
  sameReview,
} from "./reviewJournal";
import type { JournalEntry } from "./reviewJournal";
import {
  requireCertainResponse,
  UncertainReviewError,
} from "./reviewTransport";

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
const inFlightReviews = new Set<string>();
const inFlightSyncs = new Set<string>();
const warnedUncertain = new Set<string>();
const uncertainReportErrors = new Map<string, string>();
const uncertainReportWarning =
  "Could not report interrupted reviews to Obsidian. The affected items remain blocked; keep Zotero open and reconnect to Obsidian.";
const acknowledgementErrors = new Map<string, string>();

class ReviewJournalClearError extends Error {}

function reviewIdentity(
  entry: Pick<JournalEntry, "itemkey" | "libraryURI">,
): string {
  return JSON.stringify([entry.libraryURI, entry.itemkey]);
}

async function postReview(payload: object): Promise<any> {
  let response;
  try {
    response = await postToObsidian(payload);
  } catch (error) {
    throw new UncertainReviewError(
      error instanceof Error ? error.message : String(error),
    );
  }
  requireCertainResponse(response);
  return response;
}

function reviewResponseFailure(response: any, fallback: string): Error {
  const message = response?.results?.[0]?.error || response?.error || fallback;
  if (response?.results?.[0]?.status === "error") return new Error(message);
  return new UncertainReviewError(message);
}

function uncertainMessage(entry: JournalEntry): string {
  return `The outcome of the review for Zotero item ${entry.itemkey} is unknown. Check both apps before acknowledging it in Obsidian.`;
}

function forgetUncertain(entry: JournalEntry): void {
  const key = reviewIdentity(entry);
  warnedUncertain.delete(key);
  uncertainReportErrors.delete(key);
  if (!uncertainReportErrors.size && lastWarning === uncertainReportWarning)
    lastWarning = "";
  acknowledgementErrors.delete(key);
}

async function reportUncertain(
  entry: JournalEntry,
  error?: string,
): Promise<void> {
  if (error && error !== entry.error) {
    entry.error = error;
    try {
      writeReviewJournal(
        readReviewJournal().map((current) =>
          sameReview(current, entry) ? { ...current, error } : current,
        ),
      );
    } catch (journalError) {
      Zotero.logError(
        `[Obsidian sync] Could not persist review failure details for ${entry.itemkey}: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
      );
    }
  }
  const key = reviewIdentity(entry);
  if (!warnedUncertain.has(key)) {
    Zotero.logError(`[Obsidian sync] ${uncertainMessage(entry)}`);
    warnedUncertain.add(key);
  }
  try {
    const response = await postReview({
      action: "review-uncertain",
      itemkey: entry.itemkey,
      libraryURI: entry.libraryURI,
      ...(entry.error ? { error: entry.error } : {}),
    });
    if (!response?.success)
      throw new Error(
        response?.error || "Obsidian did not acknowledge the uncertain review.",
      );
    uncertainReportErrors.delete(key);
    if (!uncertainReportErrors.size && lastWarning === uncertainReportWarning)
      lastWarning = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (uncertainReportErrors.get(key) !== message) {
      Zotero.logError(
        `[Obsidian sync] Could not report uncertain review ${entry.itemkey}: ${message}`,
      );
      warn(uncertainReportWarning);
      uncertainReportErrors.set(key, message);
    }
  }
}

async function finishAcknowledgement(entry: JournalEntry): Promise<void> {
  try {
    const response = await postReview({
      action: "review-uncertain-acknowledged",
      itemkey: entry.itemkey,
      libraryURI: entry.libraryURI,
    });
    if (!response?.success)
      throw new Error(
        response?.error || "Obsidian did not confirm the acknowledgement.",
      );
    writeReviewJournal(
      readReviewJournal().filter((current) => !sameReview(current, entry)),
    );
    forgetUncertain(entry);
  } catch (error) {
    const key = reviewIdentity(entry);
    const message = error instanceof Error ? error.message : String(error);
    if (acknowledgementErrors.get(key) !== message) {
      warn(
        `Could not confirm acknowledgement for Zotero item ${entry.itemkey}; it remains blocked: ${message}`,
      );
      acknowledgementErrors.set(key, message);
    }
  }
}

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
        Number.isFinite(attachment.sourceMtime) &&
        (attachment.destinationMtime === undefined ||
          (typeof attachment.destinationMtime === "number" &&
            Number.isFinite(attachment.destinationMtime)))
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
  if (!addon.data.alive) return;
  readReviewJournal();
  if (!(await isObsidianServerReady())) return;
  const identities = await getNoteIdentities();
  const libraries = Zotero.Libraries.getAll().filter(
    (library: any) =>
      library.libraryType === "user" || library.libraryType === "group",
  );
  const payloads: ZoteroItemPayload[] = [];
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
    if (
      readReviewJournal().some(
        (entry) =>
          entry.itemkey === payload.itemkey &&
          entry.libraryURI === payload.libraryURI,
      )
    )
      continue;
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
  const journal = readReviewJournal();
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (
      journal.some(
        (entry) =>
          entry.itemkey === payloads[i].itemkey &&
          entry.libraryURI === payloads[i].libraryURI,
      )
    ) {
      payloads.splice(i, 1);
      items.splice(i, 1);
      snapshots.splice(i, 1);
      identifiers.splice(i, 1);
    }
  }
  if (!payloads.length) return;
  const syncEntries: JournalEntry[] = payloads.map((payload) => {
    if (!payload.itemkey || !payload.libraryURI)
      throw new Error(
        "Cannot journal an automatic sync without its Zotero identity.",
      );
    return {
      itemkey: payload.itemkey,
      libraryURI: payload.libraryURI,
      operation: "sync",
      state: "in-flight",
    };
  });
  const syncKeys = syncEntries.map(reviewIdentity);
  if (new Set(syncKeys).size !== syncKeys.length)
    throw new Error("Cannot journal duplicate automatic sync identities.");
  for (const key of syncKeys) inFlightSyncs.add(key);
  let actionable: JournalEntry[] = [];
  let actionablePersisted = false;
  try {
    let result;
    try {
      result = await postToObsidian({ action: "sync", data: payloads });
      requireCertainResponse(result);
      if (
        !Array.isArray(result?.results) ||
        result.results.length !== payloads.length ||
        result.results.some(
          (entry: any) => !entry || typeof entry.status !== "string",
        )
      )
        throw new Error(
          result?.error || "Obsidian returned an incomplete sync preparation.",
        );
    } catch (error) {
      warn(
        `Could not prepare automatic sync with Obsidian: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    actionable = syncEntries.filter((_entry, i) =>
      ["prepared", "set-zotero-key"].includes(result.results[i].status),
    );
    if (actionable.length) {
      const currentJournal = readReviewJournal();
      if (
        actionable.some((entry) =>
          currentJournal.some((current) => sameReview(current, entry)),
        )
      )
        throw new Error(
          "An automatic sync item became blocked while preparing.",
        );
      writeReviewJournal([...currentJournal, ...actionable]);
      actionablePersisted = true;
    }
    const entries = await resolveNoteKeyChoices(
      "sync",
      payloads.map((payload, i) => ({ item: items[i], payload })),
      result,
    );
    if (
      entries.some(
        (entry) =>
          entry.outcomeUncertain ||
          ![
            "updated",
            "skipped",
            "pending-review",
            "missing",
            "error",
          ].includes(entry.status),
      )
    )
      throw new UncertainReviewError(
        "An automatic reconciliation may be partial or returned an unknown status.",
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
    if (actionable.length)
      writeReviewJournal(
        readReviewJournal().filter(
          (entry) => !actionable.some((current) => sameReview(current, entry)),
        ),
      );
  } catch (error) {
    if (actionable.length && !actionablePersisted) throw error;
    if (actionablePersisted) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of actionable) await reportUncertain(entry, message);
      Zotero.logError(
        `[Obsidian sync] Automatic sync outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else {
      warn(
        `Could not process automatic sync with Obsidian: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    for (const key of syncKeys) inFlightSyncs.delete(key);
  }
}

export async function processReviewRequests(): Promise<boolean> {
  if (!addon.data.alive) return false;
  readReviewJournal();
  if (!(await isObsidianServerReady())) return false;
  for (const entry of readReviewJournal()) {
    if (entry.state === "ack-pending") await finishAcknowledgement(entry);
    else if (
      !inFlightReviews.has(reviewIdentity(entry)) &&
      !inFlightSyncs.has(reviewIdentity(entry))
    )
      await reportUncertain(entry);
  }
  const response = await Zotero.HTTP.request(
    "GET",
    "http://127.0.0.1:27124/lit-note-review-requests?bulk=1",
    { timeout: 5000 },
  );
  const data = JSON.parse(response.responseText);
  if (
    !data.success ||
    !Array.isArray(data.requests) ||
    !Array.isArray(data.pending)
  )
    throw new Error("Obsidian returned invalid review requests.");
  if (
    data.acknowledgedUncertain !== undefined &&
    !Array.isArray(data.acknowledgedUncertain)
  )
    throw new Error("Obsidian returned invalid uncertain acknowledgements.");
  const acknowledgements = data.acknowledgedUncertain || [];
  const acknowledged = new Set<string>();
  for (const ack of acknowledgements) {
    if (
      !ack ||
      typeof ack.itemkey !== "string" ||
      typeof ack.libraryURI !== "string"
    )
      throw new Error(
        "Obsidian returned an invalid uncertain acknowledgement.",
      );
    acknowledged.add(reviewIdentity(ack));
    const entries = readReviewJournal();
    const entry = entries.find((current) => sameReview(current, ack));
    if (
      !entry ||
      inFlightReviews.has(reviewIdentity(entry)) ||
      inFlightSyncs.has(reviewIdentity(entry))
    )
      continue;
    if (entry.state !== "ack-pending") {
      entry.state = "ack-pending";
      writeReviewJournal(entries);
    }
    await finishAcknowledgement(entry);
  }
  const pending = new Set(
    data.pending.map((entry: any) => reviewIdentity(entry)),
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
  const journal = readReviewJournal();
  if (
    data.requests.some(
      (entry: any) =>
        !entry ||
        typeof entry.itemkey !== "string" ||
        !entry.itemkey ||
        typeof entry.libraryURI !== "string" ||
        !entry.libraryURI,
    )
  )
    throw new Error("Obsidian returned an invalid review identity.");
  const available = data.requests.filter(
    (entry: any) =>
      entry &&
      typeof entry.itemkey === "string" &&
      typeof entry.libraryURI === "string" &&
      !acknowledged.has(reviewIdentity(entry)) &&
      !inFlightSyncs.has(reviewIdentity(entry)) &&
      !(
        entry.operation === "attachment-move" &&
        getAttachmentBaseValidationState() === "pending"
      ) &&
      !journal.some((current) => sameReview(current, entry)) &&
      !data.pending.some(
        (pendingEntry: any) =>
          pendingEntry?.uncertain === true && sameReview(pendingEntry, entry),
      ),
  );
  const request = available[0];
  if (!request) return false;
  if (
    request.operation !== undefined &&
    request.operation !== "library-uri" &&
    request.operation !== "library-recheck" &&
    request.operation !== "note-update" &&
    request.operation !== "attachment-move"
  )
    throw new Error("Obsidian returned an invalid review identity.");
  const entry: JournalEntry = {
    itemkey: request.itemkey,
    libraryURI: request.libraryURI,
    operation: request.operation || "review-sync",
    state: "in-flight",
  };
  writeReviewJournal([...journal, entry]);
  const key = reviewIdentity(entry);
  inFlightReviews.add(key);
  const more = available.length > 1;
  let localMayHaveChanged = false;
  let readOnlyFailure = false;
  const completeReview = () => {
    try {
      writeReviewJournal(
        readReviewJournal().filter((current) => !sameReview(current, entry)),
      );
      forgetUncertain(entry);
    } catch (error) {
      throw new ReviewJournalClearError(
        `Could not persist the completed review: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
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
      const result = await postReview({
        action: "bulk-library-uri",
        data: [payload],
      });
      if (
        !Array.isArray(result.results) ||
        result.results.length !== 1 ||
        result.results[0]?.status !== "updated"
      ) {
        throw reviewResponseFailure(result, "The library URI was not added.");
      }
      completeReview();
      return more;
    }
    if (request.operation === "library-recheck") {
      const recheck = await postReview({
        action: "review-recheck",
        data: [payload],
      });
      if (recheck.results?.[0]?.status === "waiting-index") {
        completeReview();
        return false;
      }
      if (
        !Array.isArray(recheck.results) ||
        recheck.results.length !== 1 ||
        !["skipped", "pending-review"].includes(recheck.results[0]?.status)
      ) {
        throw reviewResponseFailure(
          recheck,
          "The note could not be rechecked after adding its library URI.",
        );
      }
      completeReview();
      return more;
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
        throw new Error(
          "Zotero's Linked Attachment Base Directory validation is pending.",
        );
      if (!validatedBase)
        throw new Error(
          "Zotero's Linked Attachment Base Directory is no longer validated inside the vault.",
        );
      const { moved, linked } = await moveReviewedAttachments(
        item,
        request.attachmentMove,
        validatedBase,
        request.strategy,
        () => {
          localMayHaveChanged = true;
        },
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
      const completed = await postReview({
        action: "attachment-move-complete",
        data: [updatedPayload],
        moved,
        linked,
      });
      if (
        !Array.isArray(completed.results) ||
        completed.results.length !== 1 ||
        completed.results[0]?.status !== "updated"
      ) {
        throw new Error(
          completed.results?.[0]?.error ||
            completed.error ||
            "The attachment files moved, but Obsidian did not update the note links.",
        );
      }
      completeReview();
      return more;
    }
    let identities;
    try {
      identities = await getNoteIdentities();
    } catch (error) {
      readOnlyFailure = true;
      completeReview();
      warn(
        `Could not contact Obsidian while reading note identities: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const matching = identities.filter(
      (identity) =>
        identity.itemkey === request.itemkey &&
        (!identity.libraryURI || identity.libraryURI === request.libraryURI),
    );
    if (matching.length !== 1)
      throw new Error("The matching Obsidian note is missing or ambiguous.");
    await addCitationKeyCheck(item, payload, matching[0]);
    const result = await postReview({
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
    if (entry.outcomeUncertain)
      throw new UncertainReviewError(entry.error || "Review may be partial.");
    if (entry.status === "error" || entry.status === "missing")
      throw new Error(entry.error || "Review failed.");
    if (!["updated", "skipped", "pending-review"].includes(entry.status))
      throw new UncertainReviewError(
        "Obsidian returned an unknown review result.",
      );
    completeReview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ReviewJournalClearError) {
      if (!readOnlyFailure) {
        await reportUncertain(entry, message);
        return more;
      }
      warn(message);
      throw error;
    }
    if (error instanceof UncertainReviewError || localMayHaveChanged) {
      Zotero.logError(
        `[Obsidian sync] Review ${entry.itemkey} may be partial: ${message}`,
      );
      await reportUncertain(entry, message);
      return more;
    }
    try {
      const result = await postReview({
        action: "review-failed",
        ...request,
        error: message,
      });
      if (!result.success)
        throw new UncertainReviewError(
          result.error || "Obsidian did not acknowledge the review failure.",
        );
      completeReview();
    } catch (reportError) {
      const reportMessage =
        reportError instanceof Error
          ? reportError.message
          : String(reportError);
      await reportUncertain(
        entry,
        `${message} Failure report: ${reportMessage}`,
      );
      return more;
    }
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
  } finally {
    inFlightReviews.delete(key);
  }
  return more;
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
  warnedUncertain.clear();
  uncertainReportErrors.clear();
  acknowledgementErrors.clear();
  lastWarning = "";
  lastReport = "";
  closeNoteMatchReport();
}
