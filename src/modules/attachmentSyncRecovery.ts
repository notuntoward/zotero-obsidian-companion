import {
  copySnapshotDirectory,
  verifySnapshotDirectory,
} from "./attachmentMover";
import { enumerateZoteroAttachmentPaths } from "./attachmentReferences";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const addon: any;

interface RecoveryRecord {
  libraryID: number;
  key: string;
  newKey: string;
  version: number;
  snapshot: string;
  cache: string;
  linkedPath: string;
  linkedHash: string;
  storageDirectory: string;
  archiveDirectory: string;
  state: "prepared" | "complete";
}

function requireIdle(): void {
  if (!addon.data.alive || Zotero.Sync.Runner.syncInProgress !== false)
    throw new Error(
      "Attachment sync recovery waits until Zotero sync is idle.",
    );
}

function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    !/[\\/:<>"|?*]/.test(value) &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32) &&
    value !== "." &&
    value !== ".." &&
    !/[. ]$/.test(value)
  );
}

async function hashFile(file: string): Promise<string> {
  const before = await IOUtils.stat(file);
  if (before.type !== "regular" || before.size === 0)
    throw new Error(
      "Attachment sync recovery requires a nonempty linked file.",
    );
  const hash = await IOUtils.computeHexDigest(file, "sha256");
  const after = await IOUtils.stat(file);
  if (before.size !== after.size || before.lastModified !== after.lastModified)
    throw new Error("The linked attachment changed during sync recovery.");
  return hash;
}

async function evidence(item: any): Promise<any> {
  const cached = await Zotero.Sync.Data.Local.getCacheObject(
    "item",
    item.libraryID,
    item.key,
    item.version,
  );
  if (!cached)
    throw new Error(
      `Attachment ${item.key} has no same-version sync cache; recovery stopped.`,
    );
  if (
    cached.key !== item.key ||
    cached.version !== item.version ||
    cached.data?.key !== item.key ||
    cached.data?.version !== item.version ||
    cached.data?.itemType !== "attachment"
  )
    throw new Error(`Attachment ${item.key} has invalid sync-cache evidence.`);
  return cached;
}

async function requireUnchanged(
  item: any,
  record: RecoveryRecord,
): Promise<void> {
  requireIdle();
  if (
    JSON.stringify(item.toJSON()) !== record.snapshot ||
    item.version !== record.version ||
    item.synced !== false ||
    !item.isLinkedFileAttachment() ||
    item.getFilePath() !== record.linkedPath ||
    JSON.stringify(await evidence(item)) !== record.cache ||
    (await hashFile(record.linkedPath)) !== record.linkedHash
  )
    throw new Error(
      "Attachment or sync-cache evidence changed before mutation.",
    );
}

async function finish(record: RecoveryRecord): Promise<void> {
  requireIdle();
  const item = await Zotero.Items.getByLibraryAndKeyAsync(
    record.libraryID,
    record.key,
  );
  const replacement = await Zotero.Items.getByLibraryAndKeyAsync(
    record.libraryID,
    record.newKey,
  );
  const cached = JSON.parse(record.cache);
  if (
    cached.key !== record.key ||
    cached.version !== record.version ||
    cached.data?.key !== record.key ||
    cached.data?.version !== record.version ||
    cached.data?.itemType !== "attachment" ||
    !["imported_file", "imported_url"].includes(cached.data?.linkMode) ||
    !safeName(cached.data.filename)
  )
    throw new Error(
      "Invalid sync-cache evidence in the attachment recovery journal.",
    );
  const mode =
    Zotero.Attachments[`LINK_MODE_${cached.data.linkMode.toUpperCase()}`];
  if (!item)
    throw new Error(
      "The journaled attachment disappeared during sync recovery.",
    );
  await item.loadAllData();
  if (replacement) {
    if (
      item.attachmentLinkMode !== mode ||
      !item.deleted ||
      !replacement.isLinkedFileAttachment() ||
      replacement.deleted ||
      replacement.libraryID !== record.libraryID ||
      replacement.parentKey !== item.parentKey ||
      replacement.getFilePath() !== record.linkedPath
    )
      throw new Error(
        "The committed attachment sync recovery no longer matches its journal.",
      );
    if ((await hashFile(record.linkedPath)) !== record.linkedHash)
      throw new Error("The recovered linked file changed.");
    await Zotero.Fulltext.queueItem(replacement);
    return;
  }
  await requireUnchanged(item, record);
  if (await IOUtils.exists(record.storageDirectory)) {
    const stagingDirectory = PathUtils.join(
      PathUtils.parent(record.archiveDirectory),
      "transfers",
    );
    await IOUtils.makeDirectory(stagingDirectory, { ignoreExisting: true });
    await copySnapshotDirectory(
      record.storageDirectory,
      record.archiveDirectory,
      true,
      stagingDirectory,
    );
  }
  const clone = item.clone(item.libraryID, { includeCollections: true });
  clone.key = record.newKey;
  clone.setRelations(item.getRelations());
  clone.attachmentPath = record.linkedPath;
  clone.dateAdded = item.dateAdded;
  clone.deleted = false;
  await Zotero.DB.executeTransaction(async () => {
    await requireUnchanged(item, record);
    if (await IOUtils.exists(record.storageDirectory))
      await verifySnapshotDirectory(
        record.storageDirectory,
        record.archiveDirectory,
      );
    const incoming = await Zotero.Relations.getByObject(
      "item",
      Zotero.URI.getItemURI(item),
    );
    const paths = await enumerateZoteroAttachmentPaths();
    if (
      paths.some((path) =>
        path
          .replace(/\\/g, "/")
          .toLowerCase()
          .startsWith(
            record.storageDirectory.replace(/\\/g, "/").toLowerCase() + "/",
          ),
      )
    )
      throw new Error(
        "Another Zotero attachment references the original storage resources; sync recovery stopped.",
      );
    const notes = [];
    for (const value of await Zotero.Items.getAll(
      item.libraryID,
      false,
      true,
    )) {
      if (!value.isNote() && !value.isAttachment()) continue;
      await value.loadAllData();
      if (value.getNote().includes(item.key)) notes.push(value);
    }
    for (const { subject } of incoming) {
      await subject.loadAllData();
      if (!subject.isEditable())
        throw new Error(
          "A related item is not editable; sync recovery stopped.",
        );
    }
    await requireUnchanged(item, record);
    Zotero.Notes.replaceItemKey(clone, item.key, clone.key);
    await clone.save();
    item.attachmentLinkMode = mode;
    item.attachmentPath = `storage:${cached.data.filename}`;
    await item.save({ skipDateModifiedUpdate: true });
    await Zotero.Items.moveChildItems(item, clone, { includeTrashed: true });
    for (const { subject, predicate } of incoming) {
      subject.addRelation(predicate, Zotero.URI.getItemURI(clone));
      await subject.save({ skipDateModifiedUpdate: true });
    }
    for (const note of notes) {
      const previous = note.getNote();
      Zotero.Notes.replaceItemKey(note, item.key, clone.key);
      if (note.getNote() !== previous) await note.save();
    }
    await Zotero.Items.trash([item.id]);
  });
  await Zotero.Fulltext.queueItem(clone);
}

export async function recoverAttachmentSyncState(): Promise<void> {
  requireIdle();
  const data = Zotero.DataDirectory.dir;
  if (typeof data !== "string" || !PathUtils.isAbsolute(data))
    throw new Error("Cannot locate the attachment sync recovery journal.");
  const root = PathUtils.join(data, "obsidian-companion-attachment-archive");
  const journalPath = PathUtils.join(root, "sync-recovery.json");
  const records: RecoveryRecord[] = (await IOUtils.exists(journalPath))
    ? await IOUtils.readJSON(journalPath)
    : [];
  if (
    !Array.isArray(records) ||
    records.some(
      (record) =>
        !record ||
        !Number.isInteger(record.libraryID) ||
        !/^[A-Z0-9]{8}$/.test(record.key) ||
        !/^[A-Z0-9]{8}$/.test(record.newKey) ||
        record.key === record.newKey ||
        !Number.isInteger(record.version) ||
        record.version <= 0 ||
        typeof record.snapshot !== "string" ||
        typeof record.cache !== "string" ||
        typeof record.linkedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.linkedHash) ||
        !PathUtils.isAbsolute(record.linkedPath) ||
        record.storageDirectory !==
          PathUtils.join(data, "storage", record.key) ||
        record.archiveDirectory !==
          PathUtils.join(
            root,
            String(record.libraryID),
            `${record.key}-sync-recovery`,
            "contents",
          ) ||
        !["prepared", "complete"].includes(record.state),
    )
  )
    throw new Error(
      "Invalid attachment sync recovery journal; automatic reconciliation stopped.",
    );
  const persist = async () => {
    await IOUtils.makeDirectory(root, { ignoreExisting: true });
    await IOUtils.writeJSON(journalPath, records, {
      tmpPath: journalPath + ".tmp",
      flush: true,
    });
  };
  for (const record of records.filter((value) => value.state === "prepared")) {
    await finish(record);
    record.state = "complete";
    await persist();
  }
  for (const library of Zotero.Libraries.getAll()) {
    if (library.libraryType !== "user") continue;
    const items = await Zotero.Items.getAll(library.libraryID, false, true);
    for (const item of items) {
      requireIdle();
      if (
        !item.isLinkedFileAttachment?.() ||
        item.synced !== false ||
        !Number.isInteger(item.version) ||
        item.version <= 0
      )
        continue;
      await item.loadAllData();
      const cached = await evidence(item);
      if (cached.data.linkMode === "linked_file") continue;
      if (
        !["imported_file", "imported_url"].includes(cached.data.linkMode) ||
        !safeName(cached.data.filename) ||
        cached.data.parentItem !== item.parentKey ||
        !/^[A-Z0-9]{8}$/.test(item.key)
      )
        throw new Error(
          `Attachment ${item.key} cannot be recovered from its sync-cache evidence.`,
        );
      const linkedPath = item.getFilePath();
      if (typeof linkedPath !== "string" || !PathUtils.isAbsolute(linkedPath))
        throw new Error(
          "Cannot resolve the linked file for attachment sync recovery.",
        );
      if (
        linkedPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .startsWith(
            PathUtils.join(data, "storage").replace(/\\/g, "/").toLowerCase() +
              "/",
          )
      )
        throw new Error(
          "The linked file is still inside Zotero storage; sync recovery stopped.",
        );
      const storageDirectory =
        Zotero.Attachments.getStorageDirectory(item).path;
      if (storageDirectory !== PathUtils.join(data, "storage", item.key))
        throw new Error(
          "Unexpected Zotero storage path; sync recovery stopped.",
        );
      const archiveDirectory = PathUtils.join(
        root,
        String(item.libraryID),
        `${item.key}-sync-recovery`,
        "contents",
      );
      await IOUtils.makeDirectory(PathUtils.parent(archiveDirectory), {
        ignoreExisting: true,
      });
      const record: RecoveryRecord = {
        libraryID: item.libraryID,
        key: item.key,
        newKey: Zotero.Utilities.generateObjectKey(),
        version: item.version,
        snapshot: JSON.stringify(item.toJSON()),
        cache: JSON.stringify(cached),
        linkedPath,
        linkedHash: await hashFile(linkedPath),
        storageDirectory,
        archiveDirectory,
        state: "prepared",
      };
      records.push(record);
      await persist();
      await finish(record);
      record.state = "complete";
      await persist();
    }
  }
}
