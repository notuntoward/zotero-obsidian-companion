import { getSyncPayload } from "./obsidianPayload";
import { isObsidianServerReady, postToObsidian } from "./obsidianConnection";
import { resolveNoteKeyChoices } from "./resolveNoteKeys";
import { addCitationKeyCheck, getNoteIdentities } from "./citationKeyCheck";
import type { NoteIdentity } from "./citationKeyCheck";
import { showNotice } from "../utils/progressNotice";
import { showNoteMatchReport, closeNoteMatchReport } from "./noteMatchReport";
import type { NoteMatchIssue } from "./noteMatchReport";

declare const Zotero: any;
declare const addon: any;

const blocked = new Map<string, string>();
const deferred = new Map<string, { payload: string; citekey: string }>();
const observed = new Map<string, { snapshot: string; since: number }>();
const SETTLE_MS = 2000;
let lastWarning = "";
let lastReport = "";
let observerID: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let requested = false;

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
    if (entry.status === "skipped") blocked.set(identifiers[i], snapshots[i]);
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
      entry.status !== "error"
    )
      warn(
        `${entry.citekey || identifiers[i]}: unexpected sync result ${String(entry.status)}`,
      );
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
}

export function stopAutoSync(): void {
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  blocked.clear();
  deferred.clear();
  observed.clear();
  lastReport = "";
  closeNoteMatchReport();
}
