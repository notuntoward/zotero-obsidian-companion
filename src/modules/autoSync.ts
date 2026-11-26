import {
  CitationKeyValidationError,
  getAttachments,
  getSyncPayload,
} from "./obsidianPayload";
import type { ZoteroAttachment, ZoteroItemPayload } from "./obsidianPayload";
import { isObsidianServerReady, postToObsidian } from "./obsidianConnection";
import { resolveNoteKeyChoices } from "./resolveNoteKeys";
import { addCitationKeyCheck, getNoteIdentities } from "./citationKeyCheck";
import type { NoteIdentity } from "./citationKeyCheck";
import { moveReviewedAttachments } from "./attachmentMover";
import type { AttachmentMoveRequest } from "./attachmentMover";
import { getAttachmentBaseValidationState } from "./attachmentBaseMonitor";
import { showDismissibleNotice } from "../utils/progressNotice";
import { getString } from "../utils/locale";
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
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let scanId = "";
let scanStarted = false;
let scanWorkDone = false;
let dismissSyncNotice: (() => void) | undefined;
let scanComplete = false;
let scanSessionMismatch = false;
let scanIssue = "";
const scannedIdentities = new Set<string>();
const reportedUncertain = new Set<string>();
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
let reviewPolling = false;
let processingReviews = false;
const inFlightReviews = new Set<string>();
const inFlightSyncs = new Set<string>();
const warnedUncertain = new Set<string>();
const uncertainReportErrors = new Map<string, string>();
const uncertainTitleErrors = new Map<string, string>();
const uncertainAttachmentErrors = new Map<string, string>();
const uncertainReportWarning =
  "Could not report interrupted reviews to Obsidian. The affected items remain blocked; keep Zotero open and reconnect to Obsidian.";
const acknowledgementErrors = new Map<string, string>();
const recoveryErrors = new Map<string, string>();
const deferredAttachmentRecovery = new Set<string>();
const inFlightItemTrash = new Set<string>();
let lastRescan = "";
let lastObsidianSession = "";

class ReviewJournalClearError extends Error {}
class ScanSessionMismatchError extends Error {}

function reviewIdentity(
  entry: Pick<JournalEntry, "itemkey" | "libraryURI">,
): string {
  return JSON.stringify([entry.libraryURI, entry.itemkey]);
}

function recordAttachmentPaths(
  entry: JournalEntry,
  request: AttachmentMoveRequest,
  repair: boolean,
): void {
  const journal = readReviewJournal();
  const current = journal.find((candidate) => sameReview(candidate, entry));
  if (!current || current.state !== "in-flight")
    throw new Error(
      "The attachment review record changed before files were copied.",
    );
  const paths = request.attachments.map(
    ({ itemkey, sourcePath, destinationPath }) => ({
      itemkey,
      sourcePath,
      destinationPath,
    }),
  );
  if (repair) current.repairPaths = [...(current.repairPaths || []), ...paths];
  else current.attachmentPaths = paths;
  writeReviewJournal(journal);
  if (repair) entry.repairPaths = current.repairPaths;
  else entry.attachmentPaths = paths;
}

function recordAttachmentArchive(
  entry: JournalEntry,
  itemkey: string,
  archivePath: string,
  repair: boolean,
  resourcesOnly = false,
): void {
  const journal = readReviewJournal();
  const current = journal.find((candidate) => sameReview(candidate, entry));
  const paths = repair ? current?.repairPaths : current?.attachmentPaths;
  const path = paths?.find((candidate) => candidate.itemkey === itemkey);
  if (!current || current.state !== "in-flight" || !path)
    throw new Error(
      "The attachment journal changed before the archive was recorded.",
    );
  if (resourcesOnly) path.archiveDirectory = archivePath;
  else path.archivePath = archivePath;
  writeReviewJournal(journal);
  if (repair) entry.repairPaths = paths;
  else entry.attachmentPaths = paths;
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
  reportedUncertain.delete(key);
  uncertainReportErrors.delete(key);
  uncertainTitleErrors.delete(key);
  uncertainAttachmentErrors.delete(key);
  if (!uncertainReportErrors.size && lastWarning === uncertainReportWarning)
    lastWarning = "";
  acknowledgementErrors.delete(key);
  recoveryErrors.delete(key);
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
  let title: string | undefined;
  let attachments: ZoteroAttachment[] | undefined;
  let attachmentCheckError: string | undefined;
  try {
    const libraries = Zotero.Libraries.getAll().filter(
      (library: any) =>
        (library.libraryType === "user" || library.libraryType === "group") &&
        Zotero.URI.getLibraryURI(library.libraryID) === entry.libraryURI,
    );
    if (libraries.length === 1) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraries[0].libraryID,
        entry.itemkey,
      );
      if (item && !item.deleted && item.isRegularItem()) {
        if (typeof item.getField === "function") {
          const value = item.getField("title");
          if (typeof value === "string" && value.trim()) title = value.trim();
        }
        if (entry.operation === "attachment-move") {
          try {
            attachments = getAttachments(item).filter(
              (attachment) => attachment.isFile,
            );
            uncertainAttachmentErrors.delete(key);
          } catch (error) {
            attachmentCheckError =
              error instanceof Error ? error.message : String(error);
            if (uncertainAttachmentErrors.get(key) !== attachmentCheckError) {
              Zotero.logError(
                `[Obsidian sync] Could not inspect attachments for ${entry.itemkey}: ${attachmentCheckError}`,
              );
              uncertainAttachmentErrors.set(key, attachmentCheckError);
            }
          }
        }
      } else if (entry.operation === "attachment-move") {
        attachmentCheckError = "The Zotero item is missing or unavailable.";
      }
    } else if (entry.operation === "attachment-move") {
      attachmentCheckError = "The Zotero library could not be identified.";
    }
    uncertainTitleErrors.delete(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (entry.operation === "attachment-move") attachmentCheckError = message;
    if (uncertainTitleErrors.get(key) !== message) {
      Zotero.logError(
        `[Obsidian sync] Could not find title for uncertain review ${entry.itemkey}: ${message}`,
      );
      uncertainTitleErrors.set(key, message);
    }
  }
  try {
    const response = await postReview({
      action: "review-uncertain",
      itemkey: entry.itemkey,
      libraryURI: entry.libraryURI,
      operation: entry.operation,
      ...(title ? { title } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(attachments ? { attachments } : {}),
      ...(attachmentCheckError ? { attachmentCheckError } : {}),
      ...(entry.attachmentPaths || entry.repairPaths
        ? {
            attachmentPaths: [
              ...(entry.attachmentPaths || []),
              ...(entry.repairPaths || []),
            ],
          }
        : {}),
    });
    if (!response?.success)
      throw new Error(
        response?.error || "Obsidian did not acknowledge the uncertain review.",
      );
    uncertainReportErrors.delete(key);
    reportedUncertain.add(key);
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
        (attachment.snapshotDirectory === undefined ||
          attachment.snapshotDirectory === true) &&
        (attachment.sourceMissing === undefined ||
          attachment.sourceMissing === true) &&
        ["move", "newest", "keep-destination", "keep-note", "trash"].includes(
          attachment.resolution as string,
        ) &&
        typeof attachment.conflict === "boolean" &&
        typeof attachment.identical === "boolean" &&
        (attachment.sourceMissing === true
          ? attachment.resolution === "keep-note" &&
            attachment.sourceMtime === undefined &&
            attachment.snapshotDirectory === undefined
          : typeof attachment.sourceMtime === "number" &&
            Number.isFinite(attachment.sourceMtime)) &&
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
    dismissSyncNotice?.();
    dismissSyncNotice = showDismissibleNotice(
      `Literature note sync: ${message}`,
      {
        type: "fail",
        timeoutMs: 12000,
      },
    );
    lastWarning = message;
  }
}

export async function syncExistingNotesOnce(
  sessionScan = false,
): Promise<boolean> {
  if (!addon.data.alive) return false;
  readReviewJournal();
  if (!(await isObsidianServerReady())) return false;
  let complete = true;
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
  const seenIdentities = new Set<string>();
  for (const identity of identities) {
    if (!addon.data.alive) return false;
    if (!identity.itemkey) continue;
    const id = `${identity.libraryURI || "legacy"}:${identity.itemkey}`;
    if (sessionScan && scannedIdentities.has(id)) continue;
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
      if (error instanceof CitationKeyValidationError) {
        issues.push({
          notePath: identity.notePath,
          itemkey: identity.itemkey,
          checkedLibraries,
          matchingLibraries,
          kind: "invalid-citekey",
        });
      } else {
        complete = false;
        scanIssue = `Could not read Zotero item ${identity.itemkey}.`;
      }
      continue;
    }
    const resolvedId = `${payload.libraryURI || "legacy"}:${payload.itemkey}`;
    if (sessionScan && scannedIdentities.has(resolvedId)) {
      scannedIdentities.add(id);
      continue;
    }
    if (
      readReviewJournal().some(
        (entry) =>
          entry.itemkey === payload.itemkey &&
          entry.libraryURI === payload.libraryURI,
      )
    ) {
      if (sessionScan) {
        scannedIdentities.add(id);
        scannedIdentities.add(resolvedId);
      }
      continue;
    }
    if (!payload.citekey) {
      warn(`Zotero item ${identity.itemkey} has no citation key.`);
      issues.push({
        notePath: identity.notePath,
        itemkey: identity.itemkey,
        checkedLibraries,
        matchingLibraries,
        kind: "missing-citekey",
      });
      continue;
    }
    if (seenIdentities.has(resolvedId)) continue;
    seenIdentities.add(resolvedId);
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
      complete = false;
      continue;
    }
    if (Date.now() - previous.since < SETTLE_MS) {
      complete = false;
      continue;
    }
    try {
      await addCitationKeyCheck(candidates[0], payload, identity);
    } catch (error) {
      warn(
        `Could not check the Obsidian citation key for ${identity.itemkey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      scanIssue = `Could not check the Obsidian citation key for ${identity.itemkey}.`;
      complete = false;
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
      scanIssue = "Could not show the Obsidian note report.";
      complete = false;
    }
  }
  if (!payloads.length || !addon.data.alive)
    return complete && addon.data.alive;
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
  if (!payloads.length) return complete;
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
      scanIssue = error instanceof Error ? error.message : String(error);
      return false;
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
            "attachment-error",
          ].includes(entry.status),
      )
    )
      throw new UncertainReviewError(
        "An automatic reconciliation may be partial or returned an unknown status.",
      );
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.status === "error") {
        complete = false;
        scanIssue =
          entry.error || `Could not reconcile Zotero item ${identifiers[i]}.`;
      } else if (sessionScan) {
        scannedIdentities.add(identifiers[i]);
        scannedIdentities.add(
          `${payloads[i].libraryURI || "legacy"}:${payloads[i].itemkey}`,
        );
      }
      if (entry.status === "error")
        warn(
          `${entry.citekey || identifiers[i]}: ${entry.error || "unknown error"}`,
        );
      if (
        entry.status === "skipped" ||
        entry.status === "pending-review" ||
        entry.status === "attachment-error"
      )
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
        entry.status !== "attachment-error" &&
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
    complete = false;
    scanIssue = error instanceof Error ? error.message : String(error);
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
  return complete;
}

async function repairInterruptedAttachments(
  request: any,
  original: JournalEntry,
): Promise<void> {
  const key = reviewIdentity(original);
  inFlightReviews.add(key);
  try {
    const journal = readReviewJournal();
    const entry = journal.find((current) => sameReview(current, original));
    if (
      !entry ||
      entry.state !== "in-flight" ||
      entry.operation !== "attachment-move" ||
      entry.repairAttempt === request.repairId
    ) {
      throw new Error(
        "This interrupted attachment repair is no longer available.",
      );
    }
    entry.repairAttempt = request.repairId;
    writeReviewJournal(journal);
    const libraries = Zotero.Libraries.getAll().filter(
      (library: any) =>
        library.libraryType === "user" &&
        Zotero.URI.getLibraryURI(library.libraryID) === entry.libraryURI,
    );
    if (libraries.length !== 1)
      throw new Error("The Zotero library could not be identified.");
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraries[0].libraryID,
      entry.itemkey,
    );
    if (!item || item.deleted || !item.isRegularItem())
      throw new Error("The Zotero item is missing or in the trash.");
    await item.reload();
    const payload = await getSyncPayload(item);
    if (
      payload.itemkey !== entry.itemkey ||
      payload.libraryURI !== entry.libraryURI ||
      !payload.citekey
    )
      throw new Error(
        "The Zotero item identity or citation key is unavailable.",
      );
    const prepared = await postReview({
      action: "attachment-repair-prepare",
      repairId: request.repairId,
      data: [payload],
    });
    if (!prepared.success || !isAttachmentMoveRequest(prepared.attachmentMove))
      throw new Error(
        prepared.error || "Obsidian could not prepare the attachment repair.",
      );
    const validatedBase = payload.linkedAttachmentBaseDirectoryValidated
      ? payload.linkedAttachmentBaseDirectory || ""
      : "";
    if (!validatedBase)
      throw new Error(
        "Zotero's Linked Attachment Base Directory is no longer validated inside the vault.",
      );
    const { moved, linked } = await moveReviewedAttachments(
      item,
      prepared.attachmentMove,
      validatedBase,
      "zotero",
      () => recordAttachmentPaths(original, prepared.attachmentMove, true),
      true,
      (key, archivePath, resourcesOnly) =>
        recordAttachmentArchive(
          original,
          key,
          archivePath,
          true,
          resourcesOnly,
        ),
    );
    if (
      moved.length !== prepared.attachmentMove.attachments.length ||
      linked.length !== prepared.attachmentMove.linkNoteFiles.length ||
      moved.some((result) => !result.preservedSource)
    ) {
      throw new Error(
        "Not all attachments were copied and linked while preserving the originals.",
      );
    }
    await item.reload();
    const updatedPayload = await getSyncPayload(item);
    const completed = await postReview({
      action: "attachment-repair-complete",
      repairId: request.repairId,
      data: [updatedPayload],
      moved,
      linked,
    });
    if (
      !Array.isArray(completed.results) ||
      completed.results.length !== 1 ||
      completed.results[0]?.status !== "updated"
    )
      throw new Error(
        completed.results?.[0]?.error ||
          completed.error ||
          "Obsidian did not update the note links.",
      );
    const journalAfterRepair = readReviewJournal();
    const finished = journalAfterRepair.find((current) =>
      sameReview(current, original),
    );
    if (!finished || finished.repairAttempt !== request.repairId)
      throw new Error(
        "The interrupted review record changed during the repair.",
      );
    finished.state = "ack-pending";
    writeReviewJournal(journalAfterRepair);
    await finishAcknowledgement(finished);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(
      `[Obsidian sync] Interrupted attachment repair ${original.itemkey}: ${message}`,
    );
    try {
      const response = await postReview({
        action: "review-failed",
        itemkey: original.itemkey,
        libraryURI: original.libraryURI,
        error: message,
      });
      if (!response.success)
        throw new Error(
          response.error || "Obsidian did not record the repair failure.",
        );
    } catch (reportError) {
      Zotero.logError(
        `[Obsidian sync] Could not report attachment repair failure: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }
    await reportUncertain(original, message);
  } finally {
    inFlightReviews.delete(key);
  }
}

export async function processReviewRequests(
  reportJournal = true,
): Promise<boolean> {
  if (!addon.data.alive) return false;
  readReviewJournal();
  if (!(await isObsidianServerReady())) return false;
  for (const entry of reportJournal ? readReviewJournal() : []) {
    if (entry.state === "ack-pending") await finishAcknowledgement(entry);
    else if (
      entry.operation !== "auto-attachment" &&
      !deferredAttachmentRecovery.has(reviewIdentity(entry)) &&
      (!scanId || scanComplete) &&
      !inFlightReviews.has(reviewIdentity(entry)) &&
      !inFlightSyncs.has(reviewIdentity(entry)) &&
      (!scanId || !reportedUncertain.has(reviewIdentity(entry)))
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
  // Obsidian keeps reviews only in memory, so a restarted Obsidian needs the finished scan run again.
  if (typeof data.obsidianSession === "string" && data.obsidianSession) {
    if (!lastObsidianSession) lastObsidianSession = data.obsidianSession;
    else if (
      data.obsidianSession !== lastObsidianSession &&
      (scanComplete || scanSessionMismatch)
    ) {
      lastObsidianSession = data.obsidianSession;
      restartScan(0);
      return false;
    }
  }
  if (
    typeof data.rescan === "string" &&
    data.rescan &&
    data.rescan !== lastRescan &&
    (scanComplete || scanSessionMismatch)
  ) {
    lastRescan = data.rescan;
    restartScan(0);
  }
  if (Array.isArray(data.itemTrash))
    for (const request of data.itemTrash) await trashRequestedItem(request);
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
  for (const [id, key] of pendingBlocked) {
    if (!pending.has(key)) pendingBlocked.delete(id);
  }
  const journal = readReviewJournal();
  for (const request of data.requests) {
    if (
      request?.operation !== "attachment-repair" ||
      typeof request.repairId !== "string" ||
      !request.repairId
    )
      continue;
    const existing = journal.find((entry) => sameReview(entry, request));
    if (
      !existing ||
      existing.operation !== "attachment-move" ||
      existing.state !== "in-flight" ||
      inFlightReviews.has(reviewIdentity(existing)) ||
      inFlightSyncs.has(reviewIdentity(existing))
    )
      continue;
    if (existing.repairAttempt === request.repairId) {
      const response = await postReview({
        action: "review-failed",
        itemkey: existing.itemkey,
        libraryURI: existing.libraryURI,
        error:
          "The repair was interrupted. Check both apps before starting another repair.",
      });
      if (!response.success)
        throw new Error(
          response.error || "Obsidian did not record the interrupted repair.",
        );
      return false;
    }
    await repairInterruptedAttachments(request, existing);
    return false;
  }
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
    operation: request.automaticAttachment
      ? "auto-attachment"
      : request.operation || "review-sync",
    state: "in-flight",
    ...(request.operation === "attachment-move" &&
    isAttachmentMoveRequest(request.attachmentMove)
      ? {
          attachmentPaths: request.attachmentMove.attachments.map(
            (attachment: AttachmentMoveRequest["attachments"][number]) => ({
              itemkey: attachment.itemkey,
              sourcePath: attachment.sourcePath,
              destinationPath: attachment.destinationPath,
            }),
          ),
        }
      : {}),
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
      if (request.automaticAttachment) {
        const prepared = await postReview({
          action: "attachment-auto-prepare",
          data: [payload],
        });
        if (!prepared.success)
          throw new Error(
            prepared.error || "The automatic attachment plan changed.",
          );
      }
      const { moved, linked } = await moveReviewedAttachments(
        item,
        request.attachmentMove,
        validatedBase,
        request.strategy,
        () => {
          recordAttachmentPaths(entry, request.attachmentMove, false);
          localMayHaveChanged = true;
        },
        !!request.automaticAttachment,
        (key, archivePath, resourcesOnly) =>
          recordAttachmentArchive(
            entry,
            key,
            archivePath,
            false,
            resourcesOnly,
          ),
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
    if (!matching.length)
      throw new Error("The matching Obsidian note is missing or ambiguous.");
    if (request.operation === "note-update" && matching.length !== 1)
      throw new Error(
        "Bulk note updates require exactly one matching Obsidian note.",
      );
    if (matching.length === 1)
      await addCitationKeyCheck(item, payload, matching[0]);
    const result = await postReview({
      action:
        request.operation === "note-update"
          ? "bulk-review-sync"
          : "review-sync",
      data: [payload],
    });
    const [reviewResult] = await resolveNoteKeyChoices(
      "review-sync",
      [{ item, payload }],
      result,
    );
    if (reviewResult.outcomeUncertain)
      throw new UncertainReviewError(
        reviewResult.error || "Review may be partial.",
      );
    if (reviewResult.status === "error" || reviewResult.status === "missing")
      throw new Error(reviewResult.error || "Review failed.");
    if (!["updated", "skipped", "pending-review"].includes(reviewResult.status))
      throw new UncertainReviewError(
        "Obsidian returned an unknown review result.",
      );
    completeReview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ReviewJournalClearError) {
      if (request.automaticAttachment) {
        warn(
          `Could not persist automatic attachment completion for ${entry.itemkey}: ${message}`,
        );
        return more;
      }
      if (!readOnlyFailure) {
        await reportUncertain(entry, message);
        return more;
      }
      warn(message);
      throw error;
    }
    if (
      request.automaticAttachment &&
      (error instanceof UncertainReviewError || localMayHaveChanged)
    ) {
      warn(
        `Automatic attachment reconciliation for ${entry.itemkey} may be incomplete: ${message}`,
      );
      return more;
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
    if ((scanStarted || scanSessionMismatch) && !running) {
      processingReviews = true;
      try {
        more = await processReviewRequests(!scanSessionMismatch);
      } finally {
        processingReviews = false;
      }
    }
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
  } finally {
    if (addon.data.alive && reviewPolling)
      reviewTimer = setTimeout(() => void pollReviews(), more ? 0 : 3000);
  }
}

async function scanBoundary(payload: object): Promise<void> {
  const response = await postReview(payload);
  if (!response?.success) {
    const message =
      response?.error ||
      "Obsidian did not acknowledge the initial review scan.";
    if (
      (response &&
        Object.prototype.hasOwnProperty.call(response, "initialReviewScan")) ||
      /^HTTP 409(?:\b|:)/.test(message)
    )
      throw new ScanSessionMismatchError(message);
    throw new Error(message);
  }
}

function invalidateRecoveryScan(entry: JournalEntry): void {
  const ids = [
    `${entry.libraryURI}:${entry.itemkey}`,
    `legacy:${entry.itemkey}`,
  ];
  for (const id of ids) {
    scannedIdentities.delete(id);
    observed.delete(id);
    blocked.delete(id);
    deferred.delete(id);
    pendingBlocked.delete(id);
  }
}

function libraryForURI(libraryURI: string): any {
  const libraries = Zotero.Libraries.getAll().filter(
    (library: any) =>
      (library.libraryType === "user" || library.libraryType === "group") &&
      Zotero.URI.getLibraryURI(library.libraryID) === libraryURI,
  );
  if (libraries.length !== 1)
    throw new Error("The Zotero library is unavailable or ambiguous.");
  return libraries[0];
}

/**
 * Move an item to Zotero's trash at Obsidian's request, after its note was merged into another note.
 * An item that is already in the trash or gone counts as done, so a repeated request is harmless.
 */
async function trashRequestedItem(request: any): Promise<void> {
  if (
    !request ||
    typeof request.id !== "string" ||
    !request.id ||
    typeof request.itemkey !== "string" ||
    typeof request.libraryURI !== "string" ||
    inFlightItemTrash.has(request.id)
  )
    return;
  inFlightItemTrash.add(request.id);
  try {
    let error: string | undefined;
    try {
      const library = libraryForURI(request.libraryURI);
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library.libraryID,
        request.itemkey,
      );
      if (item && !item.deleted) {
        if (!item.isRegularItem())
          throw new Error("It is not a regular Zotero item.");
        item.deleted = true;
        await item.saveTx();
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    try {
      await postToObsidian({
        action: "item-trash-complete",
        id: request.id,
        ...(error ? { error } : {}),
      });
    } catch (failure) {
      Zotero.logError(
        `[Obsidian sync] Could not report the trash result for ${request.itemkey}: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  } finally {
    inFlightItemTrash.delete(request.id);
  }
}

async function currentRecoveryPayload(
  entry: JournalEntry,
): Promise<{ payload: ZoteroItemPayload; itemID: number }> {
  const library = libraryForURI(entry.libraryURI);
  const item = await Zotero.Items.getByLibraryAndKeyAsync(
    library.libraryID,
    entry.itemkey,
  );
  if (
    !item ||
    item.deleted ||
    !item.isRegularItem() ||
    item.key !== entry.itemkey ||
    item.libraryID !== library.libraryID ||
    !Number.isInteger(item.id) ||
    item.id <= 0
  )
    throw new Error("The Zotero item is missing, deleted, or replaced.");
  const itemID = item.id;
  await item.reload();
  if (
    item.deleted ||
    !item.isRegularItem() ||
    item.key !== entry.itemkey ||
    item.libraryID !== library.libraryID ||
    item.id !== itemID
  )
    throw new Error("The Zotero item changed while preparing recovery.");
  const payload = await getSyncPayload(item);
  if (
    payload.itemkey !== entry.itemkey ||
    payload.libraryURI !== entry.libraryURI ||
    typeof payload.title !== "string" ||
    typeof payload.citekey !== "string" ||
    !payload.citekey ||
    !Array.isArray(payload.attachments)
  )
    throw new Error(
      "The Zotero item identity or attachment data is incomplete.",
    );
  const keys = new Set<string>();
  for (const attachment of payload.attachments) {
    if (
      !attachment ||
      typeof attachment.itemkey !== "string" ||
      !attachment.itemkey ||
      keys.has(attachment.itemkey) ||
      typeof attachment.isFile !== "boolean" ||
      (attachment.isFile &&
        (typeof attachment.path !== "string" ||
          !attachment.path ||
          !["stored", "linked"].includes(attachment.mode || ""))) ||
      (!attachment.isFile &&
        (attachment.mode !== "url" ||
          typeof attachment.url !== "string" ||
          !attachment.url))
    )
      throw new Error("The Zotero attachment data is incomplete or ambiguous.");
    keys.add(attachment.itemkey);
  }
  const current = await Zotero.Items.getByLibraryAndKeyAsync(
    library.libraryID,
    entry.itemkey,
  );
  if (
    !current ||
    current.deleted ||
    !current.isRegularItem() ||
    current.key !== entry.itemkey ||
    current.libraryID !== library.libraryID ||
    current.id !== itemID
  )
    throw new Error("The Zotero item changed while preparing recovery.");
  return { payload, itemID };
}

async function recoverInitialReview(
  entry: JournalEntry,
): Promise<"recovered" | "deferred" | "failed"> {
  const key = reviewIdentity(entry);
  if (inFlightReviews.has(key) || inFlightSyncs.has(key))
    throw new Error(
      "A Zotero review is still in progress; retrying the initial scan.",
    );
  inFlightReviews.add(key);
  try {
    const { payload, itemID } = await currentRecoveryPayload(entry);
    const before = readReviewJournal().find((candidate) =>
      sameReview(candidate, entry),
    );
    if (
      !addon.data.alive ||
      inFlightSyncs.has(key) ||
      !before ||
      JSON.stringify(before) !== JSON.stringify(entry) ||
      before.state !== "in-flight"
    )
      throw new Error("The interrupted review changed before recovery.");
    const snapshot = JSON.stringify(payload);
    const response = await postReview({
      action: "review-recover",
      data: [payload],
      ...(entry.operation === "auto-attachment" && entry.attachmentPaths
        ? { automaticAttachmentPaths: entry.attachmentPaths }
        : {}),
    });
    if (
      response?.results?.length === 1 &&
      response.results[0]?.status === "attachment-error" &&
      response.results[0]?.citekey === payload.citekey
    ) {
      deferredAttachmentRecovery.add(key);
      return "deferred";
    }
    if (
      response?.success !== true ||
      !Array.isArray(response.results) ||
      response.results.length !== 1 ||
      !["skipped", "pending-review"].includes(response.results[0]?.status) ||
      response.results[0]?.citekey !== payload.citekey
    )
      throw new Error(
        response?.results?.[0]?.error ||
          response?.error ||
          "Obsidian could not recover the interrupted review.",
      );
    const currentPayload = await currentRecoveryPayload(entry);
    if (
      currentPayload.itemID !== itemID ||
      JSON.stringify(currentPayload.payload) !== snapshot
    )
      throw new Error("The Zotero item changed during recovery.");
    const journal = readReviewJournal();
    const current = journal.find((candidate) => sameReview(candidate, entry));
    if (
      !addon.data.alive ||
      inFlightSyncs.has(key) ||
      !current ||
      JSON.stringify(current) !== JSON.stringify(entry) ||
      current.state !== "in-flight"
    )
      throw new Error("The interrupted review changed during recovery.");
    writeReviewJournal(
      journal.filter((candidate) => !sameReview(candidate, entry)),
    );
    forgetUncertain(entry);
    deferredAttachmentRecovery.delete(key);
    invalidateRecoveryScan(entry);
    return "recovered";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (recoveryErrors.get(key) !== message) {
      Zotero.logError(
        `[Obsidian sync] Could not recover interrupted review ${entry.itemkey}: ${message}`,
      );
      recoveryErrors.set(key, message);
    }
    return "failed";
  } finally {
    inFlightReviews.delete(key);
  }
}

async function reportInitialJournal(): Promise<boolean> {
  let recovered = false;
  for (const entry of readReviewJournal()) {
    const key = reviewIdentity(entry);
    if (inFlightReviews.has(key) || inFlightSyncs.has(key))
      throw new Error(
        "A Zotero review is still in progress; retrying the initial scan.",
      );
    if (entry.state === "ack-pending") await finishAcknowledgement(entry);
    else if (!reportedUncertain.has(key)) {
      const recovery = await recoverInitialReview(entry);
      if (recovery === "recovered") {
        recovered = true;
      } else if (recovery === "failed") {
        const current = readReviewJournal().find((candidate) =>
          sameReview(candidate, entry),
        );
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(entry) ||
          inFlightReviews.has(key) ||
          inFlightSyncs.has(key)
        )
          throw new Error(
            "The interrupted review changed; retrying the initial scan.",
          );
        if (entry.operation === "auto-attachment") {
          warn(
            `Could not resume automatic attachment reconciliation for ${entry.itemkey}.`,
          );
        } else await reportUncertain(entry);
      }
    }
  }
  if (uncertainReportErrors.size || acknowledgementErrors.size)
    throw new Error("Could not report all interrupted reviews to Obsidian.");
  return recovered;
}

function schedule(delay: number): void {
  if (!addon.data.alive || scanComplete || scanSessionMismatch) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(), delay);
}

async function run(): Promise<void> {
  if (!addon.data.alive || running || scanComplete || scanSessionMismatch)
    return;
  if (processingReviews) {
    schedule(3000);
    return;
  }
  running = true;
  try {
    if (!(await isObsidianServerReady())) return;
    if (!scanStarted) {
      await scanBoundary({ action: "initial-review-scan-start", scanId });
      scanStarted = true;
    }
    if (!scanWorkDone) {
      if (getAttachmentBaseValidationState() === "pending") return;
      await reportInitialJournal();
      scanIssue = "";
      scanWorkDone = await syncExistingNotesOnce(true);
      if (!scanWorkDone) {
        if (scanIssue) throw new Error(scanIssue);
        return;
      }
      try {
        if (await reportInitialJournal()) {
          scanWorkDone = false;
          return;
        }
      } catch (error) {
        scanWorkDone = false;
        throw error;
      }
    }
    await scanBoundary({
      action: "initial-review-scan-end",
      scanId,
      status: "complete",
    });
    scanComplete = true;
    dismissSyncNotice?.();
    dismissSyncNotice = showDismissibleNotice(getString("startup-finish"));
    lastWarning = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ScanSessionMismatchError) {
      scanSessionMismatch = true;
      scanStarted = false;
      warn(
        "The Zotero and Obsidian review scan sessions no longer match. Restart both applications to check inconsistencies again.",
      );
      return;
    }
    warn(message);
    if (scanStarted && !scanWorkDone) {
      try {
        await scanBoundary({
          action: "initial-review-scan-end",
          scanId,
          status: "error",
          error: message,
        });
      } catch (boundaryError) {
        Zotero.logError(
          `[Obsidian sync] Could not report initial scan failure: ${boundaryError instanceof Error ? boundaryError.message : String(boundaryError)}`,
        );
      }
      scanStarted = false;
    }
  } finally {
    running = false;
    if (!scanComplete) schedule(3000);
  }
}

function restartScan(delay: number): void {
  scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  scanStarted = false;
  scanWorkDone = false;
  scanComplete = false;
  scanSessionMismatch = false;
  scannedIdentities.clear();
  reportedUncertain.clear();
  // A full recheck starts with Obsidian's review list cleared, so items it already reported must be sent again.
  blocked.clear();
  pendingBlocked.clear();
  deferred.clear();
  schedule(delay);
}

export function startAutoSync(): void {
  restartScan(1500);
  reviewTimer = setTimeout(() => void pollReviews(), 1500);
  reviewPolling = true;
}

export function stopAutoSync(): void {
  dismissSyncNotice?.();
  dismissSyncNotice = undefined;
  reviewPolling = false;
  if (reviewTimer) clearTimeout(reviewTimer);
  reviewTimer = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  scanId = "";
  lastObsidianSession = "";
  scanStarted = false;
  scanWorkDone = false;
  scanComplete = false;
  scanSessionMismatch = false;
  scannedIdentities.clear();
  reportedUncertain.clear();
  blocked.clear();
  pendingBlocked.clear();
  deferred.clear();
  observed.clear();
  warnedUncertain.clear();
  uncertainReportErrors.clear();
  uncertainTitleErrors.clear();
  uncertainAttachmentErrors.clear();
  acknowledgementErrors.clear();
  recoveryErrors.clear();
  deferredAttachmentRecovery.clear();
  inFlightItemTrash.clear();
  lastRescan = "";
  lastWarning = "";
  lastReport = "";
  closeNoteMatchReport();
}
