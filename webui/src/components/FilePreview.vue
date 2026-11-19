<script setup>
/* FilePreview —— 旧 openFileSheet 的宽版浮层：
   顶部（大小 + 原文/预览切换 + 下载），正文里 md 用 MarkdownView 渲染，
   文本类先展示 artifact preview，再拉 ?inline=1 全文覆盖。 */
import { computed, ref, watch } from "vue";
import { state, actions, ui } from "../store.js";
import MarkdownView from "./MarkdownView.vue";

const payload = computed(() => state.filePreview || {});
const file = computed(() => payload.value.file || {});
const artifact = computed(() => payload.value.artifact || {});
const workId = computed(() => ui.str(payload.value.workId));

const name = computed(() => ui.str(file.value.name || file.value.title || file.value.path, "文件"));
const path = computed(() => ui.str(file.value.path));
const isMarkdown = computed(() => ui.MD_FILE.test(path.value));
const canPreview = computed(() => ui.TEXT_FILE.test(path.value));
const sizeText = computed(() => ui.formatSize(file.value.size ?? file.value.bytes) || path.value);
const downloadName = computed(() => name.value.split("/").pop() || name.value);

function fileUrl(wid, p, inline) {
  const gid = state.groupId;
  if (!gid || !wid || !p) return null;
  const encoded = String(p).split("/").map(encodeURIComponent).join("/");
  return (
    "/api/groups/" +
    encodeURIComponent(gid) +
    "/files/" +
    encodeURIComponent(wid) +
    "/" +
    encoded +
    (inline ? "?inline=1" : "")
  );
}

const url = computed(() => fileUrl(workId.value, path.value, false));

const source = ref("");
const mode = ref("raw");
const loading = ref(false);
const failed = ref(false);

function loadFull() {
  failed.value = false;
  loading.value = false;
  if (!url.value || !canPreview.value) return;
  loading.value = !source.value;
  fetch(url.value + "?inline=1", { headers: { accept: "text/plain" }, cache: "no-store" })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error("HTTP " + res.status))))
    .then((text) => {
      if (text && text !== source.value) source.value = text;
      loading.value = false;
    })
    .catch(() => {
      loading.value = false;
      if (!source.value) {
        source.value = "";
        failed.value = true;
      }
    });
}

watch(
  payload,
  (p) => {
    const f = (p && p.file) || {};
    const a = (p && p.artifact) || {};
    source.value = ui.str(f.content || f.preview) || ui.str(a.body);
    mode.value = ui.MD_FILE.test(ui.str(f.path)) ? "render" : "raw";
    loadFull();
  },
  { immediate: true }
);

function toggleMode() {
  mode.value = mode.value === "render" ? "raw" : "render";
}

function close() {
  actions.closeFilePreview();
}
</script>

<template>
  <div class="sheet wide" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sheet-head">
      <span class="sheet-title" id="sheetTitle">{{ name }}</span>
      <button class="icon-btn" type="button" id="sheetClose" title="关闭" aria-label="关闭" @click="close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="sheet-body" id="sheetBody">
      <div class="sheet-file-head">
        <span class="member-cap">{{ sizeText }}</span>
        <button v-if="isMarkdown" class="row-action" type="button" @click="toggleMode">
          {{ mode === "render" ? "原文" : "预览" }}
        </button>
        <a v-if="url" class="btn-text primary mini ready" :href="url" :download="downloadName">下载</a>
      </div>

      <div class="sheet-doc">
        <div v-if="!canPreview" class="sheet-doc-empty">
          {{ url ? "该类型不支持在线预览,下载后查看。" : "该文件暂无内联内容。" }}
        </div>
        <div v-else-if="failed && !source" class="sheet-doc-empty">无法读取该文件,请直接下载。</div>
        <div v-else-if="!source && loading" class="sheet-doc-empty">加载中…</div>
        <div v-else-if="!source" class="sheet-doc-empty">加载中…</div>
        <MarkdownView v-else-if="isMarkdown && mode === 'render'" :source="source" />
        <pre v-else>{{ source }}</pre>
      </div>
    </div>
  </div>
</template>
