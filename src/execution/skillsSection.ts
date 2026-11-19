// Prompt section that inlines each enabled skill's guide into the bot's own conversation.
// musebot bots carry no file tools, so the body itself is injected (truncated), never a
// path the bot could not open.
import { section } from "@earendil-works/pi-durable";

const MAX_SKILL_CHARS = 1200;
const MAX_TOTAL_CHARS = 4000;

export function createSkillsSection(deps) {
  return section("bot-skills", async (input, ctx) => {
    const ref = deps.botIdFor(input.conversationId);
    if (!ref) return undefined;
    const skills = await deps.enabledSkills(ref.botId, ctx);
    if (!skills || skills.length === 0) return undefined;
    const blocks = skills.map((skill) => {
      const description = String(skill.description ?? "").trim();
      const body = String(skill.body ?? "").trim().slice(0, MAX_SKILL_CHARS);
      return `### ${skill.name}\n${description}\n\n${body}`;
    });
    const text = `已启用的技能指南(任务匹配时遵循即可,不需要复述):\n\n${blocks.join("\n\n")}`;
    return text.slice(0, MAX_TOTAL_CHARS);
  });
}
