import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileTeamStateStore,
  InMemoryTeamStateStore,
  TeamRunner,
  builtinSystemRoles,
  builtinSystemSkills,
} from "../dist/index.js";

const skill = { id: "core", version: "1.0.0", name: "core", description: "core" };

const writerRole = role("writer", "Writer", "Writes drafts", "write", ["write"], ["no review"]);
const editorRole = role("editor", "Editor", "Reviews drafts", "review", ["review"], ["no drafting"]);
const alphaRole = role("alpha", "Alpha", "Alpha participant", "alpha", ["do alpha"], ["none"]);
const betaRole = role("beta", "Beta", "Beta participant", "beta", ["do beta"], ["none"]);

const reviewTeam = {
  id: "smoke_review_team",
  version: 1,
  name: "Smoke Review Team",
  lead: { type: "builtin", id: "team_lead", runtime: "fake" },
  teammates: [
    { role: "writer", required: true },
    { role: "editor", required: true },
  ],
  policies: {
    enableTeamReAct: true,
    requireFinalReview: true,
    reviewerRoleIds: ["editor"],
    requireStrictReviewJson: true,
    reviewRepairAttempts: 1,
    maxReviewRounds: 3,
    allowHumanInput: true,
    enablePeerToPeerAct: true,
    maxPeerTurnsPerAct: 2,
    maxPeerMessagesPerPairPerTurn: 2,
    allowParallelAssignments: false,
  },
};

const peerTeam = {
  id: "smoke_peer_team",
  version: 1,
  name: "Smoke Peer Team",
  lead: { type: "builtin", id: "team_lead", runtime: "fake" },
  teammates: [
    { role: "alpha", required: true },
    { role: "beta", required: true },
  ],
  policies: {
    enablePeerToPeerAct: true,
    maxPeerTurnsPerAct: 2,
    maxPeerMessagesPerPairPerTurn: 2,
    allowParallelAssignments: false,
    requireFinalReview: false,
  },
};

async function testSystemRoleAssets() {
  const teamLead = builtinSystemRoles.find((item) => item.id === "team_lead");
  const contractor = builtinSystemRoles.find((item) => item.id === "__contractor__");
  assert.ok(teamLead, "team_lead system role should load from role assets");
  assert.ok(contractor, "__contractor__ system role should load from role assets");
  assert.deepEqual(
    teamLead.skills.map((item) => item.id).sort(),
    ["team-planning", "team-synthesis"],
  );
  assert.ok(builtinSystemSkills.some((item) => item.id === "contractor-execution"));
}

async function testReviewRepair() {
  const events = [];
  const result = await new TeamRunner().run({
    team: reviewTeam,
    roles: [writerRole, editorRole],
    skills: [skill],
    runtimeRegistry: { fake: new ReviewRuntime("repair") },
    task: "write",
    stateStore: new InMemoryTeamStateStore(),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.session.status, "completed");
  assert.deepEqual(Object.values(result.session.workItems).map((item) => item.roleId), ["writer", "writer"]);
  assert.deepEqual(result.session.reviews.map((item) => item.result?.outcome), ["changes_requested", "approved"]);
  assert.ok(events.some((event) => event.type === "runtime_session_started"));
  assert.ok(events.some((event) => event.type === "runtime_session_completed"));
}

async function testBlockedHumanInputAndPersistence() {
  const rootDir = "/tmp/hanais-agent-team-smoke";
  const store = new FileTeamStateStore({ rootDir });
  const events = [];
  const result = await new TeamRunner().run({
    team: reviewTeam,
    roles: [writerRole, editorRole],
    skills: [skill],
    runtimeRegistry: { fake: new ReviewRuntime("blocked") },
    task: "write",
    stateStore: store,
    requestHumanInput: async () => "继续修改，按审核意见消除歧义",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.session.status, "completed");
  assert.deepEqual(result.session.reviews.map((item) => item.result?.outcome), ["blocked", "approved"]);
  assert.deepEqual(result.session.humanInputs.map((item) => item.status), ["answered"]);
  assert.ok(events.some((event) => event.type === "human_input_requested"));
  assert.ok(events.some((event) => event.type === "human_input_answered"));

  const persistedRun = JSON.parse(await readFile(join(rootDir, "runs", result.session.id, "run.json"), "utf8"));
  const persistedEvents = (await readFile(join(rootDir, "runs", result.session.id, "events.jsonl"), "utf8")).trim().split(/\n/);
  assert.equal(persistedRun.status, "completed");
  assert.deepEqual(persistedRun.humanInputs.map((item) => item.status), ["answered"]);
  assert.ok(persistedEvents.length > 0);

  const resumed = await new TeamRunner().resume({
    sessionId: result.session.id,
    team: reviewTeam,
    roles: [writerRole, editorRole],
    skills: [skill],
    runtimeRegistry: { fake: new ReviewRuntime("blocked") },
    stateStore: store,
  });
  assert.equal(resumed.session.id, result.session.id);
  assert.equal(resumed.session.status, "completed");
}

async function testPeerToPeerLoop() {
  const events = [];
  const result = await new TeamRunner().run({
    team: peerTeam,
    roles: [alphaRole, betaRole],
    skills: [skill],
    runtimeRegistry: { fake: new PeerRuntime() },
    task: "coordinate",
    stateStore: new InMemoryTeamStateStore(),
    onEvent: (event) => events.push(event),
  });

  const peerMessages = result.session.messages.filter((message) => message.id.includes("_peer_"));
  assert.equal(result.session.status, "completed");
  assert.deepEqual(
    peerMessages.map((message) => `${message.from}->${message.to}:${message.type}`),
    ["alpha->beta:question", "beta->alpha:question"],
  );
  assert.ok(events.some((event) => event.type === "peer_turn_started"));
  assert.ok(events.some((event) => event.type === "peer_turn_completed"));
}

async function testPeerTurnLimit() {
  const result = await new TeamRunner().run({
    team: peerTeam,
    roles: [alphaRole, betaRole],
    skills: [skill],
    runtimeRegistry: { fake: new PeerSpamRuntime() },
    task: "coordinate",
    stateStore: new InMemoryTeamStateStore(),
  });
  const peerMessages = result.session.messages.filter((message) => message.id.includes("_peer_"));
  assert.equal(peerMessages.length, 8, "each pair should accept configured messages per peer turn");
  assert.deepEqual(
    peerMessages.map((message) => message.content),
    ["alpha spam 1", "alpha spam 2", "beta spam 1", "beta spam 2", "alpha spam 1", "alpha spam 2", "beta spam 1", "beta spam 2"],
  );
}

async function testRuntimeFailureClassification() {
  const events = [];
  await assert.rejects(
    () =>
      new TeamRunner().run({
        team: {
          ...peerTeam,
          teammates: [{ role: "alpha", required: true }],
          policies: { requireFinalReview: false, enablePeerToPeerAct: false },
        },
        roles: [alphaRole],
        skills: [skill],
        runtimeRegistry: { fake: new FailureRuntime() },
        task: "fail",
        stateStore: new InMemoryTeamStateStore(),
        onEvent: (event) => events.push(event),
      }),
    /timeout/i,
  );
  const failure = events.find((event) => event.type === "runtime_session_failed");
  assert.equal(failure?.failure.category, "timeout");
  assert.equal(failure?.failure.retryable, true);
}

function role(id, title, summary, mission, responsibilities, boundaries) {
  return {
    id,
    version: 1,
    identity: { name: title, title, summary, mission, responsibilities, boundaries },
    skills: [{ id: "core" }],
    runtime: { preferred: "fake" },
  };
}

class ReviewRuntime {
  id = "fake";
  kind = "fake";
  writerRuns = 0;

  constructor(mode) {
    this.mode = mode;
  }

  async *run(request) {
    const roleId = request.role.id;
    if (roleId === "team_lead" && request.sessionId.endsWith("_lead_plan")) {
      yield final(roleId, {
        summary: "draft then review",
        assignments: [
          { roleId: "writer", task: "write initial draft" },
          { roleId: "editor", task: "preplanned review must be ignored" },
          { roleId: "writer", task: "preplanned revision must be ignored initially" },
        ],
      });
      return;
    }
    if (roleId === "team_lead") {
      yield finalText(roleId, "FINAL");
      return;
    }
    if (roleId === "writer") {
      this.writerRuns += 1;
      yield finalText(roleId, this.writerRuns === 1 ? "draft v1" : "draft v2 fixed");
      return;
    }
    if (request.context.reviewGateRepair) {
      yield final(roleId, {
        outcome: "changes_requested",
        summary: "repair says fix draft",
        findings: [{ severity: "major", message: "needs fix" }],
        requiredChanges: ["fix draft"],
      });
      return;
    }
    const round = request.context.reviewTask?.round ?? 0;
    if (this.mode === "blocked" && round === 1) {
      yield final(roleId, {
        outcome: "blocked",
        summary: "need human decision",
        findings: [{ severity: "blocking", message: "ambiguous requirement" }],
      });
      return;
    }
    if (this.mode === "repair" && round === 1) {
      yield finalText(roleId, "needs fix but this is not json");
      return;
    }
    yield final(roleId, {
      outcome: "approved",
      summary: "approved",
      findings: [{ severity: "note", message: "ok" }],
    });
  }
}

class PeerRuntime {
  id = "fake";
  kind = "fake";

  async *run(request) {
    const roleId = request.role.id;
    if (roleId === "team_lead" && request.sessionId.endsWith("_lead_plan")) {
      yield final(roleId, {
        summary: "two people",
        assignments: [
          { roleId: "alpha", task: "alpha work" },
          { roleId: "beta", task: "beta work" },
        ],
      });
      return;
    }
    if (roleId === "team_lead") {
      yield finalText(roleId, "FINAL");
      return;
    }
    if (request.context.peerToPeerAct) {
      const own = request.context.ownInstanceId;
      const to = own === "alpha" ? "beta" : "alpha";
      const firstTurn = request.sessionId.includes("_peer_1");
      yield final(roleId, {
        messages: firstTurn ? [{ to, type: "question", content: `${own}->${to}` }] : [],
      });
      return;
    }
    yield finalText(roleId, `${roleId} output`);
  }
}

class PeerSpamRuntime {
  id = "fake";
  kind = "fake";

  async *run(request) {
    const roleId = request.role.id;
    if (roleId === "team_lead" && request.sessionId.endsWith("_lead_plan")) {
      yield final(roleId, {
        summary: "two people",
        assignments: [
          { roleId: "alpha", task: "alpha work" },
          { roleId: "beta", task: "beta work" },
        ],
      });
      return;
    }
    if (roleId === "team_lead") {
      yield finalText(roleId, "FINAL");
      return;
    }
    if (request.context.peerToPeerAct) {
      const own = request.context.ownInstanceId;
      const to = own === "alpha" ? "beta" : "alpha";
      yield final(roleId, {
        messages: [
          { to, type: "question", content: `${own} spam 1` },
          { to, type: "question", content: `${own} spam 2` },
          { to, type: "question", content: `${own} spam 3` },
          { to: "review_gate", type: "question", content: "invalid system target" },
        ],
      });
      return;
    }
    yield finalText(roleId, `${roleId} output`);
  }
}

class FailureRuntime {
  id = "fake";
  kind = "fake";

  async *run(request) {
    if (request.role.id === "team_lead" && request.sessionId.endsWith("_lead_plan")) {
      yield final(request.role.id, { summary: "fail", assignments: [{ roleId: "alpha", task: "fail now" }] });
      return;
    }
    throw new Error("timeout while running fake runtime");
  }
}

function final(roleId, output) {
  return finalText(roleId, JSON.stringify(output));
}

function finalText(roleId, output) {
  return { type: "final", roleId, output, timestamp: new Date().toISOString() };
}

await testSystemRoleAssets();
await testReviewRepair();
await testBlockedHumanInputAndPersistence();
await testPeerToPeerLoop();
await testPeerTurnLimit();
await testRuntimeFailureClassification();

console.log("agent-team smoke tests passed");
