export interface JournalEntry {
  itemkey: string;
  libraryURI: string;
  operation: string;
  state: "in-flight" | "ack-pending";
  error?: string;
  repairAttempt?: string;
  attachmentPaths?: Array<{
    itemkey: string;
    sourcePath: string;
    destinationPath: string;
    archivePath?: string;
    archiveDirectory?: string;
  }>;
  repairPaths?: JournalEntry["attachmentPaths"];
}

declare const Zotero: any;
declare const addon: any;

function preference(): string {
  return `${addon.data.config.prefsPrefix}.reviewJournal`;
}

function validPaths(paths: unknown): boolean {
  return (
    Array.isArray(paths) &&
    paths.every((path: unknown) => {
      if (!path || typeof path !== "object") return false;
      const candidate = path as Record<string, unknown>;
      return (
        typeof candidate.itemkey === "string" &&
        typeof candidate.sourcePath === "string" &&
        typeof candidate.destinationPath === "string" &&
        (candidate.archivePath === undefined ||
          typeof candidate.archivePath === "string") &&
        (candidate.archiveDirectory === undefined ||
          typeof candidate.archiveDirectory === "string")
      );
    })
  );
}

export function readReviewJournal(): JournalEntry[] {
  let raw: unknown;
  try {
    raw = Zotero.Prefs.get(preference(), true);
  } catch (error) {
    throw new Error(
      `Cannot read the review journal; automatic reviews are stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === undefined || raw === null) {
    writeReviewJournal([]);
    return [];
  }
  if (typeof raw !== "string")
    throw new Error("Invalid review journal; automatic reviews are stopped.");
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("Invalid review journal; automatic reviews are stopped.");
  }
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.itemkey !== "string" ||
        !entry.itemkey ||
        typeof entry.libraryURI !== "string" ||
        !entry.libraryURI ||
        typeof entry.operation !== "string" ||
        (entry.error !== undefined && typeof entry.error !== "string") ||
        (entry.repairAttempt !== undefined &&
          (typeof entry.repairAttempt !== "string" || !entry.repairAttempt)) ||
        (entry.attachmentPaths !== undefined &&
          !validPaths(entry.attachmentPaths)) ||
        (entry.repairPaths !== undefined && !validPaths(entry.repairPaths)) ||
        !["in-flight", "ack-pending"].includes(entry.state),
    ) ||
    new Set(
      entries.map((entry) => JSON.stringify([entry.libraryURI, entry.itemkey])),
    ).size !== entries.length
  )
    throw new Error("Invalid review journal; automatic reviews are stopped.");
  return entries as JournalEntry[];
}

export function writeReviewJournal(entries: JournalEntry[]): void {
  let services = (globalThis as any).Services;
  if (!services) {
    try {
      services = (globalThis as any).ChromeUtils?.importESModule(
        "resource://gre/modules/Services.sys.mjs",
      )?.Services;
    } catch (error) {
      throw new Error(
        `Cannot persist the review journal; automatic reviews are stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (typeof services?.prefs?.savePrefFile !== "function")
    throw new Error(
      "Cannot persist the review journal; automatic reviews are stopped.",
    );
  let previous: unknown;
  try {
    previous = Zotero.Prefs.get(preference(), true);
  } catch (error) {
    throw new Error(
      `Cannot persist the review journal; automatic reviews are stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    Zotero.Prefs.set(preference(), JSON.stringify(entries), true);
    services.prefs.savePrefFile(null);
  } catch (error) {
    try {
      Zotero.Prefs.set(preference(), previous ?? "", true);
      services.prefs.savePrefFile(null);
    } catch {
      // Preserve the previous in-memory journal when the preference file cannot be flushed.
    }
    throw new Error(
      `Cannot persist the review journal; automatic reviews are stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function sameReview(
  first: Pick<JournalEntry, "itemkey" | "libraryURI">,
  second: Pick<JournalEntry, "itemkey" | "libraryURI">,
): boolean {
  return (
    first.itemkey === second.itemkey && first.libraryURI === second.libraryURI
  );
}
