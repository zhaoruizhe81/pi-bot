<script setup>
/* AI 模型页（对照旧 renderAiSettings + saveSettings + runSettingsCheck）。 */
import { computed, reactive, ref, watch } from "vue";
import { state, actions } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
import SettingsField from "./SettingsField.vue";
import SettingsIcon from "./SettingsIcon.vue";
import SettingsKv from "./SettingsKv.vue";

const formOpen = ref(false);
const saving = ref(false);
const checking = ref(false);
const draft = reactive({ api: "", baseUrl: "", modelId: "", apiKey: "" });

const config = computed(() => state.settingsConfig);
const check = computed(() => state.settingsCheck);

watch(
  () => state.settingsConfig,
  (c) => {
    if (!c) return;
    draft.api = c.api || "";
    draft.baseUrl = c.baseUrl || "";
    draft.modelId = c.modelId || "";
    draft.apiKey = "";
  },
  { immediate: true }
);

const stateClass = computed(() => (check.value ? (check.value.ok ? "ok" : "bad") : "warn"));
const stateText = computed(() => {
  const c = check.value;
  if (!c) return "未检查 · 点右侧「重新检查」";
  return c.ok
    ? `就绪 · ${c.latencyMs}ms${c.modelListed === false ? " · 模型未在列表里" : ""}`
    : `需要处理 · ${c.detail || "检查失败"}`;
});

async function onSave() {
  if (saving.value) return;
  saving.value = true;
  try {
    await actions.saveSettings({
      api: draft.api,
      baseUrl: draft.baseUrl,
      modelId: draft.modelId,
      apiKey: draft.apiKey,
    });
    formOpen.value = false;
  } finally {
    saving.value = false;
  }
}

async function onCheck() {
  if (checking.value) return;
  checking.value = true;
  try {
    await actions.checkSettings();
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div v-if="!config" class="settings-empty">加载中…</div>
  <div v-else-if="config.error" class="settings-empty">设置加载失败:{{ config.error }}</div>
  <template v-else>
    <div class="settings-section">提供方</div>
    <SettingsCard>
      <div class="settings-row">
        <div class="settings-row-icon">
          <SettingsIcon :paths="['M4 7l8-3 8 3-8 3-8-3z', 'M4 12l8 3 8-3', 'M4 17l8 3 8-3']" width="1.6" />
        </div>
        <div class="settings-row-main">
          <div class="settings-row-name">{{ config.providerName || "Musebot Gateway" }}</div>
          <div class="settings-row-state" :class="stateClass">{{ stateText }}</div>
        </div>
        <button class="btn-text secondary mini" type="button" @click="formOpen = !formOpen">
          {{ formOpen ? "收起" : "设置" }}
        </button>
      </div>
    </SettingsCard>

    <div v-if="formOpen" class="settings-form">
      <SettingsField label="协议" for-id="set-协议">
        <select id="set-协议" v-model="draft.api">
          <option v-for="kind in config.apis || []" :key="kind" :value="kind">{{ kind }}</option>
        </select>
      </SettingsField>
      <SettingsField label="Base URL" for-id="set-Base-URL">
        <input id="set-Base-URL" type="text" v-model="draft.baseUrl" placeholder="https://gateway.example.com/v1" />
      </SettingsField>
      <SettingsField label="模型 id" for-id="set-模型-id">
        <input id="set-模型-id" type="text" v-model="draft.modelId" placeholder="workbuddy/deepseek-v4.1-flash" />
      </SettingsField>
      <SettingsField label="API Key" for-id="set-API-Key">
        <input
          id="set-API-Key"
          type="password"
          autocomplete="new-password"
          v-model="draft.apiKey"
          :placeholder="config.apiKeySet ? `已保存 ${config.apiKeyMask}(留空表示不改)` : 'sk-…'"
        />
      </SettingsField>
      <div class="settings-actions">
        <span class="settings-note">保存后下一轮生效,正在跑的任务沿用旧模型</span>
        <button class="btn-text primary mini ready" type="button" :disabled="saving" @click="onSave">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>

    <div class="settings-section">当前模型</div>
    <SettingsCard>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-name">{{ config.modelId || "(未设置)" }}</div>
          <div class="settings-row-state">
            {{ config.api }} · 来源:{{ config.source === "settings" ? "设置" : "环境变量" }}
          </div>
        </div>
        <button class="btn-text secondary mini" type="button" :disabled="checking" @click="onCheck">
          {{ checking ? "检查中…" : "重新检查" }}
        </button>
      </div>
    </SettingsCard>
    <SettingsKv
      :pairs="[
        ['Base URL', config.baseUrl],
        ['API Key', config.apiKeySet ? config.apiKeyMask : '未配置'],
        ['环境默认', config.env ? `${config.env.api} · ${config.env.modelId}` : ''],
      ]"
    />
    <pre v-if="check" class="settings-pre">{{ JSON.stringify(check, null, 2) }}</pre>
  </template>
</template>
