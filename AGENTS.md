# Agent Instructions for zotero-obsidian-companion

Zotero plugin that creates and opens Obsidian literature notes by talking to
the `Perplexity Saver` Obsidian plugin's local HTTP server
(`C:\Users\scott\repos\obsidian-perplexity-saver`).

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

Before and after contract or behavior changes, run
`node ../obsidian-commons/scripts/inventory.mjs impact`. Treat the listed
protocol peers as required; do not scan unrelated sibling repositories.
Run `node ../obsidian-commons/scripts/inventory.mjs release-check` before a
source release to verify the configured artifact and project metadata.

## Build, verify, deploy

- Type-check: `npx tsc --noEmit`
- Lint/format check: `npm run lint:check` (use `npm run lint:fix` to fix)
- Tests: `npm test` (Vitest, `tests/*.test.ts`)
- Build: `npm run build` -> `build/obsidian.xpi`
- `build/` is the single build-output location. Do not add another.
- After changing `src/`, rebuild and grep
  `build/addon/content/scripts/zoteroobsidian.js` for a fingerprint of the
  change before declaring the task done.
- Zotero loads the installed XPI, so a source build is not live until the XPI
  is replaced. Zotero must be closed to overwrite
  `%APPDATA%\Zotero\Zotero\Profiles\0vqgu3uw.default\extensions\zotero-obsidian-companion@notuntoward.xpi`.

## Zotero version

Targets Zotero 10 only (`strict_min_version: "10.0"`, esbuild target
`firefox140`). Do not add compatibility shims for Zotero 7.

## Cross-plugin contract (must stay in sync with the Obsidian plugin)

The Zotero side posts to `http://127.0.0.1:27124/lit-note`:

- `{ action: "create", data: ZoteroItemPayload[] }`
- `{ action: "open", data: ZoteroItemPayload[] }`
- `{ action: "sync", data: ZoteroItemPayload[] }` for automatic reconciliation
- `{ action: "update", data: ZoteroItemPayload[] }` for previewed metadata updates
- `{ action: "apply-sync" | "validate-zotero-key", token, data: [ZoteroItemPayload] }` to revalidate an approved plan

Obsidian replies with `{ success, results: [{ citekey, status, error? }] }`.
In addition to `created | overwritten | opened | updated | skipped | missing | error`,
reconciliation can return `prepared` with a one-use token, or `set-zotero-key`
with a token and expected/selected keys. Re-read the Zotero payload and validate
the token before applying a plan or changing Zotero; verify saved keys and
refresh attachment snapshots before continuing. Never treat a prepared plan as
a completed update. `GET /lit-note-identities` returns indexed identities and
note modification metadata and Obsidian note paths. When citation keys differ, the companion sends a
`citationKeyCheck` listing matching items in accessible Zotero libraries. It
rechecks that result before changing Zotero; lookup failures stop the update.
When a prepared plan has `needsAttachmentCheck`, enumerate the file paths of
attachments in accessible user and group libraries, including trashed items,
and supply them as `zoteroAttachmentPaths` on `apply-sync`. Fail closed when
the inventory or a file path is unavailable.
The automatic path waits for stable snapshots and retries when Obsidian becomes
available again. Payloads identify the Zotero library by name and attachments by
item key. After changing a citekey in Zotero, `zoteroChanges` records the prior
citekey and only file moves verified by the same attachment item key; preserve
this summary when revalidating and applying the resulting one-use plan.

`src/modules/actions.ts` batches all selected items into ONE request, tags the
items whose status means the note now exists
(`created | overwritten | opened`), and reports error results in a single
alert.

- Never reintroduce a Zotero-side overwrite/confirm dialog. Decisions about an
  existing or missing note are made in Obsidian's modal so the prompt is never
  hidden behind Obsidian and looks the same in every case.
- `postToObsidian` uses a 120s timeout because the user may be answering that
  modal. Do not lower it without a concrete reason.
- Changing the payload shape or statuses requires updating both plugins and
  both test suites.

## Zotero-specific gotchas

- Item menus use Zotero's native `Zotero.MenuManager.registerMenu`, registered
  once in `onStartup` (not per window). The toolkit's `Menu` helper was removed
  in stable `zotero-plugin-toolkit` releases.
- Progress-window icons: Zotero 10 removed `skin/tick.png` and `skin/cross.png`.
  `src/utils/ztoolkit.ts` registers the plugin's own
  `content/icons/success.svg` and `cross.svg` via `setIconURI`. Do not point
  icons back at Zotero PNG paths.
- Progress windows hard-code `min-width: 300px` and a 250px item label, which
  leaves dead space around short notices (and wraps/clips longer ones).
  `src/utils/progressNotice.ts` injects a compact style into the progress
  window document; use `showNotice()` for simple notices instead of building
  windows ad hoc. The progress window is a XUL/XHTML hybrid document whose
  _default_ (unprefixed) namespace is XUL, not HTML: a plain
  `document.createElement("style")` there silently creates a non-stylesheet
  element that Gecko's style engine ignores. Any injected `<style>` MUST use
  `document.createElementNS("http://www.w3.org/1999/xhtml", "style")`. Also
  call `sizeToContent()` again after changing a notice's text later
  (`resizeCompactProgressWindow()`) — `setText()` does not resize the window
  on its own, only `addLines()`/`addDescription()` do. After resizing, call
  `Zotero.ProgressWindowSet.tile(win)` and constrain the notice to its screen's
  available bounds; resizing without repositioning can leave it off-screen.
- `Zotero.Promise` is a shim in Zotero 10: only `delay`, `defer`, and `method`
  are guaranteed. Do not use Bluebird-only methods.
- Guard long-running async work against shutdown with `addon.data.alive`
  (see `obsidianConnection.ts`).

## Tests

Add regression coverage for behaviour that is easy to break:

- `tests/actions.test.ts` - batching, result handling, tagging, error alerts.
- `tests/obsidianConnection.test.ts` - launch chain, timeout, notice lifecycle.
- `tests/paneUtils.test.ts` - pane toggling (including the native
  `ZoteroPane.toggleItemPane` path).
