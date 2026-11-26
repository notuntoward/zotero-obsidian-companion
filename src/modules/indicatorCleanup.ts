import { ensureObsidianConnection, postToObsidian } from "./obsidianConnection";
import { getMainWindow, showAlert } from "../utils/alert";
import { showNotice } from "../utils/progressNotice";
import { getIndicatorIdentities } from "./citationKeyCheck";
import { refreshNoteIndicators } from "./noteIndicators";

declare const Zotero: any;
declare const addon: any;

const OLD_TAG = "obsLitNote";
let running = false;
let libraryCleanupRunning = false;

export async function fillMissingLibraryURIs(): Promise<void> {
  if (libraryCleanupRunning) return;
  libraryCleanupRunning = true;
  const win = getMainWindow();
  try {
    const connection = await ensureObsidianConnection({
      progressMessage: "Connecting to identify literature notes...",
    });
    if (!connection.ready) return;
    showNotice("Checking literature note library identities...");
    const { identities, unidentifiedNotes } = await getIndicatorIdentities();
    const counts = new Map<string, number>();
    for (const note of identities) {
      counts.set(note.itemkey, (counts.get(note.itemkey) ?? 0) + 1);
    }
    const libraries = Zotero.Libraries.getAll()
      .filter(
        (library: any) =>
          library.libraryType === "user" || library.libraryType === "group",
      )
      .map((library: any) => ({
        id: library.libraryID,
        uri: Zotero.URI.getLibraryURI(library.libraryID),
      }));
    if (!libraries.length || libraries.some((library: any) => !library.uri)) {
      throw new Error(
        "Zotero libraries are unavailable; no notes were changed.",
      );
    }
    const uniqueMatch = async (
      itemkey: string,
    ): Promise<string | undefined> => {
      const matches: Array<{ uri: string; item: any }> = [];
      for (const library of libraries) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          library.id,
          itemkey,
        );
        if (item) matches.push({ uri: library.uri, item });
      }
      if (matches.length !== 1) return undefined;
      const { item, uri } = matches[0];
      return item.isRegularItem() && !item.deleted ? uri : undefined;
    };
    const notes: Array<{
      notePath: string;
      itemkey: string;
      libraryURI: string;
    }> = [];
    let skipped = unidentifiedNotes;
    const skippedDetails: string[] = [];
    for (const note of identities) {
      if (note.libraryURI) continue;
      if (!note.notePath)
        throw new Error("Obsidian returned a note without a path.");
      if (counts.get(note.itemkey) !== 1) {
        skipped++;
        skippedDetails.push(
          `${note.notePath}: multiple literature notes share item key ${note.itemkey}.`,
        );
        continue;
      }
      const libraryURI = await uniqueMatch(note.itemkey);
      if (!libraryURI) {
        skipped++;
        skippedDetails.push(
          `${note.notePath}: item key ${note.itemkey} has no unique active Zotero item.`,
        );
        continue;
      }
      notes.push({
        notePath: note.notePath,
        itemkey: note.itemkey,
        libraryURI,
      });
    }
    const currentLibraries = Zotero.Libraries.getAll()
      .filter(
        (library: any) =>
          library.libraryType === "user" || library.libraryType === "group",
      )
      .map((library: any) => ({
        id: library.libraryID,
        uri: Zotero.URI.getLibraryURI(library.libraryID),
      }));
    if (JSON.stringify(currentLibraries) !== JSON.stringify(libraries)) {
      throw new Error(
        "Zotero libraries changed during the check; retry cleanup.",
      );
    }
    for (const note of notes) {
      if ((await uniqueMatch(note.itemkey)) !== note.libraryURI) {
        throw new Error(
          "Zotero item matches changed during the check; retry cleanup.",
        );
      }
    }
    if (!addon.data.alive) return;
    const result = await postToObsidian({
      action: "fill-missing-library-uris",
      notes,
    });
    if (
      !result ||
      typeof result.success !== "boolean" ||
      !Number.isInteger(result.updated) ||
      result.updated < 0 ||
      !Number.isInteger(result.reordered) ||
      result.reordered < 0 ||
      !Number.isInteger(result.unfilled) ||
      result.unfilled < 0 ||
      !Array.isArray(result.errors) ||
      result.errors.some((error: unknown) => typeof error !== "string") ||
      result.updated + result.unfilled !== notes.length ||
      result.success !== (result.errors.length === 0)
    ) {
      throw new Error(
        `Obsidian returned an incomplete cleanup result; some notes may have changed. ${result?.error || "Retry cleanup."}`,
      );
    }
    const errors: string[] = result.errors;
    try {
      await refreshNoteIndicators(true);
    } catch (error) {
      errors.push(`Could not refresh indicators: ${String(error)}`);
    }
    const summary = `Added library identities to ${result.updated} notes and repositioned existing identities in ${result.reordered} notes. Skipped ${skipped} notes without a unique match.`;
    const details = [
      ...(unidentifiedNotes
        ? [`${unidentifiedNotes} literature notes have no item key.`]
        : []),
      ...skippedDetails,
      ...errors,
    ];
    showAlert(
      win,
      errors.length
        ? "Library identity cleanup incomplete"
        : "Library identity cleanup complete",
      `${summary}${details.length ? `\n\n${details.join("\n")}` : ""}${errors.length ? "\n\nRetry after resolving these errors." : ""}`,
    );
  } catch (error) {
    Zotero.logError(error);
    showAlert(win, "Library identity cleanup failed", String(error));
  } finally {
    libraryCleanupRunning = false;
  }
}

export async function cleanupOldIndicators(): Promise<void> {
  if (running) return;
  running = true;
  const win = getMainWindow();
  try {
    const connection = await ensureObsidianConnection({
      progressMessage: "Connecting to remove old literature note indicators...",
    });
    if (!connection.ready) return;
    showNotice("Removing old literature note indicator tags...");
    const result = await postToObsidian({ action: "cleanup-obs-lit-note-tag" });
    if (
      !result ||
      typeof result.success !== "boolean" ||
      !Number.isInteger(result.removed) ||
      result.removed < 0 ||
      !Array.isArray(result.errors) ||
      result.errors.some((error: unknown) => typeof error !== "string")
    ) {
      throw new Error(
        "Obsidian returned an invalid cleanup result. Zotero tags were not changed.",
      );
    }

    const errors: string[] = result.errors.map(
      (error: string) => `Obsidian: ${error}`,
    );
    let removed = 0;
    const libraries = Zotero.Libraries.getAll().filter(
      (library: any) =>
        library.libraryType === "user" || library.libraryType === "group",
    );
    for (const library of libraries) {
      let failed = false;
      try {
        const items = await Zotero.Items.getAll(library.libraryID, false, true);
        for (const item of items) {
          if (!item.hasTag(OLD_TAG)) continue;
          try {
            item.removeTag(OLD_TAG);
            await item.saveTx();
            removed++;
          } catch (error) {
            failed = true;
            errors.push(
              `${library.name || library.libraryID}, ${item.key}: ${String(error)}`,
            );
            try {
              await item.reload(["tags"], true);
            } catch (reloadError) {
              errors.push(
                `${library.name || library.libraryID}, ${item.key}: Could not reload tags: ${String(reloadError)}`,
              );
            }
          }
        }
        if (!failed && Zotero.Tags.getColor(library.libraryID, OLD_TAG)) {
          await Zotero.Tags.setColor(library.libraryID, OLD_TAG, false);
        }
      } catch (error) {
        errors.push(`${library.name || library.libraryID}: ${String(error)}`);
      }
    }
    if (!result.success && !result.errors.length) {
      errors.push("Obsidian reported an incomplete cleanup.");
    }
    const summary = `Removed obsLitNote from ${removed} Zotero items and ${result.removed} Obsidian notes.`;
    showAlert(
      win,
      errors.length
        ? "Indicator cleanup incomplete"
        : "Indicator cleanup complete",
      errors.length
        ? `${summary}\n\n${errors.join("\n")}\n\nRetry cleanup after resolving these errors.`
        : summary,
    );
  } catch (error) {
    Zotero.logError(error);
    showAlert(win, "Indicator cleanup failed", String(error));
  } finally {
    running = false;
  }
}
