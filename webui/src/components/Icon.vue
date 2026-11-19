<script setup>
/* 通用 SVG 图标：对照旧 svgIcon(paths, opts)。
   fill="none" -> 描边图标；传 fill="currentColor" -> 实心图标。 */
import { computed } from "vue";

const props = defineProps({
  paths: { type: Array, default: () => [] },
  width: { type: [String, Number], default: "1.6" },
  fill: { type: String, default: "none" },
});

const stroke = computed(() => (props.fill === "none" ? "currentColor" : "none"));
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" :fill="fill" :stroke="stroke" :stroke-width="width">
    <path
      v-for="(d, i) in paths"
      :key="i"
      :d="d"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
