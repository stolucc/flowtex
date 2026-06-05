// Defence-in-depth regression suite for cross-user file access.
//
// Walks every service-level boundary that takes a fileId or projectId
// and asserts that a non-member user (and where role gating applies,
// a viewer) cannot read or modify another user's content. The HTTP
// layer is one membership check; these tests cover the second
// (service-layer) check so a future refactor that drops the HTTP
// guard cannot silently leak.
//
// Setup: alice owns a project containing a text file and a binary
// blob; bob is a separate user with no relationship to alice's
// project; carol is a viewer of the same project (membership exists,
// editor permission does not).

import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject, seedFile } from './setup.js';
import {
  uploadBinaryFile,
  getRawFile,
  getFileWithAccess,
} from '../../services/projectService.js';
import { isProjectMember } from '../../middleware/auth.js';

async function makeScene() {
  const alice = await seedUser();
  const bob = await seedUser();
  const carol = await seedUser();
  const dave = await seedUser();
  const project = await seedProject(alice.id);
  await db.run(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`,
    [project.id, carol.id],
  );
  await db.run(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'commenter')`,
    [project.id, dave.id],
  );
  const textFile = await seedFile(project.id, 'main.tex', '\\documentclass{article}');
  const binary = await uploadBinaryFile(project.id, 'cover.png', Buffer.from('PNG bytes'));
  return { alice, bob, carol, dave, project, textFile, binary };
}

describe('getRawFile — INNER JOIN against project_members', () => {
  it('returns the row for the owner', async () => {
    const { alice, textFile } = await makeScene();
    const row = await getRawFile(textFile.id, alice.id);
    expect(row).toBeDefined();
    expect(row.path).toBe('main.tex');
  });

  it('returns the row for a viewer (read-only members can still load files)', async () => {
    const { carol, textFile } = await makeScene();
    const row = await getRawFile(textFile.id, carol.id);
    expect(row).toBeDefined();
  });

  it('returns undefined for a non-member (text file)', async () => {
    const { bob, textFile } = await makeScene();
    const row = await getRawFile(textFile.id, bob.id);
    expect(row).toBeFalsy();
  });

  it('returns undefined for a non-member (binary file)', async () => {
    const { bob, binary } = await makeScene();
    const row = await getRawFile(binary.id, bob.id);
    expect(row).toBeFalsy();
  });

  it('returns undefined for an unknown fileId', async () => {
    const { bob } = await makeScene();
    const row = await getRawFile(uuid(), bob.id);
    expect(row).toBeFalsy();
  });
});

describe('getFileWithAccess — read path', () => {
  it('allows the owner', async () => {
    const { alice, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, alice.id);
    expect(out.error).toBeUndefined();
    expect(out.file.id).toBe(textFile.id);
  });

  it('allows a viewer for read', async () => {
    const { carol, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, carol.id);
    expect(out.error).toBeUndefined();
  });

  it('denies a non-member with 403', async () => {
    const { bob, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, bob.id);
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/No access/);
  });

  it('returns 404 for an unknown fileId (does not leak existence to non-members)', async () => {
    const { bob } = await makeScene();
    const out = await getFileWithAccess(uuid(), bob.id);
    expect(out.status).toBe(404);
    expect(out.file).toBeUndefined();
  });
});

describe('getFileWithAccess — edit path', () => {
  it('allows the owner to edit', async () => {
    const { alice, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, alice.id, { edit: true });
    expect(out.error).toBeUndefined();
  });

  it('denies a viewer with 403', async () => {
    const { carol, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, carol.id, { edit: true });
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/Only editors can modify/i);
  });

  it('denies a commenter from file edits (commenters can comment, not modify files)', async () => {
    const { dave, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, dave.id, { edit: true });
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/Only editors can modify/i);
  });

  it('grants a commenter file read access', async () => {
    const { dave, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, dave.id);
    expect(out.error).toBeUndefined();
    expect(out.member.role).toBe('commenter');
  });

  // Z1 regression cover: checkEditor used to enumerate REJECTED roles
  // (viewer, commenter) with fallthrough = allow. Any future role
  // (e.g. 'reviewer') or a corrupted row would silently inherit editor
  // permissions. Now the gate enumerates ALLOWED roles; unknown is
  // denied by default. Mirrors the client's isReadOnlyForUser posture.
  it('Z1 — denies an unknown future role from file edits (fail closed)', async () => {
    const { alice, textFile } = await makeScene();
    const eve = await (await import('./setup.js')).seedUser();
    // Insert a member row with a role the codebase doesn't know about.
    await db.run(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'reviewer')`,
      [textFile.project_id, eve.id],
    );
    const out = await getFileWithAccess(textFile.id, eve.id, { edit: true });
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/only editors/i);

    // Negative control: the owner still passes the same gate.
    const ownerOut = await getFileWithAccess(textFile.id, alice.id, { edit: true });
    expect(ownerOut.error).toBeUndefined();
  });

  it('denies a non-member with 403', async () => {
    const { bob, textFile } = await makeScene();
    const out = await getFileWithAccess(textFile.id, bob.id, { edit: true });
    expect(out.status).toBe(403);
  });
});

describe('isProjectMember — used by every per-message WS check', () => {
  it('returns the row for the owner', async () => {
    const { alice, project } = await makeScene();
    const m = await isProjectMember(project.id, alice.id);
    expect(m?.role).toBe('owner');
  });

  it('returns the row for a viewer', async () => {
    const { carol, project } = await makeScene();
    const m = await isProjectMember(project.id, carol.id);
    expect(m?.role).toBe('viewer');
  });

  it('returns null for a non-member', async () => {
    const { bob, project } = await makeScene();
    const m = await isProjectMember(project.id, bob.id);
    expect(m).toBeNull();
  });

  it('returns null for a malformed project id (defence-in-depth on the regex gate)', async () => {
    expect(await isProjectMember('../etc/passwd', 'whoever')).toBeNull();
    expect(await isProjectMember('', 'whoever')).toBeNull();
  });
});

describe('binary blob /raw read invariant', () => {
  it('binary uploaded by alice cannot be loaded via getRawFile by bob', async () => {
    // Belt-and-braces: the binary upload landed in alice’s project blob
    // store; the dual-mode read path goes through getRawFile (membership
    // INNER JOIN), so bob never sees a row to read the sha256 off.
    const { bob, binary } = await makeScene();
    const row = await getRawFile(binary.id, bob.id);
    expect(row).toBeFalsy();
  });
});
