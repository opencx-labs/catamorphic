// Work sidebars, as an agent wrote them (ADR 0234). Edit and save to update
// both sides live. Each side is an ordered list of tabs: { id, title, icon,
// sections }. A section shows a source ("work:<name>" or a module path),
// items, an app or a note.
module.exports = {
  sidebars: {
    left: [
      {
        id: "project",
        title: "Project",
        icon: "House",
        sections: [
          { id: "bookmarks", source: "work:bookmarks" },
          { id: "workflows", source: "work:workflows", hideEmpty: true },
          { id: "apps", source: "work:apps", hideEmpty: true },
          { id: "chats", source: "work:chats" },
          { id: "files", source: "work:files", collapsed: true },
          {
            id: "remote",
            source: "work:remote",
            title: "Server",
            hideEmpty: true,
          },
        ],
      },
      {
        id: "docs",
        title: "Docs",
        icon: "BookOpen",
        sections: [
          {
            id: "docs-links",
            title: "Documentation",
            items: [
              {
                id: "docs-web-folder",
                label: "Web documentation",
                icon: "Folder",
                items: [
                  {
                    id: "docs-mdn",
                    label: "MDN Web Docs",
                    url: "https://developer.mozilla.org/en-US/",
                    icon: "BookOpen",
                    open: "tab",
                    menu: [],
                    contextMenu: [{ label: "Copy URL", action: "copy-url" }],
                  },
                  {
                    id: "docs-javascript-guide",
                    label: "JavaScript Guide",
                    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide",
                    icon: "BookOpen",
                    open: "tab",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    right: [
      {
        id: "companion",
        title: "Activity",
        icon: "Activity",
        sections: [
          { id: "activity", source: "work:activity" },
          { id: "changes", source: "work:git", hideEmpty: true },
        ],
      },
      {
        id: "focused-chat",
        title: "Focused chat",
        icon: "MessagesSquare",
        when: { surface: ["chat"], session: true },
        sections: [
          {
            id: "subsessions",
            source: "work:subsessions",
            title: "Subsessions",
            when: { surface: ["chat"], session: true },
            hideEmpty: true,
            itemDefaults: {
              actions: [
                {
                  label: "Open beside chat",
                  action: "open-side",
                  icon: "Columns2",
                },
              ],
              menu: [{ label: "Open in new tab", action: "open-tab" }],
              contextMenu: [
                { label: "Open floating", action: "open-floating" },
                { label: "Archive", action: "archive", danger: true },
              ],
            },
          },
          { id: "working-now", source: "work:activity", title: "Working now" },
        ],
      },
    ],
  },
};
