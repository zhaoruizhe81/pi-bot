<script setup>
/* 群头像拼图：对照旧 groupAvatarEl。
   成员 = 我 + roster 的 bot，最多 9 格，3 格一行；每格或图或首字。 */
import { computed } from "vue";
import { state, ui } from "../store.js";

const props = defineProps({
  group: { type: Object, default: null },
  size: { type: [Number, String], default: "" },
});

const members = computed(() => {
  const g = props.group || {};
  // 私聊群：单头像直接用 roster[0] 对应 bot（state.bots 里找头像），命中单格 ag-single 布局
  if (g.type === "dm") {
    const botId = Array.isArray(g.roster) && g.roster[0] ? ui.str(g.roster[0]) : "";
    if (botId) return [{ id: botId, name: ui.botName(botId), avatar: ui.botAvatar(botId) }];
  }
  const list = [{ id: ui.SELF_ID, name: ui.nickName(), avatar: ui.str(state.profile && state.profile.avatar) }];
  for (const id of Array.isArray(g.roster) ? g.roster : []) {
    list.push({ id, name: ui.botName(id), avatar: ui.botAvatar(id) });
  }
  return list.slice(0, 9);
});

const rows = computed(() => ui.GROUP_GRID(members.value.length));

const grid = computed(() => {
  let idx = 0;
  return rows.value.map((count) => {
    const arr = [];
    for (let i = 0; i < count; i += 1) {
      arr.push(members.value[idx] || { id: "?", name: "?" });
      idx += 1;
    }
    return arr;
  });
});

const fontSize = computed(() => {
  const n = members.value.length;
  return n <= 1 ? 15 : n <= 2 ? 11 : n <= 4 ? 9.5 : 6.5;
});

const rootStyle = computed(() => {
  const s = {};
  if (props.size) {
    s.width = props.size + "px";
    s.height = props.size + "px";
  }
  return s;
});

function isImg(m) {
  return /^data:image\//i.test(ui.str(m && m.avatar));
}
function cellStyle(m) {
  const s = { fontSize: fontSize.value + "px" };
  if (isImg(m)) {
    s.backgroundImage = 'url("' + m.avatar + '")';
    s.backgroundSize = "cover";
    s.backgroundPosition = "center";
  } else {
    s.background = ui.hashColor(m.id);
  }
  return s;
}
function cellText(m) {
  if (isImg(m)) return "";
  return ui.str(m.avatar) || ui.firstChar(m.name);
}
</script>

<template>
  <span class="avatar avatar-grid" :class="{ 'ag-single': members.length <= 1 }" :style="rootStyle">
    <span class="ag-row" v-for="(row, ri) in grid" :key="ri">
      <span class="ag-cell" v-for="(m, ci) in row" :key="ci" :style="cellStyle(m)" :title="m.name">{{ cellText(m) }}</span>
    </span>
  </span>
</template>
