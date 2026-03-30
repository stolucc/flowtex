Add a new API route to the server. Details: $ARGUMENTS

Follow the existing patterns:

1. Determine which route file this belongs in — read the files in `server/routes/` to find the right one (projects.js, compile.js, auth.js, github.js, bib.js, zotero.js).

2. Add the route handler following existing conventions:
   - Use `requireMembership`, `requireEditor`, or `requireOwner` guards as appropriate
   - For business logic, add a function in the relevant service file (e.g. `server/services/projectService.js`) and call it from the route
   - Use `sendError(res, err)` for error handling in catch blocks
   - Return JSON responses

3. If database changes are needed:
   - Add columns via `psql -d flowtex -c "ALTER TABLE ..."`
   - Update any relevant service functions

4. Test the endpoint with curl against `https://localhost:3001` (use `-k` to skip TLS verification).

5. Build and restart using `/project:build`.
