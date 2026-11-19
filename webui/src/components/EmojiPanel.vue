<script setup>
/* EmojiPanel —— 旧 openEmojiPanel：24 个 emoji，点击插入到输入框光标处。
   开合由父组件 Composer 通过 v-show 控制；选中时 emit("pick", emoji)。 */
import { ui } from "../store.js";

const emit = defineEmits(["pick"]);
const emojis = ui.EMOJIS;

function pick(emoji) {
  emit("pick", emoji);
}
</script>

<template>
  <div class="emoji-panel" id="emojiPanel" role="dialog" aria-label="表情">
    <button v-for="(emoji, i) in emojis" :key="i" type="button" @click="pick(emoji)">{{ emoji }}</button>
  </div>
</template>
