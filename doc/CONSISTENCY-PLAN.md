# Zotero–Obsidian consistency plan

## Goal and boundaries

Keep companion literature notes consistent with Zotero as collection
membership, collection names, citation keys, and attachment paths change.
An existing Zotero library must work without any previous plugin history.
Arbitrary third-party note-linking schemes are outside this plan.

Zotero supplies collection membership and names. Personal note tags and body
content remain Obsidian-owned. Mapping collections or Zotero tags to Obsidian
tags is future work, not part of this plan.

Preserve existing notes and attachments, identify items by library and item key,
and stop rather than guess when an association or file identity is ambiguous.
Changes across the apps are not atomic; expose partial results and recovery.
External or unindexed links cannot be guaranteed to update.

## Current state and next step

- Both plugins are unreleased. Existing companion notes are still real user
  data and require safe adoption.
- Creation uses direct collection names, lowercased with spaces replaced by
  underscores, in `zotero_collections`. Hierarchy is not represented.
- Update Lit Note previews collection metadata along with other Zotero metadata.
  Startup reconciliation currently checks keys and attachments, not collections.
- Stage 1 is implemented; both plugin builds passed and the verified companion
  XPI was installed. The user restarted both apps and confirmed the manual
  collection-update check worked. Collection collisions are logged in Zotero,
  not yet shown in the review UI.
- Zotero showed a connection warning while Obsidian was still starting; startup
  then appeared normal. Investigate if the warning persists or recurs.
- The literature-note indicator uses a movable Zotero column and an atomic
  snapshot keyed by library URI and item key, cached locally for offline startup.
  Hollow diamonds identify stale cached matches. Missing or ambiguous
  identity is shown as unknown. The user completed both the old-indicator and
  missing-library-identity cleanups; their settings actions were removed.
- Initial and manual reviews include literature notes missing an item key, with
  their paths available for manual correction; the association must be rechecked
  after a key is added.
- Next: stage 2, after the remaining adoption decisions are confirmed.

## Stages and test gates

### 1. Reliable collection data

- [x] Share collection extraction between creation, manual update, and automatic
      sync payloads; retain current note formatting.
- [x] Distinguish an empty list, missing protocol data, and an incomplete or
      failed lookup. Never turn a failed lookup into an empty list.
- [x] Detect and log names that collide after existing normalization without
      changing the existing payload values.
- [x] Test memberships, renames, empty lists, collisions, and lookup failures
      in both payload paths. Preserve existing behavior elsewhere.

### 2. Manual update and adoption

- [ ] Verify Update Lit Note previews collection additions, removals, and
      renames, including empty membership, without affecting personal properties.
- [ ] Revalidate the Zotero data and note before applying; cancellation and
      concurrent edits must not silently overwrite changes.
- [ ] Review divergent existing values before adopting them as Zotero-managed;
      never guess an ambiguous or legacy item association.
- [ ] Test preview, cancellation, stale data, adoption, and existing key and
      attachment review behavior.

### 3. Startup collection synchronization

- [ ] Extend the cross-plugin automatic-sync contract and plan validation;
      missing data from an older peer is not an empty collection list.
- [ ] Compare associated notes at startup and update only the adopted managed
      property. Route conflicts and errors to Zotero reviews.
- [ ] Preserve paused checks, manual checks, recovery, retries, and startup-scan
      scheduling, including draining reviews on a retryable busy scan.
- [ ] Test old databases, adoption, stale plans, peer compatibility, paused
      checks, disconnection, recovery, and unrelated note content.

### 4. In-session collection changes

- [ ] Detect item membership changes and collection renames and deletions,
      including changes affecting many notes.
- [ ] Coalesce events, re-read current state, and serialize with reviews. If
      event details are insufficient, safely recheck rather than guess.
- [ ] Reconcile missed changes on reconnect or restart.
- [ ] Test bursts, changed notes, paused checks, offline recovery, and manual
      updates while automatic checks are paused.

### 5. Citation keys and attachments

- [ ] Persist trustworthy attachment identities and paths for associated notes.
      Old databases and notes without a baseline must remain safe to use.
- [ ] Detect direct filename edits, Zotero rename-button changes, and attachment
      moves accompanying citation-key edits. Match by attachment item key, not
      extension or filename; replacement can create a new key.
- [ ] Show Zotero changes already made separately from proposed note repairs.
      Do not silently consolidate files or infer ambiguous moves.
- [ ] Detect citation-key changes from either Zotero's field or Regen Citation
      Key, reusing existing key-choice and note-rename reviews.
- [ ] Journal multi-step work; report partial outcomes and require review when
      history, links, or identities are uncertain.
- [ ] Test multiple PDFs, meaningful names, collisions, missing files, key
      changes, stale baselines, interruption, recovery, and preserved note content.

### 6. Release readiness

- [ ] Update both plugins' documentation and protocol descriptions.
- [ ] Run required checks and builds in the original checkouts, verify runtime
      artifacts, and install the verified companion XPI as instructed.
- [ ] Manually test an old library, existing notes, collection changes,
      multiple attachments, offline recovery, and citation-key changes.
- [ ] Document flattened names, external links, third-party schemes, and
      non-atomic operations as limitations.

## Decisions to confirm before affected stages

- Empty membership: remove the property as the current metadata builder does,
  or retain an empty list? Recommendation: preserve existing behavior.
- Normalized collection collisions and hierarchy: warn while preserving the
  existing format, or change the format? Recommendation: preserve and warn.
- Existing divergent values: individual review or reviewed bulk adoption?
  Recommendation: offer reviewed bulk adoption.
- When a managed value is manually edited, define how the user resolves the
  resulting conflict before automatic updates resume.

## Working notes

Update this document at stage boundaries or when decisions change. Record the
current state, next step, blockers, and material decisions here; avoid duplicating
session logs or routine command output.
