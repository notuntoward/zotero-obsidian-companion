# Agent Instructions for zotero-obsidian-companion

Zotero plugin that creates and opens Obsidian literature notes by talking to
the `Perplexity Saver` Obsidian plugin's local HTTP server
(`C:\Users\scott\repos\obsidian-perplexity-saver`).

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

Obsidian replies with `{ success, results: [{ citekey, status, error? }] }`
where `status` is `created | overwritten | opened | skipped | missing | error`.

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
  leaves dead space around short notices. `src/utils/progressNotice.ts` injects
  a compact style into the progress-window document; use `showNotice()` for
  simple notices instead of building windows ad hoc.
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
