import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimePreference = "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi";

export interface UserSettings {
  runtimeId: RuntimePreference;
  workspaceDir: string;
}

const settingsDir = join(homedir(), ".hanais");
const settingsPath = join(settingsDir, "settings.json");
const teamsPath = join(settingsDir, "teams");
const legacySettingsPath = join(homedir(), "hanais", "settings.json");

export function readSettings(defaults: UserSettings): UserSettings {
  migrateLegacySettings();
  if (!existsSync(settingsPath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<UserSettings>;
    return normalizeSettings(parsed, defaults);
  } catch {
    return defaults;
  }
}

export function writeSettings(settings: UserSettings): UserSettings {
  mkdirSync(settingsDir, { recursive: true });
  const normalized = normalizeSettings(settings, settings);
  writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

export function getSettingsPath(): string {
  return settingsPath;
}

export function getTeamsPath(): string {
  return teamsPath;
}

function normalizeSettings(input: Partial<UserSettings>, defaults: UserSettings): UserSettings {
  return {
    runtimeId: isRuntimePreference(input.runtimeId) ? input.runtimeId : defaults.runtimeId,
    workspaceDir: typeof input.workspaceDir === "string" && input.workspaceDir.trim() ? input.workspaceDir : defaults.workspaceDir,
  };
}

function isRuntimePreference(value: unknown): value is RuntimePreference {
  return value === "codex-cli" || value === "claude-agent-sdk" || value === "claude-agent-sdk-kimi";
}

function migrateLegacySettings() {
  if (existsSync(settingsPath) || !existsSync(legacySettingsPath)) {
    return;
  }

  mkdirSync(settingsDir, { recursive: true });
  try {
    renameSync(legacySettingsPath, settingsPath);
  } catch {
    const content = readFileSync(legacySettingsPath, "utf8");
    writeFileSync(settingsPath, content, { mode: 0o600 });
  }
}
