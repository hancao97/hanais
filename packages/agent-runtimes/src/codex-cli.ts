import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunRequest, AgentRuntime } from "@hanais/agent-team";

export interface CodexCliRuntimeOptions {
  id?: string;
  command?: string;
  cwd?: string;
  model?: string;
  profile?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export class CodexCliRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind = "codex-cli";
  private readonly command: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly profile?: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];

  constructor(options: CodexCliRuntimeOptions = {}) {
    this.id = options.id ?? "codex-cli";
    this.command = options.command ?? "codex";
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model;
    this.profile = options.profile;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const startedAt = now();
    yield { type: "started", runId: request.sessionId, roleId: request.role.id, timestamp: startedAt };

    const tempDir = await mkdtemp(join(tmpdir(), "hanais-codex-"));
    const outputFile = join(tempDir, "last-message.txt");
    const timeoutMs = request.limits?.timeoutMs ?? this.timeoutMs;
    const args = this.buildArgs(outputFile);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    const prompt = [
      request.task,
      "",
      "运行约束：",
      "- 这是 agent-team runtime 调用。",
      "- 请完成本次角色任务后直接给出最终结果。",
      "- 如果你无法执行，请说明原因，不要无限等待。",
    ].join("\n");

    child.stdin.write(prompt);
    child.stdin.end();

    let stderr = "";
    let stdoutBuffer = "";
    let timedOut = false;
    const closePromise = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    try {
      for await (const chunk of child.stdout) {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const content = parseCodexLine(line);
          if (content) {
            yield { type: "message", roleId: request.role.id, content, timestamp: now() };
          }
        }
      }

      const exitCode = await closePromise;

      clearTimeout(timer);

      if (timedOut) {
        yield {
          type: "error",
          roleId: request.role.id,
          error: `Codex CLI timed out after ${timeoutMs}ms`,
          timestamp: now(),
        };
        return;
      }

      if (exitCode !== 0) {
        yield {
          type: "error",
          roleId: request.role.id,
          error: stderr.trim() || `Codex CLI exited with code ${exitCode}`,
          timestamp: now(),
        };
        return;
      }

      const finalOutput = await readFile(outputFile, "utf8").catch(() => "");
      yield {
        type: "final",
        roleId: request.role.id,
        output: finalOutput.trim() || parseCodexLine(stdoutBuffer) || stdoutBuffer.trim(),
        timestamp: now(),
      };
    } finally {
      clearTimeout(timer);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private buildArgs(outputFile: string): string[] {
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      this.cwd,
      "--output-last-message",
      outputFile,
    ];

    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.profile) {
      args.push("--profile", this.profile);
    }

    args.push(...this.extraArgs, "-");
    return args;
  }
}

function parseCodexLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      stringAt(parsed, ["message", "content"]) ??
      stringAt(parsed, ["msg", "content"]) ??
      stringAt(parsed, ["delta"]) ??
      stringAt(parsed, ["output"]) ??
      stringAt(parsed, ["content"])
    );
  } catch {
    return trimmed;
  }
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function now(): string {
  return new Date().toISOString();
}
