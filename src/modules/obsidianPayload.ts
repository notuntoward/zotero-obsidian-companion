/**
 * Extracts payload data from Zotero items to send to Obsidian Perplexity Saver.
 */

import { getValidatedAttachmentBaseDirectory } from "./attachmentBaseMonitor";

// Zotero global is available in this context
declare const Zotero: any;

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroAttachment {
  itemkey?: string;
  title?: string;
  path?: string;
  url?: string;
  isFile?: boolean;
  mode?: "linked" | "stored" | "url";
  usesRelativePath?: boolean;
}

export interface ZoteroRelation {
  citekey?: string;
}

export interface CitationKeyCheck {
  citekey: string;
  matches: Array<{
    title: string;
    citekey: string;
    libraryURI: string;
    itemkey: string;
  }>;
}

export interface ZoteroItemPayload {
  title: string;
  citekey: string;
  bibliography?: string;
  tags?: string[];
  collections?: string[];
  exportDate?: string;
  desktopURI?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  creators?: ZoteroCreator[];
  date?: string;
  itemkey?: string;
  libraryURI?: string;
  libraryName?: string;
  libraryType?: "user" | "group";
  itemType?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  publisher?: string;
  place?: string;
  pages?: string;
  ISBN?: string;
  allTags?: string[];
  notes?: string[]; // HTML strings
  attachments?: ZoteroAttachment[];
  linkedAttachmentBaseDirectory?: string;
  linkedAttachmentBaseDirectoryValidated?: boolean;
  /** Filename (without extension) Zotero's renaming template produces for this item. */
  attachmentBaseName?: string;
  relations?: ZoteroRelation[];
  citationKeyCheck?: CitationKeyCheck;
  zoteroChanges?: {
    previousCitekey: string;
    attachmentMoves: Array<{ itemkey: string; from: string; to: string }>;
  };
}

export async function getCiteKey(item: any): Promise<string> {
  let citekey = "";
  // Zotero 9+ native citekey support
  try {
    const key = getFieldSafe(item, "citationKey");
    if (key) citekey = key;
  } catch (e) {
    /* ignore */
  }

  // Fallback to Better BibTeX if available
  if (!citekey && Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager) {
    try {
      const bbtKey = Zotero.BetterBibTeX.KeyManager.get(item.id);
      if (bbtKey && bbtKey.citationKey) citekey = bbtKey.citationKey;
    } catch (e) {
      // ignore
    }
  }

  if (citekey) {
    // eslint-disable-next-line no-control-regex
    const windowsInvalidChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (windowsInvalidChars.test(citekey)) {
      throw new Error(
        `Cannot create note for citation key '${citekey}'.\n\nReason: Filename contains invalid character(s). These characters cannot be used in filenames on Windows.\n\nPlease edit the citation key in Zotero to fix this issue.`,
      );
    }
    const reservedPattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedPattern.test(citekey)) {
      throw new Error(
        `Cannot create note for citation key '${citekey}'.\n\nReason: '${citekey}' is a reserved Windows device name.\n\nPlease edit the citation key in Zotero to fix this issue.`,
      );
    }
  }

  return citekey;
}

async function getBibliography(item: any): Promise<string> {
  let bibliography = "";
  const citekey = await getCiteKey(item);
  const libItemId = `${item.libraryID}:${item.key}`;

  try {
    let bbtCitekey = citekey;
    try {
      const ckResponse = await (Zotero as any).HTTP.request(
        "POST",
        "http://127.0.0.1:23119/better-bibtex/json-rpc",
        {
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "item.citationkey",
            params: [[libItemId]],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const ckResult = JSON.parse(ckResponse.responseText);
      if (ckResult && ckResult.result && ckResult.result[libItemId]) {
        bbtCitekey = ckResult.result[libItemId];
      }
    } catch (e) {
      Zotero.debug("Failed to resolve bbt citekey: " + e);
    }

    try {
      const bbtResponse = await (Zotero as any).HTTP.request(
        "POST",
        "http://127.0.0.1:23119/better-bibtex/json-rpc",
        {
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "item.bibliography",
            params: [
              [bbtCitekey],
              {
                contentType: "text",
                id: "modern-language-association",
                locale: "en-US",
                quickCopy: false,
              },
            ],
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const result = JSON.parse(bbtResponse.responseText);
      if (result && result.result) {
        bibliography = result.result;
      }
    } catch (e) {
      Zotero.debug("Failed to fetch bibliography via citekey: " + e);
    }

    if (!bibliography) {
      try {
        const libBibResp = await (Zotero as any).HTTP.request(
          "POST",
          "http://127.0.0.1:23119/better-bibtex/json-rpc",
          {
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "item.bibliography",
              params: [
                [libItemId],
                {
                  contentType: "text",
                  id: "modern-language-association",
                  locale: "en-US",
                  quickCopy: false,
                },
              ],
            }),
            headers: { "Content-Type": "application/json" },
          },
        );
        const libBibResult = JSON.parse(libBibResp.responseText);
        if (libBibResult && libBibResult.result) {
          bibliography = libBibResult.result;
        }
      } catch (e) {
        Zotero.debug("Failed to fetch bibliography via libItemId: " + e);
      }
    }
  } catch (e) {
    Zotero.debug("Failed to fetch bibliography from BBT RPC: " + e);
  }

  // Fallback to Zotero's internal QuickCopy Engine if BBT failed or isn't installed
  if (!bibliography) {
    try {
      Zotero.debug("Falling back to native Zotero MLA QuickCopy export...");
      const format =
        "bibliography=http://www.zotero.org/styles/modern-language-association";

      // getContentFromItems returns { html: string, text: string } or a Promise in newer Zotero
      const qcResult = await Zotero.QuickCopy.getContentFromItems(
        [item],
        format,
      );

      if (qcResult) {
        if (qcResult.text) bibliography = qcResult.text;
        else if (qcResult.html) bibliography = qcResult.html;
        else if (typeof qcResult === "string") bibliography = qcResult;
      }
    } catch (err) {
      Zotero.debug("Error in Zotero QuickCopy native fallback: " + err);
    }
  }

  if (bibliography) {
    bibliography = bibliography.replace(/https?:\/\/\S+/g, "");
    bibliography = bibliography.replace(/www\.\S+/g, "");
    bibliography = bibliography.replace(/doi\.org\/\S+/g, "");
    bibliography = bibliography.replace(/,\s*\./g, ".");
    bibliography = bibliography.replace(/,\s*$/g, ".");
    bibliography = bibliography.replace(/,\s+,/g, ",");
    bibliography = bibliography.replace(/,\s*\./g, ".");
    bibliography = bibliography.replace(/\s+/g, " ").trim();
  }

  return bibliography;
}

function getFieldSafe(item: any, fieldName: string): string | undefined {
  try {
    const val = item.getField(fieldName);
    return val ? String(val) : undefined;
  } catch (e) {
    return undefined;
  }
}

function getAttachments(item: any): ZoteroAttachment[] {
  return item.getAttachments().map((id: number) => {
    const att = Zotero.Items.get(id);
    if (!att) throw new Error(`Zotero attachment ${id} could not be loaded.`);
    const isFile = att.isFileAttachment();
    const mode = !isFile
      ? "url"
      : att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE
        ? "linked"
        : att.attachmentLinkMode ===
              Zotero.Attachments.LINK_MODE_IMPORTED_FILE ||
            att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_IMPORTED_URL
          ? "stored"
          : undefined;
    return {
      itemkey: att.key,
      title: att.getField("title"),
      path: att.getFilePath() || undefined,
      url: att.getField("url"),
      isFile,
      mode,
      ...(mode === "linked"
        ? {
            usesRelativePath:
              typeof att.attachmentPath === "string" &&
              att.attachmentPath.startsWith(
                Zotero.Attachments.BASE_PATH_PLACEHOLDER,
              ),
          }
        : {}),
    };
  });
}

function getAttachmentBaseName(item: any): string | undefined {
  try {
    const name = Zotero.Attachments.getFileBaseNameFromItem(item);
    if (typeof name === "string" && name.trim()) return name;
    Zotero.logError(
      `[Obsidian sync] Attachment renaming template returned no filename for item ${item.key}.`,
    );
  } catch (error) {
    Zotero.logError(
      `[Obsidian sync] Could not evaluate attachment renaming template for item ${item.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return undefined;
}

export async function getSyncPayload(item: any): Promise<ZoteroItemPayload> {
  return {
    title: item.getField("title") || "(untitled)",
    citekey: await getCiteKey(item),
    itemkey: item.key,
    libraryURI: Zotero.URI.getLibraryURI(item.libraryID),
    libraryName: Zotero.Libraries.get(item.libraryID).name,
    libraryType: Zotero.Libraries.get(item.libraryID).libraryType,
    attachments: getAttachments(item),
    attachmentBaseName: getAttachmentBaseName(item),
    linkedAttachmentBaseDirectory: String(
      Zotero.Prefs.get("baseAttachmentPath") || "",
    ),
    linkedAttachmentBaseDirectoryValidated:
      !!Zotero.Prefs.get("baseAttachmentPath") &&
      String(Zotero.Prefs.get("baseAttachmentPath")) ===
        getValidatedAttachmentBaseDirectory(),
  };
}

export async function getItemPayload(item: any): Promise<ZoteroItemPayload> {
  const citekey = await getCiteKey(item);

  const tags = item.getTags().map((t: any) => t.tag);
  const collections = item
    .getCollections()
    .map((id: number) => {
      const col = Zotero.Collections.get(id);
      return col ? col.name : "";
    })
    .filter((n: string) => n);

  const creators = item.getCreators().map((c: any) => ({
    firstName: c.firstName,
    lastName: c.lastName,
    name: c.name,
    creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
  }));

  const attachments = getAttachments(item);
  const notes: string[] = [];

  const noteIDs = item.getNotes();
  for (const id of noteIDs) {
    const note = Zotero.Items.get(id);
    if (note) {
      let html = note.getNote();

      try {
        // Parse the HTML using DOMParser (available in Firefox/Zotero environment)
        let parser;
        if (typeof DOMParser !== "undefined") {
          parser = new DOMParser();
        } else {
          parser = new ((Zotero as any).getMainWindow().DOMParser)();
        }
        const doc = parser.parseFromString(html, "text/html");
        const citations = doc.querySelectorAll(".citation[data-citation]");

        let modified = false;
        for (const citeNode of Array.from(citations)) {
          const cite = citeNode as Element;
          const dataStr = cite.getAttribute("data-citation");
          if (dataStr) {
            try {
              // Zotero often HTML escapes this attribute, unescape it if needed, but getAttribute usually unescapes.
              let decodedStr = dataStr;
              if (decodedStr.startsWith("%7B")) {
                decodedStr = decodeURIComponent(decodedStr);
              }
              const data = JSON.parse(decodedStr);
              if (data.citationItems && data.citationItems.length > 0) {
                const uris = data.citationItems[0].uris;
                if (uris && uris.length > 0) {
                  const uri = uris[0];
                  const relItem = Zotero.URI.getURIItem(uri);
                  if (relItem) {
                    const citekey = await getCiteKey(relItem);
                    if (citekey) {
                      cite.setAttribute("data-citekey", citekey);
                      cite.setAttribute("data-zotero-uri", uri);
                      modified = true;
                    }
                  }
                }
              }
            } catch (e) {
              Zotero.debug("Failed to parse data-citation", e);
            }
          }
        }

        if (modified) {
          html = doc.body.innerHTML;
        }
      } catch (err) {
        Zotero.debug("Error parsing note HTML with DOMParser", err);
      }

      notes.push(html);
    }
  }

  const relations: ZoteroRelation[] = [];
  // Zotero relations usually have URIs like "http://zotero.org/users/123/items/ABC"
  // Or for BBT citekeys, we need to resolve the related item.
  const relatedItemURIs = item.getRelations()["dc:relation"];
  if (relatedItemURIs && Array.isArray(relatedItemURIs)) {
    for (const uri of relatedItemURIs) {
      const relItem = Zotero.URI.getURIItem(uri);
      if (relItem) {
        const relCitekey = await getCiteKey(relItem);
        if (relCitekey) {
          relations.push({ citekey: relCitekey });
        }
      }
    }
  }

  return {
    title: item.getField("title") || "(untitled)",
    citekey,
    bibliography: await getBibliography(item),
    tags,
    collections,
    exportDate: new Date().toISOString(),
    desktopURI: Zotero.URI.getItemURI(item),
    DOI: getFieldSafe(item, "DOI"),
    url: getFieldSafe(item, "url"),
    abstractNote: getFieldSafe(item, "abstractNote"),
    creators,
    date: getFieldSafe(item, "date"),
    itemkey: item.key,
    libraryURI: Zotero.URI.getLibraryURI(item.libraryID),
    libraryName: Zotero.Libraries.get(item.libraryID).name,
    libraryType: Zotero.Libraries.get(item.libraryID).libraryType,
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    publicationTitle: getFieldSafe(item, "publicationTitle"),
    volume: getFieldSafe(item, "volume"),
    issue: getFieldSafe(item, "issue"),
    publisher: getFieldSafe(item, "publisher"),
    place: getFieldSafe(item, "place"),
    pages: getFieldSafe(item, "pages"),
    ISBN: getFieldSafe(item, "ISBN"),
    allTags: tags,
    notes,
    attachments,
    linkedAttachmentBaseDirectory: String(
      Zotero.Prefs.get("baseAttachmentPath") || "",
    ),
    linkedAttachmentBaseDirectoryValidated:
      !!Zotero.Prefs.get("baseAttachmentPath") &&
      String(Zotero.Prefs.get("baseAttachmentPath")) ===
        getValidatedAttachmentBaseDirectory(),
    relations,
  };
}
