import { useEffect, useMemo, useState } from "react";

type RuntimeId = "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi";

interface Metadata {
  team: unknown;
  roles: Array<{ id: string; identity: { title: string; summary: string } }>;
  skills: Array<{ id: string; name: string; description: string }>;
  cwd: string;
  kimiConfigured: boolean;
}

interface RunResult {
  result: {
    finalOutput: string;
    plan: { summary: string; assignments: Array<{ roleId: string; task: string; contractorSpecialty?: string }> };
    outputs: Array<{ instance: { displayName: string; roleId: string; id: string }; output: string }>;
  };
  events: Array<{ type: string; [key: string]: unknown }>;
}

type TeamEvent = { type: string; [key: string]: unknown };

const defaultTask = "请写一个 1200 字左右的短篇小说：主题是雨夜里的旧书店，风格偏悬疑但结尾要温暖。";

export function App() {
  const [metadata, setMetadata] = useState<Metadata>();
  const [runtimeId, setRuntimeId] = useState<RuntimeId>("codex-cli");
  const [cwd, setCwd] = useState("");
  const [task, setTask] = useState(defaultTask);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RunResult>();
  const [liveEvents, setLiveEvents] = useState<TeamEvent[]>([]);

  useEffect(() => {
    if (!window.hanais) {
      setError("Electron preload 未注入 window.hanais，请检查 preload 构建和 BrowserWindow 配置。");
      return;
    }

    window.hanais
      .metadata()
      .then((data) => {
        setMetadata(data);
        setCwd(data.cwd);
      })
      .catch((metadataError) => {
        setError(metadataError instanceof Error ? metadataError.message : String(metadataError));
      });
  }, []);

  useEffect(() => {
    if (!window.hanais?.onTeamEvent) {
      return;
    }
    return window.hanais.onTeamEvent((event) => {
      setLiveEvents((current) => [...current, event].slice(-160));
    });
  }, []);

  const assignments = useMemo(() => {
    const latestPlan = [...liveEvents].reverse().find((event) => event.type === "plan_created");
    if (latestPlan && Array.isArray(latestPlan.assignments)) {
      return latestPlan.assignments as Array<{ roleId: string; task: string; contractorSpecialty?: string }>;
    }
    return result?.result.plan.assignments ?? [];
  }, [liveEvents, result]);
  const events = useMemo(() => (liveEvents.length ? liveEvents : result?.events ?? []).slice(-120), [liveEvents, result]);
  const memberOutputs = result?.result.outputs ?? extractCompletedOutputs(liveEvents);

  async function run() {
    if (!window.hanais) {
      setError("Electron preload 未注入 window.hanais，无法运行 team。");
      return;
    }

    setIsRunning(true);
    setError("");
    setResult(undefined);
    setLiveEvents([]);
    try {
      const response = await window.hanais.runTeam({ task, runtimeId, cwd });
      setResult(response);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setIsRunning(false);
    }
  }

  async function selectWorkspace() {
    if (!window.hanais) {
      setError("Electron preload 未注入 window.hanais，无法选择目录。");
      return;
    }
    const selected = await window.hanais.selectWorkspace();
    if (selected) {
      setCwd(selected);
    }
  }

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <h1>Agent Team 验证台</h1>
          <p>内置 team_lead 调度用户传入的小说作者和小说编辑。</p>
        </div>
        <button className="runButton" disabled={isRunning || task.trim().length === 0} onClick={run}>
          {isRunning ? "运行中" : "运行"}
        </button>
      </section>

      <section className="workspace">
        <div className="leftPane">
          <div className="panel">
            <div className="panelHeader">
              <h2>任务</h2>
              <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value as RuntimeId)}>
                <option value="codex-cli">Codex CLI</option>
                <option value="claude-agent-sdk">Claude Agent SDK</option>
                <option value="claude-agent-sdk-kimi">Claude SDK + Kimi</option>
              </select>
            </div>
            <label className="field">
              <span>工作目录</span>
              <div className="pathPicker">
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
                <button type="button" onClick={selectWorkspace}>
                  选择
                </button>
              </div>
            </label>
            {runtimeId === "claude-agent-sdk-kimi" && !metadata?.kimiConfigured ? (
              <div className="hintBox">未检测到 KIMI_API_KEY。请在项目根目录 `.env.local` 中配置后重启 GUI。</div>
            ) : null}
            <label className="field">
              <span>用户任务</span>
              <textarea value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>Teammates</h2>
            </div>
            <div className="roleList">
              {metadata?.roles.map((role) => (
                <div className="roleRow" key={role.id}>
                  <strong>{role.identity.title}</strong>
                  <span>{role.identity.summary}</span>
                  <code>{role.id}</code>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>Skills</h2>
            </div>
            <div className="skillList">
              {metadata?.skills.map((skill) => (
                <div className="skillRow" key={skill.id}>
                  <span>{skill.name}</span>
                  <small>{skill.description}</small>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rightPane">
          {error ? <div className="errorBox">{error}</div> : null}

          <div className="panel">
            <div className="panelHeader">
              <h2>交互过程</h2>
            </div>
            {events.length > 0 ? (
              <div className="timeline">
                {events.map((event, index) => (
                  <div className="timelineItem" key={`${event.type}-${index}`}>
                    <strong>{eventTitle(event)}</strong>
                    <p>{eventSummary(event)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="emptyText">运行后实时显示 team_lead 和 teammate 的交互过程。</p>
            )}
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>Team Plan</h2>
            </div>
            {assignments.length > 0 ? (
              <div className="assignmentList">
                {assignments.map((assignment, index) => (
                  <div className="assignmentRow" key={`${assignment.roleId}-${index}`}>
                    <span>{assignment.roleId === "__contractor__" ? `外包-${assignment.contractorSpecialty}` : assignment.roleId}</span>
                    <p>{assignment.task}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="emptyText">运行后显示 team_lead 的任务分配。</p>
            )}
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>成员输出</h2>
            </div>
            {memberOutputs.length ? (
              <div className="outputList">
                {memberOutputs.map((item) => (
                  <article className="outputBlock" key={item.instance.id}>
                    <header>
                      <strong>{item.instance.displayName}</strong>
                      <code>{item.instance.roleId}</code>
                    </header>
                    <pre>{item.output}</pre>
                  </article>
                ))}
              </div>
            ) : (
              <p className="emptyText">成员完成任务后显示输出。</p>
            )}
          </div>

          <div className="panel finalPanel">
            <div className="panelHeader">
              <h2>最终结果</h2>
            </div>
            <pre>{result?.result.finalOutput || "team_lead 汇总后显示最终结果。"}</pre>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>事件</h2>
            </div>
            <div className="eventLog">
              {events.map((event, index) => (
                <code key={index}>{JSON.stringify(event)}</code>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function extractCompletedOutputs(events: TeamEvent[]) {
  return events
    .filter((event) => event.type === "role_instance_completed")
    .map((event) => ({
      instance: event.instance as { displayName: string; roleId: string; id: string },
      output: typeof event.output === "string" ? event.output : "",
    }))
    .filter((item) => item.instance);
}

function eventTitle(event: TeamEvent): string {
  switch (event.type) {
    case "session_started":
      return "team session started";
    case "lead_output":
      return "team_lead plan output";
    case "plan_created":
      return "team_lead created plan";
    case "role_instance_started":
      return `${readPath(event, ["instance", "displayName"]) || "teammate"} started`;
    case "role_instance_completed":
      return `${readPath(event, ["instance", "displayName"]) || "teammate"} completed`;
    case "agent_event":
      return `agent event: ${readPath(event, ["event", "roleId"]) || "unknown"}`;
    case "final_output":
      return "team_lead final output";
    default:
      return event.type;
  }
}

function eventSummary(event: TeamEvent): string {
  if (event.type === "agent_event") {
    return truncate(String(readPath(event, ["event", "content"]) || readPath(event, ["event", "output"]) || readPath(event, ["event", "type"]) || ""));
  }
  if (event.type === "plan_created" && Array.isArray(event.assignments)) {
    return `${event.assignments.length} assignments`;
  }
  if (typeof event.output === "string") {
    return truncate(event.output);
  }
  if (typeof event.content === "string") {
    return truncate(event.content);
  }
  if (typeof event.error === "string") {
    return event.error;
  }
  if (readPath(event, ["instance", "assignedTask"])) {
    return truncate(String(readPath(event, ["instance", "assignedTask"])));
  }
  return truncate(JSON.stringify(event));
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function truncate(value: string): string {
  return value.length > 320 ? `${value.slice(0, 320)}...` : value;
}
