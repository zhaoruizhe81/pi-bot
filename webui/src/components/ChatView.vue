<script setup>
/* ChatView —— 旧 renderHeader + 聊天区骨架（<section class="chat" id="chat">）。
   header（群名/成员数/搜索/更多/返回/抽屉）+ 断线 banner + 消息搜索条 +
   <MessageStream/> + <Composer/>。点群名 / 更多 → actions.toggleInfo()。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { state, actions, ui } from "../store.js";
import MessageStream from "./MessageStream.vue";
import Composer from "./Composer.vue";
import InfoPane from "./InfoPane.vue";
import BotPane from "./BotPane.vue";

const searchOpen = ref(false);
const searchText = ref("");
const searchInputEl = ref(null);

const group = computed(() => ui.findGroup(state.groupId));
const title = computed(() => (group.value ? ui.displayName(group.value) : "—"));
/* DM 会话（群文档 type === "dm"）：标题照常显示群名（=bot 名），不显示成员数徽标。
   normalizeGroup 目前不透传 type，兜底再查详情缓存里的原始群文档。 */
function isDmGroup(g) {
  if (g && g.type === "dm") return true;
  const detail = g ? state.detailByGroup[g.id] : null;
  return !!(detail && detail.group && detail.group.type === "dm");
}

const memberCount = computed(() => {
  if (!group.value || isDmGroup(group.value)) return "";
  return group.value.roster.length + " 个成员";
});

/* booting 由 store 在首帧到达时置 false；此时 WS 正常已连接，避免启动瞬间闪 banner。 */
const showBanner = computed(() => !!state.groupId && !state.connected && !state.booting);

const searchCount = computed(() => {
  const q = ui.str(state.msgSearch).trim();
  return q ? state.filterCount + " 条匹配" : "";
});

watch(
  title,
  () => {
    const g = group.value;
    document.title = g ? g.name + " · musebot" : "musebot";
  },
  { immediate: true }
);

function toggleDrawer() {
  if (state.drawerOpen) actions.closeDrawer();
  else actions.openDrawer();
}

function openSearch() {
  searchOpen.value = true;
  searchText.value = "";
  actions.setMsgSearch("");
  nextTick(() => searchInputEl.value && searchInputEl.value.focus());
}

function closeSearch() {
  searchOpen.value = false;
  searchText.value = "";
  actions.setMsgSearch("");
  const input = document.getElementById("input");
  if (input) input.focus();
}

function onSearchInput() {
  actions.setMsgSearch(searchText.value);
}

function onKeydown(event) {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (event.key === "Escape" && searchOpen.value) {
    event.preventDefault();
    closeSearch();
  }
}

/* ===== 拖拽发文件 ===== */
/* 根容器统一接收：消息流 / 输入区都在 chat 内，drop 冒泡到这里只处理一次。
   dragenter/dragleave 会在子元素间成对触发，用深度计数判断是否真的离开，
   避免误判；不做视觉高亮，反馈沿用 sendFileNow 内的 toast。
   文件夹条目（type 为空且 size 为 0）与空列表忽略。 */
let dragDepth = 0;

function isImageFile(file) {
  return typeof file.type === "string" && file.type.startsWith("image/");
}

function onDragEnter() {
  dragDepth += 1;
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
}

function onDrop(event) {
  event.preventDefault();
  dragDepth = 0;
  const files = event.dataTransfer && event.dataTransfer.files;
  if (!state.groupId || !files || !files.length) return;
  const list = Array.from(files).filter((file) => file && !(file.type === "" && file.size === 0));
  void sendDroppedFiles(list);
}

async function sendDroppedFiles(list) {
  for (const file of list) {
    await actions.sendFileNow(file, isImageFile(file));
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <section
    class="chat"
    id="chat"
    aria-label="聊天"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <header class="chat-head">
      <div class="chat-head-left">
        <button class="icon-btn back" type="button" id="backBtn" title="返回" aria-label="返回列表" @click="actions.setView('list')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M14.5 5.5 8 12l6.5 6.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="icon-btn" type="button" id="drawerBtn" title="群列表" aria-label="群列表" @click="toggleDrawer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="chat-title">
        <button class="chat-name" type="button" id="groupTitleBtn" aria-haspopup="dialog" @click="actions.toggleInfo()">
          {{ title }}
        </button>
        <span class="chat-sub" id="memberCount">{{ memberCount }}</span>
      </div>
      <div class="chat-head-actions">
        <button class="icon-btn" type="button" id="searchMsgBtn" title="搜索消息 (⌘F)" aria-label="搜索消息" @click="openSearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="6.2" />
            <path d="m16 16 4 4" stroke-linecap="round" />
          </svg>
        </button>
        <button class="icon-btn" type="button" id="moreBtn" title="更多" aria-label="更多" aria-haspopup="menu" @click="actions.toggleInfo()">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="6" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="18" cy="12" r="1.5" />
          </svg>
        </button>
      </div>
    </header>

    <div class="banner" id="connBanner" :hidden="!showBanner">连接已断开,正在重连…</div>

    <div class="msg-search" id="msgSearch" :hidden="!searchOpen">
      <div class="field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="6.2" />
          <path d="m16 16 4 4" stroke-linecap="round" />
        </svg>
        <input
          id="msgSearchInput"
          ref="searchInputEl"
          v-model="searchText"
          type="search"
          placeholder="搜索当前群消息"
          autocomplete="off"
          aria-label="搜索当前群消息"
          @input="onSearchInput"
          @keydown.esc.prevent="closeSearch"
        />
      </div>
      <span class="count" id="msgSearchCount">{{ searchCount }}</span>
      <button class="icon-btn" type="button" id="msgSearchClose" title="关闭搜索" aria-label="关闭搜索" @click="closeSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <MessageStream />
    <Composer />

    <!-- 右侧面板常驻挂载（内部用 :hidden 控制显隐），测试按 id 读取 .hidden -->
    <InfoPane />
    <BotPane />
  </section>
</template>
