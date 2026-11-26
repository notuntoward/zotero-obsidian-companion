import { getIndicatorIdentities, type NoteIdentity } from "./citationKeyCheck";
import { ensureObsidianConnection } from "./obsidianConnection";
import { showNotice } from "../utils/progressNotice";
import { getString } from "../utils/locale";

declare const Zotero: any;
declare const addon: any;

const REFRESH_INTERVAL_MS = 15000;
const DEFAULT_COLOR = "#C99700";
const COLORS = new Set(["#C99700", "#E0B000", "#D6249F", "#8B5A2B", "#B00020"]);

type Indicator = "note" | "uncertain" | "";
type DisplayIndicator = Indicator | "stale-note" | "unknown";
type CachedIdentity = Pick<NoteIdentity, "itemkey" | "libraryURI">;

let indicators = new Map<string, Indicator>();
let libraryURIs = new Map<number, string>();
let online = false;
let hasSnapshot = false;
let unidentifiedNotes = 0;
let lastSavedSnapshot = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> | undefined;
let generation = 0;
let lastFailure = "";

function identityKey(libraryURI: string, itemkey: string): string {
  return JSON.stringify([libraryURI, itemkey]);
}

function buildSnapshot(identities: CachedIdentity[]): Map<string, Indicator> {
  const counts = new Map<string, number>();
  const legacyKeys = new Set<string>();
  for (const identity of identities) {
    if (!identity.itemkey) continue;
    if (!identity.libraryURI) {
      legacyKeys.add(identity.itemkey);
      continue;
    }
    const key = identityKey(identity.libraryURI, identity.itemkey);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const snapshot = new Map<string, Indicator>();
  for (const [key, count] of counts) {
    snapshot.set(key, count === 1 ? "note" : "uncertain");
  }
  for (const itemkey of legacyKeys) {
    for (const uri of libraryURIs.values()) {
      snapshot.set(identityKey(uri, itemkey), "uncertain");
    }
  }
  return snapshot;
}

function getLibraryURIs(): Map<number, string> {
  const libraries = Zotero.Libraries.getAll().filter(
    (library: any) =>
      library.libraryType === "user" || library.libraryType === "group",
  );
  return new Map(
    libraries.map((library: any) => [
      library.libraryID,
      Zotero.URI.getLibraryURI(library.libraryID),
    ]),
  );
}

function snapshotPreference(): string {
  return `${addon.data.config.prefsPrefix}.indicatorSnapshot`;
}

function isCachedIdentity(identity: unknown): identity is CachedIdentity {
  if (!identity || typeof identity !== "object") return false;
  return (
    "itemkey" in identity &&
    typeof identity.itemkey === "string" &&
    (!("libraryURI" in identity) ||
      identity.libraryURI === undefined ||
      typeof identity.libraryURI === "string")
  );
}

function restoreSnapshot(): void {
  try {
    const raw: unknown = Zotero.Prefs.get(snapshotPreference(), true);
    if (raw === undefined || raw === null || raw === "") return;
    if (typeof raw !== "string") throw new Error("Invalid snapshot format.");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      throw new Error("Invalid snapshot format.");
    if (
      !("identities" in parsed) ||
      !Array.isArray(parsed.identities) ||
      !parsed.identities.every(isCachedIdentity) ||
      !("unidentifiedNotes" in parsed) ||
      typeof parsed.unidentifiedNotes !== "number" ||
      !Number.isInteger(parsed.unidentifiedNotes) ||
      parsed.unidentifiedNotes < 0
    )
      throw new Error("Invalid snapshot contents.");
    libraryURIs = getLibraryURIs();
    indicators = buildSnapshot(parsed.identities);
    unidentifiedNotes = parsed.unidentifiedNotes;
    lastSavedSnapshot = raw;
    hasSnapshot = true;
  } catch (error) {
    Zotero.debug(`Literature note indicator cache could not be read: ${error}`);
  }
}

export function currentIndicatorColor(): string {
  const color = String(
    Zotero.Prefs.get(addon.data.config.prefsPrefix + ".indicatorColor", true),
  ).toUpperCase();
  return COLORS.has(color) ? color : DEFAULT_COLOR;
}

function redraw(): void {
  Zotero.ItemTreeManager.refreshColumns();
}

export function refreshIndicatorAppearance(): void {
  redraw();
}

export function indicatorForItem(item: any): DisplayIndicator {
  if (!item?.isRegularItem?.() || item.deleted) return "";
  if (!hasSnapshot) return "unknown";
  const uri = libraryURIs.get(item.libraryID);
  if (!uri || typeof item.key !== "string") return "unknown";
  const indicator =
    indicators.get(identityKey(uri, item.key)) ??
    (unidentifiedNotes ? "unknown" : "");
  return !online && indicator === "note" ? "stale-note" : indicator;
}

export function registerNoteIndicator(): void {
  const registered = Zotero.ItemTreeManager.registerColumn({
    dataKey: "obsidianNote",
    label: getString("indicator-column"),
    pluginID: addon.data.config.addonID,
    width: "56",
    staticWidth: true,
    minWidth: 24,
    zoteroPersist: ["width", "hidden", "sortDirection"],
    dataProvider: (item: any) => indicatorForItem(item),
    renderCell: (
      _index: number,
      data: DisplayIndicator,
      column: { className: string },
      first: boolean,
      doc: Document,
    ) => {
      const cell = doc.createElement("span");
      cell.className = `cell ${column.className}`;
      cell.style.textAlign = "center";
      if (first) cell.style.paddingInlineEnd = "0px";
      if (data) {
        const marker = doc.createElement("span");
        marker.className = "cell-text";
        marker.style.textAlign = "center";
        const hasNote = data === "note" || data === "stale-note";
        marker.textContent =
          data === "note" ? "◆" : data === "stale-note" ? "◇" : "?";
        marker.style.color = hasNote ? currentIndicatorColor() : "GrayText";
        if (hasNote) marker.style.fontSize = "1.5em";
        marker.title =
          data === "note"
            ? getString("indicator-has-note")
            : data === "stale-note"
              ? getString("indicator-stale")
              : getString("indicator-unknown");
        marker.setAttribute("aria-label", marker.title);
        cell.append(marker);
      }
      return cell;
    },
  });
  if (!registered)
    throw new Error("Could not register the literature note column.");
}

export function refreshNoteIndicators(afterPending = false): Promise<void> {
  if (pending) {
    return afterPending ? pending.then(() => refreshNoteIndicators()) : pending;
  }
  const currentGeneration = generation;
  pending = (async () => {
    try {
      const result = await getIndicatorIdentities();
      if (generation !== currentGeneration || !addon.data.alive) return;
      const uris = getLibraryURIs();
      const librariesChanged =
        JSON.stringify([...libraryURIs].sort()) !==
        JSON.stringify([...uris].sort());
      libraryURIs = uris;
      const snapshot = buildSnapshot(result.identities);
      const changed =
        !online ||
        librariesChanged ||
        unidentifiedNotes !== result.unidentifiedNotes ||
        JSON.stringify([...indicators].sort()) !==
          JSON.stringify([...snapshot].sort());
      indicators = snapshot;
      unidentifiedNotes = result.unidentifiedNotes;
      online = true;
      hasSnapshot = true;
      const saved = JSON.stringify({
        identities: result.identities.map(({ itemkey, libraryURI }) => ({
          itemkey,
          libraryURI,
        })),
        unidentifiedNotes: result.unidentifiedNotes,
      });
      if (saved !== lastSavedSnapshot) {
        try {
          Zotero.Prefs.set(snapshotPreference(), saved, true);
          lastSavedSnapshot = saved;
        } catch (error) {
          Zotero.debug(
            `Literature note indicator cache could not be saved: ${error}`,
          );
        }
      }
      if (changed) redraw();
    } catch (error) {
      if (generation !== currentGeneration || !addon.data.alive) return;
      if (online) {
        online = false;
        redraw();
      }
      throw error;
    }
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

async function poll(): Promise<void> {
  const currentGeneration = generation;
  try {
    await refreshNoteIndicators();
    lastFailure = "";
  } catch (error) {
    const message = String(error);
    if (message !== lastFailure) {
      Zotero.debug(`Literature note indicator refresh failed: ${message}`);
      lastFailure = message;
    }
  } finally {
    if (addon.data.alive && generation === currentGeneration) {
      timer = setTimeout(() => void poll(), REFRESH_INTERVAL_MS);
    }
  }
}

export function startNoteIndicators(): void {
  restoreSnapshot();
  registerNoteIndicator();
  void poll();
}

export function stopNoteIndicators(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  indicators.clear();
  libraryURIs.clear();
  online = false;
  hasSnapshot = false;
  unidentifiedNotes = 0;
  lastSavedSnapshot = "";
  lastFailure = "";
}

export async function syncNoteIndicatorsManually(): Promise<void> {
  const connection = await ensureObsidianConnection({
    progressMessage:
      "Launching Obsidian to refresh literature note indicators...",
  });
  if (!connection.ready) return;
  await refreshNoteIndicators(true);
  showNotice("Literature note indicators refreshed.");
}
