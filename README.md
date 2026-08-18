# Zotero Obsidian Companion

Zotero 7 plugin that will talk to [Perplexity Saver](https://github.com/notuntoward/obsidian-perplexity-saver).

Allows creating literature notes directly from Zotero items into your Obsidian vault, and automatically syncs tag indicators (e.g. `obsLitNote`) between Zotero items and your existing Obsidian literature notes.

## Acknowledgements

This plugin was inspired by [MarkDB-Connect](https://github.com/daeh/zotero-markdb-connect).

## Installation

1. Go to the [Releases](https://github.com/notuntoward/zotero-obsidian-companion/releases) page and download the latest `.xpi` file. (Or build it yourself, see below).
2. Open Zotero and go to **Tools -> Add-ons**.
3. Click the gear icon in the top right corner and select **Install Add-on From File...**.
4. Select the downloaded `.xpi` file.
5. Restart Zotero when prompted.

## Build from Source

1. Clone this repository.
2. Install [Node.js 18+](https://nodejs.org/).
3. Run `npm install` to install dependencies.
4. Run `npm run build` to compile the plugin and generate the `.xpi` file.
5. The output `.xpi` file will be located in the `.scaffold/build/` directory.
6. Install the `.xpi` file in Zotero via **Tools -> Add-ons -> Gear icon -> Install Add-on From File...**.

## Usage

- Right-click any item in your Zotero library and select **"Create Lit Note"** to push the item's metadata to Obsidian and automatically open the note.
- The plugin will automatically sync a green tag (default: `obsLitNote`) to any item in Zotero that has a corresponding literature note in Obsidian. This sync happens silently on startup.
- You can manually trigger the tag sync at any time by right-clicking any item and selecting **"Sync Obsidian Tags"**.
- Configure the sync tag name in Zotero's **Edit -> Settings -> Zotero Obsidian Companion**.

## Known Issues / Bugs / TODOs

- **Settings Menu Text Clipping:** In the Zotero 7 Add-on preferences window, the plugin name label is occasionally clipped on the right edge of the sidebar even with a shortened name and no icon.
- **Context Menu Reorganization:** The custom context menu options (Create Lit Note, Open Lit Note, Sync Obsidian Tags) currently need their grouping, order, and icons reorganized and polished to blend better natively.
- **Improve rendering:** Improve rendering of multiple Zotero notes in the Obsidian note.
- **Settings configuration:** Make the commands on the context menu configurable via settings options.
- **Callout Auto-Expansion in Obsidian:** When creating a note from Zotero, Obsidian automatically opens the new note in Live Preview mode. Because the note's cursor is placed inside the top `>[!info]-` callout block, Obsidian temporarily expands the folded callout to allow editing. Attempts to programmatically move the cursor to the bottom of the file (using `setCursor` or `eState`) have so far raced with Live Preview's mounting process, causing the callout to remain expanded upon opening.
- **Citation Link Generation:** There is currently an issue where citation spans injected into Zotero HTML notes fail to generate `data-citekey` attributes for some URIs, resulting in Obsidian rendering the citation as plain text `(Author, Year)` instead of a functional Markdown link. This seems to stem from how Zotero 7 serializes note content, but debugging is ongoing.
