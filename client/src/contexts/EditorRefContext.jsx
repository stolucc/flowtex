import React, { createContext, useContext } from 'react';

const EditorRefContext = createContext(null);

/**
 * Provides the editor ref to the component tree, allowing descendants to call
 * editor methods (insertSnippet, goToLine, etc.) without explicit prop drilling.
 * `value` should be the ref object created via `useRef(null)` in App.
 */
export function EditorRefProvider({ value, children }) {
  return <EditorRefContext.Provider value={value}>{children}</EditorRefContext.Provider>;
}

/**
 * Consumes the EditorRefContext; must be used within an EditorRefProvider.
 * @returns {{ current: object|null }} the editor ref
 */
export function useEditorRef() {
  const ref = useContext(EditorRefContext);
  if (ref === null) {
    throw new Error('useEditorRef must be used within an EditorRefProvider');
  }
  return ref;
}
