<script setup>
/* 单个头像：对照旧 paintAvatar/avatarEl。
   有 data:image 头像 -> <img>；否则圆底 + 文字首字。
   通过 attrs 透传 id/title 等（供 #railAvatar 等使用）。 */
import { computed } from "vue";
import { ui } from "../store.js";

const props = defineProps({
  name: { type: [String, Number], default: "" },
  seed: { type: [String, Number], default: "" },
  avatar: { type: String, default: "" },
  cls: { type: String, default: "" },
  size: { type: [Number, String], default: "" },
});

const isImg = computed(() => /^data:image\//i.test(ui.str(props.avatar)));
const glyph = computed(() => ui.str(props.avatar) || ui.firstChar(props.name));
const style = computed(() => {
  const s = { background: isImg.value ? "#e6e6e6" : ui.hashColor(props.seed || props.name) };
  if (props.size) {
    s.width = props.size + "px";
    s.height = props.size + "px";
  }
  return s;
});
</script>

<template>
  <span class="avatar" :class="cls" :style="style">
    <img v-if="isImg" :src="avatar" alt="" />
    <template v-else>{{ glyph }}</template>
  </span>
</template>
