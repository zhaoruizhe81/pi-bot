<script setup>
/* 三栏外壳：对照旧 index.html 的 <div class="app"> + 浮层。
   - rail / list / chat 三个容器
   - 全局浮层：menu / toast（本文件实现）；overlay 容器留给后续任务的
     FilePreview / Sheet / SettingsDialog / ContactsPane / Picker 集成
   chat 区（ChatView）由 task-B 提供，先用占位，集成时把 <ChatView/> 放进来。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { state, actions } from "./store.js";
import Rail from "./components/Rail.vue";
import GroupList from "./components/GroupList.vue";
import NewGroupForm from "./components/NewGroupForm.vue";
import ChatView from "./components/ChatView.vue";
import ContactsPane from "./components/ContactsPane.vue";
import MemberPicker from "./components/MemberPicker.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import Sheet from "./components/Sheet.vue";
import FilePreview from "./components/FilePreview.vue";

const searchInput = ref(null);
const menuEl = ref(null);
const newGroupBtn = ref(null);
const menuPos = ref({ left: 0, top: 0 });

const overlayOn = computed(
  () => state.settingsOpen || state.contactsOpen || state.pickerOpen || !!state.sheet || !!state.filePreview
);

watch(
  () => state.menu,
  async (m) => {
    if (!m) return;
    menuPos.value = { left: m.x, top: m.y };
    await nextTick();
    clampMenu();
  }
);

function clampMenu() {
  const el = menuEl.value;
  if (!el || !state.menu) return;
  const rect = el.getBoundingClientRect();
  const left = Math.min(state.menu.x, window.innerWidth - rect.width - 8);
  const top = Math.min(state.menu.y, window.innerHeight - rect.height - 8);
  menuPos.value = { left: Math.max(8, left), top: Math.max(8, top) };
}

function runItem(item) {
  actions.closeMenu();
  if (item && typeof item.run === "function") {
    try {
      const r = item.run();
      if (r && typeof r.catch === "function") r.catch((e) => console.error(e));
    } catch (e) {
      console.error(e);
    }
  }
}

function openNewMenu() {
  const el = newGroupBtn.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  actions.openMenuAt(rect.left, rect.bottom + 6, [
    { label: "新建群", run: actions.openNewGroup },
    { label: "新建 bot", run: actions.openBotCreator },
  ]);
}

function onDocMouseDown(event) {
  if (!state.menu) return;
  if (menuEl.value && menuEl.value.contains(event.target)) return;
  actions.closeMenu();
}

/* 点浮层空白处：关掉文件预览/通用 sheet（设置/通讯录/添加成员各自有打开态，不因点空白误关）。 */
function onOverlayBackdrop() {
  if (state.filePreview) actions.closeFilePreview();
  if (state.sheet) actions.closeSheet();
}

function onKeydown(event) {
  if (event.key === "Escape") {
    actions.closeAll();
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (searchInput.value) {
      searchInput.value.focus();
      searchInput.value.select();
    }
  }
}

function onResize() {
  if (window.innerWidth > 560) actions.setView("list");
  if (window.innerWidth > 900) actions.closeDrawer();
}

onMounted(() => {
  window.addEventListener("mousedown", onDocMouseDown);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onResize);
  actions.boot();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onDocMouseDown);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div class="app" id="app" :data-view="state.view" :class="{ 'list-open': state.drawerOpen }">
    <!-- rail -->
    <Rail />

    <!-- 群列表 -->
    <aside class="list" aria-label="群列表">
      <div class="list-head">
        <label class="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="6.2" />
            <path d="m16 16 4 4" stroke-linecap="round" />
          </svg>
          <input
            id="searchInput"
            ref="searchInput"
            v-model="state.search"
            type="search"
            placeholder="搜索"
            autocomplete="off"
            aria-label="搜索群"
          />
        </label>
        <button class="icon-btn" type="button" id="newGroupBtn" title="新建群" aria-label="新建群" ref="newGroupBtn" @click="openNewMenu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <path d="M12 6v12M6 12h12" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <NewGroupForm />

      <GroupList />
    </aside>
    <div class="list-backdrop" id="listBackdrop" @click="actions.closeDrawer()"></div>

    <!-- 聊天（ChatView 自身就是 <section class="chat" id="chat">，含 InfoPane/BotPane） -->
    <ChatView :key="state.groupId || 'none'" />
  </div>

  <!-- 浮层 -->
  <div class="overlay" id="overlay" :hidden="!overlayOn" @mousedown.self="onOverlayBackdrop">
    <!-- 常驻挂载，内部 :hidden 控制显隐（测试按 id 读 .hidden） -->
    <ContactsPane />
    <MemberPicker />
    <SettingsDialog />
    <Sheet v-if="state.sheet" />
    <FilePreview v-if="state.filePreview" />
  </div>

  <!-- 全局菜单 -->
  <div
    class="menu"
    id="menu"
    ref="menuEl"
    v-show="!!state.menu"
    role="menu"
    :style="{ left: menuPos.left + 'px', top: menuPos.top + 'px' }"
  >
    <template v-for="(item, i) in state.menu ? state.menu.items : []" :key="i">
      <div v-if="item.sep" class="sep"></div>
      <button
        v-else
        type="button"
        role="menuitem"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="runItem(item)"
      >
        {{ item.label }}
      </button>
    </template>
  </div>

  <!-- 全局 toast -->
  <div class="toast" id="toast" v-show="!!state.toast" role="status">{{ state.toast ? state.toast.text : "" }}</div>
</template>
