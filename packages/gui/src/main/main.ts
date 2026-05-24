import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FileTeamStateStore,
  TeamRunner,
  builtinSystemRoles,
  builtinSystemServices,
  builtinSystemSkills,
  type HumanInputRequest,
  type TeamRunEvent,
} from "@hanais/agent-team";
import { ClaudeAgentSdkRuntime, CodexCliRuntime } from "@hanais/agent-runtimes";
import { novelRoles, novelSkills, novelTeam } from "@hanais/teammates";
import { loadLocalEnv, readLocalEnv } from "./env.js";
import { getSettingsPath, getTeamsPath, readSettings, writeSettings, type RuntimePreference, type UserSettings } from "./settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = join(__dirname, "../../../..");
const teamStateStore = new FileTeamStateStore({ rootDir: getTeamsPath() });
const pendingHumanInputs = new Map<string, { request: HumanInputRequest; resolve: (answer: string | undefined) => void }>();

loadLocalEnv(appRoot);

interface RunPayload {
  task: string;
  runtimeId: RuntimePreference;
  cwd?: string;
}

const defaultSettings: UserSettings = {
  runtimeId: "codex-cli",
  workspaceDir: appRoot,
};

async function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 680,
    title: "Hanais Agent Team",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${validatedUrl}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason}`);
  });

  const devUrl = process.env.HANAIS_GUI_DEV_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
    if (process.env.HANAIS_OPEN_DEVTOOLS === "1") {
      window.webContents.openDevTools({ mode: "detach" });
    }
    return;
  }

  await window.loadFile(join(__dirname, "../renderer/index.html"));
}

ipcMain.handle("team:metadata", () => ({
  team: novelTeam,
  roles: novelRoles,
  skills: novelSkills,
  systemRoles: builtinSystemRoles,
  systemSkills: builtinSystemSkills,
  systemServices: builtinSystemServices,
  cwd: readSettings(defaultSettings).workspaceDir,
  settings: readSettings(defaultSettings),
  settingsPath: getSettingsPath(),
  teamsPath: getTeamsPath(),
  kimiConfigured: hasKimiConfig(readSettings(defaultSettings).workspaceDir),
}));

ipcMain.handle("settings:read", () => ({
  settings: readSettings(defaultSettings),
  settingsPath: getSettingsPath(),
}));

ipcMain.handle("settings:write", (_event, settings: UserSettings) => ({
  settings: writeSettings(settings),
  settingsPath: getSettingsPath(),
}));

ipcMain.handle("workspace:env-status", (_event, cwd?: string) => ({
  kimiConfigured: hasKimiConfig(cwd?.trim() || appRoot),
}));

ipcMain.handle("workspace:select", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 AI 工作目录",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("team:history", async () => ({
  runs: await teamStateStore.listSessions(30),
  teamsPath: getTeamsPath(),
}));

ipcMain.handle("team:events", async (_event, sessionId: string) => ({
  events: await teamStateStore.listEvents(sessionId),
}));

ipcMain.handle("team:answer-human-input", async (_event, payload: { requestId: string; answer: string }) => {
  const pending = pendingHumanInputs.get(payload.requestId);
  if (!pending) {
    return { accepted: false };
  }
  pendingHumanInputs.delete(payload.requestId);
  pending.resolve(payload.answer);
  return { accepted: true };
});

ipcMain.handle("team:run", async (event, payload: RunPayload) => {
  const cwd = payload.cwd?.trim() || appRoot;
  const runtime = createRuntime(payload.runtimeId, cwd);
  const runtimeIdForTeam = runtime.id;

  const events: TeamRunEvent[] = [];
  const runner = new TeamRunner();
  const team = {
    ...novelTeam,
    lead: {
      type: "builtin" as const,
      id: "team_lead" as const,
      runtime: runtimeIdForTeam,
    },
    runtimeOverrides: {
      novelist: runtimeIdForTeam,
      novel_editor: runtimeIdForTeam,
    },
  };

  const result = await runner.run({
    team,
    roles: novelRoles,
    skills: novelSkills,
    runtimeRegistry: {
      [runtimeIdForTeam]: runtime,
    },
    task: payload.task,
    stateStore: teamStateStore,
    context: {
      workspace: cwd,
      gui: "electron",
    },
    requestHumanInput: (request) =>
      new Promise((resolve) => {
        pendingHumanInputs.set(request.id, { request, resolve });
      }),
    onEvent: (teamEvent) => {
      events.push(teamEvent);
      event.sender.send("team:event", teamEvent);
    },
  });

  return { result, events, history: await teamStateStore.listSessions(30) };
});

function createRuntime(runtimeId: RunPayload["runtimeId"], cwd: string) {
  if (runtimeId === "claude-agent-sdk-kimi") {
    loadLocalEnv(cwd);
    const authToken = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("未配置 KIMI_API_KEY。请在项目根目录 .env.local 中配置，文件不会提交到 Git。");
    }

    return new ClaudeAgentSdkRuntime({
      id: runtimeId,
      cwd,
      maxTurns: 4,
      baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/anthropic",
      authToken,
      model: process.env.KIMI_MODEL || "kimi-k2.5",
    });
  }

  if (runtimeId === "claude-agent-sdk") {
    return new ClaudeAgentSdkRuntime({ id: runtimeId, cwd, maxTurns: 4 });
  }

  return new CodexCliRuntime({ id: runtimeId, cwd, timeoutMs: 10 * 60 * 1000 });
}

function hasKimiConfig(cwd: string): boolean {
  const localEnv = readLocalEnv(cwd);
  return Boolean(
    localEnv.KIMI_API_KEY ||
      localEnv.MOONSHOT_API_KEY ||
      localEnv.ANTHROPIC_AUTH_TOKEN ||
      process.env.KIMI_API_KEY ||
      process.env.MOONSHOT_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN,
  );
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
