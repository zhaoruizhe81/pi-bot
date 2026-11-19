<script setup>
/* MessageStream —— 旧 renderStreamFull / renderChatEntry / renderMessage /
   renderWorkEvent / renderFileMessage / timeRow / visibleItemsFrom 的 Vue 版。
   - 时间分隔、他人/自己气泡、@提及高亮、代码块
   - 工作事件：plan 是领导消息；delivered 是执行 bot 消息 + 文件气泡；
     started/blocked/failed/cancelled/planning 居中灰字；assigned/done 不显示
   - chat.file 文件消息、pending 乐观消息、加载更早、新消息按钮、空态
   - 滚动到底 / 新消息计数 / 按群记忆滚动位置（actions.getScroll/setScroll） */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { state, actions, ui } from "../store.js";
import FileBubble from "./FileBubble.vue";

const streamEl = ref(null);
const loadMoreVisible = ref(false);
const confirming = reactive({});

/* ===== 数据派生 ===== */
const visibleItems = computed(() => {
  const q = ui.str(state.msgSearch).trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter((entry) => ui.matchesFilter(entry, q));
});

function authorKey(entry) {
  const a = (entry.data || {}).author || {};
  return ui.str(a.id, ui.str(a.name, "?"));
}

function authorAvatar(author) {
  const a = author || {};
  if (a.type === "bot") return ui.botAvatar(a.id);
  if (String(a.id) === ui.SELF_ID || a.name === "我") return ui.profileAvatar();
  return "";
}

function isSelfAuthor(author) {
  const a = author || {};
  return a.type === "human" && (String(a.id) === ui.SELF_ID || a.name === "我");
}

/** 头像渲染参数：picture 优先，否则用 glyph + hashColor 背景（旧 paintAvatar）。 */
function avatarOf(name, seed, src) {
  const s = ui.str(src);
  if (/^data:image\//i.test(s)) return { src: s, bg: "#e6e6e6", glyph: "" };
  return { src: "", bg: ui.hashColor(seed || name), glyph: s || ui.firstChar(name) };
}

/** 气泡文本分段：@提及高亮 + ``` 代码块（旧 renderTextInto / appendWithMentions）。 */
function segmentsOf(text) {
  const s = ui.str(text);
  if (!s.includes("```")) {
    return s
      .split(/(@[^\s@,，。:：;；()（）]+)/g)
      .filter((part) => part !== "")
      .map((part) => (part.startsWith("@") ? { t: "mention", v: part } : { t: "text", v: part }));
  }
  const segs = [];
  s.split(/```/).forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) segs.push({ t: "pre", v: part.replace(/^\n/, "").replace(/\n$/, "") });
    else segs.push({ t: "text", v: part });
  });
  return segs;
}

/* 旧 plainText / clampText：交付气泡里把 Markdown 噪声抹平再截断。 */
function plainText(text) {
  return ui
    .str(text)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}[-*+]\s+/gm, "· ")
    .replace(/^\s{0,3}(\d+)\.\s+/gm, "$1. ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}
function clampText(text, max) {
  const s = ui.str(text);
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

function finishedWorkIds() {
  const set = new Set();
  for (const entry of state.items) {
    if (!entry || entry.kind !== "work.event") continue;
    const d = entry.data || {};
    if (d.workId && (d.ev === "delivered" || d.ev === "done" || d.ev === "failed" || d.ev === "cancelled")) {
      set.add(String(d.workId));
    }
  }
  return set;
}

function sysRow(text, tone, key, cancelWorkId) {
  return { t: "sys", key, text, tone: tone || "", cancelWorkId: cancelWorkId || "" };
}

/** 单个 work.event → 若干渲染块（或 null）。 */
function pushWorkEvent(entry, d, out, idx, finished) {
  const ev = ui.str(d.ev, "unknown");
  const subject = ui.subjectOf(d);
  const key = "w" + idx;

  if (ev === "planning") return out.push(sysRow("领导正在分工…", "", key));
  if (ev === "assigned" || ev === "done") return;

  if (ev === "plan") {
    const items = Array.isArray(d.items) ? d.items : [];
    const lines = [`我拆成 ${items.length} 件事,分给这几位:`];
    for (const item of items) {
      if (!item) continue;
      const deps = Array.isArray(item.deps) ? item.deps : [];
      const who = ui.memberNameByCapability(item.capability);
      lines.push(`@${who} ${ui.str(item.subject)}${deps.length ? `(需要 ${deps.join("、")})` : ""}`);
    }
    const text = lines.join("\n");
    out.push({
      t: "workmsg",
      key,
      id: ui.str(entry.id),
      name: ui.memberName("leader"),
      text,
      segments: segmentsOf(text),
      avatar: avatarOf(ui.memberName("leader"), "leader", ui.botAvatar("leader")),
      files: [],
    });
    return;
  }

  if (ev === "delivered") {
    const art = d.artifact || {};
    const body = ui.str(art.body);
    const text = `@我 交付「${subject || ui.str(art.title, "任务")}」${body ? "\n\n" + clampText(plainText(body), 240) : ""}`;
    const who = ui.memberName(d.botId);
    const files = Array.isArray(art.files) ? art.files : [];
    out.push({
      t: "workmsg",
      key,
      id: ui.str(entry.id),
      name: who,
      text,
      segments: segmentsOf(text),
      avatar: avatarOf(who, ui.str(d.botId, "bot"), ui.botAvatar(d.botId)),
      files: files.map((f) => ({ file: f, artifact: art, workId: ui.str(d.workId) })),
    });
    return;
  }

  if (ev === "started") {
    const text = `${ui.memberName(d.botId)} 开始处理「${subject || "任务"}」`;
    const showCancel = d.workId && !finished.has(String(d.workId));
    out.push(sysRow(text, "", key, showCancel ? ui.str(d.workId) : ""));
    return;
  }
  if (ev === "blocked") return out.push(sysRow(`「${subject || "任务"}」在排队:${ui.str(d.reason, "等待空闲的 bot")}`, "muted", key));
  if (ev === "failed") return out.push(sysRow(`「${subject || "任务"}」失败:${ui.str(d.error, "未知原因")}`, "bad", key));
  if (ev === "cancelled") return out.push(sysRow(`「${subject || "任务"}」已取消`, "", key));
  return out.push(sysRow(ev, "", key));
}

const rows = computed(() => {
  const finishSet = finishedWorkIds();
  const list = visibleItems.value;
  const out = [];
  let prev = null;

  list.forEach((entry, idx) => {
    const d = entry.data || {};
    const ts = ui.tsOf(entry);
    if (ui.needsTime(prev ? prev.ts : null, ts)) {
      out.push({ t: "time", key: "t" + idx, label: ui.timeLabel(ts) });
    }

    if (entry.kind === "chat.message") {
      const author = d.author || {};
      const self = isSelfAuthor(author);
      const ak = authorKey(entry);
      const sameAuthor = prev && prev.kind === "chat.message" && prev.author === ak;
      const cont = sameAuthor && ts !== null && prev.ts !== null && Math.abs(ts - prev.ts) < ui.TIME_GAP;
      const name = ui.str(author.name, self ? "我" : "成员");
      let failed = false;
      if (entry.__pending || String(entry.id).startsWith("tmp-")) {
        const p = state.pending.find((x) => x.tmpId === entry.id);
        failed = p ? !!p.failed : !!(entry.__pending && entry.__pending.failed);
      }
      const text = ui.str(d.text);
      out.push({
        t: "msg",
        key: "m" + idx,
        id: ui.str(entry.id),
        self,
        cont,
        name,
        text,
        segments: segmentsOf(text),
        failed,
        avatar: avatarOf(name, ak, authorAvatar(author)),
      });
      prev = { ts, author: ak, kind: "chat.message" };
      return;
    }

    if (entry.kind === "chat.file") {
      const author = d.author || {};
      const self = isSelfAuthor(author);
      const ak = authorKey(entry);
      const sameAuthor = prev && prev.kind === "chat.file" && prev.author === ak;
      const cont = sameAuthor && ts !== null && prev.ts !== null && Math.abs(ts - prev.ts) < ui.TIME_GAP;
      const name = ui.str(author.name, self ? "我" : "成员");
      out.push({
        t: "file",
        key: "f" + idx,
        id: ui.str(entry.id),
        self,
        cont,
        name,
        file: d.file || {},
        avatar: avatarOf(name, ak, authorAvatar(author)),
      });
      prev = { ts, author: ak, kind: "chat.file" };
      return;
    }

    if (entry.kind === "work.event") {
      pushWorkEvent(entry, d, out, idx, finishSet);
      prev = { ts, author: null, kind: "work.event" };
      return;
    }

    out.push(sysRow(ui.str(entry.kind, "未知消息"), "", "s" + idx));
    prev = { ts, author: null, kind: entry.kind };
  });

  return out;
});

const empty = computed(() => {
  if (rows.value.length) return null;
  if (state.booting && !ui.str(state.msgSearch).trim()) return { strong: "加载中…", small: "" };
  if (ui.str(state.msgSearch).trim()) return { strong: "没有匹配的消息", small: "试着换个词,或按 Esc 清空搜索" };
  return { strong: "还没有消息", small: "发一句,或者派个需求" };
});

/* ===== 滚动 ===== */
let pendingRestoreGid = null;
let prevLen = 0;
let prevFirstId = null;
let prevHeight = 0;
let saveTimer = null;

function isAtBottom() {
  const el = streamEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}
function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

function updateLoadMore() {
  const el = streamEl.value;
  if (!el) return;
  loadMoreVisible.value = !!state.next && el.scrollTop < 120 && state.items.length > 0;
}

function saveScrollDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (state.groupId && streamEl.value) actions.setScroll(state.groupId, streamEl.value.scrollTop);
  }, 200);
}

function markRead() {
  if (!state.groupId) return;
  const last = state.items[state.items.length - 1];
  if (!last) return;
  if (state.pending.length) return;
  actions.saveRead(state.groupId, last.id);
}

function onScroll() {
  const el = streamEl.value;
  if (!el) return;
  state.stick = isAtBottom();
  if (state.stick && state.newCount) state.newCount = 0;
  updateLoadMore();
  if (state.stick) markRead();
  saveScrollDebounced();
}

watch(
  () => state.groupId,
  (gid) => {
    pendingRestoreGid = gid;
    prevLen = 0;
    prevFirstId = null;
    state.newCount = 0;
    state.stick = true;
  },
  { immediate: true }
);

watch(
  rows,
  () => {
    const el = streamEl.value;
    if (!el) return;
    const gid = state.groupId;
    const len = state.items.length;
    const firstId = state.items[0] ? String(state.items[0].id) : null;

    if (pendingRestoreGid !== null && gid === pendingRestoreGid) {
      if (len === 0) {
        prevLen = 0;
        return;
      }
      const saved = actions.getScroll(gid);
      const noSaved = saved === null || saved === undefined || !Number.isFinite(Number(saved));
      el.scrollTop = noSaved ? el.scrollHeight : Math.min(Number(saved), el.scrollHeight);
      state.stick = isAtBottom();
      pendingRestoreGid = null;
      prevLen = len;
      prevFirstId = firstId;
      prevHeight = el.scrollHeight;
      updateLoadMore();
      return;
    }

    const prepend =
      !ui.str(state.msgSearch).trim() && firstId !== prevFirstId && prevFirstId !== null && len > prevLen;
    if (prepend) {
      const delta = el.scrollHeight - prevHeight;
      el.scrollTop = el.scrollTop + Math.max(0, delta);
      prevLen = len;
      prevFirstId = firstId;
      prevHeight = el.scrollHeight;
      updateLoadMore();
      return;
    }

    const added = len - prevLen;
    if (added > 0) {
      if (state.stick) {
        el.scrollTop = el.scrollHeight;
        state.newCount = 0;
      } else {
        state.newCount += added;
      }
    }
    prevLen = len;
    prevFirstId = firstId;
    prevHeight = el.scrollHeight;
    updateLoadMore();
  },
  { flush: "post" }
);

watch(
  () => state.next,
  () => updateLoadMore()
);

function onNewMsg() {
  const el = streamEl.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  state.newCount = 0;
  markRead();
}

/* drop 不在这里处理：交给 ChatView 根容器统一接 dataTransfer.files（旧占位 toast 已移除）。 */

/* ===== 取消工作（两步确认） ===== */
function onCancel(workId) {
  if (!workId) return;
  if (finishedWorkIds().has(String(workId))) {
    actions.toast("该任务已经结束");
    return;
  }
  if (!confirming[workId]) {
    confirming[workId] = true;
    setTimeout(() => {
      confirming[workId] = false;
    }, 2000);
    return;
  }
  confirming[workId] = false;
  actions.cancelWork(workId);
}

onMounted(async () => {
  await nextTick();
  const el = streamEl.value;
  if (el && pendingRestoreGid !== null && pendingRestoreGid === state.groupId && state.items.length) {
    // 挂载时 items 已经有数据（预置/缓存）：补一次滚动恢复。
    const saved = actions.getScroll(state.groupId);
    const noSaved = saved === null || saved === undefined || !Number.isFinite(Number(saved));
    el.scrollTop = noSaved ? el.scrollHeight : Math.min(Number(saved), el.scrollHeight);
    state.stick = isAtBottom();
    pendingRestoreGid = null;
    prevLen = state.items.length;
    prevFirstId = state.items[0] ? String(state.items[0].id) : null;
    prevHeight = el.scrollHeight;
  }
  updateLoadMore();
});
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <div class="stream-wrap">
    <div
      class="stream"
      id="stream"
      ref="streamEl"
      role="log"
      @scroll="onScroll"
    >
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.t === 'time'" class="time-row"><span>{{ row.label }}</span></div>

        <div
          v-else-if="row.t === 'msg'"
          class="msg-row"
          :class="{ self: row.self, cont: row.cont }"
          :data-id="row.id"
        >
          <span class="avatar" :style="row.avatar.src ? { background: '#e6e6e6' } : { background: row.avatar.bg }">
            <img v-if="row.avatar.src" :src="row.avatar.src" alt="" />
            <template v-else>{{ row.avatar.glyph }}</template>
          </span>
          <div class="msg-col">
            <div v-if="!row.self" class="msg-name">{{ row.name }}</div>
            <div class="bubble" :class="{ failed: row.failed }">
              <template v-for="(seg, i) in row.segments" :key="i">
                <pre v-if="seg.t === 'pre'">{{ seg.v }}</pre>
                <span v-else-if="seg.t === 'mention'" class="mention">{{ seg.v }}</span>
                <template v-else>{{ seg.v }}</template>
              </template>
            </div>
            <button v-if="row.failed" class="send-fail" type="button" @click="actions.retryPending(row.id)">
              发送失败,点击重试
            </button>
          </div>
        </div>

        <div
          v-else-if="row.t === 'file'"
          class="msg-row"
          :class="{ self: row.self, cont: row.cont }"
          :data-id="row.id"
        >
          <span class="avatar" :style="row.avatar.src ? { background: '#e6e6e6' } : { background: row.avatar.bg }">
            <img v-if="row.avatar.src" :src="row.avatar.src" alt="" />
            <template v-else>{{ row.avatar.glyph }}</template>
          </span>
          <div class="msg-col">
            <div v-if="!row.self" class="msg-name">{{ row.name }}</div>
            <div class="chat-file">
              <FileBubble :file="row.file" mode="upload" />
            </div>
          </div>
        </div>

        <div v-else-if="row.t === 'workmsg'" class="msg-row" :data-id="row.id">
          <span class="avatar" :style="row.avatar.src ? { background: '#e6e6e6' } : { background: row.avatar.bg }">
            <img v-if="row.avatar.src" :src="row.avatar.src" alt="" />
            <template v-else>{{ row.avatar.glyph }}</template>
          </span>
          <div class="msg-col">
            <div class="msg-name">{{ row.name }}</div>
            <div class="bubble">
              <template v-for="(seg, i) in row.segments" :key="i">
                <pre v-if="seg.t === 'pre'">{{ seg.v }}</pre>
                <span v-else-if="seg.t === 'mention'" class="mention">{{ seg.v }}</span>
                <template v-else>{{ seg.v }}</template>
              </template>
            </div>
            <div v-if="row.files && row.files.length" class="file-bubbles">
              <FileBubble
                v-for="(f, i) in row.files"
                :key="i"
                :file="f.file"
                :artifact="f.artifact"
                :work-id="f.workId"
                mode="delivery"
              />
            </div>
          </div>
        </div>

        <div v-else-if="row.t === 'sys'" class="sys-row" :class="row.tone ? 'tone-' + row.tone : ''">
          <span
            >{{ row.text
            }}<button
              v-if="row.cancelWorkId"
              class="line-cancel"
              :class="{ confirm: confirming[row.cancelWorkId] }"
              type="button"
              @click.stop="onCancel(row.cancelWorkId)"
              >{{ confirming[row.cancelWorkId] ? "确认取消" : "取消" }}</button
            ></span
          >
        </div>
      </template>

      <div v-if="empty" class="chat-empty">
        <strong>{{ empty.strong }}</strong>
        <small v-if="empty.small">{{ empty.small }}</small>
      </div>
    </div>

    <button
      class="load-more"
      type="button"
      id="loadMore"
      :hidden="!loadMoreVisible"
      :disabled="state.loadingEarlier"
      @click="actions.loadEarlier()"
    >
      {{ state.loadingEarlier ? "加载中…" : "加载更早" }}
    </button>
    <button class="new-msg" type="button" id="newMsgBtn" aria-live="polite" :hidden="state.newCount <= 0" @click="onNewMsg">
      {{ state.newCount }} 条新消息
    </button>
  </div>
</template>
