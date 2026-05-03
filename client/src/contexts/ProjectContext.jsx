import React, { createContext, useContext } from 'react';

const ProjectContext = createContext(null);

/**
 * Provides project-tier state (project, files, activeFile, members and their setters,
 * plus switchFile) to the component tree. The state itself still lives in `useProject`;
 * this context only exposes the hook outputs to consumers without prop drilling.
 */
export function ProjectProvider({ value, children }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * Consumes the ProjectContext; must be used within a ProjectProvider.
 * @returns {{
 *   project: object|null,
 *   setProject: Function,
 *   files: Array,
 *   setFiles: Function,
 *   activeFile: object|null,
 *   setActiveFile: Function,
 *   members: Array,
 *   setMembers: Function,
 *   switchFile: Function,
 * }}
 */
export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within a ProjectProvider');
  return ctx;
}
