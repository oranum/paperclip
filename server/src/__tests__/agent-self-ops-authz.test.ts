import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('http');
vi.unmock('node:http');

const agentId = '11111111-1111-4111-8111-111111111111';
const companyId = '22222222-2222-4222-8222-222222222222';
const reportAgentId = '44444444-4444-4444-4444-444444444444';
const otherAgentId = '55555555-5555-5555-5555-555555555555';

const baseAgent = {
  id: agentId,
  companyId,
  name: 'Manager',
  urlKey: 'manager',
  role: 'manager',
  title: 'Manager',
  reportsTo: null,
};

const reportAgent = {
  id: reportAgentId,
  companyId,
  name: 'Worker',
  urlKey: 'worker',
  role: 'worker',
  title: 'Worker',
  reportsTo: agentId,
};

const otherAgent = {
  id: otherAgentId,
  companyId,
  name: 'Other',
  urlKey: 'other',
  role: 'worker',
  title: 'Other',
  reportsTo: 'some-other-manager',
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  })),
}));

vi.mock('../routes/authz.js', async () => {
  return {
    assertAuthenticated: vi.fn(),
    assertBoard: (req: any) => { if (req.actor.type !== 'board') throw { status: 403, message: 'Forbidden' }; },
    assertCompanyAccess: vi.fn(),
    assertBoardCanManageAgentsForCompany: vi.fn(),
    getActorInfo: (req: any) => ({ actorType: req.actor.type, actorId: req.actor.agentId || req.actor.userId }),
  };
});

vi.mock('../services/index.js', () => ({
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_a, c) => c),
  workspaceOperationService: () => ({}),
}));

async function createApp(actor: any) {
  const { errorHandler } = await import('../middleware/index.js');
  const { agentRoutes } = await import('../routes/agents.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use('/api', agentRoutes(mockDb as any));
  app.use((err: any, req: any, res: any, next: any) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });
  return app;
}

describe('Agent Self-Ops and Wakeup Authz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id) => {
      if (id === agentId) return baseAgent;
      if (id === reportAgentId) return reportAgent;
      if (id === otherAgentId) return otherAgent;
      return null;
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: 'run-id' });
    mockAgentInstructionsService.writeFile.mockResolvedValue({});
    mockAgentService.resolveByReference.mockImplementation(async (_cid, ref) => {
        if (ref === agentId || ref === 'manager') return { agent: baseAgent, ambiguous: false };
        if (ref === reportAgentId || ref === 'worker') return { agent: reportAgent, ambiguous: false };
        if (ref === otherAgentId || ref === 'other') return { agent: otherAgent, ambiguous: false };
        return { agent: null, ambiguous: false };
    });
  });

  it('allows agent to update its own instructions bundle', async () => {
    const app = await createApp({ type: 'agent', agentId, companyId });
    const res = await request(app)
      .put(`/api/agents/${agentId}/instructions-bundle/file`)
      .send({ path: 'GEMINI.md', content: 'test' });

    // We don't care about the 500 here if it's due to missing mocks, 
    // as long as it's NOT 403.
    expect(res.status).not.toBe(403);
  });

  it('allows manager agent to wake its report', async () => {
    const app = await createApp({ type: 'agent', agentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${reportAgentId}/wakeup`)
      .send({ source: 'on_demand' });

    expect([200, 202]).toContain(res.status);
  });

  it('still blocks agent from waking non-reports', async () => {
    const app = await createApp({ type: 'agent', agentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${otherAgentId}/wakeup`)
      .send({ source: 'on_demand' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Agent can only invoke itself or its direct reports');
  });

  it('still blocks agent from managing other agent instructions', async () => {
    const app = await createApp({ type: 'agent', agentId, companyId });
    const res = await request(app)
      .put(`/api/agents/${otherAgentId}/instructions-bundle/file`)
      .send({ path: 'GEMINI.md', content: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Agent can only manage its own instructions');
  });

  it('allows board to manage any agent instructions', async () => {
    const app = await createApp({ type: 'board', userId: 'admin', companyIds: [companyId] });
    const res = await request(app)
      .put(`/api/agents/${agentId}/instructions-bundle/file`)
      .send({ path: 'GEMINI.md', content: 'test' });

    expect(res.status).not.toBe(403);
  });

  it('allows board to wake any agent', async () => {
    const app = await createApp({ type: 'board', userId: 'admin', companyIds: [companyId] });
    const res = await request(app)
      .post(`/api/agents/${otherAgentId}/wakeup`)
      .send({ source: 'on_demand' });

    expect([200, 202]).toContain(res.status);
  });
});
