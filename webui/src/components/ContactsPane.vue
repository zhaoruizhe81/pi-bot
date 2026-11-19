<script setup>
/* 通讯录：对照旧 openContactsPane / closeContactsPane / renderContactsPane /
   renderContactDetail / contactAction / contactGroups。两栏 #contactsWindow：
   左搜索 + 通讯录管理 + bot 列表，右头像资料 + 发消息 / 打开设置 / 加入本群。 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";
import Icon from "./Icon.vue";

const group = computed(() => ui.findGroup(state.groupId));
const roster = computed(() => new Set((ui.findGroup(state.groupId) || {}).roster || []));

const filtered = computed(() => {
  const q = state.contactsQuery.trim().toLowerCase();
  const list = state.bots;
  if (!q) return list;
  return list.filter((bot) => {
    const caps = Array.isArray(bot.capabilities) ? bot.capabilities.join(" ") : "";
    return `${bot.name || bot.id} ${caps}`.toLowerCase().includes(q);
  });
});

const selected = computed(
  () => filtered.value.find((b) => ui.str(b.id) === ui.str(state.contactsSelected)) || filtered.value[0] || null
);

function capLabel(bot) {
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.map((cap) => ui.CAP_TEXT[cap] || cap).join(" · ") || bot.role || "bot";
}
function capsText(bot) {
  const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
  return caps.map((cap) => ui.CAP_TEXT[cap] || cap).join(" · ") || "—";
}
function groupsOf(bot) {
  return state.groups.filter((g) => (g.roster || []).includes(bot.id));
}

function select(bot) {
  state.contactsSelected = bot.id;
}
function toggleManage() {
  state.contactsManage = !state.contactsManage;
}
function editBot(bot) {
  if (!roster.value.has(bot.id)) {
    actions.toast("先把这个 bot 加入本群");
    return;
  }
  actions.closeContacts();
  actions.openBot(state.groupId, bot.id);
}
function sendMsg(bot) {
  actions.openDm(bot.id);
}
async function joinGroup(bot) {
  if (!state.groupId) return;
  const next = await actions.addMember(state.groupId, bot.id);
  if (next) actions.toast(`已把「${bot.name || bot.id}」加入本群`);
}

function onDocMouseDown(event) {
  if (!state.contactsOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("#contactsWindow") || target.closest("#overlay") || target.closest("#menu")) return;
  if (target.closest("#railContacts")) return;
  actions.closeContacts();
}
onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <div
    class="contacts-window"
    id="contactsWindow"
    :hidden="!state.contactsOpen"
    role="dialog"
    aria-modal="true"
    aria-label="通讯录"
  >
    <div class="contacts-left">
      <div class="contacts-search">
        <Icon :paths="['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'm16 16 4 4']" width="1.8" />
        <input
          id="contactsSearch"
          v-model="state.contactsQuery"
          type="search"
          placeholder="搜索"
          autocomplete="off"
          aria-label="搜索通讯录"
        />
      </div>
      <button class="contacts-manage" :class="{ on: state.contactsManage }" type="button" id="contactsManage" @click="toggleManage">
        <Icon
          :paths="[
            'M9 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
            'M16 9a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
            'M3.5 20c.5-3.2 2.6-5.2 5.5-5.2s5 2 5.5 5.2M14.5 15c2.8-.6 5.3 1 6 4',
          ]"
          width="1.6"
        />
        <span id="contactsManageText">{{ state.contactsManage ? "完成管理" : "通讯录管理" }}</span>
      </button>
      <div class="contacts-list" id="contactsList" role="listbox" aria-label="bot 通讯录">
        <div class="contacts-section">我的 bot ({{ filtered.length }})</div>
        <div v-if="!filtered.length" class="contacts-empty">
          {{ state.contactsQuery ? "没有匹配的 bot" : "还没有 bot" }}
        </div>
        <button
          v-for="bot in filtered"
          :key="bot.id"
          class="contacts-item"
          :class="{ active: selected && selected.id === bot.id }"
          type="button"
          role="option"
          :aria-selected="selected && selected.id === bot.id ? 'true' : 'false'"
          @click="select(bot)"
        >
          <Avatar :name="bot.name || bot.id" :seed="bot.id" :avatar="bot.avatar" />
          <div class="contacts-item-main">
            <div class="contacts-item-name">{{ bot.name || bot.id }}</div>
            <div class="contacts-item-cap">{{ capLabel(bot) }}</div>
          </div>
          <button v-if="state.contactsManage" class="contact-item-edit" type="button" @click.stop="editBot(bot)">
            设置
          </button>
        </button>
      </div>
    </div>
    <div class="contacts-right">
      <button class="info-close contacts-close" type="button" id="contactsClose" title="关闭" aria-label="关闭通讯录" @click="actions.closeContacts()">
        <Icon :paths="['M6 6l12 12M18 6 6 18']" width="1.8" />
      </button>
      <div class="contacts-detail" id="contactsDetail">
        <div v-if="!selected" class="contacts-empty">从左边选择一个 bot</div>
        <template v-else>
          <div class="contacts-detail-head">
            <Avatar :name="selected.name || selected.id" :seed="selected.id" :avatar="selected.avatar" />
            <div class="contacts-detail-main">
              <div class="contacts-detail-name">{{ selected.name || selected.id }}</div>
              <div class="contacts-detail-id">bot id:{{ selected.id }}</div>
            </div>
          </div>

          <div class="contacts-detail-section">bot 资料</div>
          <dl class="contacts-detail-kv">
            <dt>能力</dt>
            <dd>{{ capsText(selected) }}</dd>
            <dt>所在群</dt>
            <dd>{{ groupsOf(selected).map((item) => item.name).join("、") || "不在任何群" }}</dd>
            <dt>来源</dt>
            <dd>{{ selected.custom ? "用户创建" : "系统内置" }}</dd>
          </dl>

          <div class="contacts-detail-section">更多信息</div>
          <dl class="contacts-detail-kv">
            <dt>接单方式</dt>
            <dd>按能力匹配;同一时间只跑一件</dd>
            <dt>在群里</dt>
            <dd>{{ roster.has(selected.id) ? "是" : "否" }}</dd>
          </dl>

          <div class="contacts-actions">
            <button class="contacts-action" type="button" @click="sendMsg(selected)">
              <Icon :paths="['M4 5h16v11H9l-4 3V16H4z']" width="1.7" />
              <span>发消息</span>
            </button>
            <button
              v-if="group && !roster.has(selected.id)"
              class="contacts-action"
              type="button"
              @click="joinGroup(selected)"
            >
              <Icon :paths="['M12 5v14', 'M5 12h14']" width="1.7" />
              <span>加入本群</span>
            </button>
            <button
              v-if="group && roster.has(selected.id)"
              class="contacts-action"
              type="button"
              @click="editBot(selected)"
            >
              <Icon :paths="['M4 19V9M9 19V5M14 19v-7M19 19v-4']" width="1.7" />
              <span>打开设置</span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
