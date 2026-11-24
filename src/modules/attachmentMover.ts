import { enumerateZoteroAttachmentPaths } from "./attachmentReferences";

export interface AttachmentMoveOperation {
  itemkey: string;
  mode: "linked" | "stored";
  basename: string;
  sourcePath: string;
  destinationPath: string;
  /**
   * move: put the file at destinationPath in the base directory (conflicts follow the strategy).
   * newest: destinationPath is the note's file with the same extension; keep the newest non-empty copy.
   * keep-destination: link to the identical file at destinationPath.
   * trash: a duplicate of the kept file at destinationPath; move it to Zotero's trash.
   */
  resolution: "move" | "newest" | "keep-destination" | "trash";
  conflict: boolean;
  identical: boolean;
  /** Milliseconds since the epoch at review time. */
  sourceMtime: number;
  /** Absent when the destination did not exist at review time. */
  destinationMtime?: number;
}

export interface AttachmentMoveRequest {
  baseDirectory: string;
  attachments: AttachmentMoveOperation[];
  /** Vault files linked only by the Obsidian note; link them to the Zotero item. */
  linkNoteFiles: string[];
}

export interface AttachmentMoveResult {
  itemkey: string;
  from: string;
  to: string;
  oldKey?: string;
  newKey?: string;
  trashed?: boolean;
  preservedSource?: boolean;
  copied?: boolean;
}

export type AttachmentConflictStrategy = "newest" | "zotero" | "skip";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const addon: any;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(first: string, second: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(first) === normalize(second);
}

function safeBasename(name: string): boolean {
  return (
    !!name &&
    name !== "." &&
    name !== ".." &&
    !/[\\/<>:"|?*]/.test(name) &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

function sameExtension(first: string, second: string): boolean {
  const extension = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLocaleLowerCase() : "";
  };
  return extension(first) === extension(second);
}

// IOUtils reports integer milliseconds, while review snapshots may be fractional.
function matchesMtime(actual: unknown, reviewed: unknown): boolean {
  return (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    typeof reviewed === "number" &&
    Number.isFinite(reviewed) &&
    Math.trunc(actual) === Math.trunc(reviewed)
  );
}

async function uniqueBackup(path: string): Promise<string> {
  let index = 1;
  let candidate = `${path}.perplexity-saver-backup`;
  while (await IOUtils.exists(candidate))
    candidate = `${path}.perplexity-saver-backup-${index++}`;
  return candidate;
}

async function copyFileSafely(
  source: string,
  destination: string,
): Promise<void> {
  let index = 1;
  let temporary = destination + ".perplexity-saver-transfer";
  while (await IOUtils.exists(temporary))
    temporary = destination + ".perplexity-saver-transfer-" + index++;
  const sourceInfo = await IOUtils.stat(source);
  let temporaryCreated = false;
  try {
    await IOUtils.copy(source, temporary, { noOverwrite: true });
    temporaryCreated = true;
    if (!(await identicalFiles(source, temporary)))
      throw new Error(
        "Could not verify the copied attachment " +
          PathUtils.filename(source) +
          ".",
      );
    if (sourceInfo.lastModified !== undefined)
      await IOUtils.setModificationTime(temporary, sourceInfo.lastModified);
    await IOUtils.move(temporary, destination, { noOverwrite: true });
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated && (await IOUtils.exists(temporary)))
      await IOUtils.remove(temporary);
    throw error;
  }
}

async function moveFile(source: string, destination: string): Promise<void> {
  await copyFileSafely(source, destination);
  try {
    await IOUtils.remove(source);
  } catch (error) {
    try {
      await IOUtils.remove(destination);
    } catch (cleanupError) {
      throw new Error(
        "Could not remove the original attachment " +
          source +
          " or roll back its copy at " +
          destination +
          ". " +
          describeError(cleanupError),
      );
    }
    throw new Error(
      "Could not remove the original attachment " +
        source +
        ". " +
        describeError(error),
    );
  }
}

function cloneLinkedAttachment(attachment: any, destination: string): any {
  const clone = attachment.clone(attachment.libraryID, {
    includeCollections: true,
  });
  clone.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
  clone.attachmentPath = destination;
  clone.dateAdded = attachment.dateAdded;
  return clone;
}

async function copySharedAttachment(
  attachment: any,
  candidate: AttachmentMoveOperation,
  strategy: AttachmentConflictStrategy,
): Promise<AttachmentMoveResult | undefined> {
  const source = await attachment.getFilePathAsync();
  if (
    !source ||
    source !== candidate.sourcePath ||
    PathUtils.filename(source).toLocaleLowerCase() !==
      candidate.basename.toLocaleLowerCase()
  )
    throw new Error(
      "Attachment " +
        candidate.basename +
        " changed since review; no file was copied.",
    );
  const sourceInfo = await IOUtils.stat(source);
  if (
    sourceInfo.type !== "regular" ||
    !matchesMtime(sourceInfo.lastModified, candidate.sourceMtime)
  )
    throw new Error(
      "Attachment " +
        candidate.basename +
        " changed since review; no file was copied.",
    );

  const destination = candidate.destinationPath;
  const destinationExists = await IOUtils.exists(destination);
  let same = false;
  let destinationEmpty = false;
  let copySource = true;
  if (destinationExists) {
    same = await identicalFiles(source, destination);
    const destinationInfo = await IOUtils.stat(destination);
    destinationEmpty = !same && destinationInfo.size === 0;
    if (!same && !destinationEmpty) {
      const effective = candidate.resolution === "newest" ? "newest" : strategy;
      if (sourceInfo.size === 0) copySource = false;
      else if (effective === "skip") return undefined;
      else if (effective === "newest")
        copySource =
          (sourceInfo.lastModified ?? 0) >= (destinationInfo.lastModified ?? 0);
    }
  }
  if (candidate.resolution === "keep-destination" && !same)
    throw new Error(
      destination +
        " no longer matches Zotero attachment " +
        candidate.basename +
        "; no file was changed.",
    );

  let backup: string | undefined;
  let destinationBackedUp = false;
  let destinationCopied = false;
  let clone: any;
  try {
    if (destinationExists && !same && copySource) {
      backup = await uniqueBackup(destination);
      await moveFile(destination, backup);
      destinationBackedUp = true;
    }
    if (!same && copySource) {
      await copyFileSafely(source, destination);
      destinationCopied = true;
    }
    clone = cloneLinkedAttachment(attachment, destination);
    await clone.saveTx();
    if (destinationEmpty && backup) {
      try {
        await IOUtils.remove(backup);
      } catch (error) {
        Zotero.logError(error);
      }
    }
    return {
      itemkey: candidate.itemkey,
      from: source,
      to: destination,
      newKey: clone.key,
      preservedSource: true,
      ...(destinationCopied ? { copied: true } : {}),
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (clone?.id && Zotero.Items.get(clone.id)) {
      try {
        await clone.eraseTx();
      } catch (rollbackError) {
        rollbackErrors.push(
          "could not remove the replacement Zotero item: " +
            describeError(rollbackError),
        );
      }
    }
    if (destinationCopied) {
      try {
        if (await IOUtils.exists(destination))
          await IOUtils.remove(destination);
      } catch (rollbackError) {
        rollbackErrors.push(
          "could not remove the copied attachment " +
            destination +
            ": " +
            describeError(rollbackError),
        );
      }
    }
    if (destinationBackedUp && backup) {
      try {
        if (!(await IOUtils.exists(backup)))
          throw new Error("the backup file is missing");
        await moveFile(backup, destination);
      } catch (rollbackError) {
        rollbackErrors.push(
          "could not restore " +
            destination +
            ": " +
            describeError(rollbackError),
        );
      }
    }
    if (rollbackErrors.length)
      throw new Error(
        describeError(error) + " Rollback issues: " + rollbackErrors.join("; "),
      );
    throw error;
  }
}
async function identicalFiles(first: string, second: string): Promise<boolean> {
  const [a, b] = await Promise.all([IOUtils.stat(first), IOUtils.stat(second)]);
  if (a.type !== "regular" || b.type !== "regular")
    throw new Error("An attachment path is not a file.");
  if (a.size !== b.size) return false;
  const [hashA, hashB] = await Promise.all([
    IOUtils.computeHexDigest(first, "sha256"),
    IOUtils.computeHexDigest(second, "sha256"),
  ]);
  return hashA === hashB;
}

async function moveOne(
  parent: any,
  attachment: any,
  candidate: AttachmentMoveOperation,
  strategy: AttachmentConflictStrategy,
  preserveSource = false,
): Promise<AttachmentMoveResult | undefined> {
  const source = await attachment.getFilePathAsync();
  if (
    !source ||
    source !== candidate.sourcePath ||
    PathUtils.filename(source).toLocaleLowerCase() !==
      candidate.basename.toLocaleLowerCase()
  )
    throw new Error(
      `Attachment ${candidate.basename} changed since review; no file was moved.`,
    );
  if (preserveSource)
    return copySharedAttachment(attachment, candidate, strategy);
  const actualDestination = candidate.destinationPath;
  const destinationExists = await IOUtils.exists(actualDestination);
  let same = false;
  let destinationEmpty = false;
  let moveSource = true;
  if (destinationExists) {
    same = await identicalFiles(source, actualDestination);
    const [sourceStat, destinationStat] = await Promise.all([
      IOUtils.stat(source),
      IOUtils.stat(actualDestination),
    ]);
    destinationEmpty = !same && destinationStat.size === 0;
    if (!same && !destinationEmpty) {
      const effective = candidate.resolution === "newest" ? "newest" : strategy;
      if (sourceStat.size === 0) moveSource = false;
      else if (effective === "skip") return undefined;
      else if (effective === "newest")
        moveSource =
          (sourceStat.lastModified ?? 0) >= (destinationStat.lastModified ?? 0);
    }
  }
  if (candidate.resolution === "keep-destination" && !same)
    throw new Error(
      `${actualDestination} no longer matches Zotero attachment ${candidate.basename}; no file was changed.`,
    );
  const conflict = destinationExists && !same;
  let backup: string | undefined;
  let sourceBackup: string | undefined;
  let sourceMovedToDestination = false;
  let destinationBackedUp = false;
  let clone: any;
  const discardEmptyBackup = async () => {
    if (!destinationEmpty || !backup) return;
    try {
      await IOUtils.remove(backup);
    } catch (error) {
      Zotero.logError(error);
    }
  };
  try {
    if (destinationExists && !same && moveSource) {
      backup = await uniqueBackup(actualDestination);
      await moveFile(actualDestination, backup);
      destinationBackedUp = true;
    }
    if (same || (conflict && !moveSource)) {
      // Zotero erases a stored attachment's folder, so keep a differing loser beside the kept file.
      sourceBackup = await uniqueBackup(
        conflict && attachment.isStoredFileAttachment()
          ? actualDestination
          : source,
      );
      await moveFile(source, sourceBackup);
    } else if (source !== actualDestination) {
      await moveFile(source, actualDestination);
      sourceMovedToDestination = true;
    }
    if (attachment.isLinkedFileAttachment()) {
      if (!(await attachment.relinkAttachmentFile(actualDestination)))
        throw new Error(`Zotero could not relink ${candidate.basename}.`);
      await discardEmptyBackup();
      return {
        itemkey: candidate.itemkey,
        from: source,
        to: actualDestination,
      };
    }
    if (!attachment.isStoredFileAttachment())
      throw new Error(
        `Zotero attachment ${candidate.basename} is not a supported file attachment.`,
      );
    clone = cloneLinkedAttachment(attachment, actualDestination);
    await clone.saveTx();
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.Items.moveChildItems(attachment, clone);
      await Zotero.Items._moveRelations(attachment, clone);
      await Zotero.Fulltext.transferItemIndex(attachment, clone);
      const noteIDs = parent.getNotes();
      for (const note of Zotero.Items.get(noteIDs)) {
        Zotero.Notes.replaceItemKey(note, attachment.key, clone.key);
        await note.saveTx();
      }
      await attachment.eraseTx();
    });
    await discardEmptyBackup();
    return {
      itemkey: candidate.itemkey,
      from: source,
      to: actualDestination,
      oldKey: attachment.key,
      newKey: clone.key,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      if (clone?.id && Zotero.Items.get(clone.id)) await clone.eraseTx();
    } catch (rollbackError) {
      rollbackErrors.push(
        `could not remove the replacement Zotero item: ${describeError(rollbackError)}`,
      );
    }
    for (const [shouldRestore, from, to] of [
      [sourceMovedToDestination, actualDestination, source],
      [destinationBackedUp, backup, actualDestination],
      [!!sourceBackup, sourceBackup, source],
    ] as const) {
      if (!shouldRestore || !from) continue;
      try {
        if (!(await IOUtils.exists(from)))
          throw new Error("the rollback source file is missing");
        await moveFile(from, to);
      } catch (rollbackError) {
        rollbackErrors.push(
          `could not restore ${from}: ${describeError(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length)
      throw new Error(
        `${describeError(error)} Rollback issues: ${rollbackErrors.join("; ")}`,
      );
    throw error;
  }
}

async function trashDuplicate(
  attachment: any,
  candidate: AttachmentMoveOperation,
): Promise<AttachmentMoveResult> {
  const source = await attachment.getFilePathAsync();
  if (!source || source !== candidate.sourcePath)
    throw new Error(
      `Attachment ${candidate.basename} changed since review; it was not moved to Zotero's trash.`,
    );
  if (
    !(await IOUtils.exists(candidate.destinationPath)) ||
    !(await identicalFiles(source, candidate.destinationPath))
  )
    throw new Error(
      `${candidate.basename} no longer matches the kept file ${candidate.destinationPath}; it was not moved to Zotero's trash.`,
    );
  attachment.deleted = true;
  await attachment.saveTx();
  return {
    itemkey: candidate.itemkey,
    from: source,
    to: candidate.destinationPath,
    trashed: true,
  };
}

export async function moveReviewedAttachments(
  parent: any,
  request: AttachmentMoveRequest,
  validatedBaseDirectory: string,
  strategy: AttachmentConflictStrategy,
  onMutation?: () => void,
): Promise<{
  moved: AttachmentMoveResult[];
  linked: Array<{ path: string; newKey: string }>;
}> {
  if (!addon.data.alive)
    throw new Error("Zotero is shutting down; no attachments were moved.");
  if (
    !validatedBaseDirectory ||
    request.baseDirectory !== validatedBaseDirectory ||
    Zotero.Prefs.get("baseAttachmentPath") !== validatedBaseDirectory
  )
    throw new Error(
      "The Linked Attachment Base Directory is no longer validated; no attachments were moved.",
    );
  if (Zotero.Libraries.get(parent.libraryID)?.libraryType !== "user")
    throw new Error(
      "Zotero does not support linked attachments in group libraries.",
    );
  const baseInfo = await IOUtils.stat(request.baseDirectory);
  if (baseInfo.type !== "directory")
    throw new Error(
      "The validated Linked Attachment Base Directory is no longer available.",
    );
  const attachments = parent
    .getAttachments()
    .map((id: number) => Zotero.Items.get(id))
    .filter(Boolean);
  const requestedKeys = request.attachments.map((entry) => entry.itemkey);
  if (
    request.attachments.some(
      (entry) =>
        !entry.basename ||
        PathUtils.filename(entry.basename) !== entry.basename ||
        (entry.resolution === "move" &&
          (!safeBasename(PathUtils.filename(entry.destinationPath)) ||
            !sameExtension(
              entry.basename,
              PathUtils.filename(entry.destinationPath),
            ) ||
            !samePath(
              entry.destinationPath,
              PathUtils.join(
                request.baseDirectory,
                PathUtils.filename(entry.destinationPath),
              ),
            ))),
    )
  ) {
    throw new Error(
      "The reviewed attachment list contains an invalid filename or destination.",
    );
  }
  const destinations = request.attachments
    .filter((entry) => entry.resolution !== "trash")
    .map((entry) => entry.destinationPath);
  if (
    new Set(requestedKeys).size !== requestedKeys.length ||
    destinations.some(
      (destination, index) =>
        destinations.findIndex((other) => samePath(other, destination)) !==
        index,
    )
  )
    throw new Error(
      "The reviewed attachment list contains duplicate identities or destinations.",
    );
  const matched = attachments.filter((entry: any) =>
    requestedKeys.includes(entry.key),
  );
  if (
    matched.length !== request.attachments.length ||
    matched.some((entry: any) => entry.parentItemID !== parent.id)
  )
    throw new Error(
      "The Zotero attachment list changed; no attachments were moved.",
    );
  let zoteroPaths: string[] = [];
  if (request.attachments.some((entry) => entry.resolution !== "trash")) {
    try {
      zoteroPaths = await enumerateZoteroAttachmentPaths();
    } catch (error) {
      throw new Error(
        "Could not verify Zotero attachment references; no files were moved. " +
          describeError(error),
      );
    }
  }
  for (const candidate of request.attachments) {
    const attachment = matched.find(
      (entry: any) => entry.key === candidate.itemkey,
    );
    const source = attachment && (await attachment.getFilePathAsync());
    if (
      !attachment ||
      !source ||
      source !== candidate.sourcePath ||
      PathUtils.filename(source).toLocaleLowerCase() !==
        candidate.basename.toLocaleLowerCase() ||
      (!attachment.isLinkedFileAttachment() &&
        !attachment.isStoredFileAttachment())
    ) {
      throw new Error(
        `Attachment ${candidate.basename} changed since review; no files were moved.`,
      );
    }
    if (!(await IOUtils.exists(source)))
      throw new Error(
        `Attachment ${candidate.basename} changed since review; no files were moved.`,
      );
    const sourceInfo = await IOUtils.stat(source);
    if (sourceInfo.type !== "regular")
      throw new Error(
        `Attachment ${candidate.basename} is not a regular file; no files were moved.`,
      );
    if (!matchesMtime(sourceInfo.lastModified, candidate.sourceMtime))
      throw new Error(
        `Attachment ${candidate.basename} changed since review; no files were moved.`,
      );
    const destination = candidate.destinationPath;
    if (samePath(source, destination))
      throw new Error(
        `Attachment ${candidate.basename} already points to its destination; no files were moved.`,
      );
    const exists = await IOUtils.exists(destination);
    if (exists !== (candidate.destinationMtime !== undefined))
      throw new Error(
        `Attachment destination changed since review; no files were moved: ${destination}`,
      );
    if (!exists) {
      if (candidate.resolution !== "move" && candidate.resolution !== "trash")
        throw new Error(
          `The note's copy of ${candidate.basename} (${destination}) is missing; no files were moved.`,
        );
      continue;
    }
    const destinationInfo = await IOUtils.stat(destination);
    if (destinationInfo.type !== "regular")
      throw new Error(
        `The destination for ${candidate.basename} is not a regular file; no files were moved.`,
      );
    if (!matchesMtime(destinationInfo.lastModified, candidate.destinationMtime))
      throw new Error(
        `Attachment destination changed since review; no files were moved: ${destination}`,
      );
    if (candidate.resolution === "trash") continue;
    const same = await identicalFiles(source, destination);
    if (
      (candidate.resolution === "keep-destination" && !same) ||
      (candidate.resolution === "newest" &&
        !sameExtension(candidate.basename, PathUtils.filename(destination)))
    )
      throw new Error(
        `${destination} no longer matches Zotero attachment ${candidate.basename}; no files were moved.`,
      );
  }
  const attachedPaths: string[] = [];
  for (const attachment of attachments) {
    const attachedPath =
      attachment.isFileAttachment?.() && (await attachment.getFilePathAsync());
    if (attachedPath) attachedPaths.push(attachedPath);
  }
  for (const [index, filePath] of request.linkNoteFiles.entries()) {
    if (
      !filePath ||
      request.linkNoteFiles.findIndex((other) => samePath(other, filePath)) !==
        index ||
      attachedPaths.some((attached) => samePath(attached, filePath)) ||
      !(await IOUtils.exists(filePath)) ||
      (await IOUtils.stat(filePath)).type !== "regular"
    )
      throw new Error(
        `The note's file ${filePath} is missing or already attached; no files were moved.`,
      );
  }

  const moved: AttachmentMoveResult[] = [];
  const linked: Array<{ path: string; newKey: string }> = [];
  const ordered = [
    ...request.attachments.filter((entry) => entry.resolution !== "trash"),
    ...request.attachments.filter((entry) => entry.resolution === "trash"),
  ];
  try {
    if (ordered.length || request.linkNoteFiles.length) onMutation?.();
    for (const candidate of ordered) {
      const attachment = matched.find(
        (entry: any) => entry.key === candidate.itemkey,
      );
      if (!attachment)
        throw new Error(
          `Zotero attachment ${candidate.itemkey} is unavailable.`,
        );
      const result =
        candidate.resolution === "trash"
          ? await trashDuplicate(attachment, candidate)
          : await moveOne(
              parent,
              attachment,
              candidate,
              strategy,
              zoteroPaths.filter((filePath) =>
                samePath(filePath, candidate.sourcePath),
              ).length > 1,
            );
      if (result) moved.push(result);
    }
    for (const filePath of request.linkNoteFiles) {
      const item = await Zotero.Attachments.linkFromFile({
        file: filePath,
        parentItemID: parent.id,
      });
      if (!item?.key)
        throw new Error(`Zotero could not link the note's file ${filePath}.`);
      linked.push({ path: filePath, newKey: item.key });
    }
  } catch (error) {
    const done = [
      ...moved.map((result) =>
        result.trashed
          ? `trashed ${PathUtils.filename(result.from)}`
          : `moved ${PathUtils.filename(result.to)}`,
      ),
      ...linked.map((result) => `linked ${PathUtils.filename(result.path)}`),
    ];
    if (done.length)
      throw new Error(
        `The attachment batch stopped after it ${done.join(", ")}. Check those Zotero attachments before retrying. ${describeError(error)}`,
      );
    throw error;
  }
  return { moved, linked };
}
