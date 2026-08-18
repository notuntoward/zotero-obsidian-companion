
/**
 * Extracts payload data from Zotero items to send to Obsidian Perplexity Saver.
 */

// Zotero global is available in this context
declare const Zotero: any;

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroAttachment {
  title?: string;
  path?: string;
  url?: string;
}

export interface ZoteroRelation {
  citekey?: string;
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
  relations?: ZoteroRelation[];
}

export async function getCiteKey(item: any): Promise<string> {
  let citekey = "";
  // Zotero 9+ native citekey support
  try {
    const key = getFieldSafe(item, "citationKey");
    if (key) citekey = key;
  } catch(e) {}

  // Fallback to Better BibTeX if available
  if (!citekey && Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager) {
    try {
      const bbtKey = Zotero.BetterBibTeX.KeyManager.get(item.id);
      if (bbtKey && bbtKey.citekey) citekey = bbtKey.citekey;
    } catch (e) {
      // ignore
    }
  }

  if (citekey) {
    const windowsInvalidChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (windowsInvalidChars.test(citekey)) {
        throw new Error(`Cannot create note for citation key '${citekey}'.\n\nReason: Filename contains invalid character(s). These characters cannot be used in filenames on Windows.\n\nPlease edit the citation key in Zotero to fix this issue.`);
    }
    const reservedPattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedPattern.test(citekey)) {
        throw new Error(`Cannot create note for citation key '${citekey}'.\n\nReason: '${citekey}' is a reserved Windows device name.\n\nPlease edit the citation key in Zotero to fix this issue.`);
    }
  }

  return citekey;
}

async function getBibliography(item: any): Promise<string> {
  let bibliography = "";
  const citekey = await getCiteKey(item);
  const libItemId = `${item.libraryID}:${item.key}`;

  try {
    // Attempt to fetch from BBT RPC
    const bbtResponse = await fetch("http://localhost:23119/better-bibtex/json-rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "item.bibliography",
            params: [
                [citekey ? citekey : libItemId],
                { contentType: "text", id: "modern-language-association", locale: "en-US", quickCopy: false }
            ]
        })
    });
    
    const result = (await bbtResponse.json()) as any;
    if (result && result.result) {
        bibliography = result.result;
    }
  } catch(e) {
     ztoolkit.log("Failed to fetch bibliography from BBT RPC", e);
  }

  // Fallback to Zotero's QuickCopy if BBT failed
  if (!bibliography) {
    try {
      const format = Zotero.Prefs.get("export.quickCopy.setting");
      const bib = Zotero.QuickCopy.unserializeSetting(format);
      if (bib && bib.mode === "bibliography") {
        const qs = new Zotero.Translate.Export();
        qs.setItems([item]);
        qs.setTranslator(bib.id);
        return new Promise<string>((resolve) => {
          qs.setHandler("done", (obj: any, success: boolean) => {
            if (success && obj && obj.string) {
              const cleanBib = obj.string.replace(/https?:\/\/\S+/g, "");
              resolve(cleanBib);
            } else {
              resolve("");
            }
          });
          qs.translate();
          setTimeout(() => resolve(""), 1000);
        });
      }
    } catch (err) {
      // ignore
    }
  }
  
  if (bibliography) {
    bibliography = bibliography.replace(/https?:\/\/\S+/g, '');
    bibliography = bibliography.replace(/www\.\S+/g, '');
    bibliography = bibliography.replace(/doi\.org\/\S+/g, '');
    bibliography = bibliography.replace(/,\s*\./g, '.');
    bibliography = bibliography.replace(/,\s*$/g, '.');
    bibliography = bibliography.replace(/,\s+,/g, ',');
    bibliography = bibliography.replace(/,\s*\./g, '.');
    bibliography = bibliography.replace(/\s+/g, ' ').trim();
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

export async function getItemPayload(item: any): Promise<ZoteroItemPayload> {
  const citekey = await getCiteKey(item);
  
  const tags = item.getTags().map((t: any) => t.tag);
  const collections = item.getCollections().map((id: number) => {
    const col = Zotero.Collections.get(id);
    return col ? col.name : "";
  }).filter((n: string) => n);

  const creators = item.getCreators().map((c: any) => ({
    firstName: c.firstName,
    lastName: c.lastName,
    name: c.name,
    creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID)
  }));

  const attachments: ZoteroAttachment[] = [];
  const notes: string[] = [];
  
  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const att = Zotero.Items.get(id);
    if (att) {
      attachments.push({
        title: att.getField("title"),
        path: att.getFilePath(),
        url: att.getField("url")
      });
    }
  }

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
               ztoolkit.log("Failed to parse data-citation", e);
            }
          }
        }
        
        if (modified) {
          html = doc.body.innerHTML;
        }
      } catch (err) {
        ztoolkit.log("Error parsing note HTML with DOMParser", err);
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
    relations,
  };
}
