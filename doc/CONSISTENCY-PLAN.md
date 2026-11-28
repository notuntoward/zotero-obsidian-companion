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

- Stage: Stage 3 implemented; a managed Bike collection change synced without approval during the live recheck.
- Next: proposed intermediate stage, remove collection baselines under the newly confirmed Zotero-authoritative policy and investigate Regen BibTeX Key persistence; then Stage 4.
- Collection names and Zotero tags are normalized to lowercase, hyphen-separated lists (spaces and underscores become `-`) without `obsLitNote`; hierarchy is not represented.
- Manual Update previews collection changes and records approved baselines by Zotero library URI and item key.
- Empty membership keeps `zotero_collections` as `[]`; missing collection data preserves the existing value.
- Stage 3 implements the earlier collection-edit conflict policy; the newly confirmed policy is that Zotero-owned metadata overwrites corresponding note values. Baseline removal is not implemented yet.
- A reviewed batch cancellation cancels before applying, but unexpected apply-time failures can leave partial writes.
- Blockers: Saver full browser suite not yet run; notes without a unique active Zotero match remain unresolved.

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

- [x] Verify Update Lit Note previews collection additions, removals, and
      renames, including empty membership, without affecting personal properties.
- [x] Revalidate the Zotero data and note before applying; cancellation and
      concurrent edits must not silently overwrite changes.
- [x] Review divergent existing values before adopting them as Zotero-managed;
      never guess an ambiguous or legacy item association.
- [x] Test preview, cancellation, stale data, adoption, and existing key and
      attachment review behavior.

### 3. Startup collection synchronization

Changes: Companion and Saver. Impact peer: each other; verified by final impact
runs in both checkouts.

Automatic scans now backfill a missing `zotero_library_uri` only after a unique
active match is rechecked across accessible libraries. Ambiguous or missing
matches are left untouched. Both `zotero_tags` and `zotero_collections` remain
present as lists, including when empty.

Live diagnosis confirmed the one-time repair used the plugin ID instead of the
registered installation directory and missed stored baselines. Saver now
migrates a managed baseline only when the actual note exactly matches its
normalized value, before reconciling new Zotero memberships. Genuine note
edits, stopped management and unresolved recovery remain protected.

- [x] Extend the cross-plugin automatic-sync contract and plan validation;
      missing data from an older peer is not an empty collection list.
- [x] Compare associated notes at startup and update only the adopted managed
      property. Route conflicts and errors to Zotero reviews. Live recheck
      confirmed the managed Bike change synced without approval.
- [x] Preserve paused checks, manual checks, recovery, retries, and startup-scan
      scheduling, including draining reviews on a retryable busy scan.
- [x] Test old databases, adoption, stale plans, peer compatibility, paused
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

- Should empty Zotero membership retain `zotero_collections` as `[]`?
  Recommended default: yes. (Confirmed.)
- Should normalized name collisions be warned about while retaining the flat
  format, without encoding hierarchy? Recommended default: yes. (Confirmed.)
- Should divergent manual values use a reviewed batch that cancels before writes,
  while unexpected apply-time failures may leave partial writes? Recommended
  default: yes. (Confirmed.)
- Should automatic sync hold a manually edited managed value until the user
  applies Zotero, keeps Obsidian and stops managing, or defers? Recommended
  default: earlier confirmed policy, implemented in Stage 3; superseded by the
  confirmed Zotero-authoritative policy. Remove collection baselines and this
  conflict review before extending synchronization. Preserve link-repair
  safeguards for citekeys and attachments; do not delete attachment-preservation
  records as if they were collection baselines.
- Which dates should note creation and modification properties represent?
  Recommended default: the Obsidian note lifecycle; use separately named
  properties for Zotero dates if needed. (Not yet confirmed.)

## Working notes

Update this document at stage boundaries or when decisions change. Record the
current state, next step, blockers, and material decisions here; avoid duplicating
session logs or routine command output.
