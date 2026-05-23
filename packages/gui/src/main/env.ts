import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadLocalEnv(cwd: string) {
  const values = readLocalEnv(cwd);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return values;
}

export function readLocalEnv(cwd: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const filename of [".env.local", ".env"]) {
    const filePath = join(cwd, filename);
    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      if (!key || values[key] !== undefined) {
        continue;
      }
      values[key] = unquote(rawValue);
    }
  }

  return values;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
