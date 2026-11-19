<script setup>
/* 快捷键页（对照旧 renderKeysSettings）。 */
import { ui } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
</script>

<template>
  <div class="settings-section">键盘</div>
  <SettingsCard>
    <div v-for="([key, desc], i) in ui.SHORTCUTS" :key="i" class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-name">{{ key }}</div>
        <div class="settings-row-state">{{ desc }}</div>
      </div>
    </div>
  </SettingsCard>
</template>
