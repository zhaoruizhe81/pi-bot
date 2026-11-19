// Discovery + per-bot enablement for pi Agent Skills: scan the user-level
// (~/.pi/agent/skills) and project-level (<botDir>/.pi/skills) directories, parse the
// name/description frontmatter, and persist each bot's enabled whitelist in the durable
// BotSkillsBook (no record = every discovered skill is enabled).
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BotSkillsBook } from "./docs.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Split a leading `---` frontmatter block from the markdown body. */
const parseSkillFile = (raw) => {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const match = text.match(FRONTMATTER);
  const meta = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!pair) continue;
      const value = pair[2].trim().replace(/^['"]/, "").replace(/['"]$/, "");
      if (value) meta[pair[1]] = value;
    }
  }
  return { meta, body: (match ? text.slice(match[0].length) : text).trim() };
};

const toSkill = (fallbackName, source, filePath, raw) => {
  const { meta, body } = parseSkillFile(raw);
  const description = String(meta.description ?? "").trim();
  if (!description) return undefined; // a skill without a description is never offered
  const name = String(meta.name ?? "").trim() || fallbackName;
  return { name, description, source, path: filePath, body };
};

/** One directory: `<name>/SKILL.md` subdirectories and flat `<name>.md` files. */
const scanSkillDir = async (dir, source) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a missing or unreadable directory simply has no skills
  }
  const found = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      const file = path.join(dir, entry.name, "SKILL.md");
      try {
        const skill = toSkill(entry.name, source, file, await readFile(file, "utf8"));
        if (skill) found.push(skill);
      } catch {
        /* a subdirectory without SKILL.md is not a skill */
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const file = path.join(dir, entry.name);
      try {
        const skill = toSkill(entry.name.replace(/\.md$/, ""), source, file, await readFile(file, "utf8"));
        if (skill) found.push(skill);
      } catch {
        /* an unreadable file is skipped, never fatal */
      }
    }
  }
  return found;
};

export function createSkillStore(config) {
  const harness = config.harness;
  const botDir = path.resolve(config?.botDir ?? process.cwd());
  const dirs = [
    { dir: path.join(homedir(), ".pi", "agent", "skills"), source: "user" },
    { dir: path.join(botDir, ".pi", "skills"), source: "project" },
  ];
  /** dir -> { mtimeMs, skills }; a directory is only rescanned when its mtime moved. */
  const cache = new Map();

  const scanDir = async (entry) => {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(entry.dir)).mtimeMs;
    } catch {
      return [];
    }
    const cached = cache.get(entry.dir);
    if (cached && cached.mtimeMs === mtimeMs) return cached.skills;
    const skills = await scanSkillDir(entry.dir, entry.source);
    cache.set(entry.dir, { mtimeMs, skills });
    return skills;
  };

  return {
    /** Every discovered skill; on a name clash the project copy replaces the user one, sorted by name. */
    async list() {
      const merged = new Map();
      for (const entry of dirs) {
        for (const skill of await scanDir(entry)) merged.set(skill.name, skill);
      }
      return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    /** One bot's enabled skills; an absent whitelist row means "all enabled". */
    async enabledFor(botId, ctx) {
      const all = await this.list();
      const entry = (await harness.snapshot(BotSkillsBook, ctx))?.bots?.[String(botId ?? "")];
      if (!entry) return all;
      const names = new Set(entry.enabled ?? []);
      return all.filter((skill) => names.has(skill.name));
    },

    /**
     * Toggle one skill for one bot. The first toggle materializes the full whitelist
     * (no record meant "all enabled"); from then on the stored list is the only truth.
     * Returns the resulting enabled names.
     */
    async setEnabled(botId, name, enabled, ctx) {
      const id = String(botId ?? "");
      if (!id) throw new Error("botId is required");
      const skillName = String(name ?? "").trim();
      if (!skillName) throw new Error("skill name is required");
      const all = await this.list();
      if (!all.some((skill) => skill.name === skillName)) throw new Error(`unknown skill: ${skillName}`);
      await harness.commit(async (tx) => {
        const doc = await tx.doc(BotSkillsBook, null);
        const names = new Set(doc.bots[id]?.enabled ?? all.map((skill) => skill.name));
        if (enabled === false) names.delete(skillName);
        else names.add(skillName);
        doc.bots[id] = { enabled: [...names].sort(), updatedAt: Date.now() };
        return null;
      }, ctx);
      return (await this.enabledFor(id, ctx)).map((skill) => skill.name);
    },
  };
}
