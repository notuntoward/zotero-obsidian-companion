import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeNoteMatchReport,
  formatNoteMatchIssue,
  formatNoteMatchReport,
  showNoteMatchReport,
  type NoteMatchIssue,
} from "../src/modules/noteMatchReport";

class ElementStub {
  style: Record<string, string> = {};
  private text = "";
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  value = "";
  children: ElementStub[] = [];
  listeners: Record<string, () => void> = {};
  setAttribute = vi.fn();
  addEventListener(type: string, handler: () => void) {
    this.listeners[type] = handler;
  }
  replaceChildren() {
    this.children = [];
    this.textContent = "";
  }
  appendChild(child: ElementStub) {
    this.children.push(child);
  }
  focus = vi.fn();
}

class DialogStub {
  static current: DialogStub;
  elements = new Map<string, ElementStub>();
  buttons = new Map<string, { callback?: () => void }>();
  data: any;
  window = {
    closed: false,
    document: {
      getElementById: (id: string) => this.elements.get(id),
      createElementNS: (namespace: string) => {
        if (namespace !== "http://www.w3.org/1999/xhtml")
          throw new Error("Expected HTML namespace");
        return new ElementStub();
      },
    },
    close: () => {
      this.window.closed = true;
    },
  };
  constructor() {
    DialogStub.current = this;
  }
  addCell(_row: number, _column: number, props: any) {
    for (const child of props.children)
      if (child.id) this.elements.set(child.id, new ElementStub());
    return this;
  }
  addButton(
    _label: string,
    id: string,
    options: { callback?: () => void } = {},
  ) {
    this.elements.set(id, new ElementStub());
    this.buttons.set(id, options);
    return this;
  }
  setDialogData(data: any) {
    this.data = data;
    return this;
  }
  open() {
    return this;
  }
}

const issue = (index: number): NoteMatchIssue => ({
  notePath: `Literature/Note ${index}.md`,
  itemkey: `ITEM${index}`,
  checkedLibraries: ["My Library"],
  matchingLibraries: [],
  kind: "missing",
});

describe("unmatched note report", () => {
  const copy = vi.fn();
  const commitCopy = vi.fn();
  beforeEach(() => {
    closeNoteMatchReport();
    copy.mockReset();
    commitCopy.mockReset();
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ screen: { availWidth: 1200, availHeight: 900 } }),
      logError: vi.fn(),
    };
    (globalThis as any).addon = {
      data: {
        ztoolkit: {
          Dialog: DialogStub,
          Clipboard: class {
            addText(text: string) {
              copy(text);
              return this;
            }
            copy() {
              commitCopy();
              return this;
            }
          },
        },
      },
    };
  });

  it("distinguishes an unavailable Zotero library from a search with no match", () => {
    expect(
      formatNoteMatchIssue({
        ...issue(1),
        checkedLibraries: [],
        unavailableLibrary: "group 9",
      }),
    ).toContain("Could not check: group 9");
    expect(
      formatNoteMatchIssue({
        ...issue(1),
        checkedLibraries: [],
        unavailableLibrary: "group 9",
      }),
    ).toContain("No Zotero libraries could be checked");
    expect(formatNoteMatchIssue(issue(1))).toContain(
      "No matching active Zotero item",
    );
  });

  it("shows the requested concise two-column report for missing items", () => {
    const issues = [
      {
        ...issue(1),
        notePath: "lit/lit_notes/Izquierdo.md",
        itemkey: "A76T9GBA",
      },
      { ...issue(2), notePath: "lit/lit_notes/WW2Pod.md", itemkey: "MX97RHKI" },
    ];
    showNoteMatchReport(issues);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    expect(dialog.elements.get("note-match-summary")!.textContent).toBe(
      "No matching Zotero items found for 2 Obsidian notes",
    );
    const table = dialog.elements.get("note-match-list")!.children[0];
    expect(table.children[0].textContent).toBe(
      "Obsidian noteZotero item key in note",
    );
    expect(table.children[1].children.map((row) => row.textContent)).toEqual([
      "Izquierdo.mdA76T9GBA",
      "WW2Pod.mdMX97RHKI",
    ]);
    expect(dialog.elements.get("note-match-checked")!.textContent).toBe(
      "Checked: My Library. The notes were not changed.",
    );
    expect(formatNoteMatchReport(issues)).toContain(
      "lit/lit_notes/Izquierdo.md\tA76T9GBA",
    );
  });

  it("reports different searched Zotero libraries for each note", () => {
    const issues = [issue(1), { ...issue(2), checkedLibraries: ["Group"] }];
    showNoteMatchReport(issues);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    const rows =
      dialog.elements.get("note-match-list")!.children[0].children[1].children;
    expect(rows[0].textContent).toContain("Checked: My Library");
    expect(rows[1].textContent).toContain("Checked: Group");
    expect(dialog.elements.get("note-match-checked")!.textContent).toContain(
      "see each note",
    );
  });

  it("uses a singular heading for one note", () => {
    expect(formatNoteMatchReport([issue(1)])).toContain(
      "No matching Zotero items found for 1 Obsidian note\n",
    );
  });

  it("distinguishes ambiguous and unavailable libraries in the table and copied report", () => {
    const issues: NoteMatchIssue[] = [
      {
        ...issue(1),
        kind: "ambiguous",
        checkedLibraries: ["My Library", "Group"],
        matchingLibraries: ["My Library", "Group"],
      },
      { ...issue(2), checkedLibraries: [], unavailableLibrary: "group 9" },
    ];
    showNoteMatchReport(issues);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    expect(dialog.elements.get("note-match-summary")!.textContent).toContain(
      "could not be matched",
    );
    const rows =
      dialog.elements.get("note-match-list")!.children[0].children[1].children;
    expect(rows[0].textContent).toContain(
      "Multiple matching active Zotero items: My Library, Group",
    );
    expect(rows[1].textContent).toContain(
      "No Zotero libraries could be checked",
    );
    expect(rows[1].textContent).toContain("Could not check: group 9");
    const report = formatNoteMatchReport(issues);
    expect(report).toContain(
      "Multiple matching active Zotero items: My Library, Group",
    );
    expect(report).toContain("Could not check: group 9");
  });

  it("previews three of 200 notes, searches all notes, and copies the full report", () => {
    const issues = Array.from({ length: 200 }, (_, i) => issue(i + 1));
    showNoteMatchReport(issues);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    const list = dialog.elements.get("note-match-list")!;
    expect(list.children).toHaveLength(2);
    expect(list.children[0].children[1].children).toHaveLength(3);
    expect(list.children[0].textContent).toContain("Note 1.md");
    expect(list.children[1].textContent).toContain("197 more Obsidian notes");
    expect(dialog.elements.get("note-match-search")!.style.display).toBe(
      "none",
    );
    dialog.buttons.get("note-match-view-all")!.callback!();
    expect(list.children[0].children[1].children).toHaveLength(200);
    const search = dialog.elements.get("note-match-search")!;
    search.value = "ITEM199";
    search.listeners.input();
    expect(list.children[0].children[1].children).toHaveLength(1);
    expect(list.children[0].textContent).toContain("Note 199.md");
    dialog.buttons.get("note-match-copy")!.callback!();
    expect(copy).toHaveBeenCalledOnce();
    expect(commitCopy).toHaveBeenCalledOnce();
    expect(copy.mock.calls[0][0]).toContain("ITEM1");
    expect(copy.mock.calls[0][0]).toContain("ITEM200");
    expect(copy.mock.calls[0][0]).toContain("Checked: My Library");
    expect(copy.mock.calls[0][0]).toContain("Literature/Note 200.md");
  });

  it("updates an open report without opening another window", () => {
    showNoteMatchReport([issue(1)]);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    showNoteMatchReport([issue(2)]);
    expect(DialogStub.current).toBe(dialog);
    expect(
      dialog.elements.get("note-match-list")!.children[0].textContent,
    ).toContain("ITEM2");
  });
  it("clearly reports a matched item with no citation key", () => {
    const missingKey: NoteMatchIssue = {
      ...issue(1),
      kind: "missing-citekey",
      matchingLibraries: ["My Library"],
    };
    showNoteMatchReport([missingKey]);
    const dialog = DialogStub.current;
    dialog.data.loadCallback();
    expect(dialog.elements.get("note-match-summary")!.textContent).toContain(
      "need attention",
    );
    expect(dialog.elements.get("note-match-list")!.textContent).toContain(
      "no citation key",
    );
    expect(formatNoteMatchReport([missingKey])).toContain(
      "Add one, then restart both applications",
    );
  });
});
