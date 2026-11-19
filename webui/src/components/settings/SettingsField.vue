<script setup>
/* 对照旧 settingsField(label, input)：label + 一个输入控件（slot 传入 input/select）。 */
defineProps({
  label: { type: String, default: "" },
  forId: { type: String, default: "" },
});
</script>

<template>
  <div class="settings-field">
    <label :for="forId">{{ label }}</label>
    <slot />
  </div>
</template>
