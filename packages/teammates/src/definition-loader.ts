import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleDefinition, SkillDefinition } from "@hanais/agent-team";

interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

interface RoleSkillManifest {
  consumes?: Array<{
    id: string;
    version?: string;
    usage?: string;
  }>;
}

const assetRoot = dirname(fileURLToPath(import.meta.url));

export function loadRoles(folderNames?: string[]): RoleDefinition[] {
  const rolesRoot = join(assetRoot, "roles");
  const folders = folderNames ?? listDefinitionFolders(rolesRoot);
  return folders.map((folderName) => loadRole(join(rolesRoot, folderName), folderName));
}

export function loadSkills(folderNames?: string[]): SkillDefinition[] {
  const skillsRoot = join(assetRoot, "skills");
  const folders = folderNames ?? listDefinitionFolders(skillsRoot);
  return folders.map((folderName) => loadSkill(join(skillsRoot, folderName), folderName));
}

function loadRole(roleDir: string, folderName: string): RoleDefinition {
  const identity = parseMarkdown(readFileSync(join(roleDir, "identity.md"), "utf8"));
  const skills = loadRoleSkillManifest(roleDir);
  const id = requiredField(identity.frontmatter, "id", folderName);
  const title = requiredField(identity.frontmatter, "title", id);
  const description = requiredField(identity.frontmatter, "description", readSection(identity.body, "Identity") || title);

  return {
    id,
    version: numberField(identity.frontmatter.version, 1),
    identity: {
      name: identity.frontmatter.name ?? title,
      title,
      summary: description,
      mission: readSection(identity.body, "Mission") || description,
      responsibilities: readListSection(identity.body, "Responsibilities", [description]),
      boundaries: readListSection(identity.body, "Boundaries", ["遵守用户任务、团队策略和角色职责边界。"]),
      communicationStyle: readListSection(identity.body, "Communication Style"),
      successCriteria: readListSection(identity.body, "Success Criteria"),
    },
    skills: skills.consumes?.map((skill) => ({ id: skill.id, version: skill.version })) ?? [],
    runtime: {
      preferred: identity.frontmatter.runtime ?? "claude-agent-sdk",
      fallback: identity.frontmatter.fallbackRuntime ?? "claude-agent-sdk-kimi",
    },
  };
}

function loadSkill(skillDir: string, folderName: string): SkillDefinition {
  const skill = parseMarkdown(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  const id = requiredField(skill.frontmatter, "id", folderName);
  const name = requiredField(skill.frontmatter, "name", id);

  return {
    id,
    version: requiredField(skill.frontmatter, "version", "1.0.0"),
    name,
    description: requiredField(skill.frontmatter, "description", name),
    prompt: {
      instructions: readListSection(skill.body, "Instructions"),
      examples: readListSection(skill.body, "Examples"),
    },
    policies: {
      notes: readSection(skill.body, "Policies"),
    },
  };
}

function loadRoleSkillManifest(roleDir: string): RoleSkillManifest {
  const manifestPath = join(roleDir, "skills.json");
  if (!existsSync(manifestPath)) {
    return { consumes: [] };
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as RoleSkillManifest;
}

function listDefinitionFolders(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseMarkdown(content: string): ParsedMarkdown {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  return {
    frontmatter: parseFlatFrontmatter(match[1] ?? ""),
    body: match[2] ?? "",
  };
}

function parseFlatFrontmatter(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    fields[match[1]] = stripQuotes(match[2].trim());
  }
  return fields;
}

function readSection(body: string, heading: string): string | undefined {
  const sections = splitSections(body);
  const section = sections.get(normalizeHeading(heading));
  return section?.join("\n").trim() || undefined;
}

function readListSection(body: string, heading: string, fallback: string[] = []): string[] {
  const section = readSection(body, heading);
  if (!section) {
    return fallback;
  }
  const bullets = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  return bullets.length > 0 ? bullets : fallback;
}

function splitSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";

  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      current = normalizeHeading(heading[1]);
      sections.set(current, []);
      continue;
    }
    if (current) {
      sections.get(current)?.push(line);
    }
  }

  return sections;
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function requiredField(fields: Record<string, string>, key: string, fallback: string): string {
  return fields[key]?.trim() || fallback;
}

function numberField(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
