# Zotero Obsidian Companion

Zotero 7/8/9 plugin that pairs with the [Perplexity Saver](https://github.com/notuntoward/obsidian-perplexity-saver) Obsidian plugin.

It allows you to create beautifully formatted literature notes directly from Zotero items into your Obsidian vault, and automatically syncs tag indicators (e.g. `#obsLitNote`) between Zotero items and your existing Obsidian literature notes.

## Zero-Configuration Architecture

This system uses a **zero-configuration local HTTP server** to communicate. 
1. The **Obsidian plugin** automatically runs a local HTTP server on port `27124` when Obsidian is open.
2. The **Zotero plugin** sends JSON payloads to that exact port when you trigger a command.
3. The **Obsidian plugin** receives the payload, formats the Markdown, and writes it directly to the OS filesystem based on your Obsidian settings.

Because of this, there are **no file paths, ports, or URLs to configure in Zotero**. As long as Obsidian is open, the Perplexity Saver plugin is enabled, and your "Lit Notes Folder" is set in Obsidian, it "just works" out of the box!

## Acknowledgements

This plugin was heavily inspired by [MarkDB-Connect](https://github.com/daeh/zotero-markdb-connect).

## Installation

1. Go to the [Releases](https://github.com/notuntoward/zotero-obsidian-companion/releases) page and download the latest `.xpi` file. (Or build it yourself, see below).
2. Open Zotero and go to **Tools -> Add-ons**.
3. Click the gear icon in the top right corner and select **Install Add-on From File...**.
4. Select the downloaded `.xpi` file.
5. Restart Zotero when prompted.

## Commands & Usage

All commands are accessed by right-clicking any item in your Zotero library and expanding the **Obsidian** menu:

- **Create Lit Note:** Extracts the Zotero item's metadata, abstract, authors, and notes, and pushes them to Obsidian. Obsidian automatically generates the Markdown file and opens it. If a note already exists, Zotero will prompt you to overwrite it.
- **Open Lit Note:** Tells Obsidian to instantly jump to the literature note corresponding to this Zotero item (based on the citekey). 
- **Sync Obsidian Tags:** Manually forces Zotero to check which literature notes exist in your Obsidian vault and updates the colored tag indicators in Zotero. (This also happens automatically on startup).
- **Regen Citation Key:** Forces Better BibTeX to regenerate the citation key for the selected item(s).
- **Toggle Left/Right Pane:** Quickly toggles Zotero's left and right sidebars for focused reading.

## Settings Configuration

Configure settings in Zotero via **Edit -> Settings -> Obsidian**:

- **Keyboard Shortcuts:** Assign custom hotkeys to all commands (Create Lit Note, Open Lit Note, Sync Tags, Toggle Panes, Regen BibTeX Key).
- **Obsidian Integration:**
  - **Tag for Zotero items with an Obsidian note** (default: `obsLitNote`): The tag assigned to Zotero items when a corresponding literature note exists in Obsidian. The plugin automatically assigns a green color to this tag on startup.
- **Zotero Interface:**
  - **Show pane toggling commands on context menu:** Shows or hides the Toggle Left/Right Pane options in the right-click menu.

## Building from Source

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

This command automatically bundles the plugin into a `.xpi` file.
1. Navigate to the generated `.scaffold/build/` directory inside the project folder.
2. You will find the newly built `obsidian.xpi` file there.
3. Open Zotero, go to **Tools -> Add-ons**.
4. Click the gear icon (top right) -> **Install Add-on From File...** and select the `.xpi` file.
