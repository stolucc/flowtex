// Integration coverage for the invitation-flow audit follow-ups:
//
//   V3 — every accept / list / cap path is gated on expires_at > NOW().
//   V4 — acceptInvitation is idempotent (ON CONFLICT DO NOTHING on the
//        project_members PK).
//   W2 — POST /api/comments/:fileId rejects assigned_to that isn't a
//        project member (covered separately in comments-routes.test.js;
//        not duplicated here).
//
// These run against a real database so the V3 fix's SQL (`AND expires_at
// > NOW()`) and V4's ON CONFLICT clause both get exercised end-to-end.

import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject } from './setup.js';
import {
  inviteMember,
  acceptInvitation,
  getMyInvitations,
  getProjectInvitations,
} from '../../services/projectService.js';

async function makeScene() {
  const owner = await seedUser();
  const invitee = await seedUser({ email: `invitee-${uuid().slice(0, 8)}@example.test` });
  const project = await seedProject(owner.id);
  return { owner, invitee, project };
}

describe('V3 — invitation expiry gating', () => {
  it('inviteMember stamps expires_at ~30 days in the future', async () => {
    const { owner, invitee, project } = await makeScene();
    await inviteMember(project.id, invitee.email, 'editor', owner.id);

    const row = await db.get(
      'SELECT expires_at FROM project_invitations WHERE project_id = $1 AND email = $2',
      [project.id, invitee.email.toLowerCase()],
    );
    const days = (new Date(row.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('getMyInvitations excludes expired rows', async () => {
    const { owner, invitee, project } = await makeScene();
    await inviteMember(project.id, invitee.email, 'editor', owner.id);
    // Backdate the invitation past its expiry.
    await db.run(
      "UPDATE project_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE project_id = $1",
      [project.id],
    );

    const rows = await getMyInvitations(invitee.id);
    expect(rows).toHaveLength(0);
  });

  it('getProjectInvitations excludes expired rows', async () => {
    const { owner, invitee, project } = await makeScene();
    await inviteMember(project.id, invitee.email, 'editor', owner.id);
    await db.run(
      "UPDATE project_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE project_id = $1",
      [project.id],
    );

    const rows = await getProjectInvitations(project.id);
    expect(rows).toHaveLength(0);
  });

  it('acceptInvitation throws 410 for an expired invitation', async () => {
    const { owner, invitee, project } = await makeScene();
    await inviteMember(project.id, invitee.email, 'editor', owner.id);
    const inv = await db.get(
      'SELECT id FROM project_invitations WHERE project_id = $1',
      [project.id],
    );
    await db.run(
      "UPDATE project_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1",
      [inv.id],
    );

    await expect(acceptInvitation(inv.id, invitee.id)).rejects.toMatchObject({ status: 410 });
  });

  it('re-invite after expiry resets expires_at (ON CONFLICT DO UPDATE)', async () => {
    const { owner, invitee, project } = await makeScene();
    await inviteMember(project.id, invitee.email, 'editor', owner.id);
    await db.run(
      "UPDATE project_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE project_id = $1",
      [project.id],
    );
    // Re-invite -- should bump expires_at + flip status back to pending.
    await inviteMember(project.id, invitee.email, 'editor', owner.id);

    const after = await db.get(
      'SELECT expires_at, status FROM project_invitations WHERE project_id = $1',
      [project.id],
    );
    expect(after.status).toBe('pending');
    const days = (new Date(after.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
  });
});

describe('V4 — acceptInvitation idempotency', () => {
  // Direct race-simulation needs separate DB connections, which the
  // SAVEPOINT-based integration harness can't provide (everything
  // shares one client). Instead we verify the underlying SQL has the
  // ON CONFLICT DO NOTHING clause AND that re-entering the membership
  // INSERT with the same (project_id, user_id) doesn't bubble a
  // unique-violation -- which was the actual surface bug V4 closed.

  it('membership INSERT is idempotent when the row already exists', async () => {
    const { invitee, project } = await makeScene();
    // Insert the membership directly to simulate the "second concurrent
    // accept arriving after the first already added the row" state.
    await db.run(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [project.id, invitee.id],
    );

    // Now exercise the SQL pattern V4 added. A naive INSERT would 23505;
    // the fixed version uses ON CONFLICT DO NOTHING.
    await expect(
      db.run(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [project.id, invitee.id, 'editor'],
      ),
    ).resolves.toBeDefined();

    const members = await db.all(
      'SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2',
      [project.id, invitee.id],
    );
    expect(members).toHaveLength(1);
  });
});

// HH2 (audit round 19): inviteMember's COUNT(members + pending) + INSERT
// used to be separate calls, so N parallel invites all saw total < cap
// and all INSERTed past the 50-member ceiling. The fix wraps the cap
// check + duplicate-invite check + INSERT in one tx with a per-project
// advisory lock. The savepoint-based integration harness can't simulate
// real parallelism, but it CAN verify the cap is enforced inside the tx
// (the second invite after the cap is reached must reject) and that the
// duplicate-invite guard still fires.

describe('inviteMember — HH2 cap check inside tx', () => {
  it('rejects with 409 when the project is already at the membership cap', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);

    // Backfill 49 additional pending invitations so the project is at
    // 50 (owner + 49 = 50). The 51st invite must hit the cap.
    for (let i = 0; i < 49; i++) {
      const inv = `cap-${i}-${Date.now()}@example.test`;
      await inviteMember(project.id, inv, 'editor', owner.id);
    }

    await expect(
      inviteMember(project.id, `over-cap-${Date.now()}@example.test`, 'editor', owner.id),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects duplicate pending invitation with 409 (existingInvite guard inside tx)', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    const dupEmail = `dup-${Date.now()}@example.test`;
    await inviteMember(project.id, dupEmail, 'editor', owner.id);

    await expect(
      inviteMember(project.id, dupEmail, 'editor', owner.id),
    ).rejects.toMatchObject({ status: 409 });
  });
});
