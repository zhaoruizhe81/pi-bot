<script setup>
/* FileBubble —— 一个文件气泡（图标/名/大小；图片 <img>、音频 <audio>、其它点击下载）。
   - mode="delivery"：交付物文件，点击打开 FilePreview。
   - mode="upload"：用户上传的文件消息，图片新窗口打开 / 其它触发下载。
   仅渲染气泡本身；外层 .chat-file / .file-bubbles 容器由 MessageStream 负责。 */
import { computed } from "vue";
import { state, actions, ui } from "../store.js";

const props = defineProps({
  file: { type: Object, default: () => ({}) },
  artifact: { type: Object, default: () => ({}) },
  workId: { type: String, default: "" },
  mode: { type: String, default: "upload" }, // upload | delivery
});

const name = computed(() => ui.str(props.file.name || props.file.title || props.file.path, "file"));
const mime = computed(() => ui.str(props.file.mime));
const isImage = computed(() => mime.value.startsWith("image/"));
const isAudio = computed(() => mime.value.startsWith("audio/"));
const size = computed(() => ui.formatSize(props.file.size ?? props.file.bytes));

/** 交付物下载/预览地址（旧 fileUrl）。 */
function fileUrl(workId, path, inline) {
  const gid = state.groupId;
  if (!gid || !workId || !path) return null;
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  return (
    "/api/groups/" +
    encodeURIComponent(gid) +
    "/files/" +
    encodeURIComponent(workId) +
    "/" +
    encoded +
    (inline ? "?inline=1" : "")
  );
}

/** 用户上传文件地址（旧 uploadUrl）。 */
function uploadUrl(file, inline) {
  const gid = state.groupId;
  if (!gid || !file || !file.id) return null;
  return (
    "/api/groups/" +
    encodeURIComponent(gid) +
    "/uploads/" +
    encodeURIComponent(file.id) +
    "?name=" +
    encodeURIComponent(file.name || "file") +
    "&mime=" +
    encodeURIComponent(file.mime || "application/octet-stream") +
    (inline ? "&inline=1" : "")
  );
}

const urlInline = computed(() =>
  props.mode === "delivery" ? fileUrl(props.workId, ui.str(props.file.path), true) : uploadUrl(props.file, true)
);
const urlDownload = computed(() =>
  props.mode === "delivery" ? fileUrl(props.workId, ui.str(props.file.path), false) : uploadUrl(props.file, false)
);

function openPreview() {
  actions.openFilePreview({ file: props.file, artifact: props.artifact, workId: props.workId });
}

function onImage() {
  if (props.mode === "delivery") openPreview();
  else if (urlInline.value) window.open(urlInline.value, "_blank", "noopener");
}

function onFile() {
  if (props.mode === "delivery") {
    openPreview();
    return;
  }
  const link = document.createElement("a");
  link.href = urlDownload.value || "";
  link.setAttribute("download", name.value);
  document.body.appendChild(link);
  link.click();
  link.remove();
}
</script>

<template>
  <button v-if="isImage" type="button" @click="onImage">
    <img :src="urlInline" :alt="name" loading="lazy" />
  </button>
  <audio v-else-if="isAudio" controls preload="metadata" :src="urlInline"></audio>
  <button v-else class="file-bubble" type="button" @click="onFile">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M13.5 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5z" />
      <path d="M13.5 4.5v5h5" />
    </svg>
    <span class="file-meta">
      <span class="file-name">{{ name }}</span>
      <span v-if="size" class="file-size">{{ size }}</span>
    </span>
  </button>
</template>
