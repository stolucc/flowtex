Build the client and restart the server. Steps:

1. Run `cd /Users/alan/underleaf/client && npx vite build` and verify it succeeds
2. Kill any running server process: `pkill -f 'node.*server/index.js'`
3. Wait 1 second, then start the server in background: `cd /Users/alan/underleaf && node --env-file=.env server/index.js &`
4. Verify the server starts by checking for the "FlowTex server running" log message
5. Remind the user to hard refresh (Cmd+Shift+R) in the browser
