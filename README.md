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
- **Copy Zotero Item Key:** Copies the selected item's Zotero item key (one key per line for multiple items) to the clipboard.
- **Toggle Left/Right Pane:** Quickly toggles Zotero's left and right sidebars for focused reading.

Citation-key and attachment changes are also reconciled automatically when both plugins are running, unless automatic checks are paused in Zotero's Obsidian settings. Reviews wait in Obsidian's **Zotero reviews** status-bar entry until selected; Zotero must be running to prepare a review. For setup, confirmation prompts, preserved fields, and limitations, see [Updating existing literature notes](https://github.com/notuntoward/obsidian-perplexity-saver#updating-existing-literature-notes).

Collection membership is refreshed by **Update Lit Note**, not automatically.
If Zotero cannot read a collection for an item, note creation and updates stop
instead of saving an incomplete collection list.

If a response is lost after reconciliation may have changed an item or note, the companion checks the current state on startup. Interrupted automatic attachment work retains its original paths for recovery and replanning without an attachment review. Other unresolved interrupted operations may require attention in **Zotero reviews**.

On startup and when Zotero's Linked Attachment Base Directory changes, the companion checks it against the open Obsidian vault and retries if Obsidian is unavailable. The connection warning closes when the Saver server becomes available, or after 30 seconds if it remains unavailable. The base directory resolves relative linked-file paths; it does not apply to stored attachments or move files. A directory outside the vault does not necessarily mean every linked file is outside it.

For eligible existing notes, the companion automatically links Zotero to a matching nonempty note attachment, even if the old Zotero file is missing, or copies unmatched Zotero files to unused vault filenames and links them in both apps. Stored originals and their snapshot resources are verified and archived under `obsidian-companion-attachment-archive` in Zotero's data directory, outside its `storage` folder. Saver records the archive and former storage paths in the note and can list them with **List preserved Zotero attachment files**. The original Zotero item goes to Trash and may count against the Zotero storage quota until the Trash is emptied and sync completes; the archive uses local disk space, not Zotero synced storage. Missing originals are not reported as preserved. Remaining resources from a missing original's storage folder are archived and recorded separately as a resource-only archive, after checking other Zotero references. The plugins recheck the plan before changing files. Zotero group-library attachments are not converted to linked files. If the base directory is invalid, automatic attachment reconciliation stops with a persistent warning.

If multiple Obsidian notes claim the same Zotero item, the companion sends the requested item to Saver for a read-only explanation with links to all matching notes. Saver opens the matching notes side by side and can merge them into the note you keep; Saver requests the item recheck automatically once only one note matches. When a merged note belonged to a different Zotero item and you chose to remove it, the companion moves that item to the Zotero trash and reports the result to Saver. Saver's **Check all literature notes against Zotero again** command makes the companion repeat its startup check without a restart. Bulk note updates still require one unambiguous matching note.

When Zotero reports notes whose items cannot be matched, click a note name to open it in Obsidian. Both plugins must be updated; if the note has moved or its Zotero item key has changed, run the check again.

Startup finishes previously queued review updates before retrying a busy initial review scan, including while automatic checks are paused. Waiting for those updates is not a scan failure.

Startup does not repair pre-existing attachment link-mode sync conflicts. Those records remain untouched for manual resolution in Zotero and do not block citation-key or multiple-note reviews, even while Zotero sync is active. The companion's ready notice appears only after the initial review scan has completed and replaces any earlier scan-failure notice; opening another Zotero window does not create another startup notice. Readiness does not mean that Zotero's own sync errors have been resolved.

If an earlier sync-state recovery attempt created `obsidian-companion-attachment-archive/sync-recovery.json`, keep that journal and its archives for later inspection. Startup does not process it. A successful companion build or completed note-review scan does not establish that Zotero's native sync warning is resolved.

If Zotero cannot check whether other attachments reference the originals, the companion can copy linked files into the vault while preserving the originals. It stops stored-file replacement if references cannot be checked or another Zotero attachment references the storage folder. A different existing destination is not overwritten; a new name is used when possible. Saver reports the result; verify references before manually deleting an original.

## Settings Configuration

Configure settings in Zotero via **Edit -> Settings -> Obsidian**:

- **Keyboard Shortcuts:** Assign custom hotkeys to Create Lit Note, Open Lit Note, Sync Tags, Toggle Panes, Regen BibTeX Key, and Copy Zotero Item Key.
- **Literature note checks:** **Pause automatic Zotero and Obsidian checks** stops new automatic consistency scans. A scan already in progress finishes first. Zotero still recovers interrupted updates and processes existing reviews. Use **Check all literature notes against Zotero again** in Obsidian for a manual check while paused, or turn the setting off to resume automatic checks. Pausing can leave citation-key, identity and attachment differences undiscovered. Obsidian hides the review status when nothing needs attention; its absence does not prove a check ran or Zotero is connected. If a manual check does not start, verify that Zotero and the updated companion are running.
- This setting does not stop has-note indicator syncing or linked-attachment base-directory validation.
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
