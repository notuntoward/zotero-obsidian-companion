import { enumerateZoteroAttachmentPaths } from "./attachmentReferences";
import { getCiteKey, getItemPayload, getSyncPayload } from "./obsidianPayload";
import { postToObsidian } from "./obsidianConnection";
import { checkCitationKey } from "./citationKeyCheck";
import type { CitationKeyCheck, ZoteroItemPayload } from "./obsidianPayload";

declare const Zotero: any;

interface Pair {
  item: any;
  payload: {
    citekey: string;
    itemkey?: string;
    libraryURI?: string;
    citationKeyCheck?: CitationKeyCheck;
  };
}

interface Result {
  citekey: string;
  status: string;
  error?: string;
  noteCitekey?: string;
  deferUntilChanged?: boolean;
  expectedZoteroKey?: string;
  token?: string;
  needsAttachmentCheck?: boolean;
}

export async function resolveNoteKeyChoices(
  action: "sync" | "update",
  pairs: Pair[],
  response: { results?: Result[]; error?: string },
): Promise<Result[]> {
  if (
    !Array.isArray(response?.results) ||
    response.results.length !== pairs.length
  ) {
    throw new Error(
      response?.error || "Obsidian returned an incomplete sync result.",
    );
  }
  const results = [...response.results];
  for (let index = 0; index < results.length; index++) {
    let choice = results[index];
    if (choice.status !== "set-zotero-key" && choice.status !== "prepared")
      continue;
    const { item, payload } = pairs[index];
    let planCheck = payload.citationKeyCheck;
    let zoteroChanges: ZoteroItemPayload["zoteroChanges"];
    try {
      if (choice.status === "set-zotero-key") {
        const key = choice.noteCitekey;
        if (
          !key ||
          !planCheck ||
          planCheck.citekey !== key ||
          !choice.token ||
          choice.expectedZoteroKey !== payload.citekey ||
          item.key !== payload.itemkey ||
          Zotero.URI.getLibraryURI(item.libraryID) !== payload.libraryURI
        ) {
          throw new Error(
            "The requested Zotero item or citation key does not match the original request.",
          );
        }
        await item.reload();
        if ((await getCiteKey(item)) !== choice.expectedZoteroKey) {
          throw new Error(
            "Zotero's citation key changed while the decision was pending; retry.",
          );
        }
        const current =
          action === "sync"
            ? await getSyncPayload(item)
            : await getItemPayload(item);
        current.citationKeyCheck = await checkCitationKey(item, key);
        if (
          JSON.stringify(current.citationKeyCheck) !== JSON.stringify(planCheck)
        ) {
          throw new Error(
            "Zotero citation-key matches changed while the decision was pending; retry.",
          );
        }
        const verified = await postToObsidian({
          action: "validate-zotero-key",
          token: choice.token,
          data: [current],
        });
        if (
          !Array.isArray(verified?.results) ||
          verified.results.length !== 1 ||
          verified.results[0].status !== "skipped" ||
          verified.results[0].noteCitekey !== key
        ) {
          throw new Error(
            verified?.results?.[0]?.error ||
              "The note changed before Zotero could be updated; retry.",
          );
        }
        if ((await getCiteKey(item)) !== choice.expectedZoteroKey) {
          throw new Error(
            "Zotero's citation key changed while the decision was pending; retry.",
          );
        }
        const finalCheck = await checkCitationKey(item, key);
        if (JSON.stringify(finalCheck) !== JSON.stringify(planCheck)) {
          throw new Error(
            "Zotero citation-key matches changed before saving; retry.",
          );
        }
        if ((await getCiteKey(item)) !== choice.expectedZoteroKey) {
          throw new Error(
            "Zotero's citation key changed before saving; retry.",
          );
        }
        const beforeSave = await getSyncPayload(item);
        if (
          JSON.stringify(beforeSave.attachments) !==
          JSON.stringify(current.attachments)
        ) {
          throw new Error("Zotero attachments changed before saving; retry.");
        }
        item.setField("citationKey", key);
        await item.saveTx({ skipDateModifiedUpdate: true });
        await item.reload();
        if ((await getCiteKey(item)) !== key) {
          throw new Error(
            "Zotero did not retain the selected citation key. Check Better BibTeX and retry.",
          );
        }

        let previous = await getSyncPayload(item);
        let stable = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          await Zotero.Promise.delay(2000);
          const current = await getSyncPayload(item);
          if (current.citekey !== key) {
            throw new Error(
              "Zotero's citation key changed again after it was saved. No note changes were made.",
            );
          }
          if (
            JSON.stringify(current.attachments) ===
            JSON.stringify(previous.attachments)
          ) {
            stable = true;
            break;
          }
          previous = current;
        }
        if (!stable) {
          throw new Error(
            "Zotero attachments are still changing; the note was not updated. Retry after they settle.",
          );
        }
        const fresh =
          action === "sync"
            ? await getSyncPayload(item)
            : await getItemPayload(item);
        if (
          fresh.citekey !== key ||
          fresh.itemkey !== payload.itemkey ||
          fresh.libraryURI !== payload.libraryURI ||
          JSON.stringify(fresh.attachments) !==
            JSON.stringify(previous.attachments)
        ) {
          throw new Error(
            "Zotero changed while preparing the update; the note was not updated. Retry.",
          );
        }
        const oldAttachments = new Map(
          (beforeSave.attachments ?? [])
            .filter((attachment) => attachment.itemkey && attachment.path)
            .map((attachment) => [attachment.itemkey, attachment.path]),
        );
        zoteroChanges = {
          previousCitekey: choice.expectedZoteroKey,
          attachmentMoves: (fresh.attachments ?? []).flatMap((attachment) => {
            const oldPath =
              attachment.itemkey && oldAttachments.get(attachment.itemkey);
            return oldPath &&
              attachment.itemkey &&
              attachment.path &&
              oldPath !== attachment.path
              ? [
                  {
                    itemkey: attachment.itemkey,
                    from: oldPath,
                    to: attachment.path,
                  },
                ]
              : [];
          }),
        };
        fresh.zoteroChanges = zoteroChanges;
        const continued = await postToObsidian({ action, data: [fresh] });
        if (
          !Array.isArray(continued?.results) ||
          continued.results.length !== 1 ||
          continued.results[0].status === "set-zotero-key"
        ) {
          throw new Error(
            "Obsidian did not complete reconciliation. Retry after checking both apps.",
          );
        }
        choice = continued.results[0];
        planCheck = undefined;
      }
      if (choice.status === "prepared") {
        if (!choice.token)
          throw new Error("Obsidian did not provide an update plan.");
        const zoteroAttachmentPaths = choice.needsAttachmentCheck
          ? await enumerateZoteroAttachmentPaths()
          : undefined;
        const fresh =
          action === "sync"
            ? await getSyncPayload(item)
            : await getItemPayload(item);
        if (
          fresh.itemkey !== payload.itemkey ||
          fresh.libraryURI !== payload.libraryURI
        ) {
          throw new Error(
            "The Zotero item identity changed; no note changes were made.",
          );
        }
        if (planCheck) fresh.citationKeyCheck = planCheck;
        if (zoteroChanges) fresh.zoteroChanges = zoteroChanges;
        const applied = await postToObsidian({
          action: "apply-sync",
          token: choice.token,
          data: [fresh],
          ...(zoteroAttachmentPaths ? { zoteroAttachmentPaths } : {}),
        });
        if (
          !Array.isArray(applied?.results) ||
          applied.results.length !== 1 ||
          !["updated", "skipped", "missing", "error"].includes(
            applied.results[0].status,
          )
        ) {
          throw new Error(
            "Obsidian did not complete the prepared update; check the note and retry.",
          );
        }
        choice = applied.results[0];
      }
      results[index] = choice;
    } catch (error) {
      results[index] = {
        citekey: payload.citekey,
        status: "error",
        error: `Zotero key reconciliation may be partial; review both apps and retry: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return results;
}
