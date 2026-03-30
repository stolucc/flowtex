Debug a UI issue in the FlowTex client. Problem: $ARGUMENTS

Approach:

1. Read the relevant component(s) in `client/src/components/` to understand the current behavior.
2. Check the CSS in `client/src/styles/app.css` for styling issues.
3. Trace the data flow — props come from `client/src/App.jsx` which manages most state.
4. Check for common issues:
   - Missing props not being passed down
   - localStorage reads running before data is available (use `useEffect` on dependencies, not `useState` initializer)
   - CSS variables not applied (check `:root` definitions in app.css)
   - Event listeners not cleaned up (return cleanup from `useEffect`)
   - Conditional rendering logic (wrong conditions showing/hiding elements)
5. Fix the issue, then build and restart using `/project:build`.
