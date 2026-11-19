<script setup>
/* 对照旧 settingsKv(pairs)：<dl class="settings-kv">，空值的键值对整体跳过。 */
import { computed } from "vue";

const props = defineProps({
  pairs: { type: Array, default: () => [] },
});

const rows = computed(() =>
  (props.pairs || []).filter((p) => Array.isArray(p) && p[1] !== undefined && p[1] !== null && p[1] !== "")
);
</script>

<template>
  <dl class="settings-kv">
    <template v-for="(p, i) in rows" :key="i">
      <dt>{{ p[0] }}</dt>
      <dd>{{ p[1] }}</dd>
    </template>
  </dl>
</template>
