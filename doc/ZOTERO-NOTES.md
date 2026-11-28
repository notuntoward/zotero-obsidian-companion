# Zotero runtime and installation notes

Read this file before changing Zotero progress notices, bootstrap caching,
async API usage, or XPI installation.

## Bundle and installation

- Build with `npm run build`; the XPI is `build/obsidian.xpi`. Keep `build/` as
  the only build-output location.
- Zotero must be closed before overwriting the installed XPI at
  `%APPDATA%\Zotero\Zotero\Profiles\0vqgu3uw.default\extensions\zotero-obsidian-companion@notuntoward.xpi`.
- Back up the installed XPI first to the profile's
  `obsidian-companion-xpi-backups\` directory.
- Verify that the installed file's SHA-256 matches `build/obsidian.xpi`.
- The version remains `0.0.1`; follow the global "Zotero plugins" rule for
  startup-cache handling.
- `addon/bootstrap.js` loads the bundle with `ignoreCache: true`;
  `tests/hooks.test.ts` guards this behavior.

## Menus and progress notices

- Register item menus once in `onStartup` with Zotero's native
  `Zotero.MenuManager.registerMenu`, not once per window. Stable
  `zotero-plugin-toolkit` releases removed the toolkit `Menu` helper.
- Zotero 10 removed `skin/tick.png` and `skin/cross.png`. Use the plugin's
  `content/icons/success.svg` and `cross.svg`, registered by
  `src/utils/ztoolkit.ts` with `setIconURI`; do not point back to Zotero PNGs.
- Use `showNotice()` for simple progress feedback instead of building windows
  ad hoc. Zotero progress windows
  reserve a 300px minimum width and a 250px item label; the compact style in
  `src/utils/progressNotice.ts` avoids excess space and clipped text.
- Progress windows are XUL/XHTML hybrids with a XUL default namespace. Create
  injected style elements with
  `document.createElementNS("http://www.w3.org/1999/xhtml", "style")`; a plain
  `document.createElement("style")` silently creates a non-stylesheet element.
- After changing a notice's text, call `sizeToContent()` again through
  `resizeCompactProgressWindow()`; `setText()` alone does not resize it, only
  `addLines()` and `addDescription()` do.
  After resizing, call `Zotero.ProgressWindowSet.tile(win)` and constrain the
  notice to the screen's available bounds so it does not move off-screen.

## Async and shutdown

- For supported `Zotero.Promise` methods, follow the global "Zotero plugins"
  rule; do not rely on Bluebird-only methods.
- Guard long-running async work against shutdown with `addon.data.alive` (see
  `obsidianConnection.ts`).
