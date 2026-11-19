<script setup>
/* 设置面板里复用的小图标（对照旧 svgIcon(paths,{width})）。
   只发一个 24x24 的 stroke svg，颜色交给 currentColor / 现有 css。 */
defineProps({
  paths: { type: Array, default: () => [] },
  width: { type: [String, Number], default: "1.6" },
});
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" :stroke-width="width">
    <path v-for="(d, i) in paths" :key="i" :d="d" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
