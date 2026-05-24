import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamRunEvent, TeamSession, TeamSessionSummary, TeamStateStore } from "./types.js";

export interface FileTeamStateStoreOptions {
  rootDir: string;
}

export class FileTeamStateStore implements TeamStateStore {
  readonly rootDir: string;
  readonly runsDir: string;

  constructor(options: FileTeamStateStoreOptions) {
    this.rootDir = options.rootDir;
    this.runsDir = join(options.rootDir, "runs");
  }

  async createSession(session: TeamSession): Promise<void> {
    await this.ensureRunDirs(session.id);
    await this.writeSessionSnapshot(session);
  }

  async updateSession(session: TeamSession): Promise<void> {
    await this.ensureRunDirs(session.id);
    await this.writeSessionSnapshot(session);
  }

  async appendEvent(sessionId: string, event: TeamRunEvent): Promise<void> {
    await this.ensureRunDirs(sessionId);
    await appendFile(this.eventLogPath(sessionId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async getSession(sessionId: string): Promise<TeamSession | undefined> {
    return readJson<TeamSession>(this.runPath(sessionId, "run.json"));
  }

  async listSessions(limit = 50): Promise<TeamSessionSummary[]> {
    await mkdir(this.runsDir, { recursive: true });
    const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
    const summaries: TeamSessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const session = await this.getSession(entry.name);
      if (!session) {
        continue;
      }
      summaries.push({
        ...summarizeSession(session),
        storagePath: this.runDir(session.id),
      });
    }

    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
  }

  async listEvents(sessionId: string): Promise<TeamRunEvent[]> {
    const content = await readFile(this.eventLogPath(sessionId), "utf8").catch(() => "");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TeamRunEvent);
  }

  private async writeSessionSnapshot(session: TeamSession): Promise<void> {
    await Promise.all([
      writeJson(this.runPath(session.id, "run.json"), session),
      writeJson(this.runPath(session.id, "work-items.json"), Object.values(session.workItems)),
      writeJson(this.runPath(session.id, "act-episodes.json"), session.actEpisodes),
      writeJson(this.runPath(session.id, "messages.json"), session.messages),
      writeJson(this.runPath(session.id, "reviews.json"), session.reviews),
      writeJson(this.runPath(session.id, "human-inputs.json"), session.humanInputs),
      writeJson(this.runPath(session.id, "artifacts.json"), session.artifacts),
    ]);
  }

  private async ensureRunDirs(sessionId: string): Promise<void> {
    await Promise.all([mkdir(this.runDir(sessionId), { recursive: true }), mkdir(this.runPath(sessionId, "artifacts"), { recursive: true })]);
  }

  private runDir(sessionId: string): string {
    return join(this.runsDir, sessionId);
  }

  private runPath(sessionId: string, fileName: string): string {
    return join(this.runDir(sessionId), fileName);
  }

  private eventLogPath(sessionId: string): string {
    return this.runPath(sessionId, "events.jsonl");
  }
}

export class InMemoryTeamStateStore implements TeamStateStore {
  private readonly sessions = new Map<string, TeamSession>();
  private readonly events = new Map<string, TeamRunEvent[]>();

  async createSession(session: TeamSession): Promise<void> {
    this.sessions.set(session.id, clone(session));
    this.events.set(session.id, []);
  }

  async updateSession(session: TeamSession): Promise<void> {
    this.sessions.set(session.id, clone(session));
  }

  async appendEvent(sessionId: string, event: TeamRunEvent): Promise<void> {
    const events = this.events.get(sessionId) ?? [];
    events.push(clone(event));
    this.events.set(sessionId, events);
  }

  async getSession(sessionId: string): Promise<TeamSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : undefined;
  }

  async listSessions(limit = 50): Promise<TeamSessionSummary[]> {
    return Array.from(this.sessions.values())
      .map(summarizeSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async listEvents(sessionId: string): Promise<TeamRunEvent[]> {
    return clone(this.events.get(sessionId) ?? []);
  }
}

function summarizeSession(session: TeamSession): TeamSessionSummary {
  const workItems = Object.values(session.workItems);
  return {
    id: session.id,
    teamId: session.teamId,
    task: session.task,
    status: session.status,
    currentPhase: session.currentPhase,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workItemCount: workItems.length,
    completedWorkItemCount: workItems.filter((item) => item.status === "completed").length,
    actEpisodeCount: session.actEpisodes.length,
    reviewCount: session.reviews.length,
    humanInputCount: session.humanInputs.length,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
