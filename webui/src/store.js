/* musebot · 全局响应式 store（旧 bot/web/app.js 的数据层移植）。
   Vue 3 reactive 单例 + actions。旧实现是 IIFE + 原生 DOM；这里把「状态 / 帧分发 /
   WS / 发送 / 写接口」抽成 store，DOM 渲交由各组件负责。

   对外：
     state       —— reactive 单例（形状见 webui/CONTRACT.md §2.1，附运行时字段）
     actions     —— 全部数据动作（§2.2，另含若干控制器/便捷动作）
     boot()      —— 启动：读偏好、加载 profile/bots/groups、连 WS、按 hash 选群
     ui          —— lib/ui.js 的纯函数与常量（re-export）
     useMusebot()—— 返回 { state, actions, ui }
*/
import { reactive } from "vue";
import * as ui from "./lib/ui.js";
import { fetchJson, postJson, apiWrite, fileToBase64, fileToDataUrl } from "./lib/api.js";

/* ================= state ================= */
export const state = reactive({
  // 群
  groups: [],
  groupsLoaded: false,
  groupId: null,
  items: [],
  next: null,
  connected: false,
  // 详情缓存（群信息边栏用）gid -> {group,members,announcement,pins}
  detailByGroup: {},
  // bot
  bots: [],
  botCapabilities: [],
  // 列表 / 搜索
  search: "",
  msgSearch: "",
  filterCount: 0,
  // 本地个人偏好（localStorage）
  profile: { name: "我", signature: "", avatar: "", updatedAt: 0 },
  nick: "",
  mute: {}, // gid -> true
  remark: {}, // gid -> string
  pins: [], // 置顶群 id 列表（mb.pins）
  pinsCollapsed: false, // mb.pins.collapsed
  botsCollapsed: false, // mb.botsCollapsed
  // 面板开合
  infoOpen: false,
  infoEdit: null,
  infoQuery: "",
  contactsOpen: false,
  contactsQuery: "",
  contactsSelected: null,
  contactsManage: false,
  pickerOpen: false,
  pickerQuery: "",
  pickerPicked: [], // 已选 botId 数组
  settingsOpen: false,
  settingsPage: "ai",
  settingsQuery: "",
  settingsAdv: false,
  settingsConfig: null,
  settingsStatus: null,
  settingsCheck: null,
  devices: null,
  im: null,
  imToken: "",
  botOpen: false,
  botId: null,
  botProfile: null,
  botAcc: "overview",
  botQuery: "",
  // 记忆（bot 详情抽屉新增分区；后端 E 提供 REST）
  memory: { items: [], enabled: true, loading: false, error: "" },
  // 浮层
  toast: null, // {text, at}
  menu: null, // {x,y,items:[{label,run,danger,disabled}]}
  filePreview: null, // {file, artifact, workId, source, preview, loading}
  sheet: null, // {title, sections?}（旧 openSheet 的替代）
  // 运行时
  busyBots: [], // 当前群忙碌 botId 数组
  pending: [], // 乐观发送 [{tmpId,text,failed,sent,entry}]
  // 附加运行时（供组件/控制器用）
  view: "list", // 移动端 list / chat（旧 setView）
  drawerOpen: false, // 旧 .list-open
  newGroupOpen: false, // 旧 newGroupForm.hidden 取反
  lastId: 0,
  loadingEarlier: false,
  booting: true,
  newCount: 0,
  stick: true,
  hostName: "",
  serveResult: null,
  _tmpSeq: 0,
});

/* 让 lib/ui.js 的纯函数读到同一份 state（避免循环依赖） */
ui.bindState(state);

/* ================= 模块内私有运行时（非响应式） ================= */
let socket = null;
let socketGroup = null;
let retry = 0;
let retryTimer = null;
let detailLoading = new Set();
let booted = false;

const enc = encodeURIComponent;
const groupUrl = (gid) => "/api/groups/" + enc(gid);
const setPref = (k, v) => ui.store.set(k, v);

/* ================= 群数据 ================= */
function normalizeGroup(raw) {
  const g = raw || {};
  return {
    id: ui.str(g.id),
    name: ui.str(g.name, "未命名群"),
    type: ui.str(g.type, "group"), // "dm" = 私聊群，后端没给就按普通群
    roster: Array.isArray(g.roster) ? g.roster.map((x) => ui.str(x)) : [],
    createdAt: typeof g.createdAt === "number" ? g.createdAt : 0,
    last: g.last && typeof g.last === "object" ? g.last : null,
  };
}

function lastIdOf(items) {
  const tail = items[items.length - 1];
  const n = tail ? Number(tail.id) : 0;
  return Number.isFinite(n) ? n : state.lastId;
}

function currentFilter() {
  return state.msgSearch.trim().toLowerCase();
}

function computeFilterCount() {
  const q = currentFilter();
  state.filterCount = q ? state.items.filter((e) => ui.matchesFilter(e, q)).length : state.items.length;
}

/* ================= 详情缓存 ================= */
function applyDetail(gid, detail) {
  if (detail) state.detailByGroup[gid] = detail;
  return detail;
}

async function loadDetail(gid, force) {
  if (!gid) return null;
  const cached = state.detailByGroup[gid];
  if (cached && !force) return cached;
  if (detailLoading.has(gid)) return cached || null;
  detailLoading.add(gid);
  try {
    const data = await fetchJson(groupUrl(gid));
    state.detailByGroup[gid] = data;
    return data;
  } finally {
    detailLoading.delete(gid);
  }
}

/* ================= WS ================= */
function wsUrl(gid) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = location.host || "127.0.0.1:3000";
  return proto + "//" + host + "/stream?g=" + enc(gid);
}

function closeSocket() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retry = 0;
  const ws = socket;
  socket = null;
  socketGroup = null;
  state.connected = false;
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

function scheduleReconnect() {
  if (retryTimer) return;
  const delay = Math.min(1000 * Math.pow(1.7, retry++), 8000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (!state.groupId || socket) return;
  const groupId = state.groupId;
  let ws;
  try {
    ws = new WebSocket(wsUrl(groupId));
  } catch (_) {
    state.connected = false;
    scheduleReconnect();
    return;
  }
  socket = ws;
  socketGroup = groupId;

  ws.onopen = () => {
    if (socket !== ws) return;
    retry = 0;
    state.connected = true;
  };
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    if (typeof event.data === "string") onFrame(event.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    socketGroup = null;
    state.connected = false;
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose 统一处理 */
  };
}

/* ================= 状态帧（增量） ================= */
function removePending(tmpId) {
  const idx = state.pending.findIndex((p) => p.tmpId === tmpId);
  if (idx >= 0) state.pending.splice(idx, 1);
}

function reconcilePending(items) {
  if (!state.pending.length) return items.slice();
  const out = items.slice();
  for (const p of state.pending.slice()) {
    if (p.failed) {
      out.push(p.entry);
      continue;
    }
    const dup = out
      .slice(-8)
      .some(
        (e) =>
          e.kind === "chat.message" &&
          ui.str(e.data && e.data.text) === p.text &&
          ui.str(e.data && e.data.author && e.data.author.id) === ui.SELF_ID
      );
    if (dup) {
      removePending(p.tmpId);
      continue;
    }
    out.push(p.entry);
  }
  return out;
}

function syncBusyFromItems() {
  const set = [];
  const has = new Set();
  for (const entry of state.items) {
    if (entry.kind !== "work.event") continue;
    const d = entry.data || {};
    if (!d.botId) continue;
    if (d.ev === "started" && !has.has(d.botId)) {
      has.add(d.botId);
      set.push(d.botId);
    }
    if (d.ev === "done" || d.ev === "failed" || d.ev === "cancelled") {
      const i = set.indexOf(d.botId);
      if (i >= 0) set.splice(i, 1);
      has.delete(d.botId);
    }
  }
  state.busyBots = set;
}

function syncGroupPreview() {
  const g = ui.findGroup(state.groupId);
  if (!g) return;
  const tail = state.items[state.items.length - 1];
  if (tail) g.last = ui.previewOf(tail);
}

function markRead() {
  if (!state.groupId) return;
  const last = state.items[state.items.length - 1];
  if (!last) return;
  if (state.pending.length) return;
  setPref("mb.read." + state.groupId, String(last.id));
}

function applyState(frame) {
  if (frame.groupId && String(frame.groupId) !== state.groupId) return;
  const incoming = reconcilePending(Array.isArray(frame.items) ? frame.items : []);
  state.items = incoming;
  state.next = frame.next || null;
  state.lastId = lastIdOf(incoming);
  state.booting = false;
  computeFilterCount();
  syncBusyFromItems();
  syncGroupPreview();
  markRead();
}

function onFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (!frame || typeof frame !== "object") return;

  const type = frame.type || frame.kind;
  if (type === "groups") {
    onGroupsFrame(frame.groups);
    return;
  }
  if (type === "state") {
    applyState(frame);
    return;
  }
  if (type === "detail") {
    const gid = ui.str(frame.groupId) || ui.str(frame.detail && frame.detail.group && frame.detail.group.id);
    if (gid) applyDetail(gid, frame.detail);
    return;
  }
  if (type === "error") {
    toast(ui.str(frame.error, "操作失败"));
    return;
  }
  if (type === "chat.message" || type === "work.event" || type === "chat.file") {
    if (frame.groupId && String(frame.groupId) !== state.groupId) return;
    const entry = { id: frame.id, kind: type, data: frame.data };
    if (entry.id && state.items.some((e) => String(e.id) === String(entry.id))) return;
    state.items.push(entry);
    state.lastId = lastIdOf(state.items);
    computeFilterCount();
    syncBusyFromItems();
    syncGroupPreview();
    markRead();
  }
}

function onGroupsFrame(rawGroups) {
  state.groups = Array.isArray(rawGroups) ? rawGroups.map(normalizeGroup) : [];
  state.groupsLoaded = true;
  if (!state.groups.length) {
    closeSocket();
    state.groupId = null;
    state.items = [];
    return;
  }
  if (!ui.findGroup(state.groupId)) {
    applyGroup(state.groups[0].id);
    return;
  }
}

async function refreshGroups() {
  const data = await fetchJson("/api/groups");
  onGroupsFrame(Array.isArray(data.groups) ? data.groups : []);
  return state.groups;
}

/* ================= 群切换 ================= */
function parseHashId() {
  const m = /(?:^#|&)g=([^&]*)/.exec(location.hash || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch (_) {
    return m[1] || null;
  }
}

function hashFor(id) {
  return "#g=" + enc(id);
}

function replaceHash(id) {
  const next = hashFor(id);
  if (location.hash === next) return;
  try {
    history.replaceState(null, "", next);
  } catch (_) {
    location.hash = next;
  }
}

function applyGroup(id) {
  if (!id || !ui.findGroup(id)) return;
  if (state.groupId && state.groupId !== id) {
    const last = ui.lastOf(state.groupId);
    if (last && last.id) setPref("mb.read." + state.groupId, String(last.id));
  }
  if (state.groupId !== id) {
    closeInfo();
    closeBot();
  }
  const sameGroup = state.groupId === id && !!socket;
  state.groupId = id;
  replaceHash(id);
  if (typeof window !== "undefined" && window.innerWidth <= 560) state.view = "chat";
  if (sameGroup) return;

  closeSocket();
  state.items = [];
  state.next = null;
  state.newCount = 0;
  state.booting = true;
  state.stick = true;
  state.msgSearch = "";
  connect();
}

function selectGroup(id) {
  if (!id || !ui.findGroup(id)) return;
  applyGroup(id);
}

/** 把后端返回的群合入列表：已存在则原位更新，否则追加（私聊建卡/刷新共用）。 */
function mergeGroup(group) {
  if (!group || !group.id) return null;
  const idx = state.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) state.groups.splice(idx, 1, group);
  else {
    state.groups.push(group);
    state.groupsLoaded = true;
  }
  return group;
}

/** 打开与某 bot 的私聊：POST /api/dm/:botId/open → 群文档(type "dm")，走选群路径载 items。 */
async function openDm(botId) {
  const id = ui.str(botId);
  if (!id) return undefined;
  try {
    const data = await postJson("/api/dm/" + enc(id) + "/open", {});
    const group = mergeGroup(normalizeGroup(data && data.group ? data.group : data));
    if (!group) throw new Error("返回数据无效");
    closeContacts();
    selectGroup(group.id);
    return group;
  } catch (error) {
    toast("打开私聊失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function loadEarlier() {
  if (!state.next || state.loadingEarlier || !state.groupId) return;
  state.loadingEarlier = true;
  const gid = state.groupId;
  try {
    const url =
      groupUrl(gid) +
      "/items?limit=" +
      ui.PAGE_SIZE +
      "&before=" +
      enc(JSON.stringify(state.next));
    const data = await fetchJson(url);
    const older = Array.isArray(data.items) ? data.items : [];
    const have = new Set(state.items.map((e) => String(e.id)));
    state.items = older.filter((e) => !have.has(String(e.id))).concat(state.items);
    state.next = data.next || null;
    computeFilterCount();
    syncBusyFromItems();
  } catch (error) {
    toast("加载失败:" + (error.message || "网络错误"));
  } finally {
    state.loadingEarlier = false;
  }
}

/* ================= 发送 ================= */
function addPending(text) {
  const tmpId = "tmp-" + ++state._tmpSeq;
  const entry = {
    id: tmpId,
    kind: "chat.message",
    data: { author: { type: "human", id: ui.SELF_ID, name: ui.nickName() }, text },
    __pending: { id: tmpId, failed: false },
  };
  state.pending.push({ tmpId, text, failed: false, sent: false, entry });
  state.items.push(entry);
  state.lastId = lastIdOf(state.items);
  computeFilterCount();
  return tmpId;
}

async function send(text) {
  const value = ui.str(text).trim();
  if (!value || !state.groupId) return undefined;
  const gid = state.groupId;
  setPref("mb.draft." + gid, "");
  const tmpId = addPending(value);
  try {
    await postJson(groupUrl(gid) + "/send", {
      text: value,
      author: { type: "human", id: ui.SELF_ID, name: ui.nickName() },
    });
    const p = state.pending.find((x) => x.tmpId === tmpId);
    if (p) p.sent = true;
    return { ok: true };
  } catch (error) {
    const p = state.pending.find((x) => x.tmpId === tmpId);
    if (p) {
      p.failed = true;
      if (p.entry) p.entry.__pending.failed = true;
    }
    toast("发送失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function sendRequirement(text) {
  const value = ui.str(text).trim();
  if (!value || !state.groupId) return undefined;
  try {
    await postJson(groupUrl(state.groupId) + "/requirements", {
      text: value,
      author: { type: "human", id: ui.SELF_ID, name: ui.nickName() },
    });
    toast("已交给领导分工");
    return { ok: true };
  } catch (error) {
    toast("派需求失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function retryPending(tmpId) {
  const p = state.pending.find((x) => x.tmpId === tmpId);
  if (!p) return;
  p.failed = false;
  if (p.entry) p.entry.__pending.failed = false;
  try {
    await postJson(groupUrl(state.groupId) + "/send", { text: p.text });
    p.sent = true;
  } catch (error) {
    p.failed = true;
    if (p.entry) p.entry.__pending.failed = true;
    toast("重试失败:" + (error.message || "网络错误"));
  }
}

async function uploadOne(groupId, file, mime) {
  const data = await fileToBase64(file);
  return postJson(groupUrl(groupId) + "/uploads", {
    name: file.name || "file",
    mime: mime || file.type || "application/octet-stream",
    data,
    author: { type: "human", id: ui.SELF_ID, name: ui.nickName() },
  });
}

async function sendFileNow(file, isImage) {
  const gid = state.groupId;
  if (!gid || !file) return undefined;
  try {
    await uploadOne(gid, file, isImage ? file.type || "image/png" : file.type);
    toast("已发送 " + (file.name || "文件"));
    return { ok: true };
  } catch (error) {
    toast("发送失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/** 头像裁 160x160 -> dataURL（不落库，返回给调用方预览/保存）。 */
async function uploadAvatar(file) {
  const raw = await fileToDataUrl(file);
  const img = await new Promise((resolve, reject) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => reject(new Error("这张图片打不开"));
    node.src = raw;
  });
  const size = 160;
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.86);
}

async function createGroup(name) {
  const value = ui.str(name).trim();
  if (!value) return undefined;
  try {
    const data = await postJson("/api/groups", { name: value });
    closeNewGroup();
    await refreshGroups();
    const id = data && data.group ? data.group.id : null;
    if (id) selectGroup(id);
    toast("已建群:" + value);
    return data;
  } catch (error) {
    toast("建群失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/* ================= 工作 ================= */
async function cancelWork(workId) {
  if (!state.groupId || !workId) return undefined;
  try {
    await postJson(groupUrl(state.groupId) + "/work/" + enc(workId) + "/cancel", {});
    toast("已取消");
    return { ok: true };
  } catch (error) {
    toast("取消失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/* ================= 群信息写 ================= */
async function renameGroup(gid, name) {
  try {
    const next = await apiWrite("PUT", groupUrl(gid), { name });
    toast("群名已更新");
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("改名失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function setAnnouncement(gid, text) {
  try {
    const next = await apiWrite("PUT", groupUrl(gid) + "/announcement", { text });
    toast("群公告已更新");
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function addPin(gid, text) {
  const value = ui.str(text).trim();
  if (!value) return undefined;
  try {
    const next = await apiWrite("POST", groupUrl(gid) + "/pins", { text: value, by: ui.nickName() });
    toast("已置顶");
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("置顶失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function removePin(gid, pinId) {
  try {
    const next = await apiWrite("DELETE", groupUrl(gid) + "/pins/" + enc(ui.str(pinId)));
    toast("已取消置顶");
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("取消失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function addMember(gid, botId) {
  try {
    const next = await apiWrite("POST", groupUrl(gid) + "/members", { botId });
    await refreshGroups();
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("加入失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function removeMember(gid, botId) {
  try {
    const next = await apiWrite("DELETE", groupUrl(gid) + "/members/" + enc(botId));
    await refreshGroups();
    applyDetail(gid, next);
    return next;
  } catch (error) {
    toast("移出失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/** 串行加成员，逐个提示失败。 */
async function addMembers(gid, botIds) {
  const ids = Array.isArray(botIds) ? botIds.slice() : [];
  let added = 0;
  for (const botId of ids) {
    try {
      await apiWrite("POST", groupUrl(gid) + "/members", { botId });
      added += 1;
    } catch (error) {
      toast("加入 " + ui.botName(botId) + " 失败:" + (error.message || "网络错误"));
    }
  }
  return { added };
}

/* ================= bot ================= */
function closeBot() {
  state.botOpen = false;
  state.botId = null;
  state.botProfile = null;
}

async function openBot(gid, botId) {
  if (!state.groupId && gid) state.groupId = gid;
  state.botOpen = true;
  state.botId = botId;
  state.botQuery = "";
  if (!state.botProfile || state.botProfile.id !== botId) state.botAcc = "overview";
  return loadBotProfile(gid || state.groupId, botId);
}

async function loadBotProfile(gid, botId) {
  try {
    const data = await fetchJson(groupUrl(gid) + "/bots/" + enc(botId));
    state.botProfile = data;
    return data;
  } catch (error) {
    state.botProfile = { id: botId, error: error.message || "加载失败" };
    return state.botProfile;
  }
}

async function saveBotProfile(patch) {
  const gid = state.groupId;
  const botId = state.botId;
  if (!gid || !botId) return undefined;
  try {
    const next = await apiWrite("PUT", groupUrl(gid) + "/bots/" + enc(botId), patch);
    state.botProfile = next;
    const live = state.bots.find((b) => String(b.id) === String(botId));
    if (live) {
      live.name = next.name;
      live.avatar = next.avatar;
    }
    const cached = state.detailByGroup[gid];
    const member = cached && Array.isArray(cached.members) ? cached.members.find((r) => String(r.id) === String(botId)) : null;
    if (member) {
      member.name = next.name;
      member.avatar = next.avatar;
    }
    toast("已保存,下一轮生效");
    return next;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function createBot(payload) {
  try {
    const created = await postJson("/api/bots", payload || {});
    if (created && created.bot) state.bots.push(created.bot);
    if (created && created.added && payload && payload.groupId) {
      const detail = await loadDetail(payload.groupId, true);
      applyDetail(payload.groupId, detail);
    }
    toast(created && created.added ? `已创建「${(payload && payload.name) || ""}」并加入本群` : `已创建「${(payload && payload.name) || ""}」`);
    return created;
  } catch (error) {
    toast("创建失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function ensureBots() {
  if (state.bots.length) return state.bots;
  try {
    const data = await fetchJson("/api/bots");
    if (Array.isArray(data.bots)) state.bots = data.bots;
    if (Array.isArray(data.capabilities)) state.botCapabilities = data.capabilities;
  } catch (_) {
    /* roster 仍可用 */
  }
  return state.bots;
}

/* ================= 记忆（后端 E 提供；REST 约定） ================= */
const memoryUrl = (gid, botId) => groupUrl(gid) + "/bots/" + enc(botId) + "/memory";

function normalizeMemory(data) {
  return {
    items: Array.isArray(data && data.items) ? data.items : [],
    enabled: data && typeof data.enabled === "boolean" ? data.enabled : true,
    loading: false,
    error: "",
  };
}

async function loadMemory(gid, botId) {
  if (!gid || !botId) return undefined;
  state.memory = { ...state.memory, loading: true, error: "" };
  try {
    const data = await fetchJson(memoryUrl(gid, botId));
    state.memory = normalizeMemory(data);
    return state.memory;
  } catch (error) {
    state.memory = { ...state.memory, loading: false, error: error.message || "加载失败" };
    toast("记忆加载失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function addMemory(gid, botId, text) {
  const value = ui.str(text).trim();
  if (!value) return undefined;
  try {
    const data = await postJson(memoryUrl(gid, botId), { text: value });
    if (data && Array.isArray(data.items)) state.memory = normalizeMemory(data);
    else await loadMemory(gid, botId);
    toast("已记住");
    return data;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function deleteMemory(gid, botId, memId) {
  try {
    const data = await apiWrite("DELETE", memoryUrl(gid, botId) + "/" + enc(ui.str(memId)));
    if (data && Array.isArray(data.items)) state.memory = normalizeMemory(data);
    else await loadMemory(gid, botId);
    toast("已删除");
    return data;
  } catch (error) {
    toast("删除失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function toggleMemory(gid, botId, enabled) {
  try {
    const data = await apiWrite("PUT", memoryUrl(gid, botId), { enabled: !!enabled });
    if (data && Array.isArray(data.items)) state.memory = normalizeMemory(data);
    else await loadMemory(gid, botId);
    return data;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function toggleBotSkill(gid, botId, name, enabled) {
  try {
    const data = await apiWrite("PUT", groupUrl(gid) + "/bots/" + enc(botId) + "/skills", { name, enabled: !!enabled });
    if (state.botProfile && data && Array.isArray(data.skills)) {
      state.botProfile.skills = data.skills;
      if (Array.isArray(data.skillsAvailable)) state.botProfile.skillsAvailable = data.skillsAvailable;
    }
    return data;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/* ================= 设置 ================= */
async function loadSettingsData() {
  try {
    const [config, status, devices, im] = await Promise.all([
      fetchJson("/api/settings"),
      fetchJson("/api/status"),
      fetchJson("/api/devices"),
      state.groupId ? fetchJson(groupUrl(state.groupId) + "/im") : Promise.resolve(null),
    ]);
    state.settingsConfig = config;
    state.settingsStatus = status;
    state.devices = devices;
    state.im = im;
    return { config, status, devices, im };
  } catch (error) {
    state.settingsConfig = state.settingsConfig || { error: error.message || "加载失败" };
    return undefined;
  }
}

async function loadDevices() {
  try {
    state.devices = await fetchJson("/api/devices");
    return state.devices;
  } catch (error) {
    toast("加载失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function saveSettings(payload) {
  try {
    const next = await apiWrite("PUT", "/api/settings", payload || {});
    state.settingsConfig = next;
    state.settingsCheck = null;
    toast("模型配置已保存");
    await loadSettingsData();
    return next;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function checkSettings() {
  try {
    state.settingsCheck = await apiWrite("POST", "/api/settings/check", {});
  } catch (error) {
    state.settingsCheck = { ok: false, latencyMs: 0, detail: error.message || "网络错误" };
  }
  return state.settingsCheck;
}

async function applyNetwork(host) {
  try {
    const result = await apiWrite("PUT", "/api/network", { host });
    toast(result.restartRequired ? "已保存,重启后生效" : "已保存");
    await loadSettingsData();
    return result;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function toggleServe(enabled) {
  try {
    const result = await apiWrite("POST", "/api/tailscale/serve", { enabled: !!enabled });
    state.serveResult = [
      result.ok ? (enabled ? "已开启 tailnet 访问" : "已关闭 tailnet 访问") : "失败:" + (result.detail || ""),
      result.serve && result.serve.enabled ? (result.serve.entries || []).map((e) => e.url).join(" ") : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 600);
    toast(result.ok ? (enabled ? "已开启 tailnet 访问" : "已关闭") : "操作失败:" + (result.detail || ""));
    await loadSettingsData();
    return result;
  } catch (error) {
    state.serveResult = "失败:" + (error.message || "网络错误");
    toast("操作失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function loadIm(gid) {
  try {
    state.im = await fetchJson(groupUrl(gid) + "/im");
    return state.im;
  } catch (error) {
    toast("加载失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function rotateIm(gid) {
  try {
    const next = await apiWrite("POST", groupUrl(gid) + "/im/rotate", {});
    state.im = next;
    state.imToken = next.token;
    toast("新 token 已生成,旧 token 立即失效");
    return next;
  } catch (error) {
    toast("生成失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

async function updateIm(gid, patch) {
  try {
    const next = await apiWrite("PUT", groupUrl(gid) + "/im", patch || {});
    state.im = next;
    return next;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

function exportGroup(gid, format) {
  const id = gid || state.groupId;
  if (!id) return;
  const group = ui.findGroup(id);
  const link = document.createElement("a");
  link.href = groupUrl(id) + "/export" + (format ? "?format=" + enc(format) : "");
  link.setAttribute("download", "");
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast("正在导出「" + (group ? group.name : id) + "」的聊天记录");
}

/* ================= profile（自我资料） ================= */
async function loadProfile() {
  try {
    const data = await fetchJson("/api/profile");
    state.profile = {
      name: ui.str(data.name, "我"),
      signature: ui.str(data.signature),
      avatar: ui.str(data.avatar),
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch (_) {
    /* 默认资料仍可用 */
  }
  return state.profile;
}

async function saveProfile(patch) {
  try {
    const saved = await apiWrite("PUT", "/api/profile", patch || {});
    state.profile = { ...saved };
    toast("个人资料已保存");
    return state.profile;
  } catch (error) {
    toast("保存失败:" + (error.message || "网络错误"));
    return undefined;
  }
}

/* ================= 本地偏好写 ================= */
function setNick(nick) {
  state.nick = ui.str(nick).trim().slice(0, 20);
  setPref("mb.nick", state.nick);
  return state.nick;
}
function setRemark(gid, text) {
  const next = ui.str(text).trim().slice(0, 20);
  if (next) state.remark[gid] = next;
  else delete state.remark[gid];
  setPref("mb.remark", { ...state.remark });
  return next;
}
function toggleMute(gid) {
  if (state.mute[gid]) delete state.mute[gid];
  else state.mute[gid] = true;
  setPref("mb.mute", Object.keys(state.mute).filter((k) => state.mute[k]));
  return !!state.mute[gid];
}
function setHostName(name) {
  state.hostName = ui.str(name).slice(0, 24);
  setPref("mb.hostName", state.hostName);
  return state.hostName;
}
function setAdv(v) {
  state.settingsAdv = !!v;
  setPref("mb.adv", state.settingsAdv);
}
function togglePinsCollapse() {
  state.pinsCollapsed = !state.pinsCollapsed;
  setPref("mb.pins.collapsed", state.pinsCollapsed);
}
function toggleBotsCollapse() {
  state.botsCollapsed = !state.botsCollapsed;
  setPref("mb.botsCollapsed", state.botsCollapsed);
}
function setPins(pins) {
  state.pins = Array.isArray(pins) ? pins.slice() : [];
  setPref("mb.pins", state.pins);
}

/* ================= 草稿 / 滚动（组件负责调用时机） ================= */
function getDraft(gid) {
  return ui.store.get("mb.draft." + gid, "") || "";
}
function setDraft(gid, text) {
  if (!gid) return;
  setPref("mb.draft." + gid, text || "");
}
function getScroll(gid) {
  return ui.store.get("mb.scroll." + gid, null);
}
function setScroll(gid, top) {
  if (!gid) return;
  setPref("mb.scroll." + gid, top || 0);
}

/* ================= 面板 / 浮层控制 ================= */
function openInfo(section) {
  if (!state.groupId) return;
  closeBot();
  closeContacts();
  state.infoOpen = true;
  if (section !== undefined) state.infoEdit = section;
  void loadDetail(state.groupId, true).catch(() => undefined);
}
function closeInfo() {
  state.infoOpen = false;
  state.infoEdit = null;
  state.infoQuery = "";
}
function toggleInfo() {
  if (state.infoOpen) closeInfo();
  else openInfo();
}
function openContacts(botId) {
  closeInfo();
  closeBot();
  closeMenu();
  closeSettings();
  state.contactsOpen = true;
  state.contactsQuery = "";
  state.contactsSelected = botId || null;
  state.contactsManage = false;
  void ensureBots();
}
function closeContacts() {
  state.contactsOpen = false;
}
function openPicker() {
  state.pickerOpen = true;
  state.pickerQuery = "";
  state.pickerPicked = [];
}
function closePicker() {
  state.pickerOpen = false;
}
function openBotCreator() {
  state.sheet = { title: "新建 bot", kind: "botCreator" };
}
function openSheet(title, sections) {
  closeMenu();
  state.pickerOpen = false;
  state.settingsOpen = false;
  state.sheet = { title: ui.str(title), sections: sections || [] };
}
function closeSheet() {
  state.sheet = null;
}
function openFilePreview(payload) {
  state.filePreview = payload || null;
}
function closeFilePreview() {
  state.filePreview = null;
}
function openSettings(page = "ai") {
  if (!state.groupId && page !== "profile") return;
  closeMenu();
  closeContacts();
  state.settingsOpen = true;
  state.settingsPage = page;
  state.settingsQuery = "";
  state.pickerOpen = false;
  state.sheet = null;
  void loadSettingsData();
}
function closeSettings() {
  if (!state.settingsOpen) return;
  state.settingsOpen = false;
}

function openNewGroup() {
  state.newGroupOpen = true;
}
function closeNewGroup() {
  state.newGroupOpen = false;
}

function setView(view) {
  state.view = view === "chat" ? "chat" : "list";
}
function openDrawer() {
  state.drawerOpen = true;
}
function closeDrawer() {
  state.drawerOpen = false;
}

function setSearch(text) {
  state.search = ui.str(text);
}
function setMsgSearch(text) {
  state.msgSearch = ui.str(text);
  computeFilterCount();
}

/* ================= 菜单 / toast / closeAll ================= */
let toastTimer = null;
function toast(text, ms = 1800) {
  state.toast = { text: String(text ?? ""), at: Date.now() };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    toastTimer = null;
  }, ms);
}

function openMenuAt(x, y, items) {
  state.menu = { x: Number(x) || 0, y: Number(y) || 0, items: Array.isArray(items) ? items : [] };
}
function closeMenu() {
  state.menu = null;
}

/** 群行右键菜单：置顶 / 标记已读 / 删除本地已读。 */
function openGroupMenu(group, x, y) {
  const pinned = state.pins.includes(group.id);
  openMenuAt(x, y, [
    {
      label: pinned ? "取消置顶" : "置顶",
      run: () => {
        setPins(pinned ? state.pins.filter((id) => id !== group.id) : [group.id, ...state.pins]);
      },
    },
    {
      label: "标记已读",
      run: () => {
        const last = ui.lastOf(group.id);
        setPref("mb.read." + group.id, last && last.id ? String(last.id) : "0");
      },
    },
    { sep: true },
    {
      label: "删除本地已读记录",
      danger: true,
      run: () => {
        ui.store.del("mb.read." + group.id);
        toast("已清除");
      },
    },
  ]);
}

function closeAll() {
  closeMenu();
  closeSheet();
  closeFilePreview();
  state.toast = null;
  closeInfo();
  closeBot();
  closeContacts();
  closeSettings();
  state.pickerOpen = false;
}

/* ================= 启动 ================= */
async function boot() {
  if (booted) return;
  booted = true;

  state.groupsLoaded = false;
  state.pins = ui.store.get("mb.pins", []) || [];
  state.pinsCollapsed = !!ui.store.get("mb.pins.collapsed", false);
  state.botsCollapsed = !!ui.store.get("mb.botsCollapsed", false);
  state.settingsAdv = !!ui.store.get("mb.adv", false);
  state.hostName = ui.str(ui.store.get("mb.hostName", ""));
  state.nick = ui.str(ui.store.get("mb.nick", ""));

  const muteArr = ui.store.get("mb.mute", []) || [];
  state.mute = {};
  for (const id of muteArr) state.mute[id] = true;
  state.remark = { ...(ui.store.get("mb.remark", {}) || {}) };

  try {
    await Promise.allSettled([loadProfile(), ensureBots()]);
  } catch (_) {
    /* 资料/名单失败不阻塞 */
  }

  try {
    await refreshGroups();
  } catch (error) {
    state.groups = [];
    state.groupsLoaded = true;
    toast("群列表加载失败 · " + (error.message || ""));
    return;
  }

  if (!state.groups.length) return;

  const wanted = parseHashId();
  const target = ui.findGroup(wanted) || state.groups[0];
  applyGroup(target.id);
}

/* ================= 对外 actions ================= */
export const actions = {
  // 生命周期
  boot,
  connect,
  refreshGroups,
  selectGroup,
  openDm,
  loadEarlier,
  loadDetail,
  saveRead(gid, lastId) {
    if (gid) setPref("mb.read." + gid, String(lastId));
  },
  // 发送
  send,
  sendRequirement,
  retryPending,
  sendFileNow,
  uploadAvatar,
  createGroup,
  // 工作
  cancelWork,
  // 群信息写
  renameGroup,
  setAnnouncement,
  addPin,
  removePin,
  addMember,
  removeMember,
  addMembers,
  // bot
  openBot,
  closeBot,
  loadBotProfile,
  saveBotProfile,
  createBot,
  ensureBots,
  // 记忆
  loadMemory,
  addMemory,
  deleteMemory,
  toggleMemory,
  // 技能
  toggleBotSkill,
  // 设置
  openSettings,
  closeSettings,
  loadSettingsData,
  loadDevices,
  saveSettings,
  checkSettings,
  applyNetwork,
  toggleServe,
  loadIm,
  rotateIm,
  updateIm,
  exportGroup,
  // profile
  loadProfile,
  saveProfile,
  // 本地偏好
  setNick,
  setRemark,
  toggleMute,
  setHostName,
  setAdv,
  togglePinsCollapse,
  toggleBotsCollapse,
  setPins,
  getDraft,
  setDraft,
  getScroll,
  setScroll,
  // 面板 / 浮层
  openInfo,
  closeInfo,
  toggleInfo,
  openContacts,
  closeContacts,
  openPicker,
  closePicker,
  openBotCreator,
  openSheet,
  closeSheet,
  openFilePreview,
  closeFilePreview,
  openNewGroup,
  closeNewGroup,
  setView,
  openDrawer,
  closeDrawer,
  setSearch,
  setMsgSearch,
  // 通用
  toast,
  openMenuAt,
  closeMenu,
  openGroupMenu,
  closeAll,
  applyDetail,
};

export { ui };

export function useMusebot() {
  return { state, actions, ui };
}
