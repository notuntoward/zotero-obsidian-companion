# Zotero–Saver protocol

The Zotero companion posts to `http://127.0.0.1:27124/lit-note`.

## Requests

- `{ action: "create" | "open", data: ZoteroItemPayload[] }`
- `{ action: "open-note-path", notePath, itemkey }` opens a reported note after
  rechecking its path and item key; it does not change the note.
- `{ action: "cleanup-obs-lit-note-tag" }` removes only the old `obsLitNote`
  Zotero tag and normalized `obslitnote` note value. It returns counts and
  per-note errors; all other tags are preserved.
- `{ action: "fill-missing-library-uris", notes: [{ notePath, itemkey, libraryURI }] }`
  fills missing identities only after unique Zotero matches are rechecked.
  Saver rechecks note-level uniqueness and metadata, then places URIs after
  `zotero_tags`, or after `zotero_item_key` when tags are absent.
  The companion runs this backfill before automatic startup reconciliation and
  requested manual scans. It fills only notes with a unique active match across
  accessible user and group libraries; ambiguous or missing matches are left
  unchanged.
- `{ action: "sync" | "update", data: ZoteroItemPayload[] }` performs automatic
  reconciliation or prepares a previewed metadata update.
- `{ action: "apply-sync" | "validate-zotero-key", token, data: [ZoteroItemPayload] }`
  revalidates and applies a one-use prepared plan.
- `{ action: "review-uncertain", itemkey, libraryURI, operation, title?, attachments?, attachmentCheckError?, attachmentPaths? }`
  reports an unknown outcome, current attachment details, and any source or
  destination paths saved before a move. Older journal entries may lack paths.

Zotero batches selected items into one request. The companion refreshes the
non-tag note indicator after creation and reports error results in one alert.

## Replies and plans

Saver replies with `{ success, results: [{ citekey, status, error? }] }`.
Results can include `created`, `overwritten`, `opened`, `updated`, `skipped`,
`missing`, `error`, `attachment-error`, `pending-review`, `prepared`, and
`set-zotero-key`. A prepared result carries a one-use token; `set-zotero-key`
also carries expected and selected keys.

Before applying a plan or changing Zotero, re-read the payload and validate the
token, saved keys, note snapshot, and attachment snapshots. Never treat a
prepared plan as a completed update. If `needsAttachmentCheck` is set, enumerate
attachment paths in accessible user and group libraries, including trashed
items, and send `zoteroAttachmentPaths` with `apply-sync`. Fail closed when the
inventory or any required path is unavailable.

`GET /lit-note-indicator-identities` returns a complete indicator snapshot and
the count of notes without item keys. The column swaps snapshots atomically and
persists only identities; cached matches are stale when offline, and missing or
ambiguous identities remain unknown. `GET /lit-note-identities` returns
indexed identities, note modification metadata, and Obsidian note paths.

When citation keys differ, the companion sends `citationKeyCheck` with matches
from accessible Zotero libraries and rechecks it before changing Zotero.
Lookup failures stop the update.

## Collections and automatic reconciliation

Sync payloads carry the current direct collection names when Zotero lookup
succeeds. Saver normalizes those names for `zotero_collections` (lowercase;
spaces and underscores become `-`; the Companion's collision log mirrors this);
hierarchy is not represented. Zotero is authoritative for this property: when
`collections` is present, Saver writes the supplied membership, including an
explicit empty list. There are no collection baselines or collection conflict
reviews. Missing `collections` (including from an older companion) is unknown
data, not an empty list, and must preserve the existing note value.

`zotero_tags` and `zotero_collections` are list properties and remain present
when empty. Newly created notes write both properties as lists. When an existing
note is missing either property, Saver repairs it through Obsidian's frontmatter
API, using `[]` when no value is available. A canceled or otherwise
unapproved operation must not mutate the note.

The automatic path waits for stable snapshots and retries when Obsidian becomes
available. Payloads identify the Zotero library by name and attachments by item
key. After changing a citekey in Zotero, `zoteroChanges` records the prior key
and only file moves verified by the same attachment item key; preserve it when
revalidating and applying the one-use plan.

Automatic checks can be paused; recovery and manual checks must remain
available. Paused scan starts preserve existing reviews and finish with
`paused`. Keep the automatic-attachment journal when recovery returns
`automaticRecoveryPending` until the recovered plan has been durably handed off.
