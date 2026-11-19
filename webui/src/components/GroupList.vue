<script setup>
/* 群列表：对照旧 renderGroups / groupRow / botListSection。
   DOM/class 与旧一致：.list-body#groupList > .row(.active/.pinned)、.pin-summary、.bot-section。 */
import { computed } from "vue";
import { state, actions, ui } from "../store.js";
import GroupAvatar from "./GroupAvatar.vue";
import Avatar from "./Avatar.vue";
import Icon from "./Icon.vue";

const q = computed(() => state.search.trim().toLowerCase());

const allGroups = computed(() =>
  state.groups.filter((g) => !q.value || ui.displayName(g).toLowerCase().includes(q.value))
);
const pinnedIds = computed(() => state.pins.filter((id) => state.groups.some((g) => g.id === id)));
const pinnedGroups = computed(() => pinnedIds.value.map((id) => ui.findGroup(id)).filter(Boolean));
const restGroups = computed(() => allGroups.value.filter((g) => !pinnedIds.value.includes(g.id)));

const botsFiltered = computed(() =>
  state.bots.filter((bot) => {
    if (!q.value) return true;
    const caps = Array.isArray(bot.capabilities) ? bot.capabilities.join(" ") : "";
    return `${bot.name || bot.id} ${caps}`.toLowerCase().includes(q.value);
  })
);

const roster = computed(() => new Set((ui.findGroup(state.groupId) || {}).roster || []));

function rowTime(g) {
  const last = ui.lastOf(g.id);
  return last ? ui.timeLabel(last.at) : "";
}
function rowSum(g) {
  return ui.summaryOfLast(ui.lastOf(g.id)) || "暂无消息";
}
function rowUnread(g) {
  return ui.unreadOf(g.id);
}
function onRowKey(g, event) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    actions.selectGroup(g.id);
  }
}
function onBotRow(bot) {
  if (state.groupId && roster.value.has(bot.id)) actions.openBot(state.groupId, bot.id);
  else actions.openContacts(bot.id);
}
function botCap(bot) {
  return (bot.capabilities || []).join(" · ") || bot.role || "bot";
}
</script>

<template>
  <div class="list-body" id="groupList" role="listbox" aria-label="群列表">
    <!-- 加载中 -->
    <div v-if="!state.groupsLoaded" class="list-empty">加载中…</div>

    <!-- 还没有群 -->
    <template v-else-if="!state.groups.length">
      <div class="list-empty">还没有群</div>
      <div class="bot-section" v-if="botsFiltered.length">
        <div class="bot-section-head" role="button" tabindex="0" :title="state.botsCollapsed ? '展开我的 bot' : '折叠我的 bot'" @click="actions.toggleBotsCollapse()">
          <span class="bot-section-icon">☰</span>
          <span class="bot-section-title">我的 bot</span>
          <span class="bot-section-count">{{ botsFiltered.length }}</span>
          <button class="bot-section-add" type="button" title="新建 bot" aria-label="新建 bot" @click.stop="actions.openBotCreator()">+</button>
          <span class="bot-section-chevron">{{ state.botsCollapsed ? "⌄" : "⌃" }}</span>
        </div>
        <template v-if="!state.botsCollapsed">
          <button v-for="bot in botsFiltered" :key="bot.id" class="bot-row" type="button" @click="onBotRow(bot)">
            <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
            <span class="bot-row-main">
              <span class="bot-row-name">{{ bot.name || bot.id }}</span>
              <span class="bot-row-cap">{{ botCap(bot) }}</span>
            </span>
            <span class="bot-row-state" v-if="roster.has(bot.id)">在群里</span>
          </button>
        </template>
      </div>
    </template>

    <!-- 没有匹配的群 -->
    <template v-else-if="!allGroups.length">
      <div class="list-empty">没有匹配的群</div>
      <div class="bot-section" v-if="botsFiltered.length">
        <div class="bot-section-head" role="button" tabindex="0" :title="state.botsCollapsed ? '展开我的 bot' : '折叠我的 bot'" @click="actions.toggleBotsCollapse()">
          <span class="bot-section-icon">☰</span>
          <span class="bot-section-title">我的 bot</span>
          <span class="bot-section-count">{{ botsFiltered.length }}</span>
          <button class="bot-section-add" type="button" title="新建 bot" aria-label="新建 bot" @click.stop="actions.openBotCreator()">+</button>
          <span class="bot-section-chevron">{{ state.botsCollapsed ? "⌄" : "⌃" }}</span>
        </div>
        <template v-if="!state.botsCollapsed">
          <button v-for="bot in botsFiltered" :key="bot.id" class="bot-row" type="button" @click="onBotRow(bot)">
            <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
            <span class="bot-row-main">
              <span class="bot-row-name">{{ bot.name || bot.id }}</span>
              <span class="bot-row-cap">{{ botCap(bot) }}</span>
            </span>
            <span class="bot-row-state" v-if="roster.has(bot.id)">在群里</span>
          </button>
        </template>
      </div>
    </template>

    <!-- 正常列表 -->
    <template v-else>
      <!-- 置顶摘要 -->
      <template v-if="pinnedGroups.length">
        <button class="pin-summary" type="button" :aria-expanded="state.pinsCollapsed ? 'false' : 'true'" @click="actions.togglePinsCollapse()">
          <span class="pin-summary-icon"><Icon :paths="['M4 7h16M4 12h16M4 17h16']" width="1.5" /></span>
          <span class="pin-summary-text">{{ pinnedGroups.length }}个置顶聊天</span>
          <span class="pin-summary-chevron"><Icon :paths="['m7 10 5 5 5-5']" width="1.6" /></span>
        </button>
        <template v-if="!state.pinsCollapsed">
          <div
            v-for="g in pinnedGroups"
            :key="'pin-' + g.id"
            class="row"
            :class="{ active: g.id === state.groupId, pinned: true }"
            role="option"
            :aria-selected="g.id === state.groupId ? 'true' : 'false'"
            tabindex="0"
            :data-id="g.id"
            :title="ui.displayName(g)"
            @click="actions.selectGroup(g.id)"
            @keydown="onRowKey(g, $event)"
            @contextmenu.prevent="actions.openGroupMenu(g, $event.clientX, $event.clientY)"
          >
            <GroupAvatar :group="g" />
            <span class="row-main">
              <span class="row-top">
                <span class="row-name">{{ ui.displayName(g) }}</span>
                <span class="row-time">{{ rowTime(g) }}</span>
              </span>
              <span class="row-bottom">
                <span class="row-sum">{{ rowSum(g) }}</span>
                <span v-if="g.type === 'dm'" class="row-badge">私聊</span>
                <span v-if="rowUnread(g) > 0" class="row-badge" :class="{ dot: ui.isMuted(g.id) }">{{ ui.isMuted(g.id) ? "" : "1" }}</span>
              </span>
            </span>
          </div>
          <div class="pin-gap" v-if="restGroups.length"></div>
        </template>
      </template>

      <!-- 其余群 -->
      <div
        v-for="g in restGroups"
        :key="g.id"
        class="row"
        :class="{ active: g.id === state.groupId }"
        role="option"
        :aria-selected="g.id === state.groupId ? 'true' : 'false'"
        tabindex="0"
        :data-id="g.id"
        :title="ui.displayName(g)"
        @click="actions.selectGroup(g.id)"
        @keydown="onRowKey(g, $event)"
        @contextmenu.prevent="actions.openGroupMenu(g, $event.clientX, $event.clientY)"
      >
        <GroupAvatar :group="g" />
        <span class="row-main">
          <span class="row-top">
            <span class="row-name">{{ ui.displayName(g) }}</span>
            <span class="row-time">{{ rowTime(g) }}</span>
          </span>
          <span class="row-bottom">
            <span class="row-sum">{{ rowSum(g) }}</span>
            <span v-if="g.type === 'dm'" class="row-badge">私聊</span>
            <span v-if="rowUnread(g) > 0" class="row-badge" :class="{ dot: ui.isMuted(g.id) }">{{ ui.isMuted(g.id) ? "" : "1" }}</span>
          </span>
        </span>
      </div>

      <!-- 我的 bot -->
      <div class="bot-section" v-if="botsFiltered.length">
        <div class="bot-section-head" role="button" tabindex="0" :title="state.botsCollapsed ? '展开我的 bot' : '折叠我的 bot'" @click="actions.toggleBotsCollapse()">
          <span class="bot-section-icon">☰</span>
          <span class="bot-section-title">我的 bot</span>
          <span class="bot-section-count">{{ botsFiltered.length }}</span>
          <button class="bot-section-add" type="button" title="新建 bot" aria-label="新建 bot" @click.stop="actions.openBotCreator()">+</button>
          <span class="bot-section-chevron">{{ state.botsCollapsed ? "⌄" : "⌃" }}</span>
        </div>
        <template v-if="!state.botsCollapsed">
          <button
            v-for="bot in botsFiltered"
            :key="bot.id"
            class="bot-row"
            type="button"
            :title="`${bot.name || bot.id}${bot.capabilities && bot.capabilities.length ? ' · ' + bot.capabilities.join('/') : ''}`"
            @click="onBotRow(bot)"
          >
            <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
            <span class="bot-row-main">
              <span class="bot-row-name">{{ bot.name || bot.id }}</span>
              <span class="bot-row-cap">{{ botCap(bot) }}</span>
            </span>
            <span class="bot-row-state" v-if="roster.has(bot.id)">在群里</span>
          </button>
        </template>
      </div>
    </template>
  </div>
</template>
