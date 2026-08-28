---
name: kandev-canvas-authoring
version: "1"
description: Author a Kandev task canvas as a self-contained web application.
---

# Kandev canvas authoring

Use this skill before you write canvas source. The canvas is a small web
application that runs in an opaque origin. It must be self-contained, safe to
reload, and usable at desktop and mobile widths.

## Required workflow

1. Call `read_canvas_authoring_skill_kandev` with no path if you need this
   document again. Read a supporting reference only when its topic is needed.
2. Call `create_canvas_kandev` with a short title and an application summary.
   Use the returned source directory and manifest scaffold.
3. Write source and built assets below that returned directory. Keep all paths
   relative to the directory. Do not write outside it.
4. Publish with `publish_canvas_kandev` after local checks. Read the returned
   diagnostics and correct rejected validation before publishing again.

## Application contract

- Include a responsive viewport declaration.
- Bundle executable frontend dependencies. The runtime must not require Node,
  a package manager, or a network build step.
- Use relative `./_kandev/v1` paths for Kandev data, state, actions, and events.
- Treat Kandev domain data as the source of truth. Do not copy domain records
  into application state.
- Store only small application-specific shared values in canvas instance state.
  Use memory for temporary values.
- The canvas has an opaque origin. Do not use `localStorage`, `sessionStorage`,
  `IndexedDB`, or service workers.
- Avoid secrets in source, URLs, query strings, logs, and client state.
- Render loading, empty, error, and retry states. Keep destructive actions
  explicit and explain their result.
- Use accessible labels, keyboard operation, visible focus, and touch targets.

Read these references when relevant:

- `references/browser-api.md` for the browser-side Kandev API.
- `references/manifest.md` for the required manifest shape.
- `references/data-and-state.md` for domain data and instance state.
- `references/events-and-recovery.md` for events, reconnect, and retries.
- `references/security.md` for opaque-origin and source safety rules.
- `references/ui-patterns.md` for responsive and accessible UI patterns.

The `scaffold/` files are a minimal no-build starting point. Copy their
patterns into the generated source when they fit the application.
