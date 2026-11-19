<script setup>
/* 设置：居中两栏对话框（对照旧 app.js 的 openSettings/closeSettings/renderSettings +
   renderSettingsNav）。左栏：搜索 + 分类导航 + 高级模式 + 版本；右栏：标题/副标题/关闭 + 内容。
   内容按 state.settingsPage 分发到 settings/* 子页组件。 */
import { computed, onMounted, ref, watch } from "vue";
import { state, actions } from "../store.js";
import SettingsIcon from "./settings/SettingsIcon.vue";
import ProfilePage from "./settings/ProfilePage.vue";
import DevicesPage from "./settings/DevicesPage.vue";
import ImPage from "./settings/ImPage.vue";
import AiPage from "./settings/AiPage.vue";
import StatusPage from "./settings/StatusPage.vue";
import DataPage from "./settings/DataPage.vue";
import KeysPage from "./settings/KeysPage.vue";
import AboutPage from "./settings/AboutPage.vue";

const SECTIONS = [
  {
    id: "profile",
    label: "个人资料",
    icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"],
  },
  {
    id: "devices",
    label: "手机和设备",
    icon: ["M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 18h2"],
  },
  {
    id: "im",
    label: "IM 接入",
    icon: ["M4 6h16v10H9l-4 3.5V16H4z"],
  },
  {
    id: "ai",
    label: "AI 模型",
    icon: ["M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3", "M9 9h6v6H9z"],
  },
  {
    id: "status",
    label: "运行状态",
    icon: ["M4 12h4l2-5 3 10 2-5h5"],
  },
  {
    id: "data",
    label: "数据与导出",
    icon: ["M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z", "M5 7v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7"],
  },
  {
    id: "keys",
    label: "快捷键",
    icon: ["M3 8h18v8H3z", "M7 11h.01M11 11h.01M15 11h.01M7 14h10"],
  },
  {
    id: "about",
    label: "关于",
    icon: ["M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z", "M12 10.5v4.5M12 8h.01"],
  },
];

const PAGES = {
  profile: ProfilePage,
  devices: DevicesPage,
  im: ImPage,
  ai: AiPage,
  status: StatusPage,
  data: DataPage,
  keys: KeysPage,
  about: AboutPage,
};

const searchInput = ref(null);

const filteredSections = computed(() => {
  const q = (state.settingsQuery || "").trim().toLowerCase();
  return SECTIONS.filter((s) => !q || s.label.toLowerCase().includes(q));
});

const current = computed(() => SECTIONS.find((s) => s.id === state.settingsPage) || SECTIONS[0]);
const pageComp = computed(() => PAGES[state.settingsPage] || AboutPage);

const subText = computed(() => {
  const page = state.settingsPage;
  if (page === "profile") {
    return `${state.profile.name} · ${state.profile.signature || "还没写个性签名"}`;
  }
  if (page === "im" && state.im) {
    return `群 ${state.im.groupId} · ${state.im.enabled ? "已启用" : "已停用"}`;
  }
  if (page === "devices" && state.devices) {
    return `这台电脑 · ${state.devices.bindHost}`;
  }
  if (page === "ai" && state.settingsStatus) {
    return `适用于 ${state.settingsStatus.groups} 个群 · ${state.settingsStatus.bots} 个 bot`;
  }
  if (page === "status" && state.settingsStatus) {
    return `${state.settingsStatus.mode === "viewer" ? "只读查看" : "写入"} · 127.0.0.1:${state.settingsStatus.port}`;
  }
  return "";
});

const versionText = computed(() =>
  state.settingsStatus
    ? `这个应用 ${state.settingsStatus.version} · ${state.settingsStatus.mode === "viewer" ? "只读" : "写入"}`
    : "这个应用"
);

function selectPage(id) {
  state.settingsPage = id;
}

function toggleAdv() {
  actions.setAdv(!state.settingsAdv);
}

function onSearchKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    state.settingsQuery = "";
    if (searchInput.value) searchInput.value.value = "";
  }
  if (event.key === "Enter") {
    const first = filteredSections.value[0];
    if (first) selectPage(first.id);
  }
}

function reload() {
  actions.loadSettingsData();
  actions.loadDevices();
}

/* 无论 lead 用 v-if 还是常驻挂载，打开时都刷新一次数据。 */
watch(
  () => state.settingsOpen,
  (open) => {
    if (open) reload();
  }
);

onMounted(() => {
  if (state.settingsOpen) reload();
});
</script>

<template>
  <div
    :hidden="!state.settingsOpen"
    class="settings"
    id="settings"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settingsTitle"
  >
    <div class="settings-left">
      <div class="settings-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="6.2" />
          <path d="m16 16 4 4" stroke-linecap="round" />
        </svg>
        <input
          id="settingsSearch"
          ref="searchInput"
          v-model="state.settingsQuery"
          type="search"
          placeholder="搜索设置"
          autocomplete="off"
          aria-label="搜索设置"
          @keydown="onSearchKeydown"
        />
        <span class="settings-kbd">/</span>
      </div>

      <div class="settings-nav" id="settingsNav" role="tablist" aria-label="设置分类">
        <button
          v-for="section in filteredSections"
          :key="section.id"
          class="settings-nav-item"
          :class="{ on: section.id === state.settingsPage }"
          type="button"
          role="tab"
          :aria-selected="section.id === state.settingsPage ? 'true' : 'false'"
          @click="selectPage(section.id)"
        >
          <SettingsIcon :paths="section.icon" width="1.7" />
          <span>{{ section.label }}</span>
        </button>
        <div v-if="!filteredSections.length" class="settings-empty">没有匹配的设置项</div>
      </div>

      <div class="settings-foot">
        <button class="settings-adv" :class="{ on: state.settingsAdv }" type="button" id="settingsAdv" @click="toggleAdv">
          <span>高级模式</span>
          <span class="switch" :class="{ on: state.settingsAdv }"></span>
        </button>
        <div class="settings-version" id="settingsVersion">{{ versionText }}</div>
      </div>
    </div>

    <div class="settings-right">
      <div class="settings-head">
        <div class="settings-head-main">
          <div class="settings-title" id="settingsTitle">{{ current.label }}</div>
          <div class="settings-sub" id="settingsSub">{{ subText }}</div>
        </div>
        <button class="info-close" type="button" id="settingsClose" title="关闭" aria-label="关闭设置" @click="actions.closeSettings()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="settings-body" id="settingsBody">
        <component :is="pageComp" />
      </div>
    </div>
  </div>
</template>
