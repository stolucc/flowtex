// Backward-compat re-export. The actual implementations live in
// `shared/trackedChanges.js` so the future client-side local-compile
// path can apply the same transforms before sending source to the local
// helper binary. See LOCAL_COMPILE_DESIGN.md §9.
//
// Keeping this shim means every existing import
// (`from '../utils/tcMarks.js'`) keeps working without changes. The
// shim is the only thing in this file — do NOT add new server-only
// helpers here; put them next to their callers or in shared/ if they
// need to be reused.

export { injectTcMacros, wrapPendingChangesAsMacros, stripPendingDeletions } from '../../shared/trackedChanges.js';
