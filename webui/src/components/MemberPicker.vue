<script setup>
/* 添加群成员：对照旧 openMemberPicker / renderPicker / submitPicker / pickerCandidates /
   closePicker。居中双栏弹窗 #picker：左搜索 + 多选，右已选列表 + 计数 + 底部按钮。
   候选 = 还没在本群的 bot（roster 来自 detail 缓存）。 */
import { computed } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";
import Icon from "./Icon.vue";

const candidates = computed(() => {
  const gid = state.groupId;
  const g = ui.findGroup(gid);
  const d = gid ? state.detailByGroup[gid] : null;
  const members =
    d && Array.isArray(d.members) && d.members.length
      ? d.members
      : (g ? g.roster : []).map((id) => ({ id, name: ui.botName(id) }));
  const roster = new Set(members.map((m) => ui.str(m.id)));
  const all = state.bots.length
    ? state.bots
    : Object.entries(ui.BOT_META).map(([id, meta]) => ({
        id,
        name: meta.name,
        capabilities: [meta.cap],
        role: "worker",
      }));
  const free = all.filter((b) => !roster.has(ui.str(b.id)));
  const q = state.pickerQuery.trim().toLowerCase();
  return q ? free.filter((b) => ui.str(b.name || b.id).toLowerCase().includes(q)) : free;
});

const pickedSet = computed(() => new Set(state.pickerPicked.map((id) => ui.str(id)))); // ids are strings already; keep str() for safety

const chosen = computed(() =>
  state.pickerPicked
    .map((id) => state.bots.find((b) => ui.str(b.id) === ui.str(id)) || { id: ui.str(id), name: ui.botName(id) })
    .filter(Boolean)
);

const okLabel = computed(() =>
  chosen.value.length ? `添加${chosen.value.length > 1 ? `(${chosen.value.length})` : ""}` : "添加"
);

function pickCap(bot) {
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.length ? caps.join(" · ") : bot.role || "成员";
}

function togglePick(id) {
  const key = ui.str(id);
  const i = state.pickerPicked.indexOf(key);
  if (i >= 0) state.pickerPicked.splice(i, 1);
  else state.pickerPicked.push(key);
}
function removePick(id) {
  const key = ui.str(id);
  const i = state.pickerPicked.indexOf(key);
  if (i >= 0) state.pickerPicked.splice(i, 1);
}
function newBot() {
  actions.closePicker();
  actions.openBotCreator();
}

async function submit() {
  const gid = state.groupId;
  const ids = state.pickerPicked.slice();
  if (!gid || !ids.length) return;
  const res = await actions.addMembers(gid, ids);
  const added = res && res.added ? res.added : 0;
  actions.closePicker();
  if (added) {
    actions.toast(`已加入 ${added} 个成员`);
    const detail = await actions.loadDetail(gid, true);
    actions.applyDetail(gid, detail);
  }
}
</script>

<template>
  <div
    class="picker"
    id="picker"
    :hidden="!state.pickerOpen"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pickerTitle"
  >
    <div class="picker-left">
      <div class="picker-search">
        <Icon :paths="['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'm16 16 4 4']" width="1.8" />
        <input
          id="pickerSearch"
          v-model="state.pickerQuery"
          type="search"
          placeholder="搜索"
          autocomplete="off"
          aria-label="搜索可加入的成员"
        />
      </div>
      <div class="picker-group">
        <span class="picker-group-name">可选成员</span>
        <span class="picker-group-count" id="pickerGroupCount">{{
          candidates.length ? `${candidates.length} 个可加入` : ""
        }}</span>
        <button class="picker-new" type="button" id="pickerNew" @click="newBot">+ 新建 bot</button>
      </div>
      <div class="picker-list" id="pickerList" role="listbox" aria-multiselectable="true">
        <div v-if="!candidates.length" class="picker-empty">
          {{ state.pickerQuery ? "没有匹配的成员" : "所有 bot 都已在群里" }}
        </div>
        <button
          v-for="bot in candidates"
          :key="bot.id"
          class="pick-row"
          :class="{ on: pickedSet.has(ui.str(bot.id)) }"
          type="button"
          role="option"
          :aria-selected="pickedSet.has(ui.str(bot.id)) ? 'true' : 'false'"
          @click="togglePick(bot.id)"
        >
          <span class="pick-check">
            <Icon v-if="pickedSet.has(ui.str(bot.id))" :paths="['m5 9 2.5 2.5L13 7']" width="2.4" />
          </span>
          <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
          <div class="pick-main">
            <div class="pick-name">{{ bot.name || bot.id }}</div>
            <div class="pick-cap">{{ pickCap(bot) }}</div>
          </div>
        </button>
      </div>
    </div>
    <div class="picker-right">
      <div class="picker-head">
        <span class="picker-title" id="pickerTitle">添加群成员</span>
        <span class="picker-count" id="pickerCount">{{
          chosen.length ? `已选择 ${chosen.length} 个联系人` : "未选择"
        }}</span>
      </div>
      <div class="picker-chosen" id="pickerChosen">
        <div v-if="!chosen.length" class="picker-empty">从左侧勾选要加入的 bot</div>
        <div v-for="bot in chosen" :key="bot.id" class="chosen-row">
          <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
          <span class="chosen-name">{{ bot.name || bot.id }}</span>
          <button
            class="chosen-del"
            type="button"
            title="移除"
            :aria-label="'移除 ' + (bot.name || bot.id)"
            @click="removePick(bot.id)"
          >
            <Icon :paths="['M6 6l12 12M18 6 6 18']" width="1.8" />
          </button>
        </div>
      </div>
      <div class="picker-foot">
        <button class="picker-cancel" type="button" id="pickerCancel" @click="actions.closePicker()">取消</button>
        <button class="picker-ok" type="button" id="pickerOk" :disabled="!chosen.length" @click="submit">
          {{ okLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
