# Agent Instructions for zotero-obsidian-companion

Zotero plugin that creates and opens Obsidian literature notes by talking to
the `Perplexity Saver` Obsidian plugin's local HTTP server
(`C:\Users\scott\repos\obsidian-perplexity-saver`).

For staged Zotero–Obsidian consistency work, use the canonical
`doc/CONSISTENCY-PLAN.md`; update its state and decisions as the work progresses.

<!-- BEGIN SUITE IMPACT -->

## Suite impact

Before and after source or contract changes, run
`node ../obsidian-commons/scripts/inventory.mjs impact`. Read only the listed required contract peers and
same-surface symmetry candidates; do not scan every sibling repository. Run
their configured checks only when the report or changed contract requires them.

Run `node ../obsidian-commons/scripts/inventory.mjs release-check` before source release. The report
distinguishes a valid bundled runtime artifact from reproducible source
dependencies. If the project declares a shared-package link, pin an immutable
tag/commit before release and pass the check again.

Run `node ../obsidian-commons/scripts/inventory.mjs community-review <project|all>` for the Obsidian
community-rule lint gate. This command runs only each selected repository's
local `npm run lint:community-review`; a consumer check/build must never start a
suite traversal. Standalone browser userscripts are outside the Obsidian
runtime profile and remain under the repository's normal lint rules.

For manual repository maintenance, run `node ../obsidian-commons/scripts/inventory.mjs bot-prs
<project...>` and `node ../obsidian-commons/scripts/inventory.mjs maintain <project...>`. They default to
dry-run; add `--apply` only to approve/update eligible bot PRs and synchronized
rule dependencies. `maintain` implicitly adds commons for any Obsidian review
target; positional `all` selects the entire inventory.
<!-- END SUITE IMPACT -->

## Impact usage

Run `node ../obsidian-commons/scripts/inventory.mjs impact` once at task start
and once after the final edits in each repository you change. Keep only the
`Explicit contracts:` and `Symmetry review:` sections (required contract peers
and same-surface symmetry candidates); do not carry the full report into
context. Run peer checks only when the report or changed contract requires them.

## Validation

- Inner loop after each edit: `npx vitest run <changed test file>` and
  `npx tsc --noEmit`.
- Final gate once per task: `npm run lint:check`, `npm test`, and
  `npm run build`. After a source change, verify
  `build/addon/content/scripts/zoteroobsidian.js` contains a fingerprint of the
  change. `build/` is the single build-output location.
- Do not run `npm run check && npm test` or a production build after every edit.

## Verification before reporting done

For UI changes, inspect a screenshot at normal and narrow sizes and verify
alignment, centering, sizing, and stale or cached states. State when a manual
check in Zotero or Obsidian is still needed.

## Zotero version

Targets Zotero 10 only (`strict_min_version: "10.0"`, esbuild target
`firefox140`). Do not add compatibility shims for Zotero 7.

## Cross-plugin contract

The Zotero side posts to `http://127.0.0.1:27124/lit-note`. Before changing
the protocol or reconciliation behavior, read
[`doc/PROTOCOL.md`](doc/PROTOCOL.md) for request and response shapes, statuses,
collection semantics, and plan validation.

- Never add a Zotero-side overwrite or confirmation dialog; Obsidian's modal
  owns that decision.
- Do not lower `postToObsidian`'s 120-second timeout without a concrete reason.
- A protocol change requires updating both plugins and both test suites.

## Generic Zotero plugin rules

Generic Zotero plugin lessons (startup-cache pitfalls, install checks, menus
and localization, hotkeys, read-only `zotero.sqlite` inspection, Zotero 10
API changes) live in the global rule "Zotero plugins" in
`~/.config/kilo/AGENTS.md`, managed through chezmoi from
`notuntoward/kilo-dotfiles`. Change them there, not here.

## Zotero runtime notes

Before changing item menus, progress notices, Zotero async API usage, bootstrap
caching, or XPI installation, read [`doc/ZOTERO-NOTES.md`](doc/ZOTERO-NOTES.md).
Follow the global "Zotero plugins" rule for generic startup-cache handling.

## Companion-specific notes

- Every user command appears in the item context menu (`src/modules/menu.ts`)
  and can have a shortcut. When adding a command, update `actions.ts`,
  `menu.ts`, `hotkeys.ts`, `addon/prefs.js`, `preferences.xhtml`,
  `preferenceScript.ts`, both `mainWindow.ftl` locales, and the README. Only
  the pane toggles are hidden, by the "Show pane toggling commands" preference.

## Tests

Add regression coverage for behaviour that is easy to break:

- `tests/actions.test.ts` - batching, result handling, tagging, error alerts.
- `tests/obsidianConnection.test.ts` - launch chain, timeout, notice lifecycle.
- `tests/paneUtils.test.ts` - pane toggling (including the native
  `ZoteroPane.toggleItemPane` path).
