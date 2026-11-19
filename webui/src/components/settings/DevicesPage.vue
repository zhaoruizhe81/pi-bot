<script setup>
/* 手机和设备页（对照旧 renderDevicesSettings）。已连接 / 访问地址 / 本机名；
   高级模式下才出现远程访问(Tailscale) 与 tailnet serve。 */
import { computed, ref } from "vue";
import { state, actions } from "../../store.js";
import SettingsCard from "./SettingsCard.vue";
import SettingsField from "./SettingsField.vue";
import SettingsIcon from "./SettingsIcon.vue";
import SettingsKv from "./SettingsKv.vue";

const devices = computed(() => state.devices);
const bindHost = computed(() => (devices.value ? devices.value.bindHost : ""));
const pending = computed(() => !!devices.value && devices.value.host !== devices.value.bindHost);
const ts = computed(() => (devices.value && devices.value.tailscale) || {});
const serve = computed(() => ts.value.serve || { enabled: false, entries: [] });

const hostNameDraft = ref(state.hostName || "");
const networkBusy = ref(false);
const serveBusy = ref(false);
const rechecking = ref(false);

function browserName(ua) {
  const s = String(ua || "");
  if (/Edg\//.test(s)) return "Edge";
  if (/Chrome\//.test(s)) return "Chrome";
  if (/Safari\//.test(s)) return "Safari";
  if (/Firefox\//.test(s)) return "Firefox";
  if (!s) return "未知客户端";
  return s.slice(0, 24);
}

function relativeTime(at) {
  const diff = Date.now() - Number(at || 0);
  if (!Number.isFinite(diff) || diff < 0) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function serveUrl() {
  if (!serve.value.enabled) return "未开启";
  return (serve.value.entries || []).map((entry) => entry.url).join(" ");
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    actions.toast(message || "已复制 " + text);
  } catch (_) {
    actions.toast("复制失败,手动选中吧");
  }
}

function saveHostName() {
  actions.setHostName(hostNameDraft.value);
  actions.toast("已保存");
}

async function onRecheck() {
  if (rechecking.value) return;
  rechecking.value = true;
  try {
    await actions.loadSettingsData();
  } finally {
    rechecking.value = false;
  }
}

async function onToggleNetwork() {
  if (networkBusy.value) return;
  networkBusy.value = true;
  try {
    await actions.applyNetwork(devices.value.host === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0");
  } finally {
    networkBusy.value = false;
  }
}

async function onToggleServe() {
  if (serveBusy.value) return;
  serveBusy.value = true;
  try {
    await actions.toggleServe(!serve.value.enabled);
  } finally {
    serveBusy.value = false;
  }
}
</script>

<template>
  <div v-if="!devices" class="settings-empty">加载中…</div>
  <template v-else>
    <div class="settings-section">已连接</div>
    <SettingsCard>
      <div v-if="!(devices.clients && devices.clients.length)" class="settings-row">还没有设备连接(刷新这个页面就会出现)</div>
      <div v-for="(client, i) in devices.clients || []" :key="i" class="settings-row">
        <div class="settings-row-icon">
          <SettingsIcon
            :paths="['M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z']"
            width="1.6"
          />
        </div>
        <div class="settings-row-main">
          <div class="settings-row-name">{{ browserName(client.ua) }}</div>
          <div class="settings-row-state">
            {{ client.ip || "本机" }}{{ Number(client.connections) > 1 ? ` · ${client.connections} 个标签页` : "" }} ·
            最近活动 {{ relativeTime(client.lastAt) }}
          </div>
        </div>
      </div>
    </SettingsCard>

    <div class="settings-section">访问地址</div>
    <SettingsCard>
      <div v-for="(entry, i) in devices.urls || []" :key="i" class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-name">{{ entry.url }}</div>
          <div class="settings-row-state">{{ entry.label === "本机" ? "这台电脑" : entry.label }}</div>
        </div>
        <button class="btn-text secondary mini" type="button" @click="copy(entry.url, '已复制 ' + entry.url)">复制</button>
      </div>
    </SettingsCard>
    <SettingsKv
      :pairs="[
        ['当前监听', bindHost === '0.0.0.0' ? '所有网卡(局域网 / tailnet 可访问)' : '仅本机 127.0.0.1'],
        ['这台电脑', state.hostName || '未命名'],
      ]"
    />

    <SettingsField label="这台电脑的名称" for-id="set-host-name">
      <input id="set-host-name" type="text" maxlength="24" placeholder="例如:办公室 Mac mini" v-model="hostNameDraft" />
    </SettingsField>
    <div class="settings-actions" style="margin-top: 8px">
      <span class="settings-note">只存在这台浏览器里</span>
      <button class="btn-text primary mini ready" type="button" @click="saveHostName">保存</button>
    </div>

    <template v-if="!state.settingsAdv">
      <div class="settings-note">打开左栏底部「高级模式」可以看到远程访问(Tailscale)设置</div>
    </template>
    <template v-else>
      <div class="settings-section">远程访问</div>
      <SettingsCard>
        <div class="settings-row">
          <div class="settings-row-icon">
            <SettingsIcon
              :paths="['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5']"
              width="1.5"
            />
          </div>
          <div class="settings-row-main">
            <div class="settings-row-name">Tailscale</div>
            <div class="settings-row-state" :class="ts.ready ? 'ok' : 'warn'">{{ ts.detail || "未检测" }}</div>
          </div>
          <button class="btn-text secondary mini" type="button" :disabled="rechecking" @click="onRecheck">
            {{ rechecking ? "检查中…" : "重新检查" }}
          </button>
          <button
            class="switch"
            :class="{ on: devices.host === '0.0.0.0' }"
            type="button"
            role="switch"
            :aria-checked="devices.host === '0.0.0.0' ? 'true' : 'false'"
            title="允许通过局域网 / tailnet 访问本机服务"
            @click="onToggleNetwork"
          ></button>
        </div>
      </SettingsCard>

      <SettingsCard>
        <div class="settings-row">
          <div class="settings-row-icon">
            <SettingsIcon :paths="['M4 12a8 8 0 0 1 16 0', 'M4 12a8 8 0 0 0 16 0', 'M12 4v16']" width="1.5" />
          </div>
          <div class="settings-row-main">
            <div class="settings-row-name">tailnet 访问</div>
            <div class="settings-row-state" :class="{ ok: serve.enabled }">{{ serveUrl() }}</div>
          </div>
          <button
            class="btn-text secondary mini"
            type="button"
            :disabled="serveBusy || !ts.ready"
            :title="!ts.ready ? 'Tailscale 未就绪' : ''"
            @click="onToggleServe"
          >
            {{ serve.enabled ? "关闭" : "开启" }}
          </button>
        </div>
      </SettingsCard>

      <div v-if="!ts.httpsReady && ts.ready" class="bot-note">
        这台 tailnet 还没启用 HTTPS 证书,所以会用 http://&lt;设备名&gt;.ts.net:&lt;端口&gt;/;要 HTTPS 到 Tailscale 管理台 → DNS →
        HTTPS Certificates 打开后再点「重新检查」。
      </div>
      <pre v-if="state.serveResult" class="settings-pre">{{ state.serveResult }}</pre>
      <div v-if="ts.hint" class="settings-note">{{ ts.hint }}</div>
      <div v-if="pending" class="settings-row-state warn">
        已保存为 {{ devices.host }},但当前进程仍监听 {{ bindHost }} —— 重启 musebot 后生效
      </div>
      <div class="settings-note">musebot 不会自己去启动或登录 Tailscale;这里只控制本服务监听哪块网卡。</div>
    </template>
  </template>
</template>
