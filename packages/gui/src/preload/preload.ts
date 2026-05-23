const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("hanais", {
  metadata: () => ipcRenderer.invoke("team:metadata"),
  readSettings: () => ipcRenderer.invoke("settings:read"),
  writeSettings: (settings: { runtimeId: "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi"; workspaceDir: string }) =>
    ipcRenderer.invoke("settings:write", settings),
  envStatus: (cwd?: string) => ipcRenderer.invoke("workspace:env-status", cwd),
  selectWorkspace: () => ipcRenderer.invoke("workspace:select"),
  runTeam: (payload: { task: string; runtimeId: "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi"; cwd?: string }) =>
    ipcRenderer.invoke("team:run", payload),
  onTeamEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, teamEvent: unknown) => callback(teamEvent);
    ipcRenderer.on("team:event", listener);
    return () => ipcRenderer.off("team:event", listener);
  },
});
