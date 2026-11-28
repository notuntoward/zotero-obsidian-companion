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

- Stage: Stage 3 follow-up implemented; its live managed Bike recheck passed, and the collection-baseline and conflict-review removal is complete.
- Next: Stage 4, in-session collection changes.
- Collection names and Zotero tags are normalized to lowercase, hyphen-separated lists (spaces and underscores become `-`) without `obsLitNote`; hierarchy is not represented.
- Zotero collection membership is authoritative when collection data is present; Saver updates `zotero_collections` without collection baselines or conflict reviews. Missing collection data preserves the existing value.
- New and synchronized literature notes keep `zotero_tags` and `zotero_collections` as lists, using `[]` when empty; missing properties on existing notes are repaired through Obsidian's frontmatter API.
- Regen Citation Key saves the confirmed key and verifies it after reloading the Zotero item; Cancel leaves the saved key unchanged.
- The user confirmed the current `3Blue1Brown24WvizIntroGPTtransfrmr` note has `zotero_collections`; no live repair was needed for that property.
- The verified Companion XPI was installed after backing up the previous XPI. The user reports Zotero 10.0.8; restart Zotero to load and behavior-test the new code.
- A reviewed batch cancellation cancels before applying, but unexpected apply-time failures can leave partial writes.
- Blockers: notes without a unique active Zotero match remain unresolved.

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
registered installation directory. Collection baselines and their conflict
reviews have since been removed: supplied Zotero collection data overwrites
the corresponding note property, while omitted data preserves it. Existing
missing Zotero list properties are repaired through Obsidian's frontmatter API.
Attachment-preservation records remain note data and are not collection
baselines.

- [x] Extend the cross-plugin automatic-sync contract and plan validation;
      missing data from an older peer is not an empty collection list.
- [x] Compare associated notes at startup, backfill missing library identities
      only after unique matches are rechecked, and preserve pause, retry,
      recovery, and link-repair safeguards. Live recheck confirmed the managed
      Bike change synced without approval.
- [x] Remove collection baselines and conflict reviews. Zotero-owned collection
      data overwrites the matching note property; missing collection data does
      not erase it. Repair missing `zotero_tags` and `zotero_collections`
      through Obsidian's frontmatter API, using `[]` when empty.
- [x] Verify Regen Citation Key confirmation persists after reloading the Zotero
      item; cancellation preserves the saved key.
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
      Old databases and notes without stored attachment history must remain
      safe to use.
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
      changes, missing or stale attachment history, interruption, recovery, and
      preserved note content.

### 6. Release readiness

- [x] Update both plugins' documentation and protocol descriptions.
- [x] Run required checks and builds in the original checkouts, verify runtime
      artifacts, and install the verified companion XPI after backing it up.
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
- Should Zotero-owned collection metadata overwrite the corresponding note
  property when supplied? Confirmed. Do not retain collection baselines or
  collection conflict reviews. Preserve missing-data, identity, pause, retry,
  recovery, link-repair, and attachment-preservation safeguards; attachment
  records are not collection baselines.
- Which dates should note creation and modification properties represent?
  Recommended default: the Obsidian note lifecycle; use separately named
  properties for Zotero dates if needed. (Not yet confirmed.)

## Working notes

Update this document at stage boundaries or when decisions change. Record the
current state, next step, blockers, and material decisions here; avoid duplicating
session logs or routine command output.
