Add a new action to the toolbar menu bar. Details: $ARGUMENTS

Follow the existing patterns:

1. Read `client/src/components/Toolbar.jsx` to understand the menu structure (File, Edit, Insert, View, Format, Tools, Help).

2. Add the menu item to the appropriate menu. Each item has a label and an `onClick` handler. Use a prop callback (e.g. `onMyAction`) passed from App.jsx.

3. In `client/src/App.jsx`:
   - Add the handler function implementing the action
   - Pass it as a prop to `<Toolbar>`
   - If it needs a modal, add state for it and render the modal component

4. If a modal is needed, create it in `client/src/components/` following existing modal patterns:
   - Use `modal-overlay` + `modal` class structure
   - Include `modal-header` with title and close button, `modal-footer` with action buttons
   - Style in `client/src/styles/app.css` using existing CSS variables

5. Build and restart using `/project:build`.
