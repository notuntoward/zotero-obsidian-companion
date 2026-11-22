import type { CitationKeyCheck, ZoteroItemPayload } from "./obsidianPayload";

declare const Zotero: any;

export interface NoteIdentity {
  itemkey: string;
  notePath?: string;
  libraryURI?: string;
  citekey: string;
  modifiedAt?: number;
  size?: number;
}

export async function getNoteIdentities(): Promise<NoteIdentity[]> {
  const response = await Zotero.HTTP.request(
    "GET",
    "http://127.0.0.1:27124/lit-note-identities",
  );
  const data = JSON.parse(response.responseText);
  if (!data.success || !Array.isArray(data.identities)) {
    throw new Error("Obsidian returned invalid literature note identities.");
  }
  return data.identities;
}

export function findNoteIdentity(
  payload: ZoteroItemPayload,
  identities: NoteIdentity[],
): NoteIdentity | undefined {
  const byKey = identities.filter((note) => note.itemkey === payload.itemkey);
  const matching = byKey.filter(
    (note) => !note.libraryURI || note.libraryURI === payload.libraryURI,
  );
  if (matching.length === 1) return matching[0];
  if (!matching.length && byKey.length === 1) return byKey[0];
  return undefined;
}

export async function checkCitationKey(
  item: any,
  citekey: string,
): Promise<CitationKeyCheck> {
  const bbt = Zotero.BetterBibTeX;
  if (bbt) {
    await bbt.ready;
    if (
      !bbt.KeyManager ||
      typeof bbt.KeyManager.get !== "function" ||
      bbt.KeyManager.started === false
    ) {
      throw new Error("Better BibTeX citation keys are not ready to check.");
    }
  }
  const insensitive =
    bbt &&
    Zotero.Prefs.get("translators.better-bibtex.citekeyCaseInsensitive") ===
      true;
  const compare = new Intl.Collator(undefined, { sensitivity: "base" });
  const matches: CitationKeyCheck["matches"] = [];
  const libraries = Zotero.Libraries.getAll().filter(
    (library: any) =>
      library.libraryType === "user" || library.libraryType === "group",
  );
  if (!libraries.some((library: any) => library.libraryID === item.libraryID)) {
    throw new Error(
      "The Zotero item's library is unavailable for citation-key checking.",
    );
  }
  for (const library of libraries) {
    const items = await Zotero.Items.getAll(library.libraryID, true, false);
    await Zotero.Items.loadDataTypes(items, ["itemData"]);
    for (const other of items) {
      if (
        !other.isRegularItem() ||
        other.deleted ||
        other.isFeedItem ||
        (other.libraryID === item.libraryID && other.key === item.key)
      )
        continue;
      const existing =
        other.getField("citationKey") ||
        bbt?.KeyManager.get(other.id)?.citationKey ||
        "";
      if (
        !existing ||
        (existing !== citekey &&
          (!insensitive || compare.compare(existing, citekey) !== 0))
      )
        continue;
      matches.push({
        title: String(other.getField("title") || "Untitled"),
        citekey: String(existing),
        libraryURI: Zotero.URI.getLibraryURI(library.libraryID),
        itemkey: other.key,
      });
    }
  }
  matches.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { citekey, matches };
}

export async function addCitationKeyCheck(
  item: any,
  payload: ZoteroItemPayload,
  identity: NoteIdentity | undefined,
): Promise<void> {
  const noteKey = identity?.citekey?.trim();
  if (noteKey && noteKey !== payload.citekey.trim()) {
    payload.citationKeyCheck = await checkCitationKey(item, noteKey);
  }
}
