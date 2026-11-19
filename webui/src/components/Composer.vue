<script setup>
/* Composer —— 旧 submitText / sendPickedFiles / toggleVoice / stopVoiceTicker /
   autosize / syncSendButtons / openEmojiPanel 的 Vue 版。
   - 工具条 #toolEmoji/#toolFile/#toolImage/#toolVoice + textarea #input + #sendBtn
   - Enter 发送 / Shift+Enter 换行 / ⌘Enter 发送 / 输入法合成不触发
   - 草稿按群存取（actions.getDraft/setDraft）
   - 文件/图片上传（actions.sendFileNow）
   - 语音 MediaRecorder 真录音（计时、取消、结束上传 audio/webm，失败明确提示）
   - 粘贴自动扩高；表情面板开合 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { state, actions } from "../store.js";
import EmojiPanel from "./EmojiPanel.vue";

const inputEl = ref(null);
const sendBtnEl = ref(null);
const fileInput = ref(null);
const imageInput = ref(null);
const inputValue = ref("");
const emojiOpen = ref(false);

const canSend = computed(() => inputValue.value.trim().length > 0 && !!state.groupId);

function autosize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function saveDraft() {
  if (!state.groupId) return;
  actions.setDraft(state.groupId, inputValue.value);
}

function onInput() {
  autosize();
  saveDraft();
  syncSendButton();
}

/* 与旧 syncSendButtons 一致：同步改 disabled，避免「同一 tick 内 set value + click」
   时按钮还处于 disabled 而被浏览器吞掉点击（自动化测试正是这样点）。 */
function syncSendButton() {
  const el = sendBtnEl.value;
  if (!el) return;
  const can = canSend.value;
  el.disabled = !can;
  el.classList.toggle("ready", can);
}

function handleInput(event) {
  inputValue.value = event.target.value;
  onInput();
}

function onKeydown(event) {
  if (event.key !== "Enter") return;
  if (event.isComposing) return;
  if (event.shiftKey) return;
  event.preventDefault();
  void submit();
}

/* 粘贴发图：剪贴板带文件（截图 / 复制的文件）时逐个上传并阻止默认插入，
   避免文件名落进草稿；无文件时保持原粘贴行为（只重算高度）。 */
function isImageFile(file) {
  return typeof file.type === "string" && file.type.startsWith("image/");
}

function onPaste(event) {
  const files = event.clipboardData && event.clipboardData.files;
  if (files && files.length && state.groupId) {
    event.preventDefault();
    void sendPastedFiles(files);
    return;
  }
  setTimeout(autosize, 0);
}

async function sendPastedFiles(files) {
  for (const file of Array.from(files)) {
    await actions.sendFileNow(file, isImageFile(file));
  }
}

async function submit() {
  const value = inputValue.value.trim();
  if (!value || !state.groupId) return;
  inputValue.value = "";
  autosize();
  actions.setDraft(state.groupId, "");
  if (inputEl.value) inputEl.value.focus();
  await actions.send(value);
}

function onFilePicked(isImage) {
  const el = isImage ? imageInput.value : fileInput.value;
  void sendPickedFiles(el, isImage);
}

async function sendPickedFiles(el, isImage) {
  const files = el ? [...(el.files || [])] : [];
  if (el) el.value = "";
  if (!state.groupId || !files.length) return;
  for (const file of files) {
    await actions.sendFileNow(file, isImage);
  }
}

/* ===== 表情 ===== */
function toggleEmoji() {
  emojiOpen.value = !emojiOpen.value;
}

function insertEmoji(emoji) {
  const el = inputEl.value;
  if (!el) {
    inputValue.value += emoji;
    return;
  }
  const start = el.selectionStart ?? inputValue.value.length;
  const end = el.selectionEnd ?? inputValue.value.length;
  inputValue.value = inputValue.value.slice(0, start) + emoji + inputValue.value.slice(end);
  const caret = start + emoji.length;
  nextTick(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = caret;
    autosize();
  });
  saveDraft();
}

function onDocClick(event) {
  if (!emojiOpen.value) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("#emojiPanel")) return;
  if (target.closest("#toolEmoji")) return;
  emojiOpen.value = false;
}

/* ===== 语音：MediaRecorder 真录音 ===== */
let recorder = null;
let recordedChunks = [];
let voiceTimer = null;
let voiceStarted = 0;
let voiceCancelled = false;
let voiceStream = null;
const recording = ref(false);
const voiceLabel = ref("00:00");

function stopVoiceTicker() {
  if (voiceTimer) clearInterval(voiceTimer);
  voiceTimer = null;
}

async function toggleVoice() {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    actions.toast("这个浏览器不支持录音");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    actions.toast("拿不到麦克风权限:" + (error.message || "被拒绝"));
    return;
  }
  voiceStream = stream;
  recordedChunks = [];
  voiceCancelled = false;
  voiceStarted = Date.now();
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  recorder = new MediaRecorder(stream, { mimeType: mime });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  recorder.onstop = async () => {
    stopVoiceTicker();
    recording.value = false;
    for (const track of stream.getTracks()) track.stop();
    voiceStream = null;
    const seconds = Math.max(1, Math.round((Date.now() - voiceStarted) / 1000));
    const chunks = recordedChunks;
    recordedChunks = [];
    recorder = null;
    if (voiceCancelled || !chunks.length) return;
    const blob = new Blob(chunks, { type: mime });
    const name = `语音-${seconds}s.webm`;
    const ok = await actions.sendFileNow(new File([blob], name, { type: mime }), false);
    if (!ok) actions.toast("语音发送失败");
  };
  recorder.start();
  recording.value = true;
  const tick = () => {
    const secs = Math.floor((Date.now() - voiceStarted) / 1000);
    voiceLabel.value = String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
  };
  tick();
  voiceTimer = setInterval(tick, 250);
}

function cancelVoice() {
  voiceCancelled = true;
  if (recorder && recorder.state === "recording") recorder.stop();
}

/* ===== 群切换：载入/保存草稿 ===== */
watch(
  () => state.groupId,
  (gid) => {
    inputValue.value = gid ? actions.getDraft(gid) : "";
    nextTick(() => {
      autosize();
      syncSendButton();
    });
  },
  { immediate: true }
);

onMounted(() => {
  document.addEventListener("click", onDocClick);
  nextTick(() => {
    autosize();
    syncSendButton();
  });
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  stopVoiceTicker();
  if (recorder && recorder.state === "recording") {
    voiceCancelled = true;
    recorder.stop();
  }
  if (voiceStream) {
    for (const track of voiceStream.getTracks()) track.stop();
    voiceStream = null;
  }
});
</script>

<template>
  <footer class="composer">
    <div class="toolbar" aria-label="工具条">
      <button class="tool" type="button" id="toolEmoji" title="表情" aria-label="表情" @click.stop="toggleEmoji">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="8.4" />
          <circle cx="9.4" cy="10.3" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.6" cy="10.3" r="0.9" fill="currentColor" stroke="none" />
          <path d="M8.8 14.4c.8.9 1.9 1.4 3.2 1.4s2.4-.5 3.2-1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button class="tool" type="button" id="toolFile" title="发送文件" aria-label="发送文件" @click="fileInput && fileInput.click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path
            d="M4 8.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-6.2L9.8 5H6a2 2 0 0 0-2 2v1.5z"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="tool" type="button" id="toolImage" title="发送图片" aria-label="发送图片" @click="imageInput && imageInput.click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path
            d="M8.2 6.6 9.6 4.5h4.8l1.4 2.1H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3.2z"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12.6" r="3.1" />
        </svg>
      </button>
      <button
        class="tool"
        :class="{ recording }"
        type="button"
        id="toolVoice"
        title="录音"
        aria-label="录音"
        @click="toggleVoice"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <rect x="9.2" y="3.2" width="5.6" height="10.4" rx="2.8" />
          <path d="M6 11.4a6 6 0 0 0 12 0M12 17.4V21" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="input-row">
      <textarea
        id="input"
        ref="inputEl"
        rows="1"
        placeholder="输入消息"
        autocomplete="off"
        aria-label="输入消息"
        :value="inputValue"
        @input="handleInput"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
      <div class="send-area">
        <button ref="sendBtnEl" class="btn-text primary" :class="{ ready: canSend }" type="button" id="sendBtn" :disabled="!canSend" @click="submit">
          发送
        </button>
      </div>
    </div>
  </footer>

  <input type="file" id="fileInput" hidden ref="fileInput" @change="onFilePicked(false)" />
  <input type="file" id="imageInput" accept="image/*" hidden ref="imageInput" @change="onFilePicked(true)" />

  <div class="voice-bar" id="voiceBar" :hidden="!recording" role="status" aria-live="polite">
    <span class="voice-dot"></span>
    <span class="voice-time" id="voiceTime">{{ voiceLabel }}</span>
    <span class="voice-hint">正在录音,点麦克风结束并发送</span>
    <button class="voice-cancel" type="button" id="voiceCancel" @click="cancelVoice">取消</button>
  </div>

  <EmojiPanel :hidden="!emojiOpen" @pick="insertEmoji" />
</template>
