<script setup>
/* 关于页（对照旧 renderAboutSettings）。 */
import { computed } from "vue";
import { state } from "../../store.js";
import SettingsKv from "./SettingsKv.vue";

const status = computed(() => state.settingsStatus);
const config = computed(() => state.settingsConfig);
</script>

<template>
  <div class="settings-section">musebot</div>
  <SettingsKv
    :pairs="[
      ['版本', status ? status.version : '0.4.1'],
      ['模型', config ? config.modelId : ''],
      ['协议', config ? config.api : ''],
      ['来源', config ? (config.source === 'settings' ? '设置面板' : '环境变量') : ''],
      ['群聊模型', '群会话只写不跑;执行都在各 bot 的私有会话里'],
    ]"
  />
  <!-- 与 SettingsKv 同构的 dl.settings-kv 行;署名固定可见(license 要求),不随接口加载成败隐藏。 -->
  <dl class="settings-kv">
    <dt>上下文压缩</dt>
    <dd><a href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener noreferrer">billion-context</a></dd>
  </dl>
  <div class="settings-section">说明</div>
  <div>
    musebot 是仿微信群聊的多 agent 客户端:领导 bot 拆任务、执行 bot 交付文件,群永远不阻塞。设置面板只放能真正生效的项;做不到的(深色模式、群二维码等)不摆假开关。
  </div>
</template>
