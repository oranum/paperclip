import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue identifier filter route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /api/companies/:companyId/issues?identifier=...", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identifier-filter-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("returns only the issue matching the requested identifier", async () => {
    const companyId = randomUUID();
    const matchingIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Identifier filter tenant",
      issuePrefix: "IDF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: matchingIssueId,
        companyId,
        issueNumber: 2,
        identifier: "IDF-2",
        title: "The one we want",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
      {
        id: otherIssueId,
        companyId,
        issueNumber: 1,
        identifier: "IDF-1",
        title: "Should be filtered out",
        status: "todo",
        priority: "medium",
        createdByUserId: "cloud-user-1",
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "IDF-2" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const returnedIdentifiers = (res.body as Array<{ identifier: string | null }>).map(
      (issue) => issue.identifier,
    );

    // The identifier filter must be honored: only IDF-2 should come back,
    // and IDF-1 must be excluded. The bug currently returns every issue.
    expect(returnedIdentifiers).toEqual(["IDF-2"]);
    expect(returnedIdentifiers).not.toContain("IDF-1");
  });
});
