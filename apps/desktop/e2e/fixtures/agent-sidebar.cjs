// Catamorphic sidebars. Edit and save to update both sides live.
// Ask the assistant to add tabs, move widgets, or build an app widget.
// Each side is an ordered list of tabs: { id, title, icon, sections }.
// Tabs use bare Lucide icons. Titles are accessible labels and tooltips.
// Each section needs a stable id, unique across the layout. Preserve ids when editing.
// Built-ins: workflows, apps, files, chats, bookmarks, remote, git, prs, activity.
// Section options: title, collapsed, hideEmpty, when: { builder, permissions }.
// Tabs also accept when. Visibility never grants authority.
// Both sides may be empty. Profile/settings and the palette remain available.
//
// App widget: { id: "renewals", type: "app", app: "renewals", height: 320 }
// Apps use the normal sandboxed app runtime, storage and host theme.
// Build a responsive compact view; expand opens the same app in a workspace tab.
// Note widget: { id: "brief", type: "note", path: "docs/brief.md" }
// Notes preview an existing project document; open it to edit.
// Custom links: { id: "docs", type: "custom", title: "Docs", items: [
//   { label: "Docs", url: "https://example.com", icon: "BookOpen", open: "tab" }
// ] }
// Items nest with items: [...], collapsed: true. open: "tab" or "replace".
// Menus: [{ label, action, danger? }]. Actions: open, open-tab, open-here,
// copy-url, pin, unpin, rename, remove. menu: [] hides the menu.
// Hover preview: { title?, description?, metadata?: [{ label, value }] } or false.
module.exports = {
  left: [
    {
      id: "project",
      title: "Project",
      icon: "House",
      sections: [
        {
          id: "bookmarks",
          type: "bookmarks",
        },
        {
          id: "workflows",
          type: "workflows",
        },
        {
          id: "apps",
          type: "apps",
        },
        {
          id: "chats",
          type: "chats",
        },
        {
          id: "tabs",
          type: "tabs",
        },
        {
          id: "files",
          type: "files",
          collapsed: true,
        },
        {
          id: "remote",
          type: "remote",
          title: "Server",
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
          type: "custom",
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
        {
          id: "activity",
          type: "activity",
        },
        {
          id: "changes",
          type: "git",
          hideEmpty: true,
        },
      ],
    },
    {
      id: "reviews",
      title: "Pull requests",
      icon: "GitPullRequest",
      when: {
        builder: true,
      },
      sections: [
        {
          id: "prs",
          type: "prs",
        },
      ],
    },
    {
      id: "focused-chat",
      title: "Focused chat",
      icon: "MessagesSquare",
      when: {
        surface: ["chat"],
        session: true,
      },
      sections: [
        {
          id: "subsessions",
          type: "subsessions",
          title: "Subsessions",
          when: {
            surface: ["chat"],
            session: true,
          },
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
        {
          id: "working-now",
          type: "custom",
          title: "Working now",
          source: {
            type: "chats",
            filter: { running: true },
            sort: { field: "createdAt", direction: "desc" },
            pageSize: 25,
          },
        },
      ],
    },
  ],
};
