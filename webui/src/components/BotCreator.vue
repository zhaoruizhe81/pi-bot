<script setup>
/* 新建 bot 表单：对照旧 openBotCreator。id 与旧一致：#creatorGlyph / #creatorName /
   #creatorCap / #creatorInstructions + 「创建后加入当前群」复选框；提交走 actions.createBot。
   所有值在提交时从 DOM 读取（与旧一致），避免示例/自动化直改 value 时丢状态。 */
import { computed, ref } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";

const glyphRef = ref(null);
const nameRef = ref(null);
const capRef = ref(null);
const instRef = ref(null);
const joinRef = ref(null);
const errRef = ref(null);

const glyphText = ref("");
const nameText = ref("");
const busy = ref(false);

const group = computed(() => ui.findGroup(state.groupId));
const caps = computed(() => (state.botCapabilities.length ? state.botCapabilities : Object.keys(ui.CAP_LABELS)));
const capValue = ref("");
const defaultCap = computed(() => (caps.value.includes("general") ? "general" : caps.value[0] || "general"));
capValue.value = defaultCap.value;

const previewName = computed(() => nameText.value.trim() || "新");
const previewGlyph = computed(() => glyphText.value.trim());

function capText(value) {
  return ui.CAP_LABELS[value] || value;
}
function showErr(message) {
  if (!errRef.value) return;
  errRef.value.hidden = false;
  errRef.value.textContent = message;
}
function readInput(refEl) {
  return refEl.value && "value" in refEl.value ? refEl.value.value : "";
}

async function cancel() {
  actions.closeSheet();
}

async function create() {
  const botName = readInput(nameRef).trim();
  if (!botName) {
    showErr("名称不能为空");
    if (nameRef.value) nameRef.value.focus();
    return;
  }
  if (errRef.value) errRef.value.hidden = true;
  busy.value = true;
  const payload = {
    name: botName,
    capability: readInput(capRef),
    instructions: readInput(instRef),
    avatar: readInput(glyphRef).trim(),
    groupId: joinRef.value && joinRef.value.checked && group.value ? group.value.id : "",
  };
  const created = await actions.createBot(payload);
  busy.value = false;
  if (created) {
    actions.closeSheet();
    await actions.refreshGroups();
  } else {
    showErr("创建失败,请重试");
  }
}
</script>

<template>
  <div class="sheet-form creator-form">
    <div class="creator-avatar-row">
      <Avatar :name="previewName" seed="creator" :avatar="previewGlyph" cls="creator-avatar" />
      <div class="creator-avatar-main">
        <div class="creator-label">头像</div>
        <div class="creator-hint">填一个 emoji 或字,例如 🧪;留空就用名称首字</div>
      </div>
      <input
        ref="glyphRef"
        id="creatorGlyph"
        v-model="glyphText"
        class="creator-glyph"
        type="text"
        maxlength="4"
        placeholder="首字"
        aria-label="bot 头像字符"
      />
    </div>

    <div class="settings-field">
      <label>名称</label>
      <input
        ref="nameRef"
        id="creatorName"
        v-model="nameText"
        type="text"
        maxlength="24"
        placeholder="例如:调研 bot"
      />
    </div>

    <div class="settings-field">
      <label>能力(领导按这个派活)</label>
      <select ref="capRef" id="creatorCap" v-model="capValue">
        <option v-for="value in caps" :key="value" :value="value">{{ capText(value) }}</option>
      </select>
    </div>

    <div class="settings-field">
      <label>人设 / 指令</label>
      <textarea
        ref="instRef"
        id="creatorInstructions"
        class="sheet-input"
        rows="5"
        placeholder="这个 bot 负责什么、输出什么格式。例如:你是用户调研 bot,负责整理访谈记录并给出 3 条结论。"
      ></textarea>
    </div>

    <label v-if="group" class="creator-join">
      <input ref="joinRef" type="checkbox" checked />
      创建后加入「{{ ui.displayName(group) }}」
    </label>

    <div ref="errRef" class="new-group-err" hidden></div>

    <div class="sheet-actions">
      <button class="btn-text secondary mini" type="button" @click="cancel">取消</button>
      <button class="btn-text primary mini ready" type="button" :disabled="busy" @click="create">
        {{ busy ? "创建中…" : "创建" }}
      </button>
    </div>
  </div>
</template>
