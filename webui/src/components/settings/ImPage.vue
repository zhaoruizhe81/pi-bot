<script setup>
/* IM 接入页（对照旧 renderImSettings）。入站 webhook / token 掩码 / 重新生成 /
   启用开关 / 出站拉取 / 最近入站。 */
import { computed } from "vue";
import { state, actions } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
import SettingsKv from "./SettingsKv.vue";

const im = computed(() => state.im);
const base = computed(() => (im.value ? `${location.origin}/api/im/${encodeURIComponent(im.value.groupId)}` : ""));

const tokenPreview = computed(() => {
  if (!state.imToken) return "";
  return [
    "只显示这一次,复制保存好:",
    "",
    `POST ${base.value}/${state.imToken}`,
    "content-type: application/json",
    "",
    '{"sender":"张三","text":"帮我整理一版周报"}',
  ].join("\n");
});

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    actions.toast(message || "已复制");
  } catch (_) {
    actions.toast("复制失败");
  }
}

async function onRotate() {
  if (!im.value) return;
  await actions.rotateIm(im.value.groupId);
}

async function onToggleEnabled() {
  if (!im.value) return;
  await actions.updateIm(im.value.groupId, { enabled: !im.value.enabled });
}
</script>

<template>
  <div v-if="!im" class="settings-empty">加载中…</div>
  <template v-else>
    <div class="settings-section">这个群的中转地址</div>
    <SettingsCard>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-name">入站 Webhook</div>
          <div class="settings-row-state">{{ base }}/&lt;token&gt;</div>
        </div>
        <button class="btn-text secondary mini" type="button" @click="copy(base + '/<token>', '已复制(把 <token> 换成生成的那串)')">
          复制
        </button>
      </div>
    </SettingsCard>

    <SettingsCard>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-name">Token</div>
          <div class="settings-row-state">{{ im.tokenSet ? "已生成 · " + im.tokenMask : "还没有生成" }}</div>
        </div>
        <button class="btn-text secondary mini" type="button" @click="onRotate">{{ im.tokenSet ? "重新生成" : "生成" }}</button>
      </div>
    </SettingsCard>

    <pre v-if="state.imToken" class="settings-pre">{{ tokenPreview }}</pre>

    <div class="settings-section">行为</div>
    <button class="info-row" type="button" @click="onToggleEnabled">
      <div class="info-main"><div class="info-label">启用这个桥</div></div>
      <span class="switch" :class="{ on: im.enabled }"></span>
    </button>
    <div class="settings-note">
      入站消息走和输入框同一个判断:像需求就交给领导分工(群里会出现「领导正在分工…」),闲聊就只落一条消息。token
      放在 URL 里,只返回掩码,重新生成会让旧 token 立即失效。
    </div>

    <div class="settings-section">出站(给中转服务拉)</div>
    <SettingsKv
      :pairs="[
        ['拉取地址', `${base}/<token>/outbox?since=<lastId>`],
        ['返回', 'id / kind / author / text 或 file / at,按 id 升序,最多 200 条'],
        ['回调 URL', im.callbackUrl || '(不用填:由你的中转服务主动拉)'],
      ]"
    />

    <template v-if="im.recent && im.recent.length">
      <div class="settings-section">最近的入站</div>
      <SettingsKv
        v-for="(entry, i) in im.recent"
        :key="i"
        :pairs="[
          [
            entry.sender || 'IM',
            `${entry.text}`.slice(0, 80) + ' · ' + (entry.routed === 'requirement' ? '转成任务' : '只是消息'),
          ],
        ]"
      />
    </template>
  </template>
</template>
