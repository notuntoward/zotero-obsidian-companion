# Zotero Obsidian Companion

[![Build](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/build.yml/badge.svg)](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/build.yml)
[![CodeQL](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/codeql.yml/badge.svg)](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/scorecard.yml/badge.svg)](https://github.com/notuntoward/zotero-obsidian-companion/actions/workflows/scorecard.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/notuntoward/zotero-obsidian-companion/badge)](https://securityscorecards.dev/viewer/?uri=github.com/notuntoward/zotero-obsidian-companion)

Zotero 10 plugin that pairs with the [Perplexity Saver](https://github.com/notuntoward/obsidian-perplexity-saver) Obsidian plugin.

It allows you to create beautifully formatted literature notes directly from Zotero items into your Obsidian vault, and automatically syncs tag indicators (e.g. `#obsLitNote`) between Zotero items and your existing Obsidian literature notes.

## Zotero and Obsidian setup

For complete Obsidian and Zotero setup, including citation keys, attachments, ZotMoov, and linked attachment paths, see [Zotero and Obsidian setup](https://github.com/notuntoward/obsidian-perplexity-saver#zotero-and-obsidian-setup) in the Perplexity Saver README.

## Acknowledgements

This plugin was heavily inspired by [MarkDB-Connect](https://github.com/daeh/zotero-markdb-connect).

## Installation

1. Go to the [Releases](https://github.com/notuntoward/zotero-obsidian-companion/releases) page and download the latest `.xpi` file. (Or build it yourself, see below).
2. Open Zotero and go to **Tools -> Plugins**.
3. Click the gear icon in the top right corner and select **Install Plugin From File...**.
4. Select the downloaded `.xpi` file.
5. Restart Zotero when prompted.

## Commands & Usage

All commands are accessed by right-clicking any item in your Zotero library and expanding the **Obsidian** menu:

- **Create Lit Note:** Extracts the Zotero item's metadata, abstract, authors, and notes, and sends them to Obsidian. If a note already exists, Obsidian asks what to do.
- **Open Lit Note:** Tells Obsidian to instantly jump to the literature note corresponding to this Zotero item (based on the citekey).
- **Update Lit Note:** Previews and refreshes the selected existing notes' Zotero metadata, citation keys, and attachment links in Obsidian.
- **Sync Has-note Indicators:** Manually forces Zotero to check which literature notes exist in your Obsidian vault and updates the colored tag indicators in Zotero. This also happens automatically on startup and after creating a literature note.
- **Regen Citation Key:** Uses Better BibTeX to propose a citation key for the selected item(s), which you can edit before saving.
- **Toggle Left/Right Pane:** Quickly toggles Zotero's left and right sidebars for focused reading.

Citation-key and attachment changes are also reconciled automatically when both plugins are running. Reviews wait in Obsidian's **Zotero reviews** status-bar entry until selected; Zotero must be running to prepare a review. For setup, confirmation prompts, preserved fields, and limitations, see [Updating existing literature notes](https://github.com/notuntoward/obsidian-perplexity-saver#updating-existing-literature-notes).

On startup and when Zotero's Linked Attachment Base Directory changes, the companion checks it against the open Obsidian vault and retries if Obsidian is unavailable. The connection warning closes when the Saver server becomes available. The base directory resolves relative linked-file paths; it does not apply to stored attachments or move files. A directory outside the vault does not necessarily mean every linked file is outside it.

For eligible existing attachment reconciliation reviews, Saver can request a confirmed bulk move into the validated base directory. The companion rechecks the Zotero item and files before moving them, changes stored attachments to linked files where needed, and preserves any losing conflicting copy as a backup. Zotero group-library attachments are not converted to linked files.

## Settings Configuration

Configure settings in Zotero via **Edit -> Settings -> Obsidian**:

- **Keyboard Shortcuts:** Assign custom hotkeys to Create Lit Note, Open Lit Note, Sync Tags, Toggle Panes, and Regen BibTeX Key.
- **Has-note Indicator Tag:**
  - **Zotero tag showing item has an Obsidian note** (default: `obsLitNote`): The tag assigned to Zotero items when a corresponding literature note exists in Obsidian. The plugin automatically assigns a green color to this tag on startup.
- **Zotero Interface:**
  - **Show pane toggling commands on context menu:** Shows or hides the Toggle Left/Right Pane options in the right-click menu.

## Building from Source

The Husky commit-message and push hooks delegate attribution checks to the
chezmoi-managed hooks under `~/.config/kilo/hooks`. Install them from
[kilo-dotfiles](https://github.com/notuntoward/kilo-dotfiles) before committing
or pushing; missing policy files fail closed. The existing lint-staged
pre-commit hook remains unchanged.

This plugin is built using the [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) framework.

```bash
# 1. Clone the repository
git clone https://github.com/notuntoward/zotero-obsidian-companion.git
cd zotero-obsidian-companion

# 2. Install dependencies (requires Node.js 18+)
npm install

# 3. Compile and package the plugin
npm run build
```

This command automatically bundles the plugin into a `.xpi` file. All build
output goes to the `build/` directory at the project root.

1. Navigate to the generated `build/` directory inside the project folder.
2. You will find the newly built `obsidian.xpi` (alongside `update.json` and the unpacked `addon/` directory).
3. Open Zotero, go to **Tools -> Plugins**.
4. Click the gear icon (top right) -> **Install Plugin From File...** and select the `.xpi` file.
