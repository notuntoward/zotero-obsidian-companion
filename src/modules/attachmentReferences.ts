declare const Zotero: any;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function enumerateZoteroAttachmentPaths(): Promise<string[]> {
  let libraries: any[];
  try {
    libraries = Zotero.Libraries?.getAll?.();
  } catch (error) {
    throw new Error(
      `Could not enumerate accessible Zotero libraries: ${describeError(error)}`,
    );
  }
  if (!Array.isArray(libraries)) {
    throw new Error("Zotero could not enumerate accessible libraries.");
  }

  const paths: string[] = [];
  let accessibleLibraryCount = 0;
  for (const library of libraries) {
    if (typeof library?.libraryType !== "string") {
      throw new Error(
        "An accessible Zotero library has unavailable library type.",
      );
    }
    if (library.libraryType === "feed") continue;
    if (library.libraryType !== "user" && library.libraryType !== "group") {
      throw new Error(
        `Unsupported Zotero library type: ${library.libraryType}.`,
      );
    }
    if (!Number.isInteger(library.libraryID)) {
      throw new Error("An accessible Zotero library has no usable library ID.");
    }
    accessibleLibraryCount++;

    let items: any[];
    try {
      // Include child and trashed items so no Zotero file reference is missed.
      items = await Zotero.Items.getAll(library.libraryID, false, true);
    } catch (error) {
      throw new Error(
        `Could not enumerate Zotero library ${library.libraryID}: ${describeError(error)}`,
      );
    }
    if (!Array.isArray(items)) {
      throw new Error(
        `Zotero library ${library.libraryID} returned an invalid item list.`,
      );
    }

    for (const item of items) {
      if (typeof item?.isFileAttachment !== "function") {
        throw new Error(
          `File-attachment state is unavailable in Zotero library ${library.libraryID}.`,
        );
      }
      const isFileAttachment = item.isFileAttachment();
      if (typeof isFileAttachment !== "boolean") {
        throw new Error(
          `File-attachment state is unavailable in Zotero library ${library.libraryID}.`,
        );
      }
      if (!isFileAttachment) continue;

      let filePath: unknown;
      try {
        if (typeof item.getFilePath !== "function") {
          throw new Error("Zotero file-path lookup is unavailable.");
        }
        filePath = item.getFilePath();
      } catch (error) {
        throw new Error(
          `Could not resolve file path for attachment ${item.key || item.id} in library ${library.libraryID}: ${describeError(error)}`,
        );
      }
      if (typeof filePath !== "string" || !filePath) {
        throw new Error(
          `File path is unavailable for attachment ${item.key || item.id} in library ${library.libraryID}.`,
        );
      }
      paths.push(filePath);
    }
  }

  if (!accessibleLibraryCount) {
    throw new Error("No accessible Zotero user or group libraries were found.");
  }
  return paths;
}
