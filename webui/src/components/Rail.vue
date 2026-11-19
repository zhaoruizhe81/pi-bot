<script setup>
/* 左栏：对照旧 index.html 的 <nav class="rail"> + renderRailAvatar/updateRailBadge。 */
import { computed } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";

const total = computed(() =>
  state.groups.reduce((sum, g) => sum + (ui.isMuted(g.id) ? 0 : ui.unreadOf(g.id)), 0)
);
const badge = computed(() => (total.value > 9 ? "9+" : String(total.value)));
</script>

<template>
  <nav class="rail" aria-label="导航">
    <button class="rail-user" id="railMe" type="button" title="个人信息" aria-label="个人信息" @click="actions.openSettings('profile')">
      <Avatar id="railAvatar" :name="ui.nickName()" :seed="ui.SELF_ID" :avatar="state.profile.avatar" :title="ui.nickName()" />
      <span class="badge" id="railBadge" :hidden="total <= 0">{{ badge }}</span>
    </button>
    <div class="rail-nav">
      <button class="rail-btn active" type="button" title="聊天" aria-label="聊天" aria-current="page" id="railChat">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3.2c-5 0-9 3.3-9 7.4 0 2.3 1.3 4.4 3.4 5.8l-.9 3.1c-.1.4.3.7.7.5l3.6-2c.7.1 1.5.2 2.2.2 5 0 9-3.3 9-7.6S17 3.2 12 3.2z" />
        </svg>
      </button>
      <button class="rail-btn" type="button" title="通讯录" aria-label="通讯录" id="railContacts" @click="actions.openContacts()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="12" cy="8.5" r="3.4" />
          <path d="M5.2 20c.6-3.5 3.4-5.8 6.8-5.8s6.2 2.3 6.8 5.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="rail-foot">
      <button class="rail-btn" type="button" title="手机" aria-label="手机" id="railPhone" @click="actions.toast('手机端请直接访问同一端口')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M10.5 18h3" stroke-linecap="round" />
        </svg>
      </button>
      <button class="rail-btn" type="button" title="设置" aria-label="设置" id="railSettings" @click="actions.openSettings('ai')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="12" cy="12" r="2.8" />
          <path d="M19 12c0 .5.4.9.8 1.1l.6.3-1.4 2.4-.6-.3c-.4-.2-.9-.1-1.2.2-.3.3-.4.8-.2 1.2l.2.6-2.4 1.4-.3-.6c-.2-.4-.6-.7-1.1-.7s-.9.3-1.1.7l-.3.6-2.4-1.4.3-.6c.1-.4 0-.9-.3-1.2-.3-.3-.8-.4-1.2-.2l-.6.3-1.4-2.4.6-.3c.4-.2.7-.6.7-1.1s-.3-.9-.7-1.1l-.6-.3 1.4-2.4.6.3c.4.2.9.1 1.2-.2.3-.3.4-.8.2-1.2l-.3-.6 2.4-1.4.3.6c.2.4.6.7 1.1.7s.9-.3 1.1-.7l.3-.6 2.4 1.4-.2.6c-.2.4-.1.9.2 1.2.3.3.8.4 1.2.2l.6-.3 1.4 2.4-.6.3c-.4.2-.8.6-.8 1.1z" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </nav>
</template>
