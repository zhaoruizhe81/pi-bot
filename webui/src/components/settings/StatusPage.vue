<script setup>
/* 运行状态页（对照旧 renderStatusSettings）。 */
import { computed } from "vue";
import { state } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
import SettingsKv from "./SettingsKv.vue";

const status = computed(() => state.settingsStatus);

const human = computed(() => {
  const uptime = Number((status.value && status.value.uptimeMs) || 0);
  const mins = Math.floor(uptime / 60000);
  return mins >= 60
    ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`
    : `${mins} 分 ${Math.floor((uptime % 60000) / 1000)} 秒`;
});

const startedText = computed(() =>
  status.value ? new Date(status.value.startedAt).toLocaleString("zh-CN", { hour12: false }) : ""
);
</script>

<template>
  <div v-if="!status" class="settings-empty">加载中…</div>
  <template v-else>
    <div class="settings-section">进程</div>
    <SettingsCard>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-name">{{ status.mode === "viewer" ? "只读查看进程" : "写入进程" }}</div>
          <div class="settings-row-state">127.0.0.1:{{ status.port }} · 已运行 {{ human }}</div>
        </div>
      </div>
    </SettingsCard>
    <SettingsKv
      :pairs="[
        ['数据库', status.storage],
        ['归档目录', status.archiveRoot],
        ['群 / bot', `${status.groups} 个群 / ${status.bots} 个 bot`],
        ['启动时间', startedText],
        ['版本', status.version],
      ]"
    />
    <pre v-if="state.settingsAdv" class="settings-pre">{{ JSON.stringify(status, null, 2) }}</pre>
  </template>
</template>
