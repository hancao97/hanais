import type { AgentEvent, AgentRunRequest, AgentRuntime } from "@hanais/agent-team";

export interface ClaudeAgentSdkRuntimeOptions {
  id?: string;
  cwd?: string;
  model?: string;
  baseUrl?: string;
  authToken?: string;
  maxTurns?: number;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
}

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind = "claude-agent-sdk";
  private readonly cwd: string;
  private readonly model?: string;
  private readonly baseUrl?: string;
  private readonly authToken?: string;
  private readonly maxTurns?: number;
  private readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";

  constructor(options: ClaudeAgentSdkRuntimeOptions = {}) {
    this.id = options.id ?? "claude-agent-sdk";
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.authToken = options.authToken;
    this.maxTurns = options.maxTurns;
    this.permissionMode = options.permissionMode ?? "default";
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: request.sessionId, roleId: request.role.id, timestamp: now() };

    const restoreEnv = applyClaudeEnv({
      baseUrl: this.baseUrl,
      authToken: this.authToken,
      model: this.model,
    });

    try {
      let sdk: Record<string, unknown>;
      try {
        sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
      } catch (error) {
        yield {
          type: "error",
          roleId: request.role.id,
          error: `Cannot load @anthropic-ai/claude-agent-sdk: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: now(),
        };
        return;
      }

      const query = sdk.query;
      if (typeof query !== "function") {
        yield {
          type: "error",
          roleId: request.role.id,
          error: "@anthropic-ai/claude-agent-sdk does not expose query()",
          timestamp: now(),
        };
        return;
      }

      const messages = query({
        prompt: request.task,
        options: {
          cwd: this.cwd,
          model: this.model,
          maxTurns: request.limits?.maxTurns ?? this.maxTurns,
          permissionMode: this.permissionMode,
        },
      }) as AsyncIterable<unknown>;

      let final = "";
      for await (const message of messages) {
        const content = extractMessageText(message);
        if (content) {
          final += content;
          yield { type: "message", roleId: request.role.id, content, timestamp: now() };
        }
      }

      yield { type: "final", roleId: request.role.id, output: final.trim(), timestamp: now() };
    } finally {
      restoreEnv();
    }
  }
}

function applyClaudeEnv(input: { baseUrl?: string; authToken?: string; model?: string }): () => void {
  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  if (input.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = input.baseUrl;
  }
  if (input.authToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = input.authToken;
    process.env.ANTHROPIC_API_KEY = input.authToken;
  }
  if (input.model) {
    process.env.ANTHROPIC_MODEL = input.model;
    process.env.ANTHROPIC_SMALL_FAST_MODEL = input.model;
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function extractMessageText(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (typeof record.result === "string") {
    return record.result;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const contentItem = item as Record<string, unknown>;
        return typeof contentItem.text === "string" ? contentItem.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function now(): string {
  return new Date().toISOString();
}
