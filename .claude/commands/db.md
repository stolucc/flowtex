Run a database operation on the FlowTex PostgreSQL database. Query or operation: $ARGUMENTS

- Database name: `flowtex`
- Run queries with: `psql -d flowtex -c "..."`
- For schema inspection: `psql -d flowtex -c "\d tablename"`
- Key tables: `users`, `projects`, `files`, `project_members`, `sessions`, `settings`, `project_tags`, `tags`, `project_invitations`, `snapshots`
- The `files` table stores file contents directly (text for source, base64 for binary)
- The `settings` table is key-value for server configuration (e.g. `compile_timeout`)
