// Feature flags. Each function evaluates the env at call time (not at
// module-load) so test suites can mutate process.env between cases
// without needing to reset module state.
//
// Conventions:
//   - All flags default OFF in production. Opt-in only.
//   - Flag values are strings; '1', 'true', 'yes', 'on' (case-insensitive)
//     all read as enabled. Anything else (including empty / undefined)
//     reads as disabled.
//
// Adding a new flag: add a new function below, document the operator
// surface (env var name) in SECURITY.md, and gate every code path that
// changes behaviour through the function. Do not read process.env
// directly from route handlers — it makes the call sites harder to
// audit and tests harder to write.

function envTruthy(value) {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * FEATURE_LOCAL_COMPILE — when on, the API accepts the new
 * `compile_location` field on PATCH /api/me and PATCH /api/projects/:id,
 * and the client may show the corresponding settings UI. When off, the
 * field is silently ignored on those routes and reads always report
 * 'server' / NULL so legacy clients see no change. See
 * LOCAL_COMPILE_DESIGN.md §3.4.
 */
export function isLocalCompileEnabled() {
  return envTruthy(process.env.FEATURE_LOCAL_COMPILE);
}
