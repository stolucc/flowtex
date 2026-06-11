// @ts-check
import React, { createContext, useContext } from 'react';

/**
 * @typedef {{
 *   project: any,
 *   setProject: (p: any) => void,
 *   files: any[],
 *   setFiles: (f: any) => void,
 *   activeFile: any,
 *   setActiveFile: (f: any) => void,
 *   members: any[],
 *   setMembers: (m: any) => void,
 *   switchFile: (...args: any[]) => any,
 * }} ProjectContextValue
 */

/** @type {React.Context<ProjectContextValue | null>} */
const ProjectContext = createContext(/** @type {ProjectContextValue | null} */ (null));

/**
 * Provides project-tier state (project, files, activeFile, members and their setters,
 * plus switchFile) to the component tree. The state itself still lives in `useProject`;
 * this context only exposes the hook outputs to consumers without prop drilling.
 * @param {{ value: ProjectContextValue, children: React.ReactNode }} props
 */
export function ProjectProvider({ value, children }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * Consumes the ProjectContext; must be used within a ProjectProvider.
 */
export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within a ProjectProvider');
  return ctx;
}
