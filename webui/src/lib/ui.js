/* musebot · 常量与纯格式化函数（逐字对照旧 bot/web/app.js 移植）。
   旧实现里这些函数直接读模块级 state；Vue 版由 store.js 在创建 state 后调用
   bindState(state) 注入，避免 store <-> ui 循环依赖求值问题。 */

/* ================= 常量 ================= */
export const NS = "http://www.w3.org/2000/svg";
export const SELF_ID = "u1";
export const TIME_GAP = 5 * 60 * 1000;
export const PAGE_SIZE = 100;
export const VERSION = "0.4.1";

export const BOT_META = {
  leader: { name: "领导", cap: "orchestration" },
  finance: { name: "财务bot", cap: "finance" },
  data: { name: "数据bot", cap: "data" },
  analysis: { name: "分析bot", cap: "analysis" },
  design: { name: "设计bot", cap: "design" },
};

export const AVATAR_COLORS = ["#5b8ff9", "#61c2a2", "#b37feb", "#f6a623", "#7a8b99", "#e2738f", "#4aa0c7"];

export const EV_META = {
  planning: { tag: "分工中", cls: "planning" },
  plan: { tag: "计划", cls: "plan" },
  assigned: { tag: "派单", cls: "assigned" },
  started: { tag: "执行中", cls: "started" },
  blocked: { tag: "阻塞", cls: "blocked" },
  delivered: { tag: "交付", cls: "delivered" },
  done: { tag: "完成", cls: "done" },
  failed: { tag: "失败", cls: "failed" },
  cancelled: { tag: "取消", cls: "cancelled" },
};

export const EV_PREVIEW = {
  planning: "[分工中] 领导正在拆解需求",
  plan: "[计划] 已生成任务",
  assigned: "[派单]",
  started: "[执行中]",
  blocked: "[阻塞]",
  delivered: "[交付]",
  done: "[完成]",
  failed: "[失败]",
  cancelled: "[取消]",
};

export const EMOJIS = [
  "😀", "😄", "😁", "😆", "😅", "🤣", "😊", "🙂",
  "😉", "😍", "🤔", "😐", "😴", "😮", "😢", "😭",
  "😡", "👍", "👎", "👏", "🙏", "💪", "🎉", "🔥",
];

export const SHORTCUTS = [
  ["⌘K / Ctrl+K", "聚焦群搜索"],
  ["⌘F / Ctrl+F", "搜索当前群消息"],
  ["Enter", "发送消息"],
  ["Shift+Enter", "换行"],
  ["⌘Enter", "发送消息"],
  ["Esc", "关闭浮层 / 清空搜索"],
  ["右键群行", "置顶、标记已读"],
];

export const CAP_TEXT = { finance: "财务", data: "数据", analysis: "分析", design: "设计", general: "通用", orchestration: "编排" };
export const CAP_LABELS = { finance: "财务", data: "数据", analysis: "分析", design: "设计", general: "通用" };

export const TEXT_FILE = /\.(md|txt|json|csv|tsv|ya?ml|diff|patch|ts|js|mjs|py|html|css|sql|sh)$/i;
export const MD_FILE = /\.(md|markdown)$/i;

export const MD_INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
export const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** WeChat-composites a group avatar from its members: up to nine cells, 3 per row. */
export const GROUP_GRID = (n) => {
  if (n <= 1) return [1];
  if (n === 2) return [2];
  if (n === 3) return [1, 2];
  if (n === 4) return [2, 2];
  if (n === 5) return [2, 3];
  if (n === 6) return [3, 3];
  if (n === 7) return [1, 3, 3];
  if (n === 8) return [2, 3, 3];
  return [3, 3, 3];
};

/* ================= state 绑定 ================= */
let state = null;
export function bindState(s) {
  state = s;
}
const st = () => state;

/* ================= 本地存储 ================= */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* quota / private mode */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  },
};

/* ================= 基础 ================= */
export const str = (v, fallback) => (v === undefined || v === null || v === "" ? fallback || "" : String(v));

export function hashColor(seed) {
  let n = 0;
  const s = String(seed || "?");
  for (let i = 0; i < s.length; i += 1) n = (n * 31 + s.charCodeAt(i)) % 9973;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

export function firstChar(name, fallback) {
  const s = str(name, fallback || "?").trim();
  return s ? s.slice(0, 1) : "?";
}

/** 我在本群的昵称(本地覆盖)优先,否则用账号资料里的昵称。 */
export const nickName = () => str(state && state.nick, "") || str(state && state.profile && state.profile.name, "我");
export const profileAvatar = () => str(state && state.profile && state.profile.avatar);
export const isMuted = (gid) => !!(state && state.mute && state.mute[gid]);
export const remarkOf = (gid) => str(state && state.remark && state.remark[gid]);

/** 备注优先显示(仅自己可见),和微信一致。 */
export function displayName(group) {
  if (!group) return "";
  return remarkOf(group.id) || group.name;
}

/** Built-in metadata plus any bot created in the app (loaded from /api/bots). */
export function botMeta(id) {
  const key = str(id);
  const live = state && Array.isArray(state.bots) ? state.bots.find((bot) => str(bot.id) === key) : null;
  if (live) return live;
  return BOT_META[key] || null;
}

export function botName(id) {
  const meta = botMeta(id);
  return meta ? str(meta.name, str(id)) : str(id, "bot");
}

export function botAvatar(id) {
  const meta = botMeta(id);
  return meta ? str(meta.avatar) : "";
}

export function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

export function hhmm(d) {
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

export function timeLabel(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(d);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "昨天 " + hhmm(d);
  if (now.getTime() - ts < 6 * 86400000) return "周" + "日一二三四五六"[d.getDay()] + " " + hhmm(d);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(d)}`;
}

/** 只认服务端时间；没有就返回 null（不编造）。 */
export function tsOf(entry) {
  const at = entry && entry.data ? entry.data.at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function needsTime(prevTs, ts) {
  if (ts === null || ts === undefined) return false;
  if (prevTs === null || prevTs === undefined) return true;
  if (new Date(prevTs).toDateString() !== new Date(ts).toDateString()) return true;
  return Math.abs(ts - prevTs) > TIME_GAP;
}

export function shortId(id) {
  const s = str(id);
  if (!s) return "";
  const tail = /-([A-Za-z]+\d+)$/.exec(s);
  if (tail) return tail[1];
  return s.length > 12 ? s.slice(0, 10) + "…" : s;
}

export function workKeyOf(data) {
  if (!data) return "";
  if (data.key) return String(data.key);
  return shortId(data.workId);
}

export function subjectOf(data) {
  const explicit = str(data && data.subject);
  if (explicit) return explicit;
  if (data && data.botId) return botName(data.botId);
  return "";
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* ================= 群 / 详情辅助 ================= */
export function findGroup(id) {
  if (!state || !Array.isArray(state.groups)) return null;
  return state.groups.find((g) => g.id === id) || null;
}

export const readOf = (gid) => store.get("mb.read." + gid, 0);

export function detailNow() {
  if (!state) return null;
  return (state.detailByGroup && state.detailByGroup[state.groupId]) || null;
}

export function memberName(id) {
  const detail = detailNow();
  const member = detail && Array.isArray(detail.members) ? detail.members.find((m) => m.id === id) : null;
  if (member) return member.name;
  return botName(id);
}

export function memberNameByCapability(capability) {
  if (!capability) return "同事";
  const detail = detailNow();
  const member =
    detail && Array.isArray(detail.members)
      ? detail.members.find((m) => Array.isArray(m.capabilities) && m.capabilities.includes(capability))
      : null;
  if (member) return member.name;
  const known = Object.values(BOT_META).find((m) => m.cap === capability);
  return known ? known.name : capability;
}

/* ================= 预览 / 未读 ================= */
export function lastOf(gid) {
  if (state && gid === state.groupId) {
    const tail = state.items[state.items.length - 1];
    if (tail) return previewOf(tail);
  }
  const g = findGroup(gid);
  return g ? g.last : null;
}

export function previewOf(entry) {
  const data = (entry && entry.data) || {};
  return {
    id: String(entry && entry.id),
    kind: entry && entry.kind,
    ev: typeof data.ev === "string" ? data.ev : undefined,
    text: typeof data.text === "string" ? data.text : undefined,
    subject: typeof data.subject === "string" ? data.subject : undefined,
    name: typeof data.file?.name === "string" ? data.file.name : undefined,
    mime: typeof data.file?.mime === "string" ? data.file.mime : undefined,
    error: typeof data.error === "string" ? data.error : typeof data.reason === "string" ? data.reason : undefined,
    at: tsOf(entry) ?? undefined,
  };
}

export function summaryOfLast(last) {
  if (!last) return "";
  if (last.kind === "chat.file") {
    const mime = str(last.mime);
    const label = mime.startsWith("image/") ? "[图片]" : mime.startsWith("audio/") ? "[语音]" : "[文件]";
    return label + " " + str(last.name, "");
  }
  if (last.kind === "chat.message") return str(last.text, "");
  const prefix = EV_PREVIEW[last.ev] || "[工作]";
  const detail = last.subject || last.text || last.error;
  return detail ? prefix + " " + detail : prefix;
}

export function unreadOf(gid) {
  if (state && gid === state.groupId) return 0;
  const last = lastOf(gid);
  if (!last || !last.id) return 0;
  const read = Number(readOf(gid)) || 0;
  return Number(last.id) > read ? 1 : 0;
}

/** 消息搜索匹配（供 store 计算 filterCount，也可由组件复用）。 */
export function matchesFilter(entry, q) {
  if (!q) return true;
  const d = (entry && entry.data) || {};
  if (entry.kind === "chat.message") return str(d.text).toLowerCase().includes(q);
  if (entry.kind === "chat.file") return str(d.file && d.file.name).toLowerCase().includes(q);
  const blob = [
    d.ev,
    d.key,
    d.subject,
    d.reason,
    d.error,
    d.botId,
    d.artifact && d.artifact.title,
    d.artifact && d.artifact.body,
    Array.isArray(d.items) ? d.items.map((i) => i && i.subject).join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}
