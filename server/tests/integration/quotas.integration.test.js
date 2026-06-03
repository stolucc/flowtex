// Integration tests for per-user resource caps. Verify that quota
// assertions trip in real DB conditions (project_members count, blob
// SUM, files row count).
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject } from './setup.js';
import {
  QUOTAS,
  assertProjectCountUnderLimit,
  assertFileCountUnderLimit,
  assertBlobBytesUnderLimitForProject,
  getUserUsage,
} from '../../services/quotas.js';
import { uploadBinaryFile, createProject } from '../../services/projectService.js';

describe('quotas: project count per user', () => {
  it('passes when under the limit', async () => {
    const user = await seedUser();
    await seedProject(user.id);
    await expect(assertProjectCountUnderLimit(user.id)).resolves.not.toThrow();
  });

  it('throws 413 once the user owns QUOTAS.PROJECTS_PER_USER projects', async () => {
    const user = await seedUser();
    // Force the threshold by lowering the cap for this assertion alone.
    const spy = vi.spyOn(QUOTAS, 'PROJECTS_PER_USER', 'get').mockReturnValue(2);
    try {
      await seedProject(user.id);
      await seedProject(user.id);
      await expect(assertProjectCountUnderLimit(user.id))
        .rejects.toMatchObject({ status: 413, message: expect.stringMatching(/Project limit/) });
    } finally {
      spy.mockRestore();
    }
  });

  it('createProject surfaces the 413 at the service boundary', async () => {
    const user = await seedUser();
    const spy = vi.spyOn(QUOTAS, 'PROJECTS_PER_USER', 'get').mockReturnValue(1);
    try {
      await createProject(user.id, 'First');
      await expect(createProject(user.id, 'Second'))
        .rejects.toMatchObject({ status: 413 });
    } finally {
      spy.mockRestore();
    }
  });

  it('memberships in projects owned by others do not count', async () => {
    const owner = await seedUser();
    const guest = await seedUser();
    const project = await seedProject(owner.id);
    await db.run(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [project.id, guest.id],
    );
    // The guest is now a member of one project but owns none.
    await expect(assertProjectCountUnderLimit(guest.id)).resolves.not.toThrow();
  });
});

describe('quotas: files per project', () => {
  it('passes when under the limit', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    await db.transaction(async (tx) => {
      await expect(assertFileCountUnderLimit(tx, project.id)).resolves.not.toThrow();
    });
  });

  it('throws 413 once the project hits the cap', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    const spy = vi.spyOn(QUOTAS, 'FILES_PER_PROJECT', 'get').mockReturnValue(2);
    try {
      await db.run(`INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, '')`, [uuid(), project.id, 'a.tex']);
      await db.run(`INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, '')`, [uuid(), project.id, 'b.tex']);
      await db.transaction(async (tx) => {
        await expect(assertFileCountUnderLimit(tx, project.id))
          .rejects.toMatchObject({ status: 413, message: expect.stringMatching(/File limit/) });
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('quotas: blob bytes per user', () => {
  it('passes when adding under the limit', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    await expect(assertBlobBytesUnderLimitForProject(project.id, 1024)).resolves.not.toThrow();
  });

  it('throws 413 when the new upload would push over the limit', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    const spy = vi.spyOn(QUOTAS, 'BLOB_BYTES_PER_USER', 'get').mockReturnValue(1024);
    try {
      // Land a blob worth 500 bytes via the real upload path.
      await uploadBinaryFile(project.id, 'a.png', Buffer.alloc(500, 1));
      // Trying to add 600 more would put owner at 1100 > 1024.
      await expect(assertBlobBytesUnderLimitForProject(project.id, 600))
        .rejects.toMatchObject({ status: 413, message: expect.stringMatching(/Storage quota/) });
    } finally {
      spy.mockRestore();
    }
  });

  it('orphan project (no owner) is a no-op rather than throwing', async () => {
    const orphanProjectId = uuid();
    await db.run(`INSERT INTO projects (id, name) VALUES ($1, 'orphan')`, [orphanProjectId]);
    await expect(assertBlobBytesUnderLimitForProject(orphanProjectId, 999999999)).resolves.not.toThrow();
  });
});

describe('getUserUsage', () => {
  it('reports project + storage counts and the static caps', async () => {
    const owner = await seedUser();
    const project = await seedProject(owner.id);
    await uploadBinaryFile(project.id, 'cover.png', Buffer.alloc(2048, 2));
    const u = await getUserUsage(owner.id);
    expect(u.projects.used).toBe(1);
    expect(u.projects.limit).toBe(QUOTAS.PROJECTS_PER_USER);
    expect(u.storageBytes.used).toBe(2048);
    expect(u.storageBytes.limit).toBe(QUOTAS.BLOB_BYTES_PER_USER);
    expect(u.filesPerProjectLimit).toBe(QUOTAS.FILES_PER_PROJECT);
  });
});
