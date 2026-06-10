// Cross-boundary type contracts shared by the server and the client.
//
// These types describe shapes that travel BETWEEN the two halves of
// FlowTex — JSON shapes returned by REST routes, plus a handful of
// internal-but-shared primitives like Platform that get used in both
// the React UI and any future server-side rendering / response shaping.
//
// Why TypeScript types in a JS codebase:
//   - JS files opt in via `// @ts-check` + `@typedef {import('shared/types.ts').Foo}`.
//     The tsc pass at CI time treats the .ts file as the source of truth
//     and verifies every JSDoc-typed usage agrees.
//   - The rest of the codebase stays JS. There is no .ts emit pipeline
//     and no Vite/Vitest config change. tsc is purely a checker.
//   - When a server-side route renames a field, the next CI run flags
//     every client-side consumer that reads the old name.
//
// To extend: add the new contract to this file, import it with
// `@typedef` in the producer + consumer file, and add the file to the
// `include` list in tsconfig.json so it gets checked.

// ─── Platform detection (client-only consumer, but co-located for symmetry) ──

export type OperatingSystem = 'darwin' | 'linux' | 'windows' | 'unknown';
export type Architecture = 'arm64' | 'amd64';

export interface Platform {
  os: OperatingSystem;
  /** Optional because Windows builds don't currently ship arch-specific binaries. */
  arch?: Architecture;
}

// ─── /api/auth/me response ──────────────────────────────────────────

export interface ServerFeatures {
  /** Operator opt-in for the flowtex-helper integration. When false,
   *  the client hides every local-compile affordance. */
  localCompile: boolean;
}

export type CompileLocation = 'server' | 'local';

export interface User {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  isAdmin: boolean;
  compileLocation: CompileLocation;
  serverFeatures: ServerFeatures;
}

// ─── Helper /version response (helper -> browser) ───────────────────

/** One installed TeX Live distribution detected by the helper. */
export interface TexDistribution {
  /** "2024", "2025", etc. */
  year: string;
  path: string;
}

/** What the helper reports when the paired browser calls /version. */
export interface HelperVersionResponse {
  engine: string;
  year: string;
  scheme: string;
  enginesAvailable: string[];
  biber: string;
  distributionsAvailable: TexDistribution[];
  /** Empty string when the helper predates v0.3.1 (didn't report own version). */
  helperVersion: string;
  helperBuildSHA: string;
}

// ─── /api/helper/latest-version response ────────────────────────────

export interface LatestHelperVersionResponse {
  /** e.g. "helper-v0.3.1". null when GitHub is unreachable and we have no cache. */
  tag: string | null;
  /** e.g. "0.3.1". null when GitHub is unreachable and we have no cache. */
  version: string | null;
  releaseUrl: string | null;
  /** ISO 8601 timestamp. */
  publishedAt: string | null;
}

// ─── SAML pending-link interstitial (the confirm-link flow) ─────────

export interface SamlPendingLink {
  idpId: string;
  idpDisplayName: string;
  email: string;
  /** The existing FlowTex account name that's about to be linked. */
  existingName: string;
  /** Unix ms; client compares against Date.now() to detect TTL expiry. */
  expiresAt: number;
}

// ─── SAML list-public response (login page IdP buttons) ─────────────

export interface PublicIdP {
  id: string;
  displayName: string;
  /** Relative URL on the SP — client uses verbatim as the button href. */
  loginUrl: string;
}

export interface PublicIdPListResponse {
  idps: PublicIdP[];
}

// ─── HelperStatusContext value shape ────────────────────────────────
//
// Strictly client-internal but worth typing because the bug that broke
// the popover this morning was passing the wrong shape into it.

export interface HelperStatusOk {
  available: true;
  loading: boolean;
  year?: string;
  scheme?: string;
  enginesAvailable?: string[];
  biber?: string;
  distributionsAvailable?: TexDistribution[];
  /** Empty string when the helper predates v0.3.1. */
  helperVersion?: string;
}

export interface HelperStatusError {
  available: false;
  loading: boolean;
  error?: 'unreachable' | 'unpaired';
}

export type HelperStatus = HelperStatusOk | HelperStatusError;
