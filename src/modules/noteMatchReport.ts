import { getMainWindow, showAlert } from "../utils/alert";
import { postToObsidian } from "./obsidianConnection";

declare const Zotero: any;
declare const addon: any;

export interface NoteMatchIssue {
  notePath?: string;
  itemkey: string;
  checkedLibraries: string[];
  unavailableLibrary?: string;
  matchingLibraries: string[];
  kind: "missing" | "ambiguous" | "missing-citekey" | "invalid-citekey";
}

const moreHelp = [
  "If the Zotero item is in Trash, restore it. If its library is unavailable, make it available.",
  "If it is in another Zotero library with the same Zotero item key, select it in Zotero and choose Obsidian → Update Lit Note. Verify the association before confirming.",
  "If the item has a different Zotero item key, it cannot be matched automatically. If it no longer exists, you can keep the Obsidian note; it will not sync.",
  "If multiple Zotero items match, verify which one belongs to the note before updating.",
  "If a matched Zotero item has a missing or invalid citation key, correct it and restart both applications to check it again.",
].join("\n\n");

function commonLibraries(issues: NoteMatchIssue[]): string[] | undefined {
  if (!issues.length || issues.some((issue) => issue.unavailableLibrary))
    return undefined;
  const first = issues[0].checkedLibraries;
  return issues.every(
    (issue) => JSON.stringify(issue.checkedLibraries) === JSON.stringify(first),
  )
    ? first
    : undefined;
}

function reportTitle(issues: NoteMatchIssue[]): string {
  if (!issues.length) return "No Obsidian notes currently need this report.";
  const notes = `${issues.length} Obsidian note${issues.length === 1 ? "" : "s"}`;
  if (
    issues.some(
      (issue) =>
        issue.kind === "missing-citekey" || issue.kind === "invalid-citekey",
    )
  )
    return `Zotero items need attention for ${notes}`;
  return issues.every(
    (issue) =>
      issue.kind === "missing" &&
      issue.checkedLibraries.length &&
      !issue.unavailableLibrary,
  )
    ? `No matching Zotero items found for ${notes}`
    : `Zotero items could not be matched for ${notes}`;
}

function noteName(issue: NoteMatchIssue): string {
  return (
    issue.notePath?.split("/").pop() ||
    "Name unavailable; update the Obsidian plugin"
  );
}

function needsDetails(issues: NoteMatchIssue[]): boolean {
  return (
    !commonLibraries(issues) || issues.some((issue) => issue.kind !== "missing")
  );
}

function issueDetail(issue: NoteMatchIssue): string {
  const checked = issue.checkedLibraries.length
    ? issue.checkedLibraries.join(", ")
    : "None";
  const status =
    issue.kind === "ambiguous"
      ? `Multiple matching active Zotero items: ${issue.matchingLibraries.join(", ")}`
      : issue.kind === "missing-citekey"
        ? "Matched Zotero item has no citation key. Add one, then restart both applications to check again"
        : issue.kind === "invalid-citekey"
          ? "Matched Zotero item has an invalid citation key. Correct it, then restart both applications to check again"
          : issue.checkedLibraries.length
            ? "No matching active Zotero item"
            : "No Zotero libraries could be checked";
  return [
    status,
    `Checked: ${checked}`,
    ...(issue.unavailableLibrary
      ? [`Could not check: ${issue.unavailableLibrary}`]
      : []),
  ].join(". ");
}

export function formatNoteMatchIssue(issue: NoteMatchIssue): string {
  return [
    `Obsidian note: ${issue.notePath || "Name unavailable; update the Obsidian plugin"}`,
    `Zotero item key: ${issue.itemkey}`,
    issueDetail(issue),
  ].join("\n");
}

export function formatNoteMatchReport(issues: NoteMatchIssue[]): string {
  const libraries = commonLibraries(issues);
  const showDetails = needsDetails(issues);
  return [
    reportTitle(issues),
    "Obsidian note\tZotero item key in note",
    ...issues.map(
      (issue) =>
        `${issue.notePath || noteName(issue)}\t${issue.itemkey}${showDetails ? `\n  ${issueDetail(issue)}` : ""}`,
    ),
    "",
    `Checked: ${libraries ? libraries.join(", ") || "None" : "see each note"}. The notes were not changed.`,
    "",
    "Search Zotero by title or check Trash.",
  ].join("\n");
}

let entries: NoteMatchIssue[] = [];
let reportWindow: Window | undefined;
let expanded = false;

function render(): void {
  if (!reportWindow || reportWindow.closed) return;
  const doc = reportWindow.document;
  const summary = doc.getElementById("note-match-summary");
  const list = doc.getElementById("note-match-list");
  const search = doc.getElementById(
    "note-match-search",
  ) as HTMLInputElement | null;
  const viewAll = doc.getElementById("note-match-view-all");
  const checked = doc.getElementById("note-match-checked");
  if (!summary || !list || !search || !viewAll || !checked) return;
  summary.textContent = reportTitle(entries);
  const libraries = commonLibraries(entries);
  checked.textContent = entries.length
    ? `Checked: ${libraries ? libraries.join(", ") || "None" : "see each note"}. The notes were not changed.`
    : "";
  viewAll.style.display = !expanded && entries.length > 3 ? "" : "none";
  search.style.display = expanded ? "" : "none";
  const query = expanded ? search.value.trim().toLocaleLowerCase() : "";
  const matching = entries.filter((entry) =>
    formatNoteMatchIssue(entry).toLocaleLowerCase().includes(query),
  );
  const shown = expanded ? matching : matching.slice(0, 3);
  const showDetails = needsDetails(entries);
  list.replaceChildren();
  if (shown.length) {
    const table = doc.createElementNS("http://www.w3.org/1999/xhtml", "table");
    table.style.width = "100%";
    table.style.textAlign = "left";
    const header = doc.createElementNS("http://www.w3.org/1999/xhtml", "tr");
    for (const label of ["Obsidian note", "Zotero item key in note"]) {
      const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "th");
      cell.textContent = label;
      cell.setAttribute("scope", "col");
      header.appendChild(cell);
    }
    const thead = doc.createElementNS("http://www.w3.org/1999/xhtml", "thead");
    thead.appendChild(header);
    table.appendChild(thead);
    const body = doc.createElementNS("http://www.w3.org/1999/xhtml", "tbody");
    for (const issue of shown) {
      const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "tr");
      const note = doc.createElementNS("http://www.w3.org/1999/xhtml", "td");
      if (issue.notePath) {
        const notePath = issue.notePath;
        const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "a");
        link.textContent = noteName(issue);
        link.setAttribute("href", "#");
        link.title = `Open ${notePath} in Obsidian`;
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          try {
            const result = await postToObsidian({
              action: "open-note-path",
              notePath,
              itemkey: issue.itemkey,
            });
            if (!result.success) {
              throw new Error(
                result.error || "Obsidian did not open the note.",
              );
            }
          } catch (error) {
            Zotero.logError(error);
            showAlert(
              getMainWindow(),
              "Could not open Obsidian note",
              String(error),
            );
          }
        });
        note.appendChild(link);
      } else {
        note.textContent = noteName(issue);
      }
      note.title = issue.notePath || "";
      note.style.overflowWrap = "anywhere";
      if (showDetails) {
        const detail = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div",
        );
        detail.textContent = issueDetail(issue);
        note.appendChild(detail);
      }
      const key = doc.createElementNS("http://www.w3.org/1999/xhtml", "td");
      key.textContent = issue.itemkey;
      key.style.verticalAlign = "top";
      row.appendChild(note);
      row.appendChild(key);
      body.appendChild(row);
    }
    table.appendChild(body);
    list.appendChild(table);
  }
  if (!expanded && matching.length > 3) {
    const remaining = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    remaining.textContent = `And ${matching.length - 3} more Obsidian notes.`;
    list.appendChild(remaining);
  } else if (expanded && !matching.length && entries.length) {
    list.textContent = "No notes match your search.";
  }
}

export function showNoteMatchReport(issues: NoteMatchIssue[]): void {
  entries = issues;
  if (reportWindow && !reportWindow.closed) {
    render();
    return;
  }
  if (!issues.length) return;
  expanded = false;
  const dialog = new addon.data.ztoolkit.Dialog(1, 1);
  dialog.addCell(0, 0, {
    tag: "div",
    namespace: "html",
    styles: {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      padding: "12px",
      boxSizing: "border-box",
      gap: "10px",
      overflow: "auto",
    },
    children: [
      {
        tag: "div",
        namespace: "html",
        id: "note-match-summary",
        styles: { fontWeight: "bold" },
      },
      {
        tag: "input",
        namespace: "html",
        id: "note-match-search",
        attributes: {
          type: "search",
          placeholder: "Search notes, Zotero item keys, or Zotero libraries",
          "aria-label": "Search notes",
        },
      },
      {
        tag: "div",
        namespace: "html",
        id: "note-match-list",
        styles: {
          overflow: "auto",
          maxHeight: "45vh",
          whiteSpace: "normal",
        },
      },
      {
        tag: "div",
        namespace: "html",
        id: "note-match-checked",
      },
      {
        tag: "div",
        namespace: "html",
        properties: { textContent: "Search Zotero by title or check Trash." },
      },
      {
        tag: "details",
        namespace: "html",
        children: [
          {
            tag: "summary",
            namespace: "html",
            properties: { textContent: "More help" },
          },
          {
            tag: "div",
            namespace: "html",
            properties: { textContent: moreHelp },
            styles: { whiteSpace: "pre-wrap" },
          },
        ],
      },
    ],
  });
  dialog.addButton("View all", "note-match-view-all", {
    noClose: true,
    callback: () => {
      expanded = true;
      render();
      reportWindow?.document.getElementById("note-match-search")?.focus();
    },
  });
  dialog.addButton("Copy report", "note-match-copy", {
    noClose: true,
    callback: () => {
      try {
        new addon.data.ztoolkit.Clipboard()
          .addText(formatNoteMatchReport(entries), "text/unicode")
          .copy();
      } catch (error) {
        Zotero.logError(error);
        showAlert(getMainWindow(), "Could not copy report", String(error));
      }
    },
  });
  dialog.addButton("Close", "note-match-close");
  dialog.setDialogData({
    loadCallback: () => {
      reportWindow?.document
        .getElementById("note-match-search")
        ?.addEventListener("input", render);
      render();
    },
    unloadCallback: () => {
      if (reportWindow === dialog.window) reportWindow = undefined;
    },
  });
  const screen = getMainWindow()?.screen;
  const width = Number.isFinite(screen?.availWidth)
    ? Math.min(720, screen.availWidth - 40)
    : 720;
  const preferredHeight = issues.length > 3 ? 560 : 360;
  const height = Number.isFinite(screen?.availHeight)
    ? Math.min(preferredHeight, screen.availHeight - 40)
    : preferredHeight;
  dialog.open(
    issues.some(
      (issue) =>
        issue.kind === "missing-citekey" || issue.kind === "invalid-citekey",
    )
      ? "Obsidian notes: Zotero items need attention"
      : "Obsidian notes: Zotero items not matched",
    {
      width,
      height,
      centerscreen: true,
      resizable: true,
      fitContent: false,
    },
  );
  reportWindow = dialog.window;
}

export function closeNoteMatchReport(): void {
  reportWindow?.close();
  reportWindow = undefined;
  entries = [];
}
