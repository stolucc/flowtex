Add a new setting to the Project Settings modal. The setting to add: $ARGUMENTS

Follow the existing patterns in the codebase:

1. **Determine the category** — which tab does this belong in? (Project, Editor, Compiler, PDF Viewer, GitHub). Read `client/src/components/ProjectSettingsModal.jsx` to see existing sections.

2. **Add state** — add a `useState` in the main `ProjectSettingsModal` component. If it's a per-project server setting, initialize from `project.<field>`. If it's a local preference, read from `localStorage` with key prefix `flowtex-`.

3. **Add to the section component** — add the prop to the relevant section component and render it. Use the `Toggle` component for boolean settings, `<select>` for choice settings, `<input>` for text.

4. **Wire up saving** in `handleSave`:
   - Server-persisted settings: add to the `updates` object and the PATCH request
   - Local settings: save to `localStorage` and include in the `flowtex:settings-changed` event detail

5. **Pass props** — make sure the section component receives the new props in the render call.

6. **If server-persisted**: also update `server/routes/projects.js` PATCH handler to accept the new field, and `server/services/projectService.js` `updateProject` to persist it. Add the DB column if needed.

7. Build and restart using `/project:build`.
