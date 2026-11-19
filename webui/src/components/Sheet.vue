<script setup>
/* 通用浮层 .sheet：由 state.sheet 驱动（旧 openSheet 的替代）。
   #sheetTitle / #sheetBody / .sheet-actions。当 state.sheet.kind === "botCreator"
   时在 body 内渲染 BotCreator；否则渲染 sections（字符串标题 / 文本 / 动作行）。
   App.vue 只需在 #overlay 内常驻挂载本组件。 */
import { computed } from "vue";
import { state, actions } from "../store.js";
import Icon from "./Icon.vue";
import BotCreator from "./BotCreator.vue";

const sheet = computed(() => state.sheet);
const sections = computed(() => (state.sheet && Array.isArray(state.sheet.sections) ? state.sheet.sections : []));

function runSection(section) {
  if (!section || section.disabled) return;
  if (typeof section.run === "function") {
    try {
      const r = section.run();
      if (r && typeof r.catch === "function") r.catch((e) => console.error(e));
    } catch (e) {
      console.error(e);
    }
  }
}
</script>

<template>
  <div
    class="sheet"
    :class="{ wide: sheet && sheet.wide === true }"
    :hidden="!sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="sheetTitle"
  >
    <div class="sheet-head">
      <span class="sheet-title" id="sheetTitle">{{ sheet ? sheet.title : "" }}</span>
      <button class="icon-btn" type="button" id="sheetClose" title="关闭" aria-label="关闭" @click="actions.closeSheet()">
        <Icon :paths="['M6 6l12 12M18 6 6 18']" width="1.8" />
      </button>
    </div>
    <div class="sheet-body" id="sheetBody">
      <BotCreator v-if="sheet && sheet.kind === 'botCreator'" />
      <template v-else-if="sheet">
        <template v-for="(section, i) in sections" :key="i">
          <div v-if="typeof section === 'string'" class="sheet-section">{{ section }}</div>
          <div v-else-if="section && section.note" class="member-cap">{{ section.note }}</div>
          <div v-else-if="section && section.text !== undefined" class="sheet-text">{{ section.text }}</div>
          <button
            v-else-if="section && section.label"
            class="row-action"
            :class="{ danger: section.danger }"
            type="button"
            :disabled="section.disabled"
            :title="section.title || ''"
            @click="runSection(section)"
          >
            {{ section.label }}
          </button>
        </template>
      </template>
    </div>
  </div>
</template>
