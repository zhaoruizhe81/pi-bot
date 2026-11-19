<script setup>
/* 个人资料页（对照旧 renderProfileSettings）。draft 只在本组件内编辑，保存时调 saveProfile。 */
import { reactive, ref } from "vue";
import { state, actions, ui } from "../../store.js";
import Avatar from "../Avatar.vue";
import SettingsCard from "./SettingsCard.vue";

const draft = reactive({
  name: state.profile.name || "我",
  signature: state.profile.signature || "",
  avatar: state.profile.avatar || "",
});
const nameText = ref(draft.name === "我" ? "" : draft.name);
const saving = ref(false);
const fileInput = ref(null);

function onNameInput(event) {
  nameText.value = event.target.value;
  draft.name = nameText.value.trim();
}

function pickAvatar() {
  if (fileInput.value) fileInput.value.click();
}

async function onFile() {
  const file = (fileInput.value && fileInput.value.files && fileInput.value.files[0]) || null;
  if (fileInput.value) fileInput.value.value = "";
  if (!file) return;
  try {
    draft.avatar = await actions.uploadAvatar(file);
  } catch (_) {
    actions.toast("这张图片打不开");
  }
}

async function onSave() {
  if (saving.value) return;
  saving.value = true;
  try {
    await actions.saveProfile({ name: draft.name, signature: draft.signature, avatar: draft.avatar });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="settings-section">头像与昵称</div>
  <SettingsCard>
    <div class="settings-row profile-head">
      <Avatar class="profile-avatar" :name="draft.name" :seed="ui.SELF_ID" :avatar="draft.avatar" />
      <div class="settings-row-main">
        <div class="settings-row-name">{{ draft.name || "我" }}</div>
        <div class="settings-row-state">头像会出现在左栏、群头像拼图和你的每条消息上</div>
      </div>
      <button class="btn-text secondary mini" type="button" @click="pickAvatar">更换头像</button>
    </div>

    <div class="settings-field" style="padding: 12px 14px 2px">
      <label for="set-profile-name">昵称</label>
      <input
        id="set-profile-name"
        type="text"
        maxlength="24"
        placeholder="例如:阿哲"
        :value="nameText"
        @input="onNameInput"
      />
    </div>
    <div class="settings-field" style="padding: 6px 14px 14px">
      <label for="set-profile-signature">个性签名</label>
      <input
        id="set-profile-signature"
        type="text"
        maxlength="80"
        placeholder="一句话介绍自己(可选)"
        v-model="draft.signature"
      />
    </div>
    <input id="avatarInput" ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
  </SettingsCard>

  <div class="settings-actions" style="margin-top: 12px">
    <span class="settings-note">保存后立即生效,所有群共用这一份资料</span>
    <button class="btn-text primary mini ready" type="button" :disabled="saving" @click="onSave">保存</button>
  </div>
  <div class="settings-note">头像支持 JPG / PNG / WebP,选择后自动裁成方形再上传;不会保存到系统相册。</div>
</template>
