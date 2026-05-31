// Single source of truth for "is the flowtex-helper paired and healthy".
//
// Why a context: prior to this, three callers each ran their own probe
// loop — App.jsx (for the compile resolver), AccountSettingsModal (for the
// Account Settings status row), and the would-be ProjectSettingsModal
// status row. They could disagree (different setInterval cadences,
// different React render trees), which produced the "paired in Account
// Settings, banner still says Helper not detected" bug we kept chasing.
//
// The context resolves it: ONE useHelperStatus call at the App root,
// every consumer reads the same value via useHelperStatusContext().
// No duplicate intervals, no drift.

import React, { createContext, useContext } from 'react';

const HelperStatusContext = createContext({
  status: { available: false, loading: false },
  redetect: () => {},
});

/** Wrap the app once. Pass the already-resolved status / redetect that
 *  comes out of useHelperStatus — the wrapping keeps consumers DRY
 *  without forcing the provider to know about feature-flag plumbing. */
export function HelperStatusProvider({ value, children }) {
  return (
    <HelperStatusContext.Provider value={value}>
      {children}
    </HelperStatusContext.Provider>
  );
}

export function useHelperStatusContext() {
  return useContext(HelperStatusContext);
}
