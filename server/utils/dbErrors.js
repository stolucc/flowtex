// Helpers for shaping Postgres error codes into the application's
// HTTP status convention. Centralised so callers don't sprinkle
// SQLSTATE numbers across the codebase.

/** Postgres SQLSTATE 23505 = unique-constraint violation. Used by
 *  upsert-shaped flows (createFile, renameFile, changeEmail) to catch
 *  the TOCTOU race between an existence pre-check and the INSERT/UPDATE
 *  and rethrow as 409 instead of bubbling a generic 500. */
export function isUniqueViolation(err) {
  return err?.code === '23505';
}
