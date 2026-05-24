import { useEffect, useMemo, useRef, useState } from "react";

type RuntimeId = "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi";

interface Metadata {
  team: unknown;
  roles: Array<{ id: string; identity: { title: string; summary: string }; skills?: Array<{ id: string; version?: string }> }>;
  skills: Array<{ id: string; name: string; description: string }>;
  systemRoles?: Array<{ id: string; identity: { title: string; summary: string } }>;
  systemSkills?: Array<{ id: string; name: string; description: string }>;
  systemServices?: Array<{ id: string; name: string; description: string }>;
  cwd: string;
  teamsPath: string;
  kimiConfigured: boolean;
}

interface TeamRunSummary {
  id: string;
  teamId: string;
  task: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  currentPhase: string;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
  completedWorkItemCount: number;
  actEpisodeCount: number;
  reviewCount: number;
  humanInputCount: number;
  storagePath?: string;
}

interface RunResult {
  result: {
    finalOutput: string;
    plan: { summary: string; assignments: Array<{ roleId: string; task: string; contractorSpecialty?: string }> };
    outputs: Array<{ instance: { displayName: string; roleId: string; id: string }; output: string }>;
  };
  events: Array<{ type: string; [key: string]: unknown }>;
  history?: TeamRunSummary[];
}

type TeamEvent = { type: string; [key: string]: unknown };
type UserInterventionEvent = {
  type: "user_intervention";
  id: string;
  from: "user";
  to: string;
  content: string;
  timestamp: string;
};
type AppEvent = TeamEvent | UserInterventionEvent;
type GraphNodeKind = "lead" | "teammate" | "user" | "mailbox";
type GraphNodeStatus = "idle" | "running" | "completed" | "attention";

interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  status: GraphNodeStatus;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  content: string;
  kind: string;
  order: number;
  status?: "active" | "replied" | "final";
  requestContent?: string;
  responseContent?: string;
  replyTimestamp?: string;
  timestamp?: string;
}

interface ConversationItem {
  kind: string;
  source: string;
  target?: string;
  title: string;
  content: string;
  timestamp?: string;
}

interface MailboxItem {
  id: string;
  from: string;
  to: string;
  kind: string;
  content: string;
  order: number;
  status: "pending" | "active" | "done";
  timestamp?: string;
}

interface MailboxGroup {
  status: MailboxItem["status"];
  label: string;
  helper: string;
  items: MailboxItem[];
}

interface HumanInputRequestView {
  id: string;
  question: string;
  reason?: string;
  status: "pending" | "answered" | "cancelled";
  answer?: string;
  createdAt: string;
}

type DragState = {
  pointerId: number;
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type GraphViewport = {
  x: number;
  y: number;
  scale: number;
};

const graphWidth = 1320;
const graphHeight = 520;

const personNodeSize = { width: 188, height: 76 };
const mailboxNodeSize = { width: 260, height: 112 };

function emptyPositions(): Record<string, { x: number; y: number }> {
  return {};
}

function defaultViewport(): GraphViewport {
  return { x: 0, y: 0, scale: 1 };
}

const defaultTask = "请写一个 1200 字左右的短篇小说：主题是雨夜里的旧书店，风格偏悬疑但结尾要温暖。我希望小说编辑对其进行多次审核。";

export function App() {
  const [metadata, setMetadata] = useState<Metadata>();
  const [runtimeId, setRuntimeId] = useState<RuntimeId>("codex-cli");
  const [cwd, setCwd] = useState("");
  const [settingsPath, setSettingsPath] = useState("");
  const [teamsPath, setTeamsPath] = useState("");
  const [task, setTask] = useState(defaultTask);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RunResult>();
  const [liveEvents, setLiveEvents] = useState<AppEvent[]>([]);
  const [kimiConfigured, setKimiConfigured] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState("team_lead");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>(emptyPositions);
  const [dragState, setDragState] = useState<DragState>();
  const [panState, setPanState] = useState<PanState>();
  const [graphViewport, setGraphViewport] = useState<GraphViewport>(defaultViewport);
  const [interventionText, setInterventionText] = useState("");
  const [pendingHumanInput, setPendingHumanInput] = useState<HumanInputRequestView>();
  const [runHistory, setRunHistory] = useState<TeamRunSummary[]>([]);
  const graphCanvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.hanais) {
      setError("Electron preload 未注入 window.hanais，请检查 preload 构建和 BrowserWindow 配置。");
      return;
    }

    window.hanais
      .metadata()
      .then((data) => {
        setMetadata(data);
        setCwd(data.settings.workspaceDir || data.cwd);
        setRuntimeId(data.settings.runtimeId);
        setSettingsPath(data.settingsPath);
        setTeamsPath(data.teamsPath);
        setKimiConfigured(data.kimiConfigured);
        setSettingsLoaded(true);
        void refreshHistory();
      })
      .catch((metadataError) => {
        setError(metadataError instanceof Error ? metadataError.message : String(metadataError));
        setSettingsLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !window.hanais?.writeSettings || !cwd) {
      return;
    }
    const timer = window.setTimeout(() => {
      void window.hanais.writeSettings({ runtimeId, workspaceDir: cwd });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settingsLoaded, runtimeId, cwd]);

  useEffect(() => {
    if (!window.hanais?.envStatus || !cwd) {
      return;
    }
    window.hanais
      .envStatus(cwd)
      .then((status) => setKimiConfigured(status.kimiConfigured))
      .catch(() => setKimiConfigured(false));
  }, [cwd]);

  useEffect(() => {
    if (!window.hanais?.onTeamEvent) {
      return;
    }
    return window.hanais.onTeamEvent((event) => {
      if (event.type === "human_input_requested") {
        const request = readPath(event, ["request"]) as HumanInputRequestView | undefined;
        if (request?.id) {
          setPendingHumanInput(request);
        }
      }
      if (event.type === "human_input_answered") {
        setPendingHumanInput(undefined);
      }
      setLiveEvents((current) => [...current, event].slice(-160));
    });
  }, []);

  const assignments = useMemo(() => {
    const latestPlan = [...liveEvents].reverse().find((event) => event.type === "plan_created");
    const planAssignments = readPath(latestPlan, ["assignments"]);
    if (Array.isArray(planAssignments)) {
      return planAssignments as Array<{ roleId: string; task: string; contractorSpecialty?: string }>;
    }
    return result?.result.plan.assignments ?? [];
  }, [liveEvents, result]);
  const events = useMemo<AppEvent[]>(() => (liveEvents.length ? liveEvents : result?.events ?? []).slice(-160), [liveEvents, result]);
  const memberOutputs = result?.result.outputs ?? extractCompletedOutputs(liveEvents);
  const graph = useMemo(() => buildInteractionGraph(events, metadata?.roles ?? []), [events, metadata]);
  const graphPositions = useMemo(() => ({ ...graph.positions, ...nodePositions }), [graph.positions, nodePositions]);
  const mailboxItems = useMemo(() => buildMailboxItems(events), [events]);
  const mailboxGroups = useMemo(() => groupMailboxItemsByStatus(mailboxItems), [mailboxItems]);
  const mailboxStats = useMemo(() => countMailboxItems(mailboxItems), [mailboxItems]);
  const selectedEdge = selectedEdgeId ? graph.edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const selectedMailboxItem = selectedEdgeId ? mailboxItems.find((item) => item.id === selectedEdgeId) : undefined;
  const selectedMessage = selectedEdge ?? selectedMailboxItem;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes[0];
  const selectedConversation = useMemo(
    () => buildNodeConversation(selectedNode?.id ?? "team_lead", events),
    [events, selectedNode?.id],
  );
  const interventionTarget = selectedNode && selectedNode.kind !== "user" && selectedNode.kind !== "mailbox" ? selectedNode.id : "team_lead";

  useEffect(() => {
    setNodePositions((current) => {
      const next = { ...current };
      let changed = false;
      for (const node of graph.nodes) {
        if (!next[node.id] && graph.positions[node.id]) {
          next[node.id] = graph.positions[node.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [graph.nodes, graph.positions]);

  async function run() {
    if (!window.hanais) {
      setError("Electron preload 未注入 window.hanais，无法运行 team。");
      return;
    }

    setIsRunning(true);
    setError("");
    setResult(undefined);
    setLiveEvents([]);
    setSelectedNodeId("team_lead");
    setSelectedEdgeId(undefined);
    setNodePositions(emptyPositions());
    setGraphViewport(defaultViewport());
    setPendingHumanInput(undefined);
    try {
      const response = await window.hanais.runTeam({ task, runtimeId, cwd });
      setResult(response);
      if (response.history) {
        setRunHistory(response.history);
      } else {
        await refreshHistory();
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setIsRunning(false);
    }
  }

  async function refreshHistory() {
    if (!window.hanais?.listTeamRuns) {
      return;
    }
    try {
      const response = await window.hanais.listTeamRuns();
      setRunHistory(response.runs);
      setTeamsPath(response.teamsPath);
    } catch {
      setRunHistory([]);
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

  function resetGraphLayout() {
    setNodePositions(graph.positions);
    setGraphViewport(defaultViewport());
  }

  async function sendIntervention() {
    const content = interventionText.trim();
    if (!content) {
      return;
    }

    if (pendingHumanInput && window.hanais?.answerHumanInput) {
      const response = await window.hanais.answerHumanInput({ requestId: pendingHumanInput.id, answer: content });
      if (!response.accepted) {
        setError("当前人工介入请求已失效，请等待新的请求。");
        return;
      }
    }

    setLiveEvents((current) =>
      [
        ...current,
        {
          type: "user_intervention",
          id: `user_msg_${Date.now()}`,
          from: "user",
          to: interventionTarget,
          content,
          timestamp: new Date().toISOString(),
        },
      ].slice(-180),
    );
    setInterventionText("");
    setPendingHumanInput(undefined);
  }

  function screenPointFromPointer(event: React.PointerEvent | React.WheelEvent) {
    const rect = graphCanvasRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function worldPointFromPointer(event: React.PointerEvent | React.WheelEvent) {
    const point = screenPointFromPointer(event);
    return {
      x: (point.x - graphViewport.x) / graphViewport.scale,
      y: (point.y - graphViewport.y) / graphViewport.scale,
    };
  }

  function startDrag(event: React.PointerEvent, nodeId: string) {
    event.stopPropagation();
    const point = worldPointFromPointer(event);
    const position = graphPositions[nodeId] ?? graph.positions[nodeId] ?? { x: point.x, y: point.y };
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(undefined);
    setPanState(undefined);
    setDragState({
      pointerId: event.pointerId,
      nodeId,
      offsetX: point.x - position.x,
      offsetY: point.y - position.y,
    });
    graphCanvasRef.current?.setPointerCapture(event.pointerId);
  }

  function startPan(event: React.PointerEvent) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(".graphNode, .edgeLabelButton, .graphEdge")) {
      return;
    }
    const point = screenPointFromPointer(event);
    setDragState(undefined);
    setPanState({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      originX: graphViewport.x,
      originY: graphViewport.y,
    });
    graphCanvasRef.current?.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent) {
    if (dragState && dragState.pointerId === event.pointerId) {
      const point = worldPointFromPointer(event);
      const node = graph.nodes.find((item) => item.id === dragState.nodeId);
      const size = graphNodeSize(node);
      setNodePositions((current) => ({
        ...current,
        [dragState.nodeId]: {
          x: clamp(point.x - dragState.offsetX, size.width / 2 + 12, graphWidth - size.width / 2 - 12),
          y: clamp(point.y - dragState.offsetY, size.height / 2 + 12, graphHeight - size.height / 2 - 12),
        },
      }));
      return;
    }

    if (panState && panState.pointerId === event.pointerId) {
      const point = screenPointFromPointer(event);
      setGraphViewport((current) => ({
        ...current,
        x: panState.originX + point.x - panState.startX,
        y: panState.originY + point.y - panState.startY,
      }));
    }
  }

  function endDrag(event: React.PointerEvent) {
    if (dragState?.pointerId === event.pointerId || panState?.pointerId === event.pointerId) {
      graphCanvasRef.current?.releasePointerCapture(event.pointerId);
      setDragState(undefined);
      setPanState(undefined);
    }
  }

  function zoomGraph(factor: number) {
    const rect = graphCanvasRef.current?.getBoundingClientRect();
    const focus = rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: graphWidth / 2, y: graphHeight / 2 };
    setGraphViewport((current) => zoomViewport(current, factor, focus));
  }

  function zoomGraphFromWheel(event: React.WheelEvent) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.88 : 1.12;
    setGraphViewport((current) => zoomViewport(current, factor, screenPointFromPointer(event)));
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
            {runtimeId === "claude-agent-sdk-kimi" && !kimiConfigured ? (
              <div className="hintBox">未检测到 KIMI_API_KEY。请在当前工作目录 `.env.local` 中配置。</div>
            ) : null}
            {settingsPath ? <div className="settingsPath">偏好保存到：{settingsPath}</div> : null}
            {teamsPath ? <div className="settingsPath">运行历史保存到：{teamsPath}</div> : null}
            <label className="field">
              <span>用户任务</span>
              <textarea value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>历史运行</h2>
              <button className="ghostButton" type="button" onClick={refreshHistory}>
                刷新
              </button>
            </div>
            {runHistory.length ? (
              <div className="historyList">
                {runHistory.slice(0, 8).map((run) => (
                  <div className={`historyRow ${run.status}`} key={run.id}>
                    <header>
                      <strong>{run.status}</strong>
                      <small>{formatTime(run.updatedAt)}</small>
                    </header>
                    <p>{run.task}</p>
                    <footer>
                      <code>{run.id}</code>
                      <span>
                        {run.completedWorkItemCount}/{run.workItemCount} work
                      </span>
                      <span>{run.actEpisodeCount} act</span>
                    </footer>
                  </div>
                ))}
              </div>
            ) : (
              <p className="emptyText">暂无历史运行。</p>
            )}
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
                  {role.skills?.length ? (
                    <div className="roleSkills">
                      {role.skills.map((skill) => (
                        <code key={skill.id}>{skill.id}</code>
                      ))}
                    </div>
                  ) : null}
                  <code>{role.id}</code>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>System</h2>
            </div>
            <div className="roleList">
              {metadata?.systemRoles?.map((role) => (
                <div className="roleRow system" key={role.id}>
                  <strong>{role.identity.title}</strong>
                  <span>{role.identity.summary}</span>
                  <code>{role.id}</code>
                </div>
              ))}
              {metadata?.systemServices?.map((service) => (
                <div className="roleRow systemService" key={service.id}>
                  <strong>{service.name}</strong>
                  <span>{service.description}</span>
                  <code>{service.id}</code>
                </div>
              ))}
              {metadata?.systemSkills?.map((skill) => (
                <div className="roleRow systemSkill" key={skill.id}>
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                  <code>{skill.id}</code>
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
              <h2>交互图</h2>
              <div className="graphToolbar">
                <button className="iconButton" type="button" title="缩小" onClick={() => zoomGraph(0.86)}>
                  -
                </button>
                <span>{Math.round(graphViewport.scale * 100)}%</span>
                <button className="iconButton" type="button" title="放大" onClick={() => zoomGraph(1.16)}>
                  +
                </button>
                <button className="ghostButton" type="button" onClick={resetGraphLayout}>
                  重置布局
                </button>
              </div>
            </div>
            <div className="graphPanel">
              <div
                className="graphCanvas"
                ref={graphCanvasRef}
                onPointerDown={startPan}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onWheel={zoomGraphFromWheel}
              >
                <div
                  className="graphWorld"
                  style={{
                    width: `${graphWidth}px`,
                    height: `${graphHeight}px`,
                    transform: `translate(${graphViewport.x}px, ${graphViewport.y}px) scale(${graphViewport.scale})`,
                  }}
                >
                  <svg className="graphSvg" viewBox={`0 0 ${graphWidth} ${graphHeight}`} aria-hidden="true">
                    <defs>
                      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" />
                      </marker>
                    </defs>
                    {graph.edges.map((edge) => {
                      const from = graphPositions[edge.from];
                      const to = graphPositions[edge.to];
                      if (!from || !to) return null;
                      const route = graphEdgeRoute(edge, graph.edges, graph.nodes, from, to);
                      return (
                        <g
                          className={`graphEdge ${edge.status ?? ""} ${selectedMessage?.id === edge.id ? "selected" : ""}`}
                          key={edge.id}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedEdgeId(edge.id);
                          }}
                        >
                          <path className="graphEdgeHit" d={route.path} />
                          <path className="graphEdgePath" d={route.path} markerEnd="url(#arrow)" />
                        </g>
                      );
                    })}
                  </svg>
                  {graph.edges.map((edge) => {
                    const from = graphPositions[edge.from];
                    const to = graphPositions[edge.to];
                    if (!from || !to) return null;
                    const route = graphEdgeRoute(edge, graph.edges, graph.nodes, from, to);
                    return (
                      <button
                        className={`edgeLabelButton ${edge.status ?? ""} ${selectedMessage?.id === edge.id ? "selected" : ""}`}
                        key={`label-${edge.id}`}
                        style={{ left: `${route.label.x}px`, top: `${route.label.y}px` }}
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedEdgeId(edge.id);
                        }}
                      >
                        <span>{`#${String(edge.order).padStart(2, "0")}`}</span>
                        <strong>{edge.label}</strong>
                        {edge.status === "replied" ? <em>已回复</em> : null}
                        {edge.timestamp ? <small>{formatShortTime(edge.replyTimestamp || edge.timestamp)}</small> : null}
                      </button>
                    );
                  })}
                  {graph.nodes.map((node) => {
                    const position = graphPositions[node.id] ?? graph.positions[node.id] ?? { x: graphWidth / 2, y: graphHeight / 2 };
                    const size = graphNodeSize(node);
                    return (
                      <button
                        className={`graphNode ${node.kind} ${node.status} ${selectedNode?.id === node.id ? "selected" : ""}`}
                        key={node.id}
                        style={{
                          left: `${position.x - size.width / 2}px`,
                          top: `${position.y - size.height / 2}px`,
                          width: `${size.width}px`,
                          minHeight: `${size.height}px`,
                        }}
                        type="button"
                        onPointerDown={(event) => startDrag(event, node.id)}
                      >
                        <span className="nodeAvatar" aria-hidden="true">
                          {nodeInitials(node)}
                        </span>
                        <span className="nodeText">
                          <strong>{node.label}</strong>
                          <span>{node.id}</span>
                        </span>
                        {node.kind === "mailbox" ? (
                          <span className="mailboxNodeStats" aria-hidden="true">
                            <span>待 {mailboxStats.pending}</span>
                            <span>中 {mailboxStats.active}</span>
                            <span>完 {mailboxStats.done}</span>
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="nodeInspector">
                <header className="inspectorHeader">
                  <div>
                    <h3>{selectedMessage ? `消息 #${String(selectedMessage.order).padStart(2, "0")}` : selectedNode ? `${selectedNode.label} 会话` : "会话"}</h3>
                    <span>
                      {selectedMessage
                        ? `${selectedMessage.from} -> ${selectedMessage.to}`
                        : selectedNode?.id}
                    </span>
                  </div>
                  <strong>{selectedEdge ? graphEdgeStatusText(selectedEdge) : selectedMessage ? selectedMessage.kind : selectedNode?.status ?? "idle"}</strong>
                </header>
                {selectedMessage ? (
                  <article className={`conversationItem selectedMessage ${selectedMessage.kind}`}>
                    <header>
                      <strong>{selectedEdge?.label || selectedMessage.kind}</strong>
                      <small>{selectedMessage.timestamp ? formatTime(selectedMessage.timestamp) : ""}</small>
                    </header>
                    <small>
                      {selectedMessage.from}
                      {" -> "}
                      {selectedMessage.to}
                    </small>
                    <p>{selectedMessage.content}</p>
                  </article>
                ) : selectedConversation.length ? (
                  selectedConversation.map((item, index) => (
                    <article className={`conversationItem ${item.kind}`} key={`${item.source}-${item.title}-${index}`}>
                      <header>
                        <strong>{item.title}</strong>
                        <small>{item.timestamp ? formatTime(item.timestamp) : ""}</small>
                      </header>
                      <small>
                        {item.source}
                        {item.target ? ` -> ${item.target}` : ""}
                      </small>
                      <p>{item.content}</p>
                    </article>
                  ))
                ) : (
                  <p className="emptyText">暂无会话事件。</p>
                )}
              </div>
            </div>
            <div className="mailboxPanel">
              <div className="mailboxBoard">
                <header>
                  <div>
                    <h3>Team Mailbox</h3>
                    <span>按事务状态展示队列、认领和完成情况</span>
                  </div>
                  <strong>{mailboxItems.length} work items</strong>
                </header>
                {mailboxItems.length ? (
                  <div className="mailboxGrid">
                    <div className="messageRail">
                      {mailboxItems.map((item) => (
                        <button
                          className={`mailRoute ${item.status} ${selectedMessage?.id === item.id ? "selected" : ""}`}
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setSelectedEdgeId(item.id);
                            setSelectedNodeId("mailbox");
                          }}
                        >
                          <span className="mailOrder">#{String(item.order).padStart(2, "0")}</span>
                          <span className="mailRouteText">
                            <strong>
                              {mailboxStatusLabel(item.status)}
                              {" · "}
                              {item.to}
                            </strong>
                            <small>
                              {item.kind}
                              {item.timestamp ? ` · ${formatTime(item.timestamp)}` : ""}
                            </small>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="mailBuckets">
                      {mailboxGroups.map((group) => (
                        <section className={`mailBucket ${group.status}`} key={group.status}>
                          <header>
                            <strong>{group.label}</strong>
                            <span>{group.items.length}</span>
                          </header>
                          <small className="mailBucketHelper">{group.helper}</small>
                          {group.items.length ? group.items.map((item) => (
                            <button
                              className={`mailPreview ${item.status}`}
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setSelectedEdgeId(item.id);
                                setSelectedNodeId("mailbox");
                              }}
                            >
                              <small>
                                #{String(item.order).padStart(2, "0")} {item.from}
                                {" -> "}
                                {item.to}
                              </small>
                              <span>{truncate(item.content)}</span>
                            </button>
                          )) : <p className="mailBucketEmpty">暂无</p>}
                        </section>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="emptyText">暂无信箱消息。</p>
                )}
              </div>
              <div className="interventionBox">
                <header>
                  <h3>用户介入</h3>
                  <span>{pendingHumanInput ? `request ${pendingHumanInput.id}` : `to ${interventionTarget}`}</span>
                </header>
                {pendingHumanInput ? (
                  <div className="humanInputRequest">
                    <strong>{pendingHumanInput.reason || "waiting_for_human"}</strong>
                    <p>{pendingHumanInput.question}</p>
                  </div>
                ) : null}
                <textarea value={interventionText} onChange={(event) => setInterventionText(event.target.value)} />
                <button type="button" onClick={sendIntervention} disabled={!interventionText.trim()}>
                  {pendingHumanInput ? "提交介入" : "投递消息"}
                </button>
              </div>
            </div>
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

          <div className="panel finalPanel">
            <div className="panelHeader">
              <h2>最终结果</h2>
            </div>
            <pre>{result?.result.finalOutput || "team_lead 汇总后显示最终结果。"}</pre>
          </div>

        </div>
      </section>
    </main>
  );
}

function extractCompletedOutputs(events: AppEvent[]) {
  return events
    .filter((event) => event.type === "role_instance_completed")
    .map((event) => ({
      instance: readPath(event, ["instance"]) as { displayName: string; roleId: string; id: string },
      output: typeof readPath(event, ["output"]) === "string" ? String(readPath(event, ["output"])) : "",
    }))
    .filter((item) => item.instance);
}

function eventTitle(event: AppEvent): string {
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
    case "human_input_requested":
      return "review_gate needs human input";
    case "human_input_answered":
      return "human input answered";
    case "user_intervention":
      return `user -> ${String(event.to || "team_lead")}`;
    default:
      return event.type;
  }
}

function eventSummary(event: AppEvent): string {
  if (event.type === "user_intervention") {
    return truncate(String(event.content || ""));
  }
  if (event.type === "agent_event") {
    return truncate(String(readPath(event, ["event", "content"]) || readPath(event, ["event", "output"]) || readPath(event, ["event", "type"]) || ""));
  }
  if (event.type === "plan_created" && Array.isArray(event.assignments)) {
    return `${event.assignments.length} assignments`;
  }
  const question = readPath(event, ["request", "question"]);
  if (typeof question === "string") {
    return truncate(question);
  }
  const output = readPath(event, ["output"]);
  if (typeof output === "string") {
    return truncate(output);
  }
  const content = readPath(event, ["content"]);
  if (typeof content === "string") {
    return truncate(content);
  }
  const error = readPath(event, ["error"]);
  if (typeof error === "string") {
    return error;
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

function isGraphSystemService(id: string): boolean {
  return id === "mailbox" || id === "state_store" || id === "review_gate" || id === "human_input_gateway";
}

function buildInteractionGraph(events: AppEvent[], roles: Metadata["roles"]) {
  const roleTitle = new Map(roles.map((role) => [role.id, role.identity.title]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let edgeOrder = 1;
  const addEdge = (edge: Omit<GraphEdge, "order"> & { order?: number }) => {
    const order = edge.order ?? edgeOrder++;
    edgeOrder = Math.max(edgeOrder, order + 1);
    edges.push({ ...edge, order });
  };
  const upsertEdge = (edge: GraphEdge) => {
    const existingIndex = edges.findIndex((item) => item.id === edge.id);
    if (existingIndex >= 0) {
      edges[existingIndex] = { ...edges[existingIndex], ...edge, order: edges[existingIndex].order };
      return;
    }
    addEdge(edge);
  };

  nodes.set("user", { id: "user", label: "用户", kind: "user", status: "idle" });
  nodes.set("team_lead", { id: "team_lead", label: "Team Lead", kind: "lead", status: events.length ? "running" : "idle" });
  addEdge({
    id: "user-task",
    from: "user",
    to: "team_lead",
    label: "task",
    content: "用户提交任务",
    kind: "task",
  });

  events.forEach((event, index) => {
    const workItemId = String(readPath(event, ["workItem", "id"]) || "");
    const workSequence = Number(readPath(event, ["workItem", "sequence"]));
    const workOrder = Number.isFinite(workSequence) && workSequence > 0 ? workSequence + 1 : undefined;

    if (event.type === "work_item_posted") {
      const roleInstanceId = String(readPath(event, ["workItem", "roleInstanceId"]) || readPath(event, ["workItem", "roleId"]) || "");
      const roleId = String(readPath(event, ["workItem", "roleId"]) || "");
      if (roleInstanceId && !nodes.has(roleInstanceId)) {
        nodes.set(roleInstanceId, {
          id: roleInstanceId,
          label: roleTitle.get(roleId) || roleId || roleInstanceId,
          kind: "teammate",
          status: "idle",
        });
      }
    }

    if (event.type === "team_message_posted") {
      const message = readPath(event, ["message"]) as { id?: string; from?: string; to?: string; type?: string; content?: string } | undefined;
      const from = String(message?.from || "");
      const to = String(message?.to || "mailbox");
      const messageType = String(message?.type || "message");
      const isMailboxEdge = from === "mailbox" || to === "mailbox";
      const duplicatesWorkItemEdge = messageType === "task_request";
      if (from && !isGraphSystemService(from) && !nodes.has(from)) {
        nodes.set(from, {
          id: from,
          label: roleTitle.get(from) || from,
          kind: from === "team_lead" ? "lead" : from === "user" ? "user" : "teammate",
          status: "idle",
        });
      }
      if (to && !isGraphSystemService(to) && !nodes.has(to)) {
        nodes.set(to, {
          id: to,
          label: roleTitle.get(to) || to,
          kind: to === "team_lead" ? "lead" : to === "user" ? "user" : "teammate",
          status: "attention",
        });
      }
      if (!isMailboxEdge && !duplicatesWorkItemEdge) {
        addEdge({
          id: message?.id || `team-message-${index}`,
          from,
          to,
          label: messageType,
          content: String(message?.content || ""),
          kind: messageType,
          order: edgeOrder,
          status: messageType === "approval" || messageType === "artifact_delivery" ? "replied" : "active",
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "work_item_claimed") {
      const instance = event.instance as { id: string; displayName?: string; roleId?: string };
      const nodeId = instance.id;
      nodes.set(nodeId, {
        id: nodeId,
        label: instance.displayName || roleTitle.get(instance.roleId || "") || instance.roleId || nodeId,
        kind: "teammate",
        status: "running",
      });
      const timestamp = eventTimestamp(event);
      const requestContent = typeof event.content === "string" ? event.content : "";
      upsertEdge({
        id: workItemId || `claimed-${index}`,
        from: "team_lead",
        to: nodeId,
        label: "任务会话",
        content: requestContent,
        kind: "conversation",
        order: workOrder ?? edgeOrder,
        status: "active",
        requestContent,
        timestamp,
      });
    }

    if (event.type === "role_instance_started") {
      const instance = event.instance as { id: string; displayName?: string; roleId?: string };
      const existing = nodes.get(instance.id);
      nodes.set(instance.id, {
        id: instance.id,
        label: existing?.label || instance.displayName || roleTitle.get(instance.roleId || "") || instance.id,
        kind: "teammate",
        status: "running",
      });
    }

    if (event.type === "work_item_completed") {
      const instance = event.instance as { id: string; displayName?: string; roleId?: string };
      const existing = nodes.get(instance.id);
      nodes.set(instance.id, {
        id: instance.id,
        label: existing?.label || instance.displayName || roleTitle.get(instance.roleId || "") || instance.id,
        kind: "teammate",
        status: "completed",
      });
      const timestamp = eventTimestamp(event);
      const responseContent = typeof event.content === "string" ? event.content : "";
      const edgeId = workItemId || `completed-${index}`;
      const existingEdge = edges.find((item) => item.id === edgeId);
      const requestContent = existingEdge?.requestContent || String(readPath(event, ["workItem", "title"]) || "");
      upsertEdge({
        id: edgeId,
        from: "team_lead",
        to: instance.id,
        label: "任务会话",
        content: composeConversationContent(requestContent, responseContent),
        kind: "conversation",
        order: existingEdge?.order ?? workOrder ?? edgeOrder,
        status: "replied",
        requestContent,
        responseContent,
        replyTimestamp: timestamp,
        timestamp,
      });
    }

    if (event.type === "review_completed") {
      const reviewer = String(readPath(event, ["review", "reviewerInstanceId"]) || readPath(event, ["review", "reviewerRoleId"]) || "");
      const outcome = String(readPath(event, ["review", "result", "outcome"]) || "review_completed");
      if (reviewer) {
        const existing = nodes.get(reviewer);
        nodes.set(reviewer, {
          id: reviewer,
          label: existing?.label || roleTitle.get(reviewer) || reviewer,
          kind: "teammate",
          status: outcome === "approved" ? "completed" : "attention",
        });
      }
    }

    if (event.type === "final_output") {
      const lead = nodes.get("team_lead");
      nodes.set("team_lead", { ...(lead ?? { id: "team_lead", label: "Team Lead", kind: "lead" as const }), status: "completed" });
      const order = edgeOrder++;
      const timestamp = eventTimestamp(event);
      addEdge({
        id: `final-${index}`,
        from: "team_lead",
        to: "user",
        label: "final",
        content: typeof event.output === "string" ? event.output : "",
        kind: "final",
        status: "final",
        order,
        timestamp,
      });
    }
    if (event.type === "user_intervention") {
      const target = String(event.to || "team_lead");
      const targetNode = nodes.get(target);
      if (!targetNode && target !== "team_lead") {
        nodes.set(target, { id: target, label: target, kind: "teammate", status: "attention" });
      } else if (targetNode) {
        nodes.set(target, { ...targetNode, status: "attention" });
      }
      const order = edgeOrder++;
      const timestamp = eventTimestamp(event);
      addEdge({
        id: `user-intervention-${index}`,
        from: "user",
        to: target,
        label: "user",
        content: String(event.content || ""),
        kind: "user",
        order,
        timestamp,
      });
    }
  });

  const nodeList = Array.from(nodes.values());
  const teammateNodes = nodeList.filter((node) => node.kind === "teammate");
  const positions: Record<string, { x: number; y: number }> = {
    user: { x: 150, y: 260 },
    team_lead: { x: 475, y: 220 },
  };

  teammateNodes.forEach((node, index) => {
    const spacing = Math.min(160, 360 / Math.max(teammateNodes.length - 1, 1));
    const startY = 250 - ((teammateNodes.length - 1) * spacing) / 2;
    positions[node.id] = { x: 990, y: startY + index * spacing };
  });

  return { nodes: nodeList, edges, positions };
}

function buildNodeConversation(nodeId: string, events: AppEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const hasWorkItemEvents = events.some(
    (event) => event.type === "work_item_posted" || event.type === "work_item_claimed" || event.type === "work_item_completed",
  );

  for (const event of events) {
    if (nodeId === "user" && event.type === "session_started") {
      items.push({
        kind: "system",
        source: "user",
        target: "team_lead",
        title: "任务提交",
        content: String(readPath(event, ["session", "task"]) || ""),
      });
    }

    if (nodeId === "team_lead" && event.type === "lead_output") {
      items.push({ kind: "plan", source: "team_lead", target: "team", title: "计划输出", content: String(event.content || "") });
    }

    if (nodeId === "team_lead" && event.type === "plan_created" && Array.isArray(event.assignments)) {
      items.push({
        kind: "plan",
        source: "team_lead",
        target: "orchestrator",
        title: "结构化计划",
        content: JSON.stringify(event.assignments, null, 2),
      });
    }

    if (event.type === "work_item_posted" && nodeId === "mailbox") {
      const workItemId = String(readPath(event, ["workItem", "id"]) || "");
      const target = String(readPath(event, ["workItem", "roleInstanceId"]) || readPath(event, ["workItem", "roleId"]) || "");
      items.push({
        kind: "pending",
        source: "team_lead",
        target,
        title: `事务入箱 ${workItemId}`,
        content: String(event.content || ""),
        timestamp: eventTimestamp(event),
      });
    }

    if (event.type === "team_message_posted") {
      const message = readPath(event, ["message"]) as { from?: string; to?: string; type?: string; content?: string } | undefined;
      const from = String(message?.from || "");
      const to = String(message?.to || "mailbox");
      if (nodeId === from || nodeId === to || nodeId === "mailbox") {
        items.push({
          kind: String(message?.type || "message"),
          source: from,
          target: to,
          title: String(message?.type || "团队消息"),
          content: String(message?.content || ""),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "work_item_claimed") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.to || "");
      if (nodeId === "mailbox" || nodeId === "team_lead" || nodeId === instanceId) {
        items.push({
          kind: "claimed",
          source: "mailbox",
          target: instanceId,
          title: "事务被认领",
          content: String(event.content || ""),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "work_item_completed") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.from || "");
      if (nodeId === "mailbox" || nodeId === "team_lead" || nodeId === instanceId) {
        items.push({
          kind: "completed",
          source: instanceId,
          target: "mailbox",
          title: "事务已处理",
          content: String(event.content || ""),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (!hasWorkItemEvents && event.type === "assignment_sent") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.to || "");
      if (nodeId === "team_lead") {
        items.push({
          kind: "assignment",
          source: "team_lead",
          target: instanceId,
          title: "任务分配",
          content: String(event.content || ""),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "role_instance_started") {
      const instanceId = String(readPath(event, ["instance", "id"]) || "");
      if (nodeId === instanceId) {
        items.push({
          kind: "system",
          source: "orchestrator",
          target: instanceId,
          title: "会话启动",
          content: String(readPath(event, ["instance", "assignedTask"]) || ""),
        });
      }
    }

    if (event.type === "agent_event") {
      const instanceId = String(event.instanceId || readPath(event, ["event", "roleId"]) || "");
      if (nodeId === instanceId || (nodeId === "team_lead" && !event.instanceId)) {
        const agentEventType = String(readPath(event, ["event", "type"]) || "message");
        const content =
          agentEventType === "tool_call"
            ? JSON.stringify(
                {
                  name: readPath(event, ["event", "name"]),
                  args: readPath(event, ["event", "args"]),
                },
                null,
                2,
              )
            : String(readPath(event, ["event", "content"]) || readPath(event, ["event", "output"]) || readPath(event, ["event", "error"]) || agentEventType);
        items.push({
          kind: agentEventType,
          source: event.instanceId ? `${instanceId} runtime` : "team_lead runtime",
          title: agentEventTitle(agentEventType),
          content,
          timestamp: String(readPath(event, ["event", "timestamp"]) || ""),
        });
      }
    }

    if (!hasWorkItemEvents && event.type === "teammate_response") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.from || "");
      if (nodeId === "team_lead") {
        items.push({
          kind: "response",
          source: instanceId,
          target: "team_lead",
          title: "成员回复",
          content: String(event.content || ""),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "role_instance_completed") {
      const instanceId = String(readPath(event, ["instance", "id"]) || "");
      if (nodeId === instanceId) {
        items.push({
          kind: "final",
          source: instanceId,
          target: "team_lead",
          title: "角色最终输出",
          content: String(event.output || ""),
        });
      }
    }

    if (event.type === "review_completed") {
      const reviewer = String(readPath(event, ["review", "reviewerInstanceId"]) || readPath(event, ["review", "reviewerRoleId"]) || "");
      const targetWorkItemId = String(readPath(event, ["review", "targetWorkItemId"]) || "");
      if (nodeId === reviewer || nodeId === "mailbox" || nodeId === "team_lead") {
        items.push({
          kind: "review",
          source: reviewer,
          target: targetWorkItemId,
          title: `Review: ${String(readPath(event, ["review", "result", "outcome"]) || "")}`,
          content: JSON.stringify(readPath(event, ["review", "result"]) || {}, null, 2),
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "human_input_requested") {
      const request = readPath(event, ["request"]) as HumanInputRequestView | undefined;
      if (request && (nodeId === "user" || nodeId === "team_lead")) {
        items.push({
          kind: "human_input",
          source: "review_gate",
          target: "user",
          title: "等待人工介入",
          content: request.question,
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "human_input_answered") {
      const request = readPath(event, ["request"]) as HumanInputRequestView | undefined;
      if (request && (nodeId === "user" || nodeId === "team_lead")) {
        items.push({
          kind: "human_input",
          source: "user",
          target: "review_gate",
          title: "人工介入已提交",
          content: request.answer || "",
          timestamp: eventTimestamp(event),
        });
      }
    }

    if (event.type === "user_intervention") {
      const target = String(event.to || "team_lead");
      if (nodeId === "user" || nodeId === target || nodeId === "mailbox") {
        items.push({
          kind: "user",
          source: "user",
          target,
          title: "用户消息",
          content: String(event.content || ""),
          timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
        });
      }
    }

    if (nodeId === "user" && event.type === "final_output") {
      items.push({ kind: "final", source: "team_lead", target: "user", title: "最终答复", content: String(event.output || "") });
    }
  }

  return items;
}

function buildMailboxItems(events: AppEvent[]): MailboxItem[] {
  const itemsByWorkId = new Map<string, MailboxItem>();
  const hasWorkItemEvents = events.some(
    (event) => event.type === "work_item_posted" || event.type === "work_item_claimed" || event.type === "work_item_completed",
  );
  let fallbackOrder = 1;

  const upsertWorkItem = (
    event: AppEvent,
    index: number,
    status: MailboxItem["status"],
    kind: string,
    from: string,
    to: string,
    content: string,
  ) => {
    const workItemId = String(readPath(event, ["workItem", "id"]) || `${kind}-${index}`);
    const sequence = Number(readPath(event, ["workItem", "sequence"]));
    const current = itemsByWorkId.get(workItemId);
    itemsByWorkId.set(workItemId, {
      id: workItemId,
      from,
      to,
      kind,
      content,
      order: current?.order ?? (Number.isFinite(sequence) && sequence > 0 ? sequence : fallbackOrder++),
      status,
      timestamp: eventTimestamp(event),
    });
  };

  events.forEach((event, index) => {
    if (event.type === "work_item_posted") {
      const roleInstanceId = String(readPath(event, ["workItem", "roleInstanceId"]) || readPath(event, ["workItem", "roleId"]) || "");
      upsertWorkItem(event, index, "pending", "pending", "team_lead", roleInstanceId, String(event.content || ""));
    }

    if (event.type === "work_item_claimed") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.to || "");
      upsertWorkItem(event, index, "active", "claimed", "team_lead", instanceId, String(event.content || ""));
    }

    if (event.type === "work_item_completed") {
      const instanceId = String(readPath(event, ["instance", "id"]) || event.from || "");
      upsertWorkItem(event, index, "done", "completed", instanceId, "team_lead", String(event.content || ""));
    }

    if (!hasWorkItemEvents && event.type === "assignment_sent") {
      itemsByWorkId.set(`legacy-assignment-${index}`, {
        id: `legacy-assignment-${index}`,
        from: "team_lead",
        to: String(event.to || readPath(event, ["instance", "id"]) || ""),
        kind: "assignment",
        content: String(event.content || ""),
        order: fallbackOrder++,
        status: "pending",
        timestamp: eventTimestamp(event),
      });
    }
    if (!hasWorkItemEvents && event.type === "teammate_response") {
      itemsByWorkId.set(`legacy-response-${index}`, {
        id: `legacy-response-${index}`,
        from: String(event.from || ""),
        to: "team_lead",
        kind: "response",
        content: String(event.content || ""),
        order: fallbackOrder++,
        status: "done",
        timestamp: eventTimestamp(event),
      });
    }
    if (event.type === "user_intervention") {
      itemsByWorkId.set(`user-intervention-${index}`, {
        id: `user-intervention-${index}`,
        from: "user",
        to: String(event.to || "team_lead"),
        kind: "user",
        content: String(event.content || ""),
        order: fallbackOrder++,
        status: "active",
        timestamp: eventTimestamp(event),
      });
    }
    if (event.type === "team_message_posted") {
      const message = readPath(event, ["message"]) as
        | { id?: string; from?: string; to?: string; type?: string; content?: string; workItemId?: string }
        | undefined;
      const messageType = String(message?.type || "message");
      if ((messageType === "task_request" || messageType === "artifact_delivery") && message?.workItemId) {
        return;
      }
      itemsByWorkId.set(message?.id || `team-message-${index}`, {
        id: message?.id || `team-message-${index}`,
        from: String(message?.from || ""),
        to: String(message?.to || "mailbox"),
        kind: messageType,
        content: String(message?.content || ""),
        order: fallbackOrder++,
        status: messageType === "artifact_delivery" || messageType === "approval" || messageType === "answer" ? "done" : "active",
        timestamp: eventTimestamp(event),
      });
    }
    if (event.type === "human_input_requested") {
      const request = readPath(event, ["request"]) as HumanInputRequestView | undefined;
      if (request) {
        itemsByWorkId.set(request.id, {
          id: request.id,
          from: "review_gate",
          to: "user",
          kind: "human_input",
          content: request.question,
          order: fallbackOrder++,
          status: "active",
          timestamp: eventTimestamp(event),
        });
      }
    }
    if (event.type === "human_input_answered") {
      const request = readPath(event, ["request"]) as HumanInputRequestView | undefined;
      if (request) {
        itemsByWorkId.set(request.id, {
          id: request.id,
          from: "user",
          to: "review_gate",
          kind: "human_input",
          content: request.answer || "",
          order: fallbackOrder++,
          status: "done",
          timestamp: eventTimestamp(event),
        });
      }
    }
    if (event.type === "final_output") {
      itemsByWorkId.set(`final-${index}`, {
        id: `final-${index}`,
        from: "team_lead",
        to: "user",
        kind: "final",
        content: String(event.output || ""),
        order: fallbackOrder++,
        status: "done",
        timestamp: eventTimestamp(event),
      });
    }
  });

  return Array.from(itemsByWorkId.values()).sort((left, right) => left.order - right.order);
}

function groupMailboxItemsByStatus(items: MailboxItem[]): MailboxGroup[] {
  const definitions: Array<Omit<MailboxGroup, "items">> = [
    { status: "pending", label: "待处理事务", helper: "team_lead 已投递，等待角色认领" },
    { status: "active", label: "处理中事务", helper: "已被角色或用户消息认领，正在推进" },
    { status: "done", label: "已处理事务", helper: "角色已完成并回到 team_lead 汇总" },
  ];
  return definitions.map((definition) => ({
    ...definition,
    items: items.filter((item) => item.status === definition.status),
  }));
}

function countMailboxItems(items: MailboxItem[]): Record<MailboxItem["status"], number> {
  return {
    pending: items.filter((item) => item.status === "pending").length,
    active: items.filter((item) => item.status === "active").length,
    done: items.filter((item) => item.status === "done").length,
  };
}

function graphEdgeRoute(
  edge: GraphEdge,
  edges: GraphEdge[],
  nodes: GraphNode[],
  from: { x: number; y: number },
  to: { x: number; y: number },
): { path: string; label: { x: number; y: number } } {
  const siblings = edges
    .filter((item) => graphPairKey(item) === graphPairKey(edge))
    .sort((left, right) => left.order - right.order);
  const siblingIndex = Math.max(
    0,
    siblings.findIndex((item) => item.id === edge.id),
  );
  const spread = (siblingIndex - (siblings.length - 1) / 2) * 62;
  const fromNode = nodes.find((node) => node.id === edge.from);
  const toNode = nodes.find((node) => node.id === edge.to);
  const ports = edgePorts(from, to, graphNodeSize(fromNode), graphNodeSize(toNode));
  const dx = ports.to.x - ports.from.x;
  const dy = ports.to.y - ports.from.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const normal = { x: -dy / length, y: dx / length };
  const curve = Math.min(Math.max(Math.abs(dx) * 0.38, 90), 260);
  const control1 = {
    x: ports.from.x + dx * 0.34 + normal.x * spread,
    y: ports.from.y + dy * 0.12 + normal.y * (spread - curve * 0.1),
  };
  const control2 = {
    x: ports.to.x - dx * 0.34 + normal.x * spread,
    y: ports.to.y - dy * 0.12 + normal.y * (spread + curve * 0.1),
  };
  const label = {
    x: (ports.from.x + ports.to.x) / 2 + normal.x * spread,
    y: (ports.from.y + ports.to.y) / 2 + normal.y * spread - 14,
  };

  return {
    path: `M ${ports.from.x} ${ports.from.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${ports.to.x} ${ports.to.y}`,
    label,
  };
}

function graphPairKey(edge: Pick<GraphEdge, "from" | "to">): string {
  return [edge.from, edge.to].sort().join("::");
}

function graphNodeSize(node?: Pick<GraphNode, "kind">): { width: number; height: number } {
  return node?.kind === "mailbox" ? mailboxNodeSize : personNodeSize;
}

function edgePorts(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSize: { width: number; height: number },
  toSize: { width: number; height: number },
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    return {
      from: { x: from.x + direction * (fromSize.width / 2 + 8), y: from.y },
      to: { x: to.x - direction * (toSize.width / 2 + 8), y: to.y },
    };
  }
  const direction = dy >= 0 ? 1 : -1;
  return {
    from: { x: from.x, y: from.y + direction * (fromSize.height / 2 + 8) },
    to: { x: to.x, y: to.y - direction * (toSize.height / 2 + 8) },
  };
}

function composeConversationContent(request: string, response: string): string {
  return [`【任务】\n${request || "无任务内容"}`, `【回复】\n${response || "尚未回复"}`].join("\n\n");
}

function zoomViewport(current: GraphViewport, factor: number, focus: { x: number; y: number }): GraphViewport {
  const nextScale = clamp(current.scale * factor, 0.55, 2.1);
  const worldFocus = {
    x: (focus.x - current.x) / current.scale,
    y: (focus.y - current.y) / current.scale,
  };
  return {
    scale: nextScale,
    x: focus.x - worldFocus.x * nextScale,
    y: focus.y - worldFocus.y * nextScale,
  };
}

function nodeInitials(node: GraphNode): string {
  if (node.kind === "user") {
    return "U";
  }
  if (node.kind === "lead") {
    return "L";
  }
  if (node.kind === "mailbox") {
    return "M";
  }
  const ascii = node.label.match(/[A-Za-z]/g)?.slice(0, 2).join("");
  return ascii?.toUpperCase() || node.label.slice(0, 1);
}

function mailboxStatusLabel(status: MailboxItem["status"]): string {
  if (status === "pending") {
    return "待处理";
  }
  if (status === "active") {
    return "处理中";
  }
  return "已处理";
}

function graphEdgeStatusText(edge: GraphEdge): string {
  if (edge.status === "replied") {
    return "已回复";
  }
  if (edge.status === "active") {
    return "进行中";
  }
  if (edge.status === "final") {
    return "最终答复";
  }
  return edge.kind;
}

function eventTimestamp(event: AppEvent): string | undefined {
  if (typeof event.timestamp === "string") {
    return event.timestamp;
  }
  const nested = readPath(event, ["event", "timestamp"]);
  return typeof nested === "string" ? nested : undefined;
}

function agentEventTitle(type: string): string {
  switch (type) {
    case "started":
      return "会话启动";
    case "message":
      return "模型消息";
    case "tool_call":
      return "工具调用";
    case "final":
      return "最终输出";
    case "error":
      return "错误";
    default:
      return type;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
