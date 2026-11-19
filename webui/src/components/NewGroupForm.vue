<script setup>
/* 新建群表单：对照旧 index.html 的 <form class="new-group"> + openNewGroup/closeNewGroup/submitNewGroup。 */
import { ref, watch } from "vue";
import { state, actions } from "../store.js";

const name = ref("");
const err = ref("");
const busy = ref(false);

watch(
  () => state.newGroupOpen,
  (open) => {
    if (open) {
      name.value = "";
      err.value = "";
      busy.value = false;
    }
  }
);

async function submit() {
  const value = name.value.trim();
  if (!value) {
    err.value = "群名不能为空";
    return;
  }
  busy.value = true;
  err.value = "";
  try {
    const created = await actions.createGroup(value);
    if (!created) err.value = err.value || "建群失败,请重试";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="new-group" id="newGroupForm" :hidden="!state.newGroupOpen" @submit.prevent="submit">
    <input id="newGroupName" v-model="name" type="text" maxlength="40" placeholder="新群名" autocomplete="off" aria-label="新群名" />
    <div class="new-group-actions">
      <button class="btn-text secondary mini" type="submit" id="newGroupOk" :disabled="busy">建</button>
      <button class="btn-text secondary mini" type="button" id="newGroupCancel" @click="actions.closeNewGroup()">取消</button>
    </div>
    <div class="new-group-err" id="newGroupErr" :hidden="!err">{{ err }}</div>
  </form>
</template>
