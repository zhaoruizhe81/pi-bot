<script setup>
/* 数据与导出页（对照旧 renderDataSettings）。 */
import { computed } from "vue";
import { state, actions, ui } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
import SettingsKv from "./SettingsKv.vue";

const status = computed(() => state.settingsStatus);
const archive = computed(() => (status.value && status.value.archive ? status.value.archive : null));

function exportMd() {
  actions.exportGroup(state.groupId);
}

function exportJson() {
  actions.exportGroup(state.groupId, "json");
}

function clearRead() {
  (state.groups || []).forEach((group) => ui.store.del("mb.read." + group.id));
  actions.toast("已清空本地已读");
}

function clearPrefs() {
  state.nick = "";
  state.remark = {};
  state.mute = {};
  ui.store.del("mb.nick");
  ui.store.del("mb.remark");
  ui.store.del("mb.mute");
  actions.toast("本地偏好已清空");
}
</script>

<template>
  <div class="settings-section">交付物归档</div>
  <SettingsKv
    :pairs="[
      ['目录', status ? status.archiveRoot : ''],
      ['文件', archive ? `${archive.files} 个 · ${ui.formatSize(archive.bytes)}` : ''],
    ]"
  />

  <div class="settings-section">导出</div>
  <SettingsCard>
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-name">当前群聊天记录</div>
        <div class="settings-row-state">markdown 给人看,json 用来归档</div>
      </div>
      <button class="btn-text primary mini ready" type="button" @click="exportMd">导出 md</button>
      <button class="btn-text secondary mini" type="button" @click="exportJson">导出 json</button>
    </div>
  </SettingsCard>

  <div class="settings-section">本地数据</div>
  <SettingsKv
    :pairs="[
      ['已读记录', 'localStorage · mb.read.*'],
      ['偏好', '昵称 / 备注 / 免打扰 / 置顶 / 草稿'],
    ]"
  />
  <div class="settings-actions" style="margin-top: 10px">
    <span class="settings-note">只影响这台电脑的浏览器</span>
    <button class="btn-text secondary mini" type="button" @click="clearRead">清空已读</button>
    <button class="btn-text secondary mini" type="button" @click="clearPrefs">清空昵称/备注/免打扰</button>
  </div>
</template>
