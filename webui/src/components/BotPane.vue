<script setup>
/* 单个 bot 的设置抽屉：对照旧 openBotPane / renderBotPane / botSectionsShown / botKv /
   botSectionBody / saveBotProfile。手风琴分区 .bot-acc / .bot-acc-head / .bot-acc.open /
   .bot-edit。在旧 7 个分区基础上新增「记忆」分区（列表 / 新增 / 删除 / 开关），
   打开抽屉时调用 actions.loadMemory(gid, botId)。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";
import Icon from "./Icon.vue";

const BOT_SECTIONS = [
  { id: "overview", label: "概览", icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"] },
  { id: "identity", label: "身份", icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"] },
  { id: "soul", label: "提示词", icon: ["M12 4l1.8 4.6L18.5 10l-4.7 1.4L12 16l-1.8-4.6L5.5 10l4.7-1.4L12 4z"] },
  { id: "model", label: "模型", icon: ["M7 7h10v10H7z", "M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"] },
  { id: "tools", label: "技能", icon: ["M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z", "M5 18.5h14"] },
  { id: "library", label: "资料库", icon: ["M4 19V9M9 19V5M14 19v-7M19 19v-4"] },
  { id: "history", label: "历史记录", icon: ["M12 7v5l3.5 2", "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"] },
  { id: "memory", label: "记忆", icon: ["M9 4h6a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z", "M9 9h6M9 13h6M9 17h4"] },
];

/* 注意：模板 ref 若写在 v-for 内会变成数组，读不到元素；因此编辑区一律用
   「当前展开分区」的 DOM 查询读值（与旧实现 field.value 一致，兼容自动化直改 value）。 */
const avatarFile = ref(null);

function openBody() {
  return document.querySelector("#botPane .bot-acc.open .bot-acc-body");
}
function readField(selector) {
  const body = openBody();
  const el = body && body.querySelector(selector);
  return el ? el.value : "";
}
function clearField(selector) {
  const body = openBody();
  const el = body && body.querySelector(selector);
  if (el) el.value = "";
}

const profile = computed(() => state.botProfile);
const sections = computed(() => {
  const q = state.botQuery.trim().toLowerCase();
  return q ? BOT_SECTIONS.filter((section) => section.label.toLowerCase().includes(q)) : BOT_SECTIONS;
});

const instructionsDefault = computed(() => (profile.value && profile.value.instructions && profile.value.instructions.default) || "");
const instructionsOverride = computed(() => (profile.value && profile.value.instructions && profile.value.instructions.override) || "");
const modelGlobal = computed(() => (profile.value && profile.value.model && profile.value.model.global) || "");
const modelOverride = computed(() => (profile.value && profile.value.model && profile.value.model.override) || "");
const delivered = computed(() => (profile.value && Array.isArray(profile.value.delivered) ? profile.value.delivered : []));
const libraryFiles = computed(() =>
  delivered.value.flatMap((item) => (item.files || []).map((file) => ({ ...file, workId: item.workId })))
);

function kvPairs(pairs) {
  return pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]);
}
const overviewKv = computed(() =>
  profile.value
    ? kvPairs([
        ["角色", profile.value.role === "leader" ? "编排者(领导)" : "执行 bot"],
        ["状态", profile.value.busy ? "正在执行任务" : "空闲"],
        ["会话", profile.value.conversationId ? `#${profile.value.conversationId}` : "—"],
        ["能力", (profile.value.capabilities || []).join(" · ") || "—"],
        ["工具", (profile.value.tools || []).join(" · ") || "—"],
        ["所在群", (profile.value.groups || []).map((group) => group.name).join("、")],
      ])
    : []
);
const identityKv = computed(() =>
  profile.value
    ? kvPairs([
        ["id", profile.value.id],
        ["角色", profile.value.role],
        ["能力", (profile.value.capabilities || []).join(" · ") || "—"],
      ])
    : []
);
const modelKv = computed(() =>
  profile.value && profile.value.model
    ? kvPairs([
        ["当前生效", profile.value.model.effective],
        ["全局模型", profile.value.model.global],
      ])
    : []
);
/* ---------- 技能 ---------- */
const availableSkills = computed(() => (profile.value && Array.isArray(profile.value.skillsAvailable) ? profile.value.skillsAvailable : []));
const enabledSkills = computed(() => (profile.value && Array.isArray(profile.value.skills) ? profile.value.skills : []));

function skillEnabled(name) {
  return enabledSkills.value.includes(name);
}
function skillSourceLabel(source) {
  return source === "user" ? "用户级 ~/.pi/agent/skills" : "项目级 bot/.pi/skills";
}

/* ---------- 记忆 ---------- */
const memoryItems = computed(() => (state.memory && state.memory.items) || []);
const memoryEnabled = computed(() => !state.memory || state.memory.enabled !== false);
const memoryLoading = computed(() => !!(state.memory && state.memory.loading));
const memoryError = computed(() => (state.memory && state.memory.error) || "");

function formatAt(at) {
  if (typeof at === "number") return ui.timeLabel(at);
  if (!at) return "";
  const t = Date.parse(at);
  return Number.isFinite(t) ? ui.timeLabel(t) : "";
}
function ensureMemoryLoaded() {
  const gid = state.groupId;
  const botId = state.botId;
  if (gid && botId && !memoryLoading.value && !memoryItems.value.length) void actions.loadMemory(gid, botId);
}

/* ---------- 手风琴 / 保存 ---------- */
function toggleAcc(id) {
  state.botAcc = state.botAcc === id ? "" : id;
  if (id === "memory") ensureMemoryLoaded();
}
async function saveIdentityName() {
  const name = readField('.bot-edit input[type="text"]').trim();
  if (!name) return;
  await actions.saveBotProfile({ name });
}
async function saveSoul() {
  await actions.saveBotProfile({ instructions: readField(".bot-edit textarea") });
}
async function resetSoul() {
  clearField(".bot-edit textarea");
  await actions.saveBotProfile({ instructions: "" });
}
async function saveModel() {
  await actions.saveBotProfile({ model: readField('.bot-edit input[type="text"]').trim() });
}
async function followGlobal() {
  clearField('.bot-edit input[type="text"]');
  await actions.saveBotProfile({ model: "" });
}

function pickAvatar() {
  if (avatarFile.value) avatarFile.value.click();
}
async function onAvatarChange(event) {
  const file = (event.target.files || [])[0];
  if (event.target) event.target.value = "";
  if (!file || !state.botOpen || !state.botId) return;
  const data = await actions.uploadAvatar(file);
  if (!data) return;
  const next = await actions.saveBotProfile({ avatar: data });
  if (next) actions.toast("bot 头像已保存");
}

async function toggleMem() {
  const gid = state.groupId;
  const botId = state.botId;
  if (!gid || !botId) return;
  await actions.toggleMemory(gid, botId, !memoryEnabled.value);
}
async function addMem() {
  const gid = state.groupId;
  const botId = state.botId;
  const text = readField(".bot-edit textarea").trim();
  if (!gid || !botId || !text) return;
  const data = await actions.addMemory(gid, botId, text);
  if (data) clearField(".bot-edit textarea");
}
async function delMem(id) {
  const gid = state.groupId;
  const botId = state.botId;
  if (!gid || !botId) return;
  await actions.deleteMemory(gid, botId, id);
}

async function toggleSkill(name) {
  const gid = state.groupId;
  const botId = state.botId;
  if (!gid || !botId) return;
  await actions.toggleBotSkill(gid, botId, name, !skillEnabled(name));
}

function downloadFile(file) {
  const gid = state.groupId;
  const encoded = String(file.path).split("/").map(encodeURIComponent).join("/");
  location.href =
    "/api/groups/" + encodeURIComponent(gid) + "/files/" + encodeURIComponent(file.workId) + "/" + encoded;
}

/* 点外部关闭（旧全局 mousedown 行为：面板互斥） */
function onDocMouseDown(event) {
  if (!state.botOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest("#botPane") ||
    target.closest("#infoPane") ||
    target.closest("#contactsWindow") ||
    target.closest("#picker") ||
    target.closest("#overlay") ||
    target.closest("#menu")
  )
    return;
  if (target.closest("#moreBtn") || target.closest("#groupTitleBtn")) return;
  actions.closeBot();
}
onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));

/* 打开抽屉时加载记忆（后端 E 提供） */
watch(
  () => [state.botOpen, state.botId],
  ([open, id]) => {
    if (open && id) void actions.loadMemory(state.groupId, id);
  }
);
</script>

<template>
  <aside class="bot-pane" id="botPane" :hidden="!state.botOpen" aria-label="bot 设置">
    <input ref="avatarFile" type="file" accept="image/*" hidden @change="onAvatarChange" />
    <div class="bot-scroll" id="botBody">
      <div v-if="!profile" class="settings-empty">加载中…</div>
      <div v-else-if="profile.error" class="settings-empty">加载失败:{{ profile.error }}</div>
      <template v-else>
        <div class="bot-head">
          <Avatar :name="profile.name || profile.id" :seed="profile.id" :avatar="profile.avatar" />
          <div class="bot-head-main">
            <div class="bot-name">{{ profile.name || profile.id }}</div>
            <div class="bot-sub">{{ profile.role === "leader" ? "编排者" : "执行 bot" }} · {{ profile.busy ? "忙碌" : "空闲" }}</div>
          </div>
          <button class="info-close" type="button" title="关闭" aria-label="关闭 bot 设置" @click="actions.closeBot()">
            <Icon :paths="['M6 6l12 12M18 6 6 18']" width="1.8" />
          </button>
        </div>

        <div class="bot-search">
          <Icon :paths="['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'm16 16 4 4']" width="1.8" />
          <input v-model="state.botQuery" type="search" placeholder="搜索" aria-label="搜索设置项" />
        </div>

        <div v-if="!sections.length" class="settings-empty">没有匹配的设置项</div>

        <div v-for="section in sections" :key="section.id" class="bot-acc" :class="{ open: state.botAcc === section.id }">
          <button
            class="bot-acc-head"
            type="button"
            :aria-expanded="state.botAcc === section.id ? 'true' : 'false'"
            @click="toggleAcc(section.id)"
          >
            <Icon :paths="section.icon" width="1.7" class="icon" />
            <span class="bot-acc-label">{{ section.label }}</span>
            <span class="bot-acc-arrow"><Icon :paths="['m6 10 6 6 6-6']" width="1.8" /></span>
          </button>

          <div v-if="state.botAcc === section.id" class="bot-acc-body">
            <!-- 概览 -->
            <template v-if="section.id === 'overview'">
              <dl class="bot-kv">
                <template v-for="pair in overviewKv" :key="pair[0]">
                  <dt>{{ pair[0] }}</dt>
                  <dd>{{ pair[1] }}</dd>
                </template>
              </dl>
              <div v-if="profile.busy" class="bot-note">正在跑任务时改设置,新的提示词/模型从下一轮开始生效。</div>
            </template>

            <!-- 身份 -->
            <template v-else-if="section.id === 'identity'">
              <div class="bot-edit">
                <div class="bot-avatar-row">
                  <Avatar :name="profile.name || profile.id" :seed="profile.id" :avatar="profile.avatar" cls="bot-avatar" />
                  <div class="bot-avatar-main">
                    <div class="creator-label">头像</div>
                    <div class="creator-hint">支持图片;不选图片时用名称首字</div>
                  </div>
                  <button class="btn-text secondary mini" type="button" @click="pickAvatar">更换头像</button>
                </div>
                <div class="settings-field">
                  <label>名字</label>
                  <input
                    type="text"
                    maxlength="24"
                    :value="profile.name || ''"
                    :placeholder="profile.defaultName || profile.id"
                  />
                </div>
                <div class="bot-edit-actions">
                  <button class="btn-text primary mini ready" type="button" @click="saveIdentityName">保存名字</button>
                </div>
              </div>
              <dl class="bot-kv">
                <template v-for="pair in identityKv" :key="pair[0]">
                  <dt>{{ pair[0] }}</dt>
                  <dd>{{ pair[1] }}</dd>
                </template>
              </dl>
              <div class="bot-note">名字和头像全群生效;能力来自 bot 配置,只读。提示词在「提示词」里改。</div>
            </template>

            <!-- 提示词 -->
            <template v-else-if="section.id === 'soul'">
              <div class="bot-edit">
                <textarea rows="6" :placeholder="instructionsDefault" :value="instructionsOverride"></textarea>
                <div class="bot-edit-actions">
                  <button class="btn-text primary mini ready" type="button" @click="saveSoul">保存</button>
                  <button class="btn-text secondary mini" type="button" @click="resetSoul">恢复默认</button>
                </div>
              </div>
              <div class="bot-note">默认提示词:{{ instructionsDefault }}</div>
              <div class="bot-note">{{ instructionsOverride ? "当前用的是本群覆盖版本。" : "当前用的是默认版本;留空保存即恢复默认。" }}</div>
            </template>

            <!-- 模型 -->
            <template v-else-if="section.id === 'model'">
              <div class="bot-edit">
                <input type="text" :placeholder="modelGlobal" :value="modelOverride" />
                <div class="bot-edit-actions">
                  <button class="btn-text primary mini ready" type="button" @click="saveModel">保存</button>
                  <button class="btn-text secondary mini" type="button" @click="followGlobal">跟随全局</button>
                </div>
              </div>
              <dl class="bot-kv">
                <template v-for="pair in modelKv" :key="pair[0]">
                  <dt>{{ pair[0] }}</dt>
                  <dd>{{ pair[1] }}</dd>
                </template>
              </dl>
              <div class="bot-note">只影响本群里的这个 bot;留空保存 = 跟随全局。模型 id 要跟网关 /models 里的一致。</div>
            </template>

            <!-- 工具（技能开关） -->
            <template v-else-if="section.id === 'tools'">
              <div v-if="!availableSkills.length" class="bot-note">还没有安装的技能。把技能放进 ~/.pi/agent/skills 或 bot/.pi/skills 就会出现在这里。</div>
              <template v-for="skill in availableSkills" :key="skill.name">
                <button class="info-row" type="button" @click="toggleSkill(skill.name)">
                  <div class="info-main">
                    <div class="info-label">{{ skill.name }}</div>
                    <div class="info-value">{{ skill.description }}</div>
                  </div>
                  <span class="switch" :class="{ on: skillEnabled(skill.name) }"></span>
                </button>
                <div class="bot-history-time">{{ skillSourceLabel(skill.source) }}</div>
              </template>
              <div class="bot-note">内置工具(read、write_file、bash)由 pi 运行时自带,所有 bot 可用;这里管理的是技能(Skill)。</div>
            </template>

            <!-- 资料库 -->
            <template v-else-if="section.id === 'library'">
              <div v-if="!libraryFiles.length" class="bot-note">这个 bot 在本群还没有交付过文件。</div>
              <button v-for="(file, i) in libraryFiles" :key="i" class="bot-file" type="button" @click="downloadFile(file)">
                <span class="bot-file-name">{{ file.path }}</span>
                <span class="bot-file-size">{{ ui.formatSize(file.bytes) }}</span>
              </button>
            </template>

            <!-- 历史记录 -->
            <template v-else-if="section.id === 'history'">
              <div v-if="!delivered.length" class="bot-note">还没有交付记录。</div>
              <div v-for="(item, i) in delivered" :key="i" class="bot-history-row">
                <div>{{ `${item.key || ""} ${item.subject || ""}`.trim() }}</div>
                <div class="bot-history-time">
                  {{ item.status }}{{ item.files && item.files.length ? ` · ${item.files.length} 个文件` : "" }}
                </div>
              </div>
            </template>

            <!-- 记忆（新增） -->
            <template v-else-if="section.id === 'memory'">
              <button class="info-row" type="button" @click="toggleMem">
                <div class="info-main">
                  <div class="info-label">启用记忆</div>
                  <div class="info-value">
                    {{ memoryEnabled ? "bot 会记住重要信息并在后续任务里使用" : "已关闭,不再记忆也不再读取" }}
                  </div>
                </div>
                <span class="switch" :class="{ on: memoryEnabled }"></span>
              </button>
              <div v-if="memoryLoading" class="bot-note">加载中…</div>
              <div v-else-if="memoryError" class="bot-note">加载失败:{{ memoryError }}</div>
              <template v-else>
                <div v-if="!memoryItems.length" class="bot-note">还没有记忆。可以在下面手动记一条,或在任务完成后自动沉淀。</div>
                <div v-for="m in memoryItems" :key="m.id" class="bot-history-row">
                  <div class="info-pin-row">
                    <span class="info-pin-text">{{ m.text }}</span>
                    <button class="row-action danger" type="button" @click="delMem(m.id)">删除</button>
                  </div>
                  <div class="bot-history-time">{{ m.kind || "note" }} · {{ formatAt(m.at) }}</div>
                </div>
                <div class="bot-edit">
                  <textarea rows="2" placeholder="记一条,例如:本群对外数字统一用 Q3 口径"></textarea>
                  <div class="bot-edit-actions">
                    <button class="btn-text primary mini ready" type="button" @click="addMem">添加</button>
                  </div>
                </div>
              </template>
            </template>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>
