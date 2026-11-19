/* musebot · 微信桌面端同构的多 bot 群聊客户端。
   零依赖、零构建：一个 IIFE + 原生 DOM。
   接口(只读现有契约，不新增字段)：
     GET  /api/groups                         群列表(含 last 预览)
     GET  /api/groups/:id                     群详情(成员/公告/置顶)
     POST /api/groups {name}                  建群
     GET  /api/groups/:id/items?limit&before  历史分页(before = 上一页的 next)
     POST /api/groups/:id/send                {text}
     POST /api/groups/:id/requirements        {text}
     POST /api/groups/:id/work/:workId/cancel 取消任务
     PUT  /api/groups/:id/announcement        {text}      改群公告
     POST /api/groups/:id/pins                {text, by}  加置顶
     DELETE /api/groups/:id/pins/:pinId                  删置顶
     POST /api/groups/:id/members             {botId}     加成员
     DELETE /api/groups/:id/members/:botId               移成员
     GET  /api/bots                           可加入的 bot 名单
     WS   /stream?g=<id>  ↓ groups / state(含 next) / detail(公告·置顶·成员) ↑ send / requirement
   时间：每条 entry 的 `data.at`(毫秒)。老数据没有 at 就不显示时间行，不编造。
*/
(() => {
  "use strict";

  /* ================= 常量 ================= */
  const NS = "http://www.w3.org/2000/svg";
  const SELF_ID = "u1";
  const TIME_GAP = 5 * 60 * 1000;
  const PAGE_SIZE = 100;
  const VERSION = "0.4.1";

  const BOT_META = {
    leader: { name: "领导", cap: "orchestration" },
    finance: { name: "财务bot", cap: "finance" },
    data: { name: "数据bot", cap: "data" },
    analysis: { name: "分析bot", cap: "analysis" },
    design: { name: "设计bot", cap: "design" },
  };

  const AVATAR_COLORS = ["#5b8ff9", "#61c2a2", "#b37feb", "#f6a623", "#7a8b99", "#e2738f", "#4aa0c7"];

  const EV_META = {
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

  const EV_PREVIEW = {
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

  const EMOJIS = [
    "😀", "😄", "😁", "😆", "😅", "🤣", "😊", "🙂",
    "😉", "😍", "🤔", "😐", "😴", "😮", "😢", "😭",
    "😡", "👍", "👎", "👏", "🙏", "💪", "🎉", "🔥",
  ];

  const SHORTCUTS = [
    ["⌘K / Ctrl+K", "聚焦群搜索"],
    ["⌘F / Ctrl+F", "搜索当前群消息"],
    ["Enter", "发送消息"],
    ["Shift+Enter", "换行"],
    ["⌘Enter", "发送消息"],
    ["Esc", "关闭浮层 / 清空搜索"],
    ["右键群行", "置顶、标记已读"],
  ];

  /* ================= 工具 ================= */
  const $ = (id) => document.getElementById(id);

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function svgIcon(paths, opts = {}) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", opts.width || "1.6");
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
    }
    return svg;
  }

  const str = (v, fallback) => (v === undefined || v === null || v === "" ? fallback || "" : String(v));

  const store = {
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

  function hashColor(seed) {
    let n = 0;
    const s = String(seed || "?");
    for (let i = 0; i < s.length; i += 1) n = (n * 31 + s.charCodeAt(i)) % 9973;
    return AVATAR_COLORS[n % AVATAR_COLORS.length];
  }

  function firstChar(name, fallback) {
    const s = str(name, fallback || "?").trim();
    return s ? s.slice(0, 1) : "?";
  }

  /** 我在本群的昵称(本地覆盖)优先,否则用账号资料里的昵称。 */
  const nickName = () => str(state.nick, "") || str(state.profile && state.profile.name, "我");
  const profileAvatar = () => str(state.profile && state.profile.avatar);
  const isMuted = (gid) => state.mute.has(gid);
  const remarkOf = (gid) => str(state.remark.get(gid));
  /** 备注优先显示(仅自己可见),和微信一致。 */
  function displayName(group) {
    if (!group) return "";
    return remarkOf(group.id) || group.name;
  }

  /** Built-in metadata plus any bot created in the app (loaded from /api/bots). */
  function botMeta(id) {
    const key = str(id);
    const live = state.bots.find((bot) => str(bot.id) === key);
    if (live) return live;
    return BOT_META[key] || null;
  }

  function botName(id) {
    const meta = botMeta(id);
    return meta ? str(meta.name, str(id)) : str(id, "bot");
  }

  function botAvatar(id) {
    const meta = botMeta(id);
    return meta ? str(meta.avatar) : "";
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function hhmm(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function timeLabel(ts) {
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
  function tsOf(entry) {
    const at = entry && entry.data ? entry.data.at : undefined;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  }

  function needsTime(prevTs, ts) {
    if (ts === null || ts === undefined) return false;
    if (prevTs === null || prevTs === undefined) return true;
    if (new Date(prevTs).toDateString() !== new Date(ts).toDateString()) return true;
    return Math.abs(ts - prevTs) > TIME_GAP;
  }

  function shortId(id) {
    const s = str(id);
    if (!s) return "";
    const tail = /-([A-Za-z]+\d+)$/.exec(s);
    if (tail) return tail[1];
    return s.length > 12 ? s.slice(0, 10) + "…" : s;
  }

  function workKeyOf(data) {
    if (!data) return "";
    if (data.key) return String(data.key);
    return shortId(data.workId);
  }

  function detailNow() {
    return state.detail.get(state.groupId) || null;
  }

  function memberName(id) {
    const detail = detailNow();
    const member = detail && Array.isArray(detail.members) ? detail.members.find((m) => m.id === id) : null;
    if (member) return member.name;
    return botName(id);
  }

  function memberNameByCapability(capability) {
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

  /** Work activity reads as a plain line, the way WeChat shows "XX 撤回了一条消息". */
  function eventLine(text, tone) {
    const row = h("div", "sys-row" + (tone ? " tone-" + tone : ""));
    row.appendChild(h("span", null, text));
    return row;
  }

  function subjectOf(data) {
    const explicit = str(data && data.subject);
    if (explicit) return explicit;
    if (data && data.botId) return botName(data.botId);
    return "";
  }

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function readJsonSafe(res) {
    return res.json().catch(() => null);
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(errText(data, res.status));
    return data;
  }

  function errText(data, status) {
    if (data && data.error) return String(data.error);
    return "HTTP " + status;
  }

  function selectionActive() {
    const sel = window.getSelection();
    return !!(sel && sel.rangeCount > 0 && !sel.isCollapsed && String(sel).trim().length > 0);
  }

  /* ================= 状态 ================= */
  const state = {
    groups: [],
    groupsLoaded: false,
    groupId: null,
    items: [],
    next: null,
    ws: null,
    socketGroup: null,
    connected: false,
    retry: 0,
    retryTimer: null,
    pending: new Map(),
    tmpSeq: 0,
    pins: [],
    pinsCollapsed: false,
    lastId: 0,
    newCount: 0,
    stick: true,
    booting: true,
    restoreScroll: null,
    fadeNext: false,
    search: "",
    msgSearch: "",
    filterCount: 0,
    detail: new Map(),
    detailLoading: new Set(),
    bots: [],
    botCapabilities: [],
    infoOpen: false,
    infoEdit: null,
    infoQuery: "",
    contactsOpen: false,
    contactsQuery: "",
    contactsSelected: null,
    contactsManage: false,
    pickerQuery: "",
    pickerPicked: new Set(),
    settingsOpen: false,
    settingsPage: "ai",
    settingsQuery: "",
    settingsAdv: false,
    settingsForm: false,
    settingsConfig: null,
    settingsStatus: null,
    settingsCheck: null,
    settingsSaving: false,
    profile: { name: "我", signature: "", avatar: "", updatedAt: 0 },
    profileDraft: null,
    devices: null,
    im: null,
    imToken: "",
    networkBusy: false,
    serveBusy: false,
    hostName: "",
    botOpen: false,
    botId: null,
    botProfile: null,
    botAcc: "overview",
    botQuery: "",
    nick: "",
    mute: new Set(),
    remark: new Map(),
    deferredRender: false,
    busyBots: new Set(),
  };

  /* ================= DOM ================= */
  const app = $("app");
  const stream = $("stream");
  const input = $("input");
  const sendBtn = $("sendBtn");
  const groupList = $("groupList");
  const searchInput = $("searchInput");
  const newGroupBtn = $("newGroupBtn");
  const newGroupForm = $("newGroupForm");
  const newGroupName = $("newGroupName");
  const newGroupOk = $("newGroupOk");
  const newGroupCancel = $("newGroupCancel");
  const newGroupErr = $("newGroupErr");
  const groupTitleBtn = $("groupTitleBtn");
  const memberCount = $("memberCount");
  const connBanner = $("connBanner");
  const msgSearch = $("msgSearch");
  const msgSearchInput = $("msgSearchInput");
  const msgSearchCount = $("msgSearchCount");
  const loadMoreBtn = $("loadMore");
  const newMsgBtn = $("newMsgBtn");
  const overlay = $("overlay");
  const infoPane = $("infoPane");
  const infoBody = $("infoBody");
  const contactsWindow = $("contactsWindow");
  const contactsList = $("contactsList");
  const contactsDetail = $("contactsDetail");
  const contactsSearch = $("contactsSearch");
  const contactsClose = $("contactsClose");
  const contactsManage = $("contactsManage");
  const contactsManageText = $("contactsManageText");
  const picker = $("picker");
  const pickerList = $("pickerList");
  const pickerChosen = $("pickerChosen");
  const pickerCount = $("pickerCount");
  const pickerGroupCount = $("pickerGroupCount");
  const pickerSearch = $("pickerSearch");
  const pickerOk = $("pickerOk");
  const pickerCancel = $("pickerCancel");
  const settingsEl = $("settings");
  const settingsNav = $("settingsNav");
  const settingsBody = $("settingsBody");
  const settingsTitle = $("settingsTitle");
  const settingsSub = $("settingsSub");
  const settingsSearch = $("settingsSearch");
  const settingsAdvBtn = $("settingsAdv");
  const settingsVersion = $("settingsVersion");
  const fileInput = $("fileInput");
  const imageInput = $("imageInput");
  const avatarInput = $("avatarInput");
  const botAvatarInput = $("botAvatarInput");
  const voiceBar = $("voiceBar");
  const voiceTime = $("voiceTime");
  const toolVoice = $("toolVoice");
  const botPane = $("botPane");
  const botBody = $("botBody");
  const sheetTitle = $("sheetTitle");
  const sheetBody = $("sheetBody");
  const menu = $("menu");
  const toastEl = $("toast");
  const emojiPanel = $("emojiPanel");
  const railBadge = $("railBadge");
  const railAvatar = $("railAvatar");
  const chatPane = $("chat");
  const backBtn = $("backBtn");
  const drawerBtn = $("drawerBtn");
  const listBackdrop = $("listBackdrop");

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= 群数据 ================= */
  function normalizeGroup(raw) {
    const g = raw || {};
    return {
      id: str(g.id),
      name: str(g.name, "未命名群"),
      roster: Array.isArray(g.roster) ? g.roster.map((x) => str(x)) : [],
      createdAt: typeof g.createdAt === "number" ? g.createdAt : 0,
      last: g.last && typeof g.last === "object" ? g.last : null,
    };
  }

  function findGroup(id) {
    return state.groups.find((g) => g.id === id) || null;
  }

  const readOf = (gid) => store.get("mb.read." + gid, 0);

  function lastOf(gid) {
    if (gid === state.groupId) {
      const tail = state.items[state.items.length - 1];
      if (tail) return previewOf(tail);
    }
    const g = findGroup(gid);
    return g ? g.last : null;
  }

  function previewOf(entry) {
    const data = entry.data || {};
    return {
      id: String(entry.id),
      kind: entry.kind,
      ev: typeof data.ev === "string" ? data.ev : undefined,
      text: typeof data.text === "string" ? data.text : undefined,
      subject: typeof data.subject === "string" ? data.subject : undefined,
      name: typeof data.file?.name === "string" ? data.file.name : undefined,
      mime: typeof data.file?.mime === "string" ? data.file.mime : undefined,
      error: typeof data.error === "string" ? data.error : typeof data.reason === "string" ? data.reason : undefined,
      at: tsOf(entry) ?? undefined,
    };
  }

  function summaryOfLast(last) {
    if (!last) return "";
    if (last.kind === "chat.file") {
      const mime = str(last.mime);
      const label = mime.startsWith("image/") ? "[图片]" : mime.startsWith("audio/") ? "[语音]" : "[文件]";
      return label + " " + str(last.name, "");
    }
    if (last.kind === "chat.message") return str(last.text, "");
    const prefix = EV_PREVIEW[last.ev] || "[工作]";
    // Cards name their task ("[交付] 拉取本周值班数据"); fall back to text/reason.
    const detail = last.subject || last.text || last.error;
    return detail ? prefix + " " + detail : prefix;
  }

  function unreadOf(gid) {
    if (gid === state.groupId) return 0;
    const last = lastOf(gid);
    if (!last || !last.id) return 0;
    const read = Number(readOf(gid)) || 0;
    return Number(last.id) > read ? 1 : 0;
  }

  /* ================= 渲染：群列表 ================= */
  /** The bot roster belongs beside groups, not only inside a drawer: people should
      always see who they can ask, and get to "新建 bot" without hunting. */
  function botListSection(q) {
    const bots = state.bots.filter((bot) => {
      if (!q) return true;
      const caps = Array.isArray(bot.capabilities) ? bot.capabilities.join(" ") : "";
      return `${bot.name || bot.id} ${caps}`.toLowerCase().includes(q);
    });
    if (!bots.length) return null;
    const section = h("div", "bot-section");
    const head = h("div", "bot-section-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.title = state.botsCollapsed ? "展开我的 bot" : "折叠我的 bot";
    head.appendChild(h("span", "bot-section-icon", "☰"));
    head.appendChild(h("span", "bot-section-title", "我的 bot"));
    head.appendChild(h("span", "bot-section-count", String(bots.length)));
    const add = h("button", "bot-section-add", "+");
    add.type = "button";
    add.title = "新建 bot";
    add.setAttribute("aria-label", "新建 bot");
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      openBotCreator();
    });
    head.appendChild(add);
    const chevron = h("span", "bot-section-chevron", state.botsCollapsed ? "⌄" : "⌃");
    head.appendChild(chevron);
    const toggle = () => {
      state.botsCollapsed = !state.botsCollapsed;
      store.set("mb.botsCollapsed", state.botsCollapsed);
      renderGroups();
    };
    head.addEventListener("click", (event) => {
      if (event.target.closest(".bot-section-add")) return;
      toggle();
    });
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    section.appendChild(head);
    if (state.botsCollapsed) return section;

    const group = findGroup(state.groupId);
    const roster = new Set(group ? group.roster : []);
    for (const bot of bots) {
      const row = h("button", "bot-row");
      row.type = "button";
      row.title = `${bot.name || bot.id}${bot.capabilities?.length ? " · " + bot.capabilities.join("/") : ""}`;
      row.appendChild(avatarEl(bot.name || bot.id, bot.id, "", bot.avatar));
      const main = h("span", "bot-row-main");
      main.appendChild(h("span", "bot-row-name", bot.name || bot.id));
      main.appendChild(h("span", "bot-row-cap", (bot.capabilities || []).join(" · ") || bot.role || "bot"));
      row.appendChild(main);
      if (roster.has(bot.id)) row.appendChild(h("span", "bot-row-state", "在群里"));
      row.addEventListener("click", () => {
        if (state.groupId && roster.has(bot.id)) openBotPane(bot.id);
        else openContactsPane(bot.id);
      });
      section.appendChild(row);
    }
    return section;
  }

  function renderGroups() {
    groupList.textContent = "";
    const q = state.search.trim().toLowerCase();
    const all = state.groups.filter((g) => !q || displayName(g).toLowerCase().includes(q));
    const pinnedIds = state.pins.filter((id) => state.groups.some((g) => g.id === id));
    const pinned = pinnedIds.map(findGroup).filter(Boolean);
    const rest = all.filter((g) => !pinnedIds.includes(g.id));

    if (!state.groupsLoaded) {
      groupList.appendChild(h("div", "list-empty", "加载中…"));
      updateRailBadge();
      return;
    }
    if (!state.groups.length) {
      groupList.appendChild(h("div", "list-empty", "还没有群"));
      const bots = botListSection(q);
      if (bots) groupList.appendChild(bots);
      updateRailBadge();
      return;
    }
    if (!all.length) {
      groupList.appendChild(h("div", "list-empty", "没有匹配的群"));
      const bots = botListSection(q);
      if (bots) groupList.appendChild(bots);
      updateRailBadge();
      return;
    }

    if (pinned.length) {
      const summary = h("button", "pin-summary");
      summary.type = "button";
      summary.setAttribute("aria-expanded", state.pinsCollapsed ? "false" : "true");
      const icon = h("span", "pin-summary-icon");
      icon.appendChild(svgIcon(["M4 7h16M4 12h16M4 17h16"], { width: "1.5" }));
      summary.appendChild(icon);
      summary.appendChild(h("span", "pin-summary-text", `${pinned.length}个置顶聊天`));
      summary.appendChild(svgIcon(["m7 10 5 5 5-5"], { width: "1.6" })).classList.add("pin-summary-chevron");
      summary.addEventListener("click", () => {
        state.pinsCollapsed = !state.pinsCollapsed;
        store.set("mb.pins.collapsed", state.pinsCollapsed);
        renderGroups();
      });
      groupList.appendChild(summary);
      if (!state.pinsCollapsed) {
        for (const g of pinned) groupList.appendChild(groupRow(g, true));
        if (rest.length) groupList.appendChild(h("div", "pin-gap"));
      }
    }

    for (const g of rest) groupList.appendChild(groupRow(g, false));
    const bots = botListSection(q);
    if (bots) groupList.appendChild(bots);
    updateRailBadge();
  }

  function groupRow(group, pinned) {
    const active = group.id === state.groupId;
    const row = h("div", "row" + (active ? " active" : "") + (pinned ? " pinned" : ""));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", active ? "true" : "false");
    row.tabIndex = 0;
    row.dataset.id = group.id;
    row.title = displayName(group);

    row.appendChild(groupAvatarEl(group));

    const main = h("span", "row-main");
    const top = h("span", "row-top");
    top.appendChild(h("span", "row-name", displayName(group)));
    const last = lastOf(group.id);
    top.appendChild(h("span", "row-time", last ? timeLabel(last.at) : ""));
    main.appendChild(top);

    const bottom = h("span", "row-bottom");
    bottom.appendChild(h("span", "row-sum", summaryOfLast(last) || "暂无消息"));
    const unread = unreadOf(group.id);
    if (unread > 0) {
      // 免打扰的群只给小圆点,不报数(和微信一致)
      bottom.appendChild(isMuted(group.id) ? h("span", "row-badge dot") : h("span", "row-badge", "1"));
    }
    main.appendChild(bottom);

    row.appendChild(main);
    row.addEventListener("click", () => selectGroup(group.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectGroup(group.id);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openGroupMenu(group, event.clientX, event.clientY);
    });
    return row;
  }

  function updateRailBadge() {
    // 免打扰的群不计入左栏角标
    const total = state.groups.reduce((sum, g) => sum + (isMuted(g.id) ? 0 : unreadOf(g.id)), 0);
    railBadge.hidden = total <= 0;
    railBadge.textContent = total > 9 ? "9+" : String(total);
  }

  function renderRailAvatar() {
    paintAvatar(railAvatar, nickName(), SELF_ID, profileAvatar());
    railAvatar.title = nickName();
  }

  /** Load the account profile once at boot; every avatar on the page follows it. */
  async function loadProfile() {
    try {
      const data = await fetchJson("/api/profile");
      state.profile = {
        name: str(data.name, "我"),
        signature: str(data.signature),
        avatar: str(data.avatar),
        updatedAt: Number(data.updatedAt) || 0,
      };
    } catch (_) {
      /* default profile is still usable */
    }
    renderRailAvatar();
  }

  /* ================= 渲染：头部 ================= */
  function renderHeader() {
    const group = findGroup(state.groupId);
    groupTitleBtn.textContent = group ? displayName(group) : "—";
    memberCount.textContent = group ? group.roster.length + " 个成员" : "";
    document.title = group ? group.name + " · musebot" : "musebot";
  }

  /* ================= 渲染：消息流 ================= */
  function isSelf(entry) {
    const d = entry.data || {};
    const a = d.author || {};
    return a.type === "human" && (String(a.id) === SELF_ID || a.name === "我");
  }

  function authorKey(entry) {
    const d = entry.data || {};
    const a = d.author || {};
    return str(a.id, str(a.name, "?"));
  }

  function currentFilter() {
    return state.msgSearch.trim().toLowerCase();
  }

  function matchesFilter(entry, q) {
    if (!q) return true;
    const d = entry.data || {};
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

  function timeRow(ts) {
    const row = h("div", "time-row");
    row.appendChild(h("span", null, timeLabel(ts)));
    return row;
  }

  /** WeChat-composites a group avatar from its members: up to nine cells, 3 per row. */
  const GROUP_GRID = (n) => {
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

  function groupAvatarEl(group, size) {
    const members = [
      { id: SELF_ID, name: nickName(), avatar: profileAvatar() },
      ...(group && Array.isArray(group.roster) ? group.roster : []).map((id) => ({
        id,
        name: botName(id),
        avatar: botAvatar(id),
      })),
    ].slice(0, 9);
    const rows = GROUP_GRID(members.length);
    const el = h("span", "avatar avatar-grid" + (members.length <= 1 ? " ag-single" : ""));
    if (size) {
      el.style.width = size + "px";
      el.style.height = size + "px";
    }
    // 3 cells per row leaves ~11px per cell at 40px; keep the glyph inside it.
    const fontSize = members.length <= 1 ? 15 : members.length <= 2 ? 11 : members.length <= 4 ? 9.5 : 6.5;
    let index = 0;
    for (const count of rows) {
      const row = h("span", "ag-row");
      for (let i = 0; i < count; i += 1) {
        const member = members[index] ?? { id: "?", name: "?" };
        index += 1;
        const cell = h("span", "ag-cell");
        if (/^data:image\//i.test(str(member.avatar))) {
          cell.style.backgroundImage = 'url("' + member.avatar + '")';
          cell.style.backgroundSize = "cover";
          cell.style.backgroundPosition = "center";
        } else {
          cell.textContent = str(member.avatar) || firstChar(member.name);
        }
        if (!cell.style.backgroundImage) cell.style.background = hashColor(member.id);
        cell.style.fontSize = fontSize + "px";
        cell.title = member.name;
        row.appendChild(cell);
      }
      el.appendChild(row);
    }
    return el;
  }

  /** Paint a span.avatar with either a picture or a glyph; shared by rail, lists and messages. */
  function paintAvatar(el, name, seed, avatar) {
    el.textContent = "";
    const value = str(avatar);
    if (/^data:image\//i.test(value)) {
      const img = document.createElement("img");
      img.src = value;
      img.alt = "";
      el.appendChild(img);
      el.style.background = "#e6e6e6";
    } else {
      el.textContent = value || firstChar(name);
      el.style.background = hashColor(seed || name);
    }
    return el;
  }

  function avatarEl(name, seed, cls, avatar) {
    return paintAvatar(h("span", "avatar" + (cls ? " " + cls : "")), name, seed, avatar);
  }

  function appendWithMentions(parent, text) {
    const s = str(text);
    const parts = s.split(/(@[^\s@,，。:：;；()（）]+)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("@")) parent.appendChild(h("span", "mention", part));
      else parent.appendChild(document.createTextNode(part));
    }
  }

  function renderTextInto(parent, text) {
    const s = str(text);
    if (!s.includes("```")) {
      appendWithMentions(parent, s);
      return;
    }
    const parts = s.split(/```/);
    parts.forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) {
        const pre = document.createElement("pre");
        pre.textContent = part.replace(/^\n/, "").replace(/\n$/, "");
        parent.appendChild(pre);
      } else {
        const span = document.createElement("span");
        span.textContent = part;
        parent.appendChild(span);
      }
    });
  }

  function authorAvatar(author) {
    const a = author || {};
    if (a.type === "bot") return botAvatar(a.id);
    if (String(a.id) === SELF_ID || a.name === "我") return profileAvatar();
    return "";
  }

  function renderMessage(entry, prev) {
    const d = entry.data || {};
    const self = isSelf(entry);
    const sameAuthor = prev && prev.kind === "chat.message" && prev.author === authorKey(entry);
    const ts = tsOf(entry);
    const cont = sameAuthor && ts !== null && prev.ts !== null && Math.abs(ts - prev.ts) < TIME_GAP;

    const row = h("div", "msg-row" + (self ? " self" : "") + (cont ? " cont" : ""));
    row.dataset.id = str(entry.id);

    const name = str(d.author && d.author.name, self ? "我" : "成员");
    row.appendChild(avatarEl(name, str(d.author && d.author.id, name), "", authorAvatar(d.author)));

    const col = h("div", "msg-col");
    if (!self) col.appendChild(h("div", "msg-name", name));
    const bubble = h("div", "bubble");
    renderTextInto(bubble, d.text);
    col.appendChild(bubble);

    const pending = entry.__pending;
    if (pending && pending.failed) {
      bubble.classList.add("failed");
      const retry = h("button", "send-fail", "发送失败,点击重试");
      retry.type = "button";
      retry.addEventListener("click", () => retryPending(pending.id));
      col.appendChild(retry);
    }
    row.appendChild(col);
    return row;
  }

  function tagEl(ev) {
    const meta = EV_META[ev] || { tag: ev, cls: "done" };
    const tag = h("span", "tag tag-" + meta.cls);
    if (meta.cls === "started") tag.appendChild(h("span", "dot"));
    tag.appendChild(document.createTextNode(meta.tag));
    return tag;
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

  function cancelButton(workId) {
    const btn = h("button", "card-cancel", "取消");
    btn.type = "button";
    btn.addEventListener("click", () => confirmCancel(btn, workId));
    return btn;
  }

  function cardHead({ ev, title, id, workId }) {
    const head = h("div", "card-head");
    head.appendChild(tagEl(ev));
    head.appendChild(h("span", "card-title", title));
    if (id) head.appendChild(h("span", "card-id", id));
    if (workId) head.appendChild(cancelButton(workId));
    return head;
  }

  /** Bubbles show plain words: strip the markdown noise the model likes to emit. */
  function plainText(text) {
    return str(text)
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}[-*+]\s+/gm, "· ")
      .replace(/^\s{0,3}(\d+)\.\s+/gm, "$1. ")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  }

  function clampText(text, max) {
    const s = str(text);
    return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
  }

  /** A bot message: same bubble as a person's, with its own avatar and name. */
  function agentMessage(entry, who, text) {
    const author = { type: "bot", id: str(who.id, "bot"), name: str(who.name, "bot") };
    return renderMessage({ id: entry.id, kind: "chat.message", data: { author, text } }, null);
  }

  /** Download URL for one archived deliverable; null when the entry has no work id. */
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

  const TEXT_FILE = /\.(md|txt|json|csv|tsv|ya?ml|diff|patch|ts|js|mjs|py|html|css|sql|sh)$/i;

  function fileBubble(file, artifact, workId) {
    const name = str(file.name || file.title || file.path, "file");
    const btn = h("button", "file-bubble");
    btn.type = "button";
    btn.appendChild(
      svgIcon(
        ["M13.5 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5z", "M13.5 4.5v5h5"],
        { width: "1.5" }
      )
    );
    const meta = h("span", "file-meta");
    meta.appendChild(h("span", "file-name", name));
    const size = formatSize(file.size ?? file.bytes);
    if (size) meta.appendChild(h("span", "file-size", size));
    btn.appendChild(meta);
    btn.addEventListener("click", () => openFileSheet(file, artifact, workId));
    return btn;
  }

  /**
   * Work events are messages, not cards: the leader writes what it split,
   * a bot says what it delivered, and progress is a quiet centred line.
   */
  function renderWorkEvent(entry) {
    const d = entry.data || {};
    const ev = str(d.ev, "unknown");
    const subject = subjectOf(d);

    if (ev === "planning") return eventLine("领导正在分工…");
    if (ev === "assigned" || ev === "done") return null;

    if (ev === "plan") {
      const items = Array.isArray(d.items) ? d.items : [];
      const lines = [`我拆成 ${items.length} 件事,分给这几位:`];
      for (const item of items) {
        if (!item) continue;
        const deps = Array.isArray(item.deps) ? item.deps : [];
        const who = memberNameByCapability(item.capability);
        lines.push(`@${who} ${str(item.subject)}${deps.length ? `(需要 ${deps.join("、")})` : ""}`);
      }
      return agentMessage(entry, { id: "leader", name: memberName("leader") }, lines.join("\n"));
    }

    if (ev === "delivered") {
      const art = d.artifact || {};
      const body = str(art.body);
      const text = `@我 交付「${subject || str(art.title, "任务")}」${body ? "\n\n" + clampText(plainText(body), 240) : ""}`;
      const row = agentMessage(entry, { id: d.botId || "bot", name: memberName(d.botId) }, text);
      const files = Array.isArray(art.files) ? art.files : [];
      if (files.length) {
        const wrap = h("div", "file-bubbles");
        for (const file of files) wrap.appendChild(fileBubble(file, art, str(d.workId)));
        row.querySelector(".msg-col").appendChild(wrap);
      }
      return row;
    }

    if (ev === "started") {
      const line = eventLine(`${memberName(d.botId)} 开始处理「${subject || "任务"}」`);
      if (d.workId && !finishedWorkIds().has(String(d.workId))) {
        const cancel = h("button", "line-cancel", "取消");
        cancel.type = "button";
        cancel.addEventListener("click", () => confirmCancel(cancel, d.workId));
        line.appendChild(cancel);
      }
      return line;
    }

    if (ev === "blocked") {
      return eventLine(`「${subject || "任务"}」在排队:${str(d.reason, "等待空闲的 bot")}`, "muted");
    }
    if (ev === "failed") {
      return eventLine(`「${subject || "任务"}」失败:${str(d.error, "未知原因")}`, "bad");
    }
    if (ev === "cancelled") {
      return eventLine(`「${subject || "任务"}」已取消`);
    }
    return eventLine(str(ev));
  }

  function renderSysRow(text) {
    const row = h("div", "sys-row");
    row.appendChild(h("span", null, text));
    return row;
  }

  /** A file the user sent: images render inline, audio gets a player, anything else downloads. */
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

  function renderFileMessage(entry, prev) {
    const d = entry.data || {};
    const file = d.file || {};
    const self = isSelf(entry);
    const sameAuthor = prev && prev.kind === "chat.file" && prev.author === authorKey(entry);
    const ts = tsOf(entry);
    const cont = sameAuthor && ts !== null && prev.ts !== null && Math.abs(ts - prev.ts) < TIME_GAP;

    const row = h("div", "msg-row" + (self ? " self" : "") + (cont ? " cont" : ""));
    row.dataset.id = str(entry.id);
    const name = str(d.author && d.author.name, self ? "我" : "成员");
    row.appendChild(avatarEl(name, str(d.author && d.author.id, name), "", authorAvatar(d.author)));

    const col = h("div", "msg-col");
    if (!self) col.appendChild(h("div", "msg-name", name));
    const wrap = h("div", "chat-file");
    const mime = str(file.mime);
    const url = uploadUrl(file, true);

    if (mime.startsWith("image/")) {
      const btn = h("button");
      btn.type = "button";
      const img = document.createElement("img");
      img.src = url;
      img.alt = str(file.name, "图片");
      img.loading = "lazy";
      btn.appendChild(img);
      btn.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      wrap.appendChild(btn);
    } else if (mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = url;
      wrap.appendChild(audio);
    } else {
      const btn = h("button", "file-bubble");
      btn.type = "button";
      btn.appendChild(
        svgIcon(
          ["M13.5 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5z", "M13.5 4.5v5h5"],
          { width: "1.5" }
        )
      );
      const meta = h("span", "file-meta");
      meta.appendChild(h("span", "file-name", str(file.name, "file")));
      meta.appendChild(h("span", "file-size", formatSize(file.bytes)));
      btn.appendChild(meta);
      btn.addEventListener("click", () => {
        const link = document.createElement("a");
        link.href = uploadUrl(file, false);
        link.setAttribute("download", str(file.name, "file"));
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
      wrap.appendChild(btn);
    }
    col.appendChild(wrap);
    row.appendChild(col);
    return row;
  }

  function renderChatEntry(entry, prev, container) {
    const ts = tsOf(entry);
    if (needsTime(prev ? prev.ts : null, ts)) container.appendChild(timeRow(ts));

    if (entry.kind === "chat.message") {
      container.appendChild(renderMessage(entry, prev));
      return { ts, author: authorKey(entry), kind: "chat.message" };
    }
    if (entry.kind === "chat.file") {
      container.appendChild(renderFileMessage(entry, prev));
      return { ts, author: authorKey(entry), kind: "chat.file" };
    }
    if (entry.kind === "work.event") {
      const node = renderWorkEvent(entry);
      if (node) container.appendChild(node);
      return { ts, author: null, kind: "work.event" };
    }
    container.appendChild(renderSysRow(str(entry.kind, "未知消息")));
    return { ts, author: null, kind: entry.kind };
  }

  function prevInfo(items, i) {
    const p = items[i - 1];
    if (!p) return null;
    if (p.kind === "chat.message") return { ts: tsOf(p), author: authorKey(p), kind: "chat.message" };
    return { ts: tsOf(p), author: null, kind: p.kind };
  }

  /** 全量重建（切群 / 重连 / 前缀不一致）。仅在无选区时调用。 */
  function renderStreamFull(items, opts = {}) {
    const prevScrollHeight = stream.scrollHeight;
    const prevScrollTop = stream.scrollTop;
    const wasBottom = prevScrollHeight - prevScrollTop - stream.clientHeight < 40;
    const openIds = new Set(
      [...stream.querySelectorAll("details.card-body[open]")].map((d) => d.dataset.entry)
    );

    const fragment = document.createDocumentFragment();
    const list = visibleItemsFrom(items);
    state.filterCount = list.length;

    if (!list.length) {
      const empty = h("div", "chat-empty");
      if (currentFilter()) {
        empty.appendChild(h("strong", null, "没有匹配的消息"));
        empty.appendChild(h("small", null, "试着换个词,或按 Esc 清空搜索"));
      } else {
        empty.appendChild(h("strong", null, "还没有消息"));
        empty.appendChild(h("small", null, "发一句,或者派个需求"));
      }
      fragment.appendChild(empty);
    } else {
      let prev = null;
      for (const entry of list) {
        prev = renderChatEntry(entry, prev, fragment);
      }
    }

    stream.textContent = "";
    stream.appendChild(fragment);

    if (openIds.size) {
      for (const det of stream.querySelectorAll("details.card-body")) {
        if (openIds.has(det.dataset.entry)) det.open = true;
      }
    }

    if (opts.restoreTop != null && Number.isFinite(Number(opts.restoreTop))) {
      stream.scrollTop = Math.min(Number(opts.restoreTop), stream.scrollHeight);
    } else if (opts.keepPosition) {
      const delta = stream.scrollHeight - prevScrollHeight;
      stream.scrollTop = prevScrollTop + Math.max(0, delta);
    } else if (opts.forceBottom || wasBottom) {
      stream.scrollTop = stream.scrollHeight;
      state.newCount = 0;
      updateNewMsgBtn();
    } else {
      stream.scrollTop = prevScrollTop;
    }

    updateMsgSearchCount();
    updateLoadMore();
    syncBusyFromItems();
  }

  function visibleItemsFrom(items) {
    const q = currentFilter();
    if (!q) return items;
    return items.filter((entry) => matchesFilter(entry, q));
  }

  /** 增量：只把新 entry 追加到流末尾。 */
  function appendEntryDom(entry, prev) {
    const placeholder = stream.querySelector(".chat-empty");
    if (placeholder) placeholder.remove();
    const fragment = document.createDocumentFragment();
    renderChatEntry(entry, prev, fragment);
    stream.appendChild(fragment);
  }

  function syncBusyFromItems() {
    state.busyBots.clear();
    for (const entry of state.items) {
      if (entry.kind !== "work.event") continue;
      const d = entry.data || {};
      if (d.ev === "started" && d.botId) state.busyBots.add(d.botId);
      if ((d.ev === "done" || d.ev === "failed" || d.ev === "cancelled") && d.botId) {
        state.busyBots.delete(d.botId);
      }
    }
  }

  function updateNewMsgBtn() {
    if (state.newCount > 0) {
      newMsgBtn.hidden = false;
      newMsgBtn.textContent = state.newCount + " 条新消息";
    } else {
      newMsgBtn.hidden = true;
    }
  }

  function updateLoadMore() {
    const show = !!state.next && stream.scrollTop < 120 && state.items.length > 0;
    loadMoreBtn.hidden = !show;
    loadMoreBtn.textContent = state.loadingEarlier ? "加载中…" : "加载更早";
    loadMoreBtn.disabled = !!state.loadingEarlier;
  }

  function updateMsgSearchCount() {
    if (msgSearch.hidden) return;
    const q = state.msgSearch.trim();
    msgSearchCount.textContent = q ? state.filterCount + " 条匹配" : "";
  }

  function isAtBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
  }

  function showEmptyChat(text) {
    stream.textContent = "";
    const empty = h("div", "chat-empty");
    empty.appendChild(h("strong", null, text));
    stream.appendChild(empty);
  }

  /* ================= 状态帧（增量） ================= */
  function reconcilePending(items) {
    if (!state.pending.size) return items.slice();
    const out = items.slice();
    for (const [id, p] of state.pending) {
      if (p.failed) {
        out.push(p.entry);
        continue;
      }
      const dup = out
        .slice(-8)
        .some(
          (e) =>
            e.kind === "chat.message" &&
            str(e.data && e.data.text) === p.text &&
            str(e.data && e.data.author && e.data.author.id) === SELF_ID
        );
      if (dup) {
        state.pending.delete(id);
        continue;
      }
      out.push(p.entry);
    }
    return out;
  }

  function lastIdOf(items) {
    const tail = items[items.length - 1];
    const n = tail ? Number(tail.id) : 0;
    return Number.isFinite(n) ? n : state.lastId;
  }

  function applyState(frame) {
    if (frame.groupId && String(frame.groupId) !== state.groupId) return;

    const incoming = reconcilePending(Array.isArray(frame.items) ? frame.items : []);
    const prev = state.items;
    const beforeLast = state.lastId;
    const wasBottom = isAtBottom();
    const wasBooting = state.booting;
    const restore = state.restoreScroll;
    const isPrefix =
      prev.length <= incoming.length && prev.every((e, i) => String(e.id) === String(incoming[i].id));

    state.next = frame.next || null;
    state.restoreScroll = null;

    // 正在选中文本：先不动 DOM，等选区释放再刷（BLOCKER B1）。
    if (selectionActive()) {
      state.items = incoming;
      state.lastId = lastIdOf(incoming);
      state.deferredRender = true;
      state.booting = false;
      syncGroupPreview();
      return;
    }

    if (isPrefix && !wasBooting && !currentFilter()) {
      const added = incoming.slice(prev.length);
      state.items = incoming;
      state.lastId = lastIdOf(incoming);
      for (let i = prev.length; i < incoming.length; i += 1) {
        appendEntryDom(incoming[i], i > 0 ? prevInfo(incoming, i) : null);
      }
      if (added.length) {
        if (wasBottom) {
          stream.scrollTop = stream.scrollHeight;
          state.newCount = 0;
        } else {
          state.newCount += added.length;
        }
        updateNewMsgBtn();
        updateLoadMore();
        syncBusyFromItems();
      }
    } else {
      state.items = incoming;
      state.lastId = lastIdOf(incoming);
      renderStreamFull(incoming, {
        restoreTop: restore,
        forceBottom: restore == null && (wasBooting || wasBottom),
      });
    }

    state.booting = false;
    syncGroupPreview();
    renderHeader();
    renderGroups();
    markRead();
    if (state.fadeNext) {
      state.fadeNext = false;
      startFade();
    }
  }

  /** 当前群摘要回写到 groups（不轮询其它群）。 */
  function syncGroupPreview() {
    const g = findGroup(state.groupId);
    if (!g) return;
    const tail = state.items[state.items.length - 1];
    if (tail) g.last = previewOf(tail);
  }

  function markRead() {
    if (!state.groupId) return;
    const last = state.items[state.items.length - 1];
    if (!last) return;
    if (!isAtBottom() && !state.booting) return;
    if (state.pending.size) return;
    store.set("mb.read." + state.groupId, String(last.id));
  }

  function startFade() {
    if (reducedMotion()) return;
    chatPane.classList.remove("switching");
    void chatPane.offsetWidth;
    chatPane.classList.add("switching");
    setTimeout(() => chatPane.classList.remove("switching"), 120);
  }

  function flushDeferred() {
    if (!state.deferredRender) return;
    if (selectionActive()) return;
    state.deferredRender = false;
    renderStreamFull(state.items, { keepPosition: true });
  }

  /* ================= 帧分发 ================= */
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
    // 公告 / 置顶 / 成员 changed: not conversation entries, so the writer pushes the detail.
    if (type === "detail") {
      const gid = str(frame.groupId) || str(frame.detail && frame.detail.group && frame.detail.group.id);
      if (gid) void applyDetail(gid, frame.detail);
      return;
    }
    if (type === "error") {
      toast(str(frame.error, "操作失败"));
      return;
    }
    if (type === "chat.message" || type === "work.event") {
      if (frame.groupId && String(frame.groupId) !== state.groupId) return;
      const entry = { id: frame.id, kind: type, data: frame.data };
      if (entry.id && state.items.some((e) => String(e.id) === String(entry.id))) return;
      const atBottom = isAtBottom();
      const prev = prevInfo(state.items.concat(entry), state.items.length);
      state.items.push(entry);
      state.lastId = lastIdOf(state.items);
      appendEntryDom(entry, prev);
      if (atBottom) {
        stream.scrollTop = stream.scrollHeight;
        state.newCount = 0;
      } else {
        state.newCount += 1;
      }
      updateNewMsgBtn();
      syncGroupPreview();
      renderGroups();
      markRead();
    }
  }

  function onGroupsFrame(rawGroups) {
    state.groups = Array.isArray(rawGroups) ? rawGroups.map(normalizeGroup) : [];
    state.groupsLoaded = true;
    renderGroups();

    if (!state.groups.length) {
      closeSocket();
      state.groupId = null;
      showEmptyChat("还没有群");
      renderHeader();
      return;
    }
    if (!findGroup(state.groupId)) {
      const first = state.groups[0];
      replaceHash(first.id);
      applyGroup(first.id);
      return;
    }
    renderHeader();
  }

  /** Pull the roster from the server; used at boot and after creating a group. */
  async function reloadGroups() {
    const res = await fetch("/api/groups", { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(errText(data, res.status));
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
    return "#g=" + encodeURIComponent(id);
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

  function selectGroup(id) {
    if (!id || !findGroup(id)) return;
    closeDrawer();
    if (id === state.groupId) {
      if (window.innerWidth <= 560) setView("chat");
      return;
    }
    if (parseHashId() === id) {
      applyGroup(id);
      return;
    }
    location.hash = hashFor(id);
  }

  function saveDraft() {
    if (!state.groupId) return;
    store.set("mb.draft." + state.groupId, input.value);
  }

  function saveScroll() {
    if (!state.groupId) return;
    store.set("mb.scroll." + state.groupId, stream.scrollTop);
  }

  function applyGroup(id) {
    if (!id || !findGroup(id)) return;

    if (state.groupId && state.groupId !== id) {
      saveDraft();
      saveScroll();
      const last = lastOf(state.groupId);
      if (last && last.id) store.set("mb.read." + state.groupId, String(last.id));
    }

    if (state.groupId !== id) {
      closeInfoPane();
      closeBotPane();
    }
    const sameGroup = state.groupId === id && !!state.ws;
    state.groupId = id;
    renderHeader();
    renderGroups();
    if (window.innerWidth <= 560) setView("chat");
    if (sameGroup) {
      syncSendButtons();
      return;
    }

    closeSocket();
    state.items = [];
    state.next = null;
    state.newCount = 0;
    state.booting = true;
    state.stick = true;
    state.restoreScroll = store.get("mb.scroll." + id, null);
    state.msgSearch = "";
    msgSearch.hidden = true;
    msgSearchInput.value = "";
    showEmptyChat("加载中…");
    state.fadeNext = true;

    input.value = store.get("mb.draft." + id, "") || "";
    autosize();
    syncSendButtons();
    connect();
  }

  /* ================= WebSocket ================= */
  function wsUrl(gid) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const host = location.host || "127.0.0.1:3000";
    return proto + "//" + host + "/stream?g=" + encodeURIComponent(gid);
  }

  function closeSocket() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retry = 0;
    const socket = state.ws;
    state.ws = null;
    state.socketGroup = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
    }
    connBanner.hidden = true;
    syncSendButtons();
  }

  function scheduleReconnect() {
    if (state.retryTimer) return;
    const delay = Math.min(1000 * Math.pow(1.7, state.retry++), 8000);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!state.groupId || state.ws) return;
    const groupId = state.groupId;
    let socket;
    try {
      socket = new WebSocket(wsUrl(groupId));
    } catch (_) {
      connBanner.hidden = false;
      scheduleReconnect();
      return;
    }
    state.ws = socket;
    state.socketGroup = groupId;

    socket.onopen = () => {
      if (state.ws !== socket) return;
      state.retry = 0;
      connBanner.hidden = true;
      syncSendButtons();
    };

    socket.onmessage = (event) => {
      if (state.ws !== socket) return;
      if (typeof event.data === "string") onFrame(event.data);
    };

    socket.onclose = () => {
      if (state.ws !== socket) return;
      state.ws = null;
      state.socketGroup = null;
      connBanner.hidden = false;
      syncSendButtons();
      scheduleReconnect();
    };

    socket.onerror = () => {
      /* onclose 统一处理 */
    };
  }

  /* ================= 发送 ================= */
  function syncSendButtons() {
    const has = input.value.trim().length > 0;
    const can = has && !!state.groupId;
    sendBtn.disabled = !can;
    sendBtn.classList.toggle("ready", can);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(errText(data, res.status));
    return data;
  }

  /** Same contract as postJson, for the group-context writes (PUT / DELETE). */
  async function apiWrite(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) throw new Error(errText(data, res.status));
    return data;
  }

  /** A group-context write: cache the detail it returns and repaint the open panel. */
  async function applyDetail(gid, detail) {
    if (detail) state.detail.set(gid, detail);
    if (state.infoOpen && gid === state.groupId) renderInfoPane();
  }

  function addPending(text) {
    const id = "tmp-" + ++state.tmpSeq;
    const entry = {
      id,
      kind: "chat.message",
      data: { author: { type: "human", id: SELF_ID, name: nickName() }, text },
      __pending: { id, failed: false },
    };
    state.pending.set(id, { text, entry, failed: false });
    const atBottom = isAtBottom();
    const prev = prevInfo(state.items.concat(entry), state.items.length);
    state.items.push(entry);
    appendEntryDom(entry, prev);
    if (atBottom) stream.scrollTop = stream.scrollHeight;
    updateLoadMore();
    return id;
  }

  /** Read a File as a data URL (used by the avatar cropper). */
  const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });

  /** Center-crop to a square and shrink to `size`; avatars live in one small doc. */
  async function squareAvatar(file, size = 160) {
    const raw = await fileToDataUrl(file);
    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("这张图片打不开"));
      node.src = raw;
    });
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

  /** Read a File as base64 (no data: prefix) so the JSON upload route takes it as-is. */
  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });

  async function uploadOne(groupId, file, mime) {
    const data = await fileToBase64(file);
    await postJson("/api/groups/" + encodeURIComponent(groupId) + "/uploads", {
      name: file.name || "file",
      mime: mime || file.type || "application/octet-stream",
      data,
      author: { type: "human", id: SELF_ID, name: nickName() },
    });
  }

  async function sendPickedFiles(inputEl, isImage) {
    const gid = state.groupId;
    const files = [...(inputEl.files || [])];
    inputEl.value = "";
    if (!gid || !files.length) return;
    for (const file of files) {
      try {
        await uploadOne(gid, file, isImage ? file.type || "image/png" : file.type);
        toast("已发送 " + (file.name || "文件"));
      } catch (error) {
        toast("发送失败:" + (error.message || "网络错误"));
      }
    }
  }

  /* ---------- 语音:MediaRecorder 真录音 ---------- */
  let recorder = null;
  let recordedChunks = [];
  let voiceTimer = null;
  let voiceStarted = 0;
  let voiceCancelled = false;

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
      toast("这个浏览器不支持录音");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast("拿不到麦克风权限:" + (error.message || "被拒绝"));
      return;
    }
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
      voiceBar.hidden = true;
      toolVoice.classList.remove("recording");
      for (const track of stream.getTracks()) track.stop();
      const seconds = Math.max(1, Math.round((Date.now() - voiceStarted) / 1000));
      const chunks = recordedChunks;
      recordedChunks = [];
      recorder = null;
      if (voiceCancelled || !chunks.length) return;
      const blob = new Blob(chunks, { type: mime });
      const name = `语音-${seconds}s.webm`;
      try {
        await uploadOne(state.groupId, new File([blob], name, { type: mime }), mime);
        toast(`已发送语音 ${seconds}s`);
      } catch (error) {
        toast("语音发送失败:" + (error.message || "网络错误"));
      }
    };
    recorder.start();
    toolVoice.classList.add("recording");
    voiceBar.hidden = false;
    const tick = () => {
      const secs = Math.floor((Date.now() - voiceStarted) / 1000);
      voiceTime.textContent = String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
    };
    tick();
    voiceTimer = setInterval(tick, 250);
  }

  $("voiceCancel").addEventListener("click", () => {
    voiceCancelled = true;
    if (recorder && recorder.state === "recording") recorder.stop();
  });

  async function submitText(type) {
    const text = input.value.trim();
    if (!text || !state.groupId) return;
    const gid = state.groupId;
    const kind = type === "requirement" ? "requirements" : "send";

    input.value = "";
    autosize();
    store.set("mb.draft." + gid, "");
    syncSendButtons();
    input.focus();

    let tmpId = null;
    if (kind === "send") tmpId = addPending(text);
    else toast("已交给领导分工");

    try {
      await postJson("/api/groups/" + encodeURIComponent(gid) + "/" + kind, {
        text,
        author: { type: "human", id: SELF_ID, name: nickName() },
      });
      if (tmpId && state.pending.has(tmpId)) state.pending.get(tmpId).sent = true;
    } catch (error) {
      if (tmpId && state.pending.has(tmpId)) {
        const p = state.pending.get(tmpId);
        p.failed = true;
        p.entry.__pending.failed = true;
        renderStreamFull(state.items, { keepPosition: true });
      }
      if (kind === "requirements") toast("派需求失败:" + (error.message || "网络错误"));
    }
  }

  async function retryPending(tmpId) {
    const p = state.pending.get(tmpId);
    if (!p) return;
    p.failed = false;
    p.entry.__pending.failed = false;
    renderStreamFull(state.items, { keepPosition: true });
    try {
      await postJson("/api/groups/" + encodeURIComponent(state.groupId) + "/send", { text: p.text });
    } catch (error) {
      p.failed = true;
      p.entry.__pending.failed = true;
      renderStreamFull(state.items, { keepPosition: true });
      toast("重试失败:" + (error.message || "网络错误"));
    }
  }

  /* ================= 取消任务 ================= */
  function confirmCancel(btn, workId) {
    if (!workId) return;
    if (finishedWorkIds().has(String(workId))) {
      toast("该任务已经结束");
      return;
    }
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1";
      btn.classList.add("confirm");
      const original = btn.textContent;
      btn.textContent = "确认取消";
      btn.__timer = setTimeout(() => {
        btn.dataset.confirm = "";
        btn.classList.remove("confirm");
        btn.textContent = original;
      }, 2000);
      return;
    }
    clearTimeout(btn.__timer);
    cancelWork(workId, btn);
  }

  async function cancelWork(workId, btn) {
    if (!state.groupId) return;
    const text = btn.textContent;
    btn.disabled = true;
    btn.classList.remove("confirm");
    btn.dataset.confirm = "";
    btn.textContent = "取消中…";
    try {
      await postJson(
        "/api/groups/" + encodeURIComponent(state.groupId) + "/work/" + encodeURIComponent(workId) + "/cancel",
        {}
      );
      toast("已取消");
    } catch (error) {
      toast("取消失败:" + (error.message || "网络错误"));
      btn.textContent = text === "确认取消" ? "取消" : text;
    } finally {
      btn.disabled = false;
    }
  }

  /* ================= 加载更早 ================= */
  async function loadEarlier() {
    if (!state.next || state.loadingEarlier || !state.groupId) return;
    if (selectionActive()) return; // 不打断选区
    state.loadingEarlier = true;
    updateLoadMore();
    const gid = state.groupId;
    try {
      const url =
        "/api/groups/" +
        encodeURIComponent(gid) +
        "/items?limit=" +
        PAGE_SIZE +
        "&before=" +
        encodeURIComponent(JSON.stringify(state.next));
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(errText(data, res.status));
      const older = Array.isArray(data.items) ? data.items : [];
      const have = new Set(state.items.map((e) => String(e.id)));
      state.items = older.filter((e) => !have.has(String(e.id))).concat(state.items);
      state.next = data.next || null;
      renderStreamFull(state.items, { keepPosition: true });
    } catch (error) {
      toast("加载失败:" + (error.message || "网络错误"));
    } finally {
      state.loadingEarlier = false;
      updateLoadMore();
    }
  }

  /* ================= 群详情 ================= */
  async function loadDetail(gid, force) {
    if (!gid) return null;
    const cached = state.detail.get(gid);
    if (cached && !force) return cached;
    if (state.detailLoading.has(gid)) return cached || null;
    state.detailLoading.add(gid);
    try {
      const res = await fetch("/api/groups/" + encodeURIComponent(gid), {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(errText(data, res.status));
      state.detail.set(gid, data);
      return data;
    } finally {
      state.detailLoading.delete(gid);
    }
  }

  /* ================= 菜单 / 浮层 / toast ================= */
  let menuCloser = null;
  function closeMenu() {
    menu.hidden = true;
    menu.textContent = "";
    if (menuCloser) {
      menuCloser();
      menuCloser = null;
    }
  }

  function openMenuAt(x, y, items) {
    closeMenu();
    menu.textContent = "";
    items.forEach((item) => {
      if (item.sep) {
        menu.appendChild(h("div", "sep"));
        return;
      }
      const btn = h("button", "", item.label);
      if (item.danger) btn.classList.add("danger");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.addEventListener("click", () => {
        closeMenu();
        item.run();
      });
      menu.appendChild(btn);
    });
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = Math.max(8, top) + "px";
    setTimeout(() => {
      const onDoc = (event) => {
        if (!menu.contains(event.target)) closeMenu();
      };
      document.addEventListener("mousedown", onDoc);
      menuCloser = () => document.removeEventListener("mousedown", onDoc);
    }, 0);
  }

  function openGroupMenu(group, x, y) {
    const pinned = state.pins.includes(group.id);
    openMenuAt(x, y, [
      {
        label: pinned ? "取消置顶" : "置顶",
        run: () => {
          state.pins = pinned ? state.pins.filter((id) => id !== group.id) : [group.id, ...state.pins];
          store.set("mb.pins", state.pins);
          renderGroups();
        },
      },
      {
        label: "标记已读",
        run: () => {
          const last = lastOf(group.id);
          store.set("mb.read." + group.id, last && last.id ? String(last.id) : "0");
          renderGroups();
        },
      },
      { sep: true },
      {
        label: "删除本地已读记录",
        danger: true,
        run: () => {
          store.del("mb.read." + group.id);
          renderGroups();
          toast("已清除");
        },
      },
    ]);
  }

  let toastTimer = null;
  function toast(text, ms = 1800) {
    if (!toastEl) return;
    toastEl.textContent = String(text ?? "");
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, ms);
  }

  function openSheet(title, build, opts = {}) {
    closeMenu();
    picker.hidden = true;
    settingsEl.hidden = true;
    const pane = overlay.querySelector(".sheet");
    if (pane) pane.hidden = false;
    if (pane) pane.classList.toggle("wide", opts.wide === true);
    sheetTitle.textContent = title;
    sheetBody.textContent = "";
    build(sheetBody);
    overlay.hidden = false;
    $("sheetClose").onclick = () => {
      overlay.hidden = true;
    };
    overlay.onclick = (event) => {
      if (event.target === overlay) overlay.hidden = true;
    };
  }

  function sheetNote(text) {
    return h("div", "member-cap", text);
  }

  /** Rows shared by the three group-context sheets. */
  function sheetSection(text) {
    return h("div", "sheet-section", text);
  }

  function rowAction(label, run, opts = {}) {
    const btn = h("button", "row-action" + (opts.danger ? " danger" : ""), label);
    btn.type = "button";
    btn.disabled = !!opts.disabled;
    if (opts.title) btn.title = opts.title;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      void run(btn);
    });
    return btn;
  }

  /** All bots that exist; fetched once, used by the members sheet to offer candidates. */
  async function ensureBots() {
    if (state.bots.length) return state.bots;
    try {
      const res = await fetch("/api/bots", { headers: { accept: "application/json" }, cache: "no-store" });
      const data = await readJsonSafe(res);
      if (res.ok && Array.isArray(data.bots)) state.bots = data.bots;
      if (res.ok && Array.isArray(data.capabilities)) state.botCapabilities = data.capabilities;
    } catch (_) {
      /* the sheet still works with the roster alone */
    }
    return state.bots;
  }

  /* ================= 群信息侧边栏(仿微信桌面端) ================= */
  const groupUrl = (gid) => "/api/groups/" + encodeURIComponent(gid);

  function chevronEl() {
    const wrap = h("span", "info-chevron");
    wrap.appendChild(svgIcon(["m10 6 6 6-6 6"], { width: "1.8" }));
    return wrap;
  }

  function infoRow(opts) {
    const clickable = typeof opts.onClick === "function";
    const row = clickable ? h("button", "info-row") : h("div", "info-row static");
    if (clickable) row.type = "button";
    const main = h("div", "info-main");
    main.appendChild(h("div", "info-label", opts.label));
    if (opts.value !== undefined) main.appendChild(h("div", "info-value", opts.value));
    row.appendChild(main);
    if (opts.switch !== undefined) row.appendChild(h("span", "switch" + (opts.switch ? " on" : "")));
    else if (opts.chevron) row.appendChild(chevronEl());
    if (clickable) row.addEventListener("click", opts.onClick);
    return row;
  }

  const infoSwitch = (label, value, onChange) => {
    const row = infoRow({ label, switch: value, onClick: onChange });
    return row;
  };

  /** The inline editor under a row; only one row is open at a time. */
  function infoEditor(kind, build) {
    if (state.infoEdit !== kind) return null;
    const box = h("div", "info-edit");
    build(box);
    return box;
  }

  function infoActions(box, onSave, saveLabel) {
    const actions = h("div", "info-edit-actions");
    const ok = h("button", "btn-text primary mini ready", saveLabel || "保存");
    ok.type = "button";
    const cancel = h("button", "btn-text secondary mini", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.infoEdit = null;
      renderInfoPane();
    });
    ok.addEventListener("click", () => onSave(ok));
    actions.appendChild(ok);
    actions.appendChild(cancel);
    box.appendChild(actions);
    return ok;
  }

  function openInfoPane(section) {
    if (!state.groupId) return;
    closeBotPane();
    closeContactsPane();
    state.infoOpen = true;
    if (section !== undefined) state.infoEdit = section;
    infoPane.hidden = false;
    renderInfoPane();
    void loadDetail(state.groupId, true)
      .then((detail) => applyDetail(state.groupId, detail))
      .catch(() => undefined);
  }

  function closeInfoPane() {
    state.infoOpen = false;
    state.infoEdit = null;
    state.infoQuery = "";
    infoPane.hidden = true;
  }

  /* ================= 通讯录:左右两栏,照微信通讯录管理 ================= */
  const CAP_TEXT = { finance: "财务", data: "数据", analysis: "分析", design: "设计", general: "通用", orchestration: "编排" };

  function closeContactsPane() {
    state.contactsOpen = false;
    state.contactsQuery = "";
    if (contactsSearch) contactsSearch.value = "";
    contactsWindow.hidden = true;
    if (settingsEl.hidden && picker.hidden) overlay.hidden = true;
  }

  function contactGroups(botId) {
    return state.groups.filter((group) => (group.roster || []).includes(botId));
  }

  function contactAction(icon, label, onClick, disabled) {
    const button = h("button", "contacts-action");
    button.type = "button";
    button.disabled = !!disabled;
    button.appendChild(svgIcon(icon, { width: "1.7" }));
    button.appendChild(h("span", "", label));
    button.addEventListener("click", onClick);
    return button;
  }

  function renderContactDetail(bot) {
    contactsDetail.textContent = "";
    if (!bot) {
      contactsDetail.appendChild(h("div", "contacts-empty", "从左边选择一个 bot"));
      return;
    }
    const group = findGroup(state.groupId);
    const roster = new Set(group ? group.roster : []);
    const groups = contactGroups(bot.id);
    const head = h("div", "contacts-detail-head");
    head.appendChild(avatarEl(bot.name || bot.id, bot.id, "", bot.avatar));
    const main = h("div", "contacts-detail-main");
    main.appendChild(h("div", "contacts-detail-name", bot.name || bot.id));
    main.appendChild(h("div", "contacts-detail-id", `bot id:${bot.id}`));
    head.appendChild(main);
    contactsDetail.appendChild(head);

    contactsDetail.appendChild(h("div", "contacts-detail-section", "bot 资料"));
    const kv = h("dl", "contacts-detail-kv");
    const add = (k, v) => {
      kv.appendChild(h("dt", "", k));
      kv.appendChild(h("dd", "", v));
    };
    add("能力", (bot.capabilities || []).map((cap) => CAP_TEXT[cap] || cap).join(" · ") || "—");
    add("所在群", groups.map((item) => item.name).join("、") || "不在任何群");
    add("来源", bot.custom ? "用户创建" : "系统内置");
    contactsDetail.appendChild(kv);

    contactsDetail.appendChild(h("div", "contacts-detail-section", "更多信息"));
    const kv2 = h("dl", "contacts-detail-kv");
    const add2 = (k, v) => {
      kv2.appendChild(h("dt", "", k));
      kv2.appendChild(h("dd", "", v));
    };
    add2("接单方式", "按能力匹配;同一时间只跑一件");
    add2("在群里", roster.has(bot.id) ? "是" : "否");
    contactsDetail.appendChild(kv2);

    const actions = h("div", "contacts-actions");
    actions.appendChild(
      contactAction(
        ["M4 5h16v11H9l-4 3V16H4z"],
        "发消息",
        () => {
          if (!state.groupId) return;
          closeContactsPane();
          input.value = "@" + (bot.name || bot.id) + " ";
          input.focus();
          autosize();
          syncSendButtons();
        }
      )
    );
    if (group && !roster.has(bot.id)) {
      actions.appendChild(
        contactAction(
          ["M12 5v14", "M5 12h14"],
          "加入本群",
          async () => {
            try {
              await postJson(groupUrl(state.groupId) + "/members", { botId: bot.id });
              toast(`已把「${bot.name || bot.id}」加入本群`);
              await reloadGroups();
              renderGroups();
              const detail = await loadDetail(state.groupId, true);
              applyDetail(state.groupId, detail);
              renderContactsPane();
            } catch (error) {
              toast("加入失败:" + (error.message || "网络错误"));
            }
          }
        )
      );
    }
    if (group && roster.has(bot.id)) {
      actions.appendChild(
        contactAction(["M4 19V9M9 19V5M14 19v-7M19 19v-4"], "打开设置", () => {
          closeContactsPane();
          openBotPane(bot.id);
        })
      );
    }
    contactsDetail.appendChild(actions);
  }

  async function renderContactsPane() {
    if (!state.contactsOpen) return;
    const q = state.contactsQuery.trim().toLowerCase();
    contactsList.textContent = "";
    const bots = await ensureBots();
    const filtered = q
      ? bots.filter((bot) => {
          const caps = Array.isArray(bot.capabilities) ? bot.capabilities.join(" ") : "";
          return `${bot.name || bot.id} ${caps}`.toLowerCase().includes(q);
        })
      : bots;
    const section = h("div", "contacts-section", `我的 bot (${filtered.length})`);
    contactsList.appendChild(section);
    if (!filtered.length) {
      contactsList.appendChild(h("div", "contacts-empty", q ? "没有匹配的 bot" : "还没有 bot"));
      renderContactDetail(null);
      return;
    }
    if (!filtered.some((bot) => bot.id === state.contactsSelected)) state.contactsSelected = filtered[0].id;
    for (const bot of filtered) {
      const row = h("button", "contacts-item" + (bot.id === state.contactsSelected ? " active" : ""));
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", bot.id === state.contactsSelected ? "true" : "false");
      row.appendChild(avatarEl(bot.name || bot.id, bot.id, "", bot.avatar));
      const main = h("div", "contacts-item-main");
      main.appendChild(h("div", "contacts-item-name", bot.name || bot.id));
      const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
      main.appendChild(h("div", "contacts-item-cap", caps.map((cap) => CAP_TEXT[cap] || cap).join(" · ") || bot.role || "bot"));
      row.appendChild(main);
      if (state.contactsManage) {
        const edit = h("button", "contact-item-edit", "设置");
        edit.type = "button";
        edit.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!findGroup(state.groupId)?.roster.includes(bot.id)) {
            toast("先把这个 bot 加入本群");
            return;
          }
          closeContactsPane();
          openBotPane(bot.id);
        });
        row.appendChild(edit);
      }
      row.addEventListener("click", () => {
        state.contactsSelected = bot.id;
        renderContactsPane();
      });
      contactsList.appendChild(row);
    }
    const selected = filtered.find((bot) => bot.id === state.contactsSelected) || filtered[0];
    renderContactDetail(selected);
  }

  function openContactsPane(botId) {
    if (state.contactsOpen) {
      closeContactsPane();
      return;
    }
    closeInfoPane();
    closeBotPane();
    closeMenu();
    closeSettings();
    const sheet = pickerSheet();
    if (sheet) sheet.hidden = true;
    state.contactsOpen = true;
    state.contactsQuery = "";
    state.contactsSelected = botId || null;
    state.contactsManage = false;
    if (contactsManageText) contactsManageText.textContent = "通讯录管理";
    if (contactsManage) contactsManage.classList.remove("on");
    contactsSearch.value = "";
    contactsWindow.hidden = false;
    overlay.hidden = false;
    overlay.onclick = (event) => {
      if (event.target === overlay) closeContactsPane();
    };
    void renderContactsPane();
  }

  const toggleInfoPane = () => (state.infoOpen ? closeInfoPane() : openInfoPane());

  function openMemberMenu(m, event) {
    const gid = state.groupId;
    const name = m.name || m.id;
    const busy = !!m.busy || state.busyBots.has(m.id);
    if (m.role === "leader") {
      openMenuAt(event.clientX, event.clientY, [{ label: "领导负责分工,不能移出", run: () => undefined }]);
      return;
    }
    if (busy) {
      openMenuAt(event.clientX, event.clientY, [{ label: "正在执行任务,先取消再移出", run: () => undefined }]);
      return;
    }
    openMenuAt(event.clientX, event.clientY, [
      {
        label: "移出群聊",
        danger: true,
        run: async () => {
          try {
            await apiWrite("DELETE", groupUrl(gid) + "/members/" + encodeURIComponent(m.id));
            toast("已移出 " + name);
            await applyDetail(gid, await loadDetail(gid, true));
          } catch (error) {
            toast("移出失败:" + (error.message || "网络错误"));
          }
        },
      },
    ]);
  }

  /* ================= 单个 bot 的设置抽屉 ================= */
  const BOT_SECTIONS = [
    { id: "overview", label: "概览", icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"] },
    { id: "identity", label: "身份", icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"] },
    { id: "soul", label: "提示词", icon: ["M12 4l1.8 4.6L18.5 10l-4.7 1.4L12 16l-1.8-4.6L5.5 10l4.7-1.4L12 4z"] },
    { id: "model", label: "模型", icon: ["M7 7h10v10H7z", "M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"] },
    { id: "tools", label: "工具", icon: ["M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z", "M5 18.5h14"] },
    { id: "library", label: "资料库", icon: ["M4 19V9M9 19V5M14 19v-7M19 19v-4"] },
    { id: "history", label: "历史记录", icon: ["M12 7v5l3.5 2", "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"] },
  ];

  function closeBotPane() {
    state.botOpen = false;
    state.botId = null;
    state.botProfile = null;
    botPane.hidden = true;
  }

  async function openBotPane(botId) {
    if (!state.groupId) return;
    closeContactsPane();
    state.botOpen = true;
    state.botId = botId;
    state.botQuery = "";
    if (!state.botProfile || state.botProfile.id !== botId) state.botAcc = "overview";
    botPane.hidden = false;
    closeInfoPane();
    renderBotPane();
    try {
      state.botProfile = await fetchJson(
        "/api/groups/" + encodeURIComponent(state.groupId) + "/bots/" + encodeURIComponent(botId)
      );
      if (state.botOpen && state.botId === botId) renderBotPane();
    } catch (error) {
      state.botProfile = { id: botId, error: error.message || "加载失败" };
      renderBotPane();
    }
  }

  const botSectionsShown = () => {
    const q = state.botQuery.trim().toLowerCase();
    return q ? BOT_SECTIONS.filter((section) => section.label.toLowerCase().includes(q)) : BOT_SECTIONS;
  };

  function botKv(pairs) {
    const dl = h("dl", "bot-kv");
    for (const [key, value] of pairs) {
      if (value === undefined || value === null || value === "") continue;
      dl.appendChild(h("dt", "", key));
      dl.appendChild(h("dd", "", String(value)));
    }
    return dl;
  }

  async function saveBotProfile(patch, button) {
    const gid = state.groupId;
    const botId = state.botId;
    if (!gid || !botId) return;
    if (button) button.disabled = true;
    try {
      const next = await apiWrite(
        "PUT",
        "/api/groups/" + encodeURIComponent(gid) + "/bots/" + encodeURIComponent(botId),
        patch
      );
      state.botProfile = next;
      const liveBot = state.bots.find((bot) => String(bot.id) === String(botId));
      if (liveBot) {
        liveBot.name = next.name;
        liveBot.avatar = next.avatar;
        renderGroups();
      }
      const cached = state.detail.get(gid);
      const member = cached && Array.isArray(cached.members) ? cached.members.find((row) => String(row.id) === String(botId)) : null;
      if (member) {
        member.name = next.name;
        member.avatar = next.avatar;
        if (state.infoOpen) renderInfoPane();
      }
      toast("已保存,下一轮生效");
      renderBotPane();
    } catch (error) {
      if (button) button.disabled = false;
      toast("保存失败:" + (error.message || "网络错误"));
    }
  }

  function botSectionBody(id, profile, body) {
    if (id === "overview") {
      body.appendChild(
        botKv([
          ["角色", profile.role === "leader" ? "编排者(领导)" : "执行 bot"],
          ["状态", profile.busy ? "正在执行任务" : "空闲"],
          ["会话", profile.conversationId ? `#${profile.conversationId}` : "—"],
          ["能力", (profile.capabilities || []).join(" · ") || "—"],
          ["所在群", (profile.groups || []).map((group) => group.name).join("、")],
        ])
      );
      if (profile.busy) body.appendChild(h("div", "bot-note", "正在跑任务时改设置,新的提示词/模型从下一轮开始生效。"));
      return;
    }

    if (id === "identity") {
      const edit = h("div", "bot-edit");
      const avatarRow = h("div", "bot-avatar-row");
      const av = h("span", "avatar bot-avatar");
      paintAvatar(av, profile.name || profile.id, profile.id, profile.avatar);
      avatarRow.appendChild(av);
      const avatarMain = h("div", "bot-avatar-main");
      avatarMain.appendChild(h("div", "creator-label", "头像"));
      avatarMain.appendChild(h("div", "creator-hint", "支持图片;不选图片时用名称首字"));
      avatarRow.appendChild(avatarMain);
      const change = h("button", "btn-text secondary mini", "更换头像");
      change.type = "button";
      change.addEventListener("click", () => botAvatarInput.click());
      avatarRow.appendChild(change);
      edit.appendChild(avatarRow);

      const nameField = h("div", "settings-field");
      nameField.appendChild(h("label", "", "名字"));
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 24;
      nameInput.value = profile.name || "";
      nameInput.placeholder = profile.defaultName || profile.id;
      nameField.appendChild(nameInput);
      edit.appendChild(nameField);

      const actions = h("div", "bot-edit-actions");
      const save = h("button", "btn-text primary mini ready", "保存名字");
      save.type = "button";
      save.addEventListener("click", () => void saveBotProfile({ name: nameInput.value }, save));
      actions.appendChild(save);
      edit.appendChild(actions);
      body.appendChild(edit);

      body.appendChild(
        botKv([
          ["id", profile.id],
          ["角色", profile.role],
          ["能力", (profile.capabilities || []).join(" · ") || "—"],
        ])
      );
      body.appendChild(h("div", "bot-note", "名字和头像全群生效;能力来自 bot 配置,只读。提示词在「提示词」里改。"));
      return;
    }

    if (id === "soul") {
      const edit = h("div", "bot-edit");
      const area = document.createElement("textarea");
      area.rows = 6;
      area.placeholder = profile.instructions.default;
      area.value = profile.instructions.override || "";
      edit.appendChild(area);
      const actions = h("div", "bot-edit-actions");
      const save = h("button", "btn-text primary mini ready", "保存");
      save.type = "button";
      save.addEventListener("click", () => void saveBotProfile({ instructions: area.value }, save));
      const reset = h("button", "btn-text secondary mini", "恢复默认");
      reset.type = "button";
      reset.addEventListener("click", () => {
        area.value = "";
        void saveBotProfile({ instructions: "" }, reset);
      });
      actions.appendChild(save);
      actions.appendChild(reset);
      edit.appendChild(actions);
      body.appendChild(edit);
      body.appendChild(h("div", "bot-note", "默认提示词:" + profile.instructions.default));
      body.appendChild(
        h("div", "bot-note", profile.instructions.override ? "当前用的是本群覆盖版本。" : "当前用的是默认版本;留空保存即恢复默认。")
      );
      return;
    }

    if (id === "model") {
      const edit = h("div", "bot-edit");
      const field = document.createElement("input");
      field.type = "text";
      field.placeholder = profile.model.global;
      field.value = profile.model.override || "";
      edit.appendChild(field);
      const actions = h("div", "bot-edit-actions");
      const save = h("button", "btn-text primary mini ready", "保存");
      save.type = "button";
      save.addEventListener("click", () => void saveBotProfile({ model: field.value.trim() }, save));
      const follow = h("button", "btn-text secondary mini", "跟随全局");
      follow.type = "button";
      follow.addEventListener("click", () => {
        field.value = "";
        void saveBotProfile({ model: "" }, follow);
      });
      actions.appendChild(save);
      actions.appendChild(follow);
      edit.appendChild(actions);
      body.appendChild(edit);
      body.appendChild(
        botKv([
          ["当前生效", profile.model.effective],
          ["全局模型", profile.model.global],
        ])
      );
      body.appendChild(h("div", "bot-note", "只影响本群里的这个 bot;留空保存 = 跟随全局。模型 id 要跟网关 /models 里的一致。"));
      return;
    }

    if (id === "tools") {
      body.appendChild(
        botKv([
          ["工具", (profile.tools || []).join(" · ") || "—"],
          ["接单方式", "按能力匹配;同一时间只跑一件"],
        ])
      );
      body.appendChild(
        h(
          "div",
          "bot-note",
          "工具(Tool)是模型可以直接调用的函数,例如 write_file;技能(Skill)是可复用的指令/流程包,当前这个 bot 没有配置技能。"
        )
      );
      return;
    }

    if (id === "library") {
      const files = (profile.delivered || []).flatMap((item) =>
        (item.files || []).map((file) => ({ ...file, workId: item.workId }))
      );
      if (!files.length) {
        body.appendChild(h("div", "bot-note", "这个 bot 在本群还没有交付过文件。"));
        return;
      }
      for (const file of files) {
        const row = h("button", "bot-file");
        row.type = "button";
        row.appendChild(h("span", "bot-file-name", file.path));
        row.appendChild(h("span", "bot-file-size", formatSize(file.bytes)));
        row.addEventListener("click", () => {
          const gid = state.groupId;
          const encoded = String(file.path).split("/").map(encodeURIComponent).join("/");
          location.href =
            "/api/groups/" + encodeURIComponent(gid) + "/files/" + encodeURIComponent(file.workId) + "/" + encoded;
        });
        body.appendChild(row);
      }
      return;
    }

    if (id === "history") {
      const rows = profile.delivered || [];
      if (!rows.length) {
        body.appendChild(h("div", "bot-note", "还没有交付记录。"));
        return;
      }
      for (const item of rows) {
        const row = h("div", "bot-history-row");
        row.appendChild(h("div", "", `${item.key || ""} ${item.subject}`.trim()));
        const files = item.files ? item.files.length : 0;
        row.appendChild(h("div", "bot-history-time", `${item.status}${files ? ` · ${files} 个文件` : ""}`));
        body.appendChild(row);
      }
    }
  }

  function renderBotPane() {
    if (!state.botOpen || !botBody) return;
    const profile = state.botProfile;
    botBody.textContent = "";
    if (!profile) {
      botBody.appendChild(h("div", "settings-empty", "加载中…"));
      return;
    }
    if (profile.error) {
      botBody.appendChild(h("div", "settings-empty", "加载失败:" + profile.error));
      return;
    }

    const head = h("div", "bot-head");
    head.appendChild(avatarEl(profile.name || profile.id, profile.id, "", profile.avatar));
    const main = h("div", "bot-head-main");
    main.appendChild(h("div", "bot-name", profile.name || profile.id));
    main.appendChild(
      h("div", "bot-sub", `${profile.role === "leader" ? "编排者" : "执行 bot"} · ${profile.busy ? "忙碌" : "空闲"}`)
    );
    head.appendChild(main);
    const close = h("button", "info-close");
    close.type = "button";
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭 bot 设置");
    close.appendChild(svgIcon(["M6 6l12 12M18 6 6 18"], { width: "1.8" }));
    close.addEventListener("click", closeBotPane);
    head.appendChild(close);
    botBody.appendChild(head);

    const search = h("div", "bot-search");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "搜索";
    input.value = state.botQuery;
    input.setAttribute("aria-label", "搜索设置项");
    input.addEventListener("input", () => {
      state.botQuery = input.value;
      renderBotPane();
      const next = botBody.querySelector(".bot-search input");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    search.appendChild(svgIcon(["M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "m16 16 4 4"], { width: "1.8" }));
    search.appendChild(input);
    botBody.appendChild(search);

    const sections = botSectionsShown();
    if (!sections.length) botBody.appendChild(h("div", "settings-empty", "没有匹配的设置项"));
    for (const section of sections) {
      const open = state.botAcc === section.id;
      const wrap = h("div", "bot-acc" + (open ? " open" : ""));
      const headBtn = h("button", "bot-acc-head");
      headBtn.type = "button";
      headBtn.setAttribute("aria-expanded", open ? "true" : "false");
      const icon = svgIcon(section.icon, { width: "1.7" });
      icon.classList.add("icon");
      headBtn.appendChild(icon);
      headBtn.appendChild(h("span", "bot-acc-label", section.label));
      const arrow = h("span", "bot-acc-arrow");
      arrow.appendChild(svgIcon(["m6 10 6 6 6-6"], { width: "1.8" }));
      headBtn.appendChild(arrow);
      headBtn.addEventListener("click", () => {
        state.botAcc = state.botAcc === section.id ? "" : section.id;
        renderBotPane();
      });
      wrap.appendChild(headBtn);
      if (open) {
        const body = h("div", "bot-acc-body");
        botSectionBody(section.id, profile, body);
        wrap.appendChild(body);
      }
      botBody.appendChild(wrap);
    }

    if (profile.role !== "leader" && state.groupId) {
      const foot = h("div", "bot-foot");
      const remove = h("button", "row-action danger", "移出本群");
      remove.type = "button";
      remove.disabled = !!profile.busy;
      if (profile.busy) remove.title = "正在执行任务,先取消再移出";
      remove.addEventListener("click", async () => {
        try {
          await apiWrite("DELETE", groupUrl(state.groupId) + "/members/" + encodeURIComponent(profile.id));
          toast("已移出 " + profile.name);
          closeBotPane();
          await applyDetail(state.groupId, await loadDetail(state.groupId, true));
        } catch (error) {
          toast("移出失败:" + (error.message || "网络错误"));
        }
      });
      foot.appendChild(remove);
      botBody.appendChild(foot);
    }
  }

  /** 群成员九宫格:点成员出菜单,点「+」展开可加入的 bot。 */
  function renderMembersSection(gid, group, detail) {
    const members =
      detail && Array.isArray(detail.members) && detail.members.length
        ? detail.members
        : group.roster.map((id) => ({ id, name: botName(id), capabilities: [], busy: false }));
    const q = state.infoQuery.trim().toLowerCase();
    const shown = q ? members.filter((m) => str(m.name || m.id).toLowerCase().includes(q)) : members;
    const grid = h("div", "info-grid");
    for (const m of shown) {
      const btn = h("button", "info-member");
      btn.type = "button";
      btn.title = m.name || m.id;
      btn.appendChild(avatarEl(m.name || m.id, m.id, "", m.avatar));
      btn.appendChild(h("span", "info-member-name", m.name || m.id));
      btn.addEventListener("click", () => openBotPane(m.id));
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMemberMenu(m, event);
      });
      grid.appendChild(btn);
    }
    if (!q) {
      const add = h("button", "info-member add");
      add.type = "button";
      add.title = "添加成员";
      add.appendChild(h("span", "info-add-box", "+"));
      add.appendChild(h("span", "info-member-name", "添加"));
      add.addEventListener("click", () => openMemberPicker());
      grid.appendChild(add);
    }
    infoBody.appendChild(grid);
  }

  /* ================= 添加群成员(左右两栏,照微信) ================= */
  const pickerSheet = () => overlay.querySelector(".sheet");

  /** Bots that are not in this group yet; the roster comes from the cached detail. */
  function pickerCandidates() {
    const gid = state.groupId;
    const group = findGroup(gid);
    const detail = state.detail.get(gid);
    const members =
      detail && Array.isArray(detail.members) && detail.members.length
        ? detail.members
        : (group ? group.roster : []).map((id) => ({ id, name: botName(id) }));
    const roster = new Set(members.map((m) => str(m.id)));
    const all = state.bots.length
      ? state.bots
      : Object.entries(BOT_META).map(([id, meta]) => ({ id, name: meta.name, capabilities: [meta.cap], role: "worker" }));
    const free = all.filter((b) => !roster.has(str(b.id)));
    const q = state.pickerQuery.trim().toLowerCase();
    return q ? free.filter((b) => str(b.name || b.id).toLowerCase().includes(q)) : free;
  }

  function renderPicker() {
    if (picker.hidden) return;
    const all = pickerCandidates();
    const picked = state.pickerPicked;

    pickerList.textContent = "";
    pickerGroupCount.textContent = all.length ? `${all.length} 个可加入` : "";
    if (!all.length) {
      pickerList.appendChild(h("div", "picker-empty", state.pickerQuery ? "没有匹配的成员" : "所有 bot 都已在群里"));
    }
    for (const bot of all) {
      const on = picked.has(str(bot.id));
      const row = h("button", "pick-row" + (on ? " on" : ""));
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", on ? "true" : "false");
      const check = h("span", "pick-check");
      if (on) check.appendChild(svgIcon(["m5 9 2.5 2.5L13 7"], { width: "2.4" }));
      row.appendChild(check);
      row.appendChild(avatarEl(bot.name || bot.id, bot.id, "", bot.avatar));
      const main = h("div", "pick-main");
      main.appendChild(h("div", "pick-name", bot.name || bot.id));
      const caps = Array.isArray(bot.capabilities) ? bot.capabilities : [];
      main.appendChild(h("div", "pick-cap", caps.length ? caps.join(" · ") : bot.role || "成员"));
      row.appendChild(main);
      row.addEventListener("click", () => {
        const id = str(bot.id);
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        renderPicker();
      });
      pickerList.appendChild(row);
    }

    pickerChosen.textContent = "";
    const chosen = [...picked]
      .map((id) => state.bots.find((b) => str(b.id) === id) || { id, name: botName(id) })
      .filter(Boolean);
    pickerCount.textContent = chosen.length ? `已选择 ${chosen.length} 个联系人` : "未选择";
    if (!chosen.length) pickerChosen.appendChild(h("div", "picker-empty", "从左侧勾选要加入的 bot"));
    for (const bot of chosen) {
      const row = h("div", "chosen-row");
      row.appendChild(avatarEl(bot.name || bot.id, bot.id, "", bot.avatar));
      row.appendChild(h("span", "chosen-name", bot.name || bot.id));
      const del = h("button", "chosen-del");
      del.type = "button";
      del.title = "移除";
      del.setAttribute("aria-label", "移除 " + (bot.name || bot.id));
      del.appendChild(svgIcon(["M6 6l12 12M18 6 6 18"], { width: "1.8" }));
      del.addEventListener("click", () => {
        picked.delete(str(bot.id));
        renderPicker();
      });
      row.appendChild(del);
      pickerChosen.appendChild(row);
    }
    pickerOk.disabled = chosen.length === 0;
    pickerOk.textContent = chosen.length ? `添加${chosen.length > 1 ? `(${chosen.length})` : ""}` : "添加";
  }

  function openMemberPicker() {
    if (!state.groupId) return;
    closeMenu();
    state.pickerPicked = new Set();
    state.pickerQuery = "";
    pickerSearch.value = "";
    const sheet = pickerSheet();
    if (sheet) sheet.hidden = true;
    settingsEl.hidden = true;
    picker.hidden = false;
    overlay.hidden = false;
    overlay.onclick = (event) => {
      if (event.target === overlay) closePicker();
    };
    renderPicker();
    if (!state.bots.length) void ensureBots().then(() => renderPicker());
  }

  function closePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    overlay.hidden = true;
    const sheet = pickerSheet();
    if (sheet) sheet.hidden = false;
    state.pickerPicked = new Set();
    state.pickerQuery = "";
  }

  async function submitPicker() {
    const gid = state.groupId;
    const ids = [...state.pickerPicked];
    if (!gid || !ids.length) return;
    pickerOk.disabled = true;
    let added = 0;
    for (const botId of ids) {
      try {
        await apiWrite("POST", groupUrl(gid) + "/members", { botId });
        added += 1;
      } catch (error) {
        toast("加入失败:" + (error.message || "网络错误"));
      }
    }
    closePicker();
    if (added) toast(`已加入 ${added} 个成员`);
    if (added) await applyDetail(gid, await loadDetail(gid, true));
  }

  function renderInfoPane() {
    if (!state.infoOpen) return;
    const gid = state.groupId;
    const group = findGroup(gid);
    if (!group || !infoBody) {
      if (infoBody) infoBody.textContent = "";
      return;
    }
    const detail = state.detail.get(gid);
    infoBody.textContent = "";

    /* 搜索群成员 */
    const search = h("div", "info-search");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "搜索群成员";
    input.value = state.infoQuery;
    input.setAttribute("aria-label", "搜索群成员");
    input.addEventListener("input", () => {
      state.infoQuery = input.value;
      renderInfoPane();
      const next = infoBody.querySelector(".info-search input");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    search.appendChild(input);
    const close = h("button", "info-close");
    close.type = "button";
    close.title = "关闭";
    close.setAttribute("aria-label", "关闭群信息");
    close.appendChild(svgIcon(["M6 6l12 12M18 6 6 18"], { width: "1.8" }));
    close.addEventListener("click", closeInfoPane);
    search.appendChild(close);
    infoBody.appendChild(search);

    renderMembersSection(gid, group, detail);
    infoBody.appendChild(h("div", "info-gap"));

    /* 群聊名称 */
    infoBody.appendChild(
      infoRow({
        label: "群聊名称",
        value: group.name,
        chevron: true,
        onClick: () => {
          state.infoEdit = state.infoEdit === "name" ? null : "name";
          renderInfoPane();
        },
      })
    );
    const nameEditor = infoEditor("name", (box) => {
      const field = document.createElement("input");
      field.type = "text";
      field.maxLength = 40;
      field.value = group.name;
      box.appendChild(field);
      const ok = infoActions(box, async () => {
        ok.disabled = true;
        try {
          const next = await apiWrite("PUT", groupUrl(gid), { name: field.value });
          state.infoEdit = null;
          toast("群名已更新");
          await applyDetail(gid, next);
        } catch (error) {
          ok.disabled = false;
          toast("改名失败:" + (error.message || "网络错误"));
        }
      });
      setTimeout(() => field.focus(), 0);
    });
    if (nameEditor) infoBody.appendChild(nameEditor);

    /* 群公告 */
    const announcement = str(detail && detail.announcement);
    infoBody.appendChild(
      infoRow({
        label: "群公告",
        value: announcement ? clampText(announcement.replace(/\s+/g, " "), 36) : "未设置",
        chevron: true,
        onClick: () => {
          state.infoEdit = state.infoEdit === "announcement" ? null : "announcement";
          renderInfoPane();
        },
      })
    );
    const annEditor = infoEditor("announcement", (box) => {
      const area = document.createElement("textarea");
      area.rows = 5;
      area.placeholder = "写点什么给全群看,每个 bot 都会读到";
      area.value = announcement;
      box.appendChild(area);
      const ok = infoActions(box, async () => {
        ok.disabled = true;
        try {
          const next = await apiWrite("PUT", groupUrl(gid) + "/announcement", { text: area.value });
          state.infoEdit = null;
          toast("群公告已更新");
          await applyDetail(gid, next);
        } catch (error) {
          ok.disabled = false;
          toast("保存失败:" + (error.message || "网络错误"));
        }
      });
      setTimeout(() => area.focus(), 0);
    });
    if (annEditor) infoBody.appendChild(annEditor);

    /* 群置顶 */
    const pins = Array.isArray(detail && detail.pins) ? detail.pins : [];
    infoBody.appendChild(
      infoRow({
        label: "群置顶",
        value: pins.length ? `${pins.length} 条 · 每个 bot 都会读到` : "未设置",
        chevron: true,
        onClick: () => {
          state.infoEdit = state.infoEdit === "pins" ? null : "pins";
          renderInfoPane();
        },
      })
    );
    const pinsEditor = infoEditor("pins", (box) => {
      const list = h("div", "info-pin");
      if (!pins.length) list.appendChild(h("div", "info-value", "还没有置顶"));
      for (const pin of pins) {
        const row = h("div", "info-pin-row");
        row.appendChild(h("span", "info-pin-text", str(pin.text)));
        row.appendChild(
          rowAction(
            "取消",
            async () => {
              try {
                const next = await apiWrite(
                  "DELETE",
                  groupUrl(gid) + "/pins/" + encodeURIComponent(str(pin.id))
                );
                toast("已取消置顶");
                await applyDetail(gid, next);
              } catch (error) {
                toast("取消失败:" + (error.message || "网络错误"));
              }
            },
            { danger: true }
          )
        );
        list.appendChild(row);
      }
      const form = h("div", "sheet-form");
      const area = document.createElement("textarea");
      area.className = "sheet-input";
      area.rows = 2;
      area.placeholder = "比如:对外数字统一用 Q3 财报口径";
      form.appendChild(area);
      const ok = infoActions(form, async () => {
        const text = area.value.trim();
        if (!text) return;
        ok.disabled = true;
        try {
          const next = await apiWrite("POST", groupUrl(gid) + "/pins", { text, by: nickName() });
          toast("已置顶");
          await applyDetail(gid, next);
        } catch (error) {
          ok.disabled = false;
          toast("置顶失败:" + (error.message || "网络错误"));
        }
      }, "置顶");
      list.appendChild(form);
      box.appendChild(list);
    });
    if (pinsEditor) infoBody.appendChild(pinsEditor);

    infoBody.appendChild(h("div", "info-gap"));

    /* 我在本群的昵称(本地) */
    infoBody.appendChild(
      infoRow({
        label: "我在本群的昵称",
        value: state.nick || "未设置",
        chevron: true,
        onClick: () => {
          state.infoEdit = state.infoEdit === "nick" ? null : "nick";
          renderInfoPane();
        },
      })
    );
    const nickEditor = infoEditor("nick", (box) => {
      const field = document.createElement("input");
      field.type = "text";
      field.maxLength = 20;
      field.value = state.nick;
      box.appendChild(field);
      infoActions(box, () => {
        state.nick = field.value.trim().slice(0, 20);
        store.set("mb.nick", state.nick);
        state.infoEdit = null;
        toast("昵称已改:" + nickName());
        renderInfoPane();
      });
      setTimeout(() => field.focus(), 0);
    });
    if (nickEditor) infoBody.appendChild(nickEditor);

    /* 备注(仅自己可见) */
    infoBody.appendChild(
      infoRow({
        label: "备注",
        value: remarkOf(gid) || "仅自己可见",
        chevron: true,
        onClick: () => {
          state.infoEdit = state.infoEdit === "remark" ? null : "remark";
          renderInfoPane();
        },
      })
    );
    const remarkEditor = infoEditor("remark", (box) => {
      const field = document.createElement("input");
      field.type = "text";
      field.maxLength = 20;
      field.value = remarkOf(gid);
      box.appendChild(field);
      infoActions(box, () => {
        const next = field.value.trim().slice(0, 20);
        if (next) state.remark.set(gid, next);
        else state.remark.delete(gid);
        store.set("mb.remark", Object.fromEntries(state.remark));
        state.infoEdit = null;
        renderGroups();
        renderHeader();
        toast(next ? "备注已保存" : "已清除备注");
        renderInfoPane();
      });
      setTimeout(() => field.focus(), 0);
    });
    if (remarkEditor) infoBody.appendChild(remarkEditor);

    infoBody.appendChild(
      infoRow({
        label: "查找聊天内容",
        chevron: true,
        onClick: () => {
          closeInfoPane();
          openMsgSearch();
        },
      })
    );

    infoBody.appendChild(h("div", "info-gap"));

    /* 开关:免打扰 / 置顶聊天(群置顶是本地偏好) */
    infoBody.appendChild(
      infoSwitch("消息免打扰", isMuted(gid), () => {
        if (isMuted(gid)) state.mute.delete(gid);
        else state.mute.add(gid);
        store.set("mb.mute", [...state.mute]);
        renderGroups();
        renderInfoPane();
      })
    );
    infoBody.appendChild(
      infoSwitch("置顶聊天", state.pins.includes(gid), () => {
        state.pins = state.pins.includes(gid)
          ? state.pins.filter((id) => id !== gid)
          : [gid, ...state.pins];
        store.set("mb.pins", state.pins);
        renderGroups();
        renderInfoPane();
      })
    );
    infoBody.appendChild(
      infoRow({ label: "导出聊天记录", chevron: true, onClick: () => exportGroup() })
    );

    infoBody.appendChild(h("div", "info-gap"));
    const foot = h("div", "info-foot");
    const clear = h("button", "", "清空本地已读记录");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.groups.forEach((g) => store.del("mb.read." + g.id));
      renderGroups();
      toast("已清空本地已读");
    });
    foot.appendChild(clear);
    infoBody.appendChild(foot);
  }

  /* ================= Markdown(够用即可:全部走 textContent,不拼 HTML) ================= */
  const MD_INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  function mdInline(text, into) {
    for (const part of String(text).split(MD_INLINE)) {
      if (!part) continue;
      let m;
      if ((m = /^\*\*([\s\S]+)\*\*$/.exec(part))) {
        into.appendChild(h("strong", "", m[1]));
      } else if ((m = /^`([\s\S]+)`$/.exec(part))) {
        into.appendChild(h("code", "", m[1]));
      } else if ((m = /^\*([^*\n]+)\*$/.exec(part))) {
        into.appendChild(h("em", "", m[1]));
      } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part))) {
        const a = h("a", "", m[1]);
        if (/^(https?:|mailto:|\/|#)/i.test(m[2])) {
          a.href = m[2];
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        into.appendChild(a);
      } else {
        into.appendChild(document.createTextNode(part));
      }
    }
    return into;
  }

  const mdCells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  /** Minimal CommonMark: 标题 / 粗斜体 / 行内码 / 链接 / 代码块 / 表格 / 引用 / 有序无序列表(一层缩进) / 分隔线。 */
  function renderMarkdown(source) {
    const root = h("div", "md");
    const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    let para = null;
    const breakPara = () => {
      para = null;
    };
    const paragraph = () => {
      if (!para) {
        para = document.createElement("p");
        root.appendChild(para);
      }
      return para;
    };

    while (i < lines.length) {
      const line = lines[i];

      const fence = /^\s*```(\S*)\s*$/.exec(line);
      if (fence) {
        breakPara();
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i += 1;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = body.join("\n");
        pre.appendChild(code);
        root.appendChild(pre);
        continue;
      }

      if (!line.trim()) {
        breakPara();
        i += 1;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        breakPara();
        const el = document.createElement("h" + heading[1].length);
        mdInline(heading[2], el);
        root.appendChild(el);
        i += 1;
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        breakPara();
        root.appendChild(h("hr"));
        i += 1;
        continue;
      }

      if (/\|/.test(line) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1])) {
        breakPara();
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const hrow = document.createElement("tr");
        for (const cell of mdCells(line)) {
          const th = document.createElement("th");
          mdInline(cell, th);
          hrow.appendChild(th);
        }
        thead.appendChild(hrow);
        table.appendChild(thead);
        i += 2;
        const tbody = document.createElement("tbody");
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          const row = document.createElement("tr");
          for (const cell of mdCells(lines[i])) {
            const td = document.createElement("td");
            mdInline(cell, td);
            row.appendChild(td);
          }
          tbody.appendChild(row);
          i += 1;
        }
        table.appendChild(tbody);
        root.appendChild(table);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        breakPara();
        const quote = h("blockquote");
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          if (quote.childNodes.length) quote.appendChild(document.createElement("br"));
          mdInline(lines[i].replace(/^\s*>\s?/, ""), quote);
          i += 1;
        }
        root.appendChild(quote);
        continue;
      }

      const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        breakPara();
        const ordered = /\d/.test(bullet[2]);
        const baseIndent = bullet[1].length;
        const top = document.createElement(ordered ? "ol" : "ul");
        const stack = [{ list: top, indent: baseIndent }];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          const depth = m[1].length;
          if (depth > stack[stack.length - 1].indent) {
            const nested = document.createElement(/\d/.test(m[2]) ? "ol" : "ul");
            const last = stack[stack.length - 1].list.lastElementChild;
            (last || stack[stack.length - 1].list).appendChild(nested);
            stack.push({ list: nested, indent: depth });
          } else {
            while (stack.length > 1 && depth < stack[stack.length - 1].indent) stack.pop();
          }
          const item = document.createElement("li");
          mdInline(m[3], item);
          stack[stack.length - 1].list.appendChild(item);
          i += 1;
        }
        root.appendChild(top);
        continue;
      }

      const p = paragraph();
      if (p.childNodes.length) p.appendChild(document.createElement("br"));
      mdInline(line.trim(), p);
      i += 1;
    }
    return root;
  }

  const MD_FILE = /\.(md|markdown)$/i;

  function openFileSheet(file, artifact, workId) {
    const name = str(file && (file.name || file.title || file.path), "文件");
    const path = str(file && file.path);
    const url = fileUrl(workId, path);
    const isMarkdown = MD_FILE.test(path);
    const canPreview = TEXT_FILE.test(path);
    let source = str(file && (file.content || file.preview)) || str(artifact && artifact.body);
    let mode = isMarkdown ? "render" : "raw";

    openSheet(name, (body) => {
      const head = h("div", "sheet-file-head");
      head.appendChild(h("span", "member-cap", formatSize(file && (file.size ?? file.bytes)) || path));

      const view = h("div", "sheet-doc");
      let toggle = null;

      const paint = () => {
        view.textContent = "";
        if (!canPreview) {
          view.appendChild(h("div", "sheet-doc-empty", url ? "该类型不支持在线预览,下载后查看。" : "该文件暂无内联内容。"));
          return;
        }
        if (!source) {
          view.appendChild(h("div", "sheet-doc-empty", "加载中…"));
          return;
        }
        if (isMarkdown && mode === "render") {
          view.appendChild(renderMarkdown(source));
          return;
        }
        const pre = document.createElement("pre");
        pre.textContent = source;
        view.appendChild(pre);
      };

      if (isMarkdown) {
        toggle = h("button", "row-action", mode === "render" ? "原文" : "预览");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          mode = mode === "render" ? "raw" : "render";
          toggle.textContent = mode === "render" ? "原文" : "预览";
          paint();
        });
        head.appendChild(toggle);
      }
      if (url) {
        const link = h("a", "btn-text primary mini ready", "下载");
        link.href = url;
        link.setAttribute("download", name.split("/").pop() || name);
        head.appendChild(link);
      }
      body.appendChild(head);
      body.appendChild(view);
      paint();

      if (!url || !canPreview) return;
      // The artifact preview is capped; read the archived file so long deliverables show whole.
      fetch(url + "?inline=1", { headers: { accept: "text/plain" }, cache: "no-store" })
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error("HTTP " + res.status))))
        .then((text) => {
          if (!text || text === source) return;
          source = text;
          paint();
        })
        .catch(() => {
          if (!source) {
            source = "";
            view.textContent = "";
            view.appendChild(h("div", "sheet-doc-empty", "无法读取该文件,请直接下载。"));
          }
        });
    }, { wide: true }); // 交付物常带表格,窄浮层读不了
  }

  /** Whole group history as one file (markdown); the server sets the filename. */
  function exportGroup() {
    const gid = state.groupId;
    if (!gid) return;
    const group = findGroup(gid);
    const link = document.createElement("a");
    link.href = "/api/groups/" + encodeURIComponent(gid) + "/export";
    link.setAttribute("download", "");
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast("正在导出「" + (group ? group.name : gid) + "」的聊天记录");
  }

  /* ================= 设置(居中两栏:左导航 / 右内容) ================= */
  const SETTINGS_SECTIONS = [
    {
      id: "profile",
      label: "个人资料",
      icon: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4.5 20c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"],
    },
    {
      id: "devices",
      label: "手机和设备",
      icon: ["M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 18h2"],
    },
    {
      id: "im",
      label: "IM 接入",
      icon: ["M4 6h16v10H9l-4 3.5V16H4z"],
    },
    {
      id: "ai",
      label: "AI 模型",
      icon: ["M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3", "M9 9h6v6H9z"],
    },
    {
      id: "status",
      label: "运行状态",
      icon: ["M4 12h4l2-5 3 10 2-5h5"],
    },
    {
      id: "data",
      label: "数据与导出",
      icon: ["M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z", "M5 7v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7"],
    },
    {
      id: "keys",
      label: "快捷键",
      icon: ["M3 8h18v8H3z", "M7 11h.01M11 11h.01M15 11h.01M7 14h10"],
    },
    {
      id: "about",
      label: "关于",
      icon: ["M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z", "M12 10.5v4.5M12 8h.01"],
    },
  ];

  function settingsSection(id) {
    return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
  }

  function openSettings(page = "ai") {
    if (!state.groupId && page !== "profile") return;
    closeMenu();
    closeContactsPane();
    state.settingsOpen = true;
    state.settingsPage = page;
    state.settingsForm = false;
    if (page === "profile") state.profileDraft = { ...state.profile };
    state.settingsQuery = "";
    settingsSearch.value = "";
    picker.hidden = true;
    const sheet = pickerSheet();
    if (sheet) sheet.hidden = true;
    settingsEl.hidden = false;
    overlay.hidden = false;
    overlay.onclick = (event) => {
      if (event.target === overlay) closeSettings();
    };
    renderSettings();
    void loadSettingsData();
  }

  function closeSettings() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    state.settingsForm = false;
    settingsEl.hidden = true;
    overlay.hidden = true;
    const sheet = pickerSheet();
    if (sheet) sheet.hidden = false;
  }

  async function loadSettingsData() {
    try {
      const [config, status, devices, im] = await Promise.all([
        fetch("/api/settings", { headers: { accept: "application/json" }, cache: "no-store" }).then((res) =>
          res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))
        ),
        fetch("/api/status", { headers: { accept: "application/json" }, cache: "no-store" }).then((res) =>
          res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))
        ),
        fetch("/api/devices", { headers: { accept: "application/json" }, cache: "no-store" }).then((res) =>
          res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))
        ),
        state.groupId
          ? fetch("/api/groups/" + encodeURIComponent(state.groupId) + "/im", {
              headers: { accept: "application/json" },
              cache: "no-store",
            }).then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
          : Promise.resolve(null),
      ]);
      state.settingsConfig = config;
      state.settingsStatus = status;
      state.devices = devices;
      state.im = im;
      if (state.settingsOpen) renderSettings();
    } catch (error) {
      state.settingsConfig = state.settingsConfig || { error: error.message || "加载失败" };
      if (state.settingsOpen) renderSettings();
    }
  }

  const settingsKv = (pairs) => {
    const dl = h("dl", "settings-kv");
    for (const [key, value] of pairs) {
      if (value === undefined || value === null || value === "") continue;
      dl.appendChild(h("dt", "", key));
      dl.appendChild(h("dd", "", String(value)));
    }
    return dl;
  };

  const settingsCard = (children) => {
    const card = h("div", "settings-card");
    for (const child of children) if (child) card.appendChild(child);
    return card;
  };

  function settingsField(label, input) {
    const field = h("div", "settings-field");
    const id = "set-" + label.replace(/\s+/g, "-");
    input.id = id;
    const lab = h("label", "", label);
    lab.setAttribute("for", id);
    field.appendChild(lab);
    field.appendChild(input);
    return field;
  }

  function renderSettingsNav() {
    settingsNav.textContent = "";
    const q = state.settingsQuery.trim().toLowerCase();
    const sections = SETTINGS_SECTIONS.filter((section) => !q || section.label.toLowerCase().includes(q));
    if (!sections.length) {
      settingsNav.appendChild(h("div", "settings-empty", "没有匹配的设置项"));
      return;
    }
    for (const section of sections) {
      const item = h("button", "settings-nav-item" + (section.id === state.settingsPage ? " on" : ""));
      item.type = "button";
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", section.id === state.settingsPage ? "true" : "false");
      item.appendChild(svgIcon(section.icon, { width: "1.7" }));
      item.appendChild(h("span", "", section.label));
      item.addEventListener("click", () => {
        state.settingsPage = section.id;
        state.settingsForm = false;
        if (section.id === "profile") state.profileDraft = { ...state.profile };
        renderSettings();
      });
      settingsNav.appendChild(item);
    }
  }

  function renderAiSettings(body, config) {
    if (!config || config.error) {
      body.appendChild(h("div", "settings-empty", config ? "设置加载失败:" + config.error : "加载中…"));
      return;
    }
    const check = state.settingsCheck;
    const stateClass = check ? (check.ok ? "ok" : "bad") : "warn";
    const stateText = check
      ? check.ok
        ? `就绪 · ${check.latencyMs}ms${check.modelListed === false ? " · 模型未在列表里" : ""}`
        : `需要处理 · ${check.detail || "检查失败"}`
      : "未检查 · 点右侧「重新检查」";

    body.appendChild(h("div", "settings-section", "提供方"));
    const providerRow = h("div", "settings-row");
    const icon = h("div", "settings-row-icon");
    icon.appendChild(svgIcon(["M4 7l8-3 8 3-8 3-8-3z", "M4 12l8 3 8-3", "M4 17l8 3 8-3"], { width: "1.6" }));
    providerRow.appendChild(icon);
    const main = h("div", "settings-row-main");
    main.appendChild(h("div", "settings-row-name", config.providerName || "Musebot Gateway"));
    main.appendChild(h("div", "settings-row-state " + stateClass, stateText));
    providerRow.appendChild(main);
    const manage = h("button", "btn-text secondary mini", state.settingsForm ? "收起" : "设置");
    manage.type = "button";
    manage.addEventListener("click", () => {
      state.settingsForm = !state.settingsForm;
      renderSettings();
    });
    providerRow.appendChild(manage);
    body.appendChild(settingsCard([providerRow]));

    if (state.settingsForm) {
      const form = h("div", "settings-form");

      const apiSelect = document.createElement("select");
      for (const kind of config.apis || []) {
        const option = document.createElement("option");
        option.value = kind;
        option.textContent = kind;
        if (kind === config.api) option.selected = true;
        apiSelect.appendChild(option);
      }
      form.appendChild(settingsField("协议", apiSelect));

      const baseInput = document.createElement("input");
      baseInput.type = "text";
      baseInput.value = config.baseUrl || "";
      baseInput.placeholder = "https://gateway.example.com/v1";
      form.appendChild(settingsField("Base URL", baseInput));

      const modelInput = document.createElement("input");
      modelInput.type = "text";
      modelInput.value = config.modelId || "";
      modelInput.placeholder = "workbuddy/deepseek-v4.1-flash";
      form.appendChild(settingsField("模型 id", modelInput));

      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.autocomplete = "new-password";
      keyInput.placeholder = config.apiKeySet ? `已保存 ${config.apiKeyMask}(留空表示不改)` : "sk-…";
      form.appendChild(settingsField("API Key", keyInput));

      const actions = h("div", "settings-actions");
      const note = h("span", "settings-note", "保存后下一轮生效,正在跑的任务沿用旧模型");
      actions.appendChild(note);
      const save = h("button", "btn-text primary mini ready", state.settingsSaving ? "保存中…" : "保存");
      save.type = "button";
      save.disabled = state.settingsSaving;
      save.addEventListener("click", () => void saveSettings(apiSelect.value, baseInput.value, modelInput.value, keyInput.value, save));
      actions.appendChild(save);
      form.appendChild(actions);
      body.appendChild(form);
    }

    body.appendChild(h("div", "settings-section", "当前模型"));
    body.appendChild(
      settingsCard([
        (() => {
          const row = h("div", "settings-row");
          const main = h("div", "settings-row-main");
          main.appendChild(h("div", "settings-row-name", config.modelId || "(未设置)"));
          main.appendChild(h("div", "settings-row-state", `${config.api} · 来源:${config.source === "settings" ? "设置" : "环境变量"}`));
          row.appendChild(main);
          const recheck = h("button", "btn-text secondary mini", "重新检查");
          recheck.type = "button";
          recheck.addEventListener("click", () => void runSettingsCheck(recheck));
          row.appendChild(recheck);
          return row;
        })(),
      ])
    );
    body.appendChild(settingsKv([
      ["Base URL", config.baseUrl],
      ["API Key", config.apiKeySet ? config.apiKeyMask : "未配置"],
      ["环境默认", config.env ? `${config.env.api} · ${config.env.modelId}` : ""],
    ]));
    if (check) {
      const pre = h("pre", "settings-pre");
      pre.textContent = JSON.stringify(check, null, 2);
      body.appendChild(pre);
    }
  }

  async function saveSettings(api, baseUrl, modelId, apiKey, button) {
    state.settingsSaving = true;
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      const next = await apiWrite("PUT", "/api/settings", { api, baseUrl, modelId, apiKey });
      state.settingsConfig = next;
      state.settingsForm = false;
      state.settingsCheck = null;
      toast("模型配置已保存");
      renderSettings();
      void loadSettingsData();
    } catch (error) {
      toast("保存失败:" + (error.message || "网络错误"));
      state.settingsSaving = false;
      button.disabled = false;
      button.textContent = "保存";
    }
  }

  async function runSettingsCheck(button) {
    button.disabled = true;
    button.textContent = "检查中…";
    try {
      state.settingsCheck = await apiWrite("POST", "/api/settings/check", {});
    } catch (error) {
      state.settingsCheck = { ok: false, latencyMs: 0, detail: error.message || "网络错误" };
    }
    button.disabled = false;
    button.textContent = "重新检查";
    renderSettings();
  }

  const browserName = (ua) => {
    const s = String(ua || "");
    if (/Edg\//.test(s)) return "Edge";
    if (/Chrome\//.test(s)) return "Chrome";
    if (/Safari\//.test(s)) return "Safari";
    if (/Firefox\//.test(s)) return "Firefox";
    if (!s) return "未知客户端";
    return s.slice(0, 24);
  };

  const relativeTime = (at) => {
    const diff = Date.now() - Number(at || 0);
    if (!Number.isFinite(diff) || diff < 0) return "";
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  };

  async function toggleServe(enabled, button) {
    state.serveBusy = true;
    button.disabled = true;
    button.textContent = enabled ? "开启中…" : "关闭中…";
    try {
      const result = await apiWrite("POST", "/api/tailscale/serve", { enabled });
      state.serveResult = [
        result.ok ? (enabled ? "已开启 tailnet 访问" : "已关闭 tailnet 访问") : "失败:" + (result.detail || ""),
        result.serve && result.serve.enabled ? (result.serve.entries || []).map((e) => e.url).join(" ") : "",
        result.detail && !result.ok ? "" : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 600);
      toast(result.ok ? (enabled ? "已开启 tailnet 访问" : "已关闭") : "操作失败:" + (result.detail || ""));
      await loadSettingsData();
    } catch (error) {
      state.serveResult = "失败:" + (error.message || "网络错误");
      toast("操作失败:" + (error.message || "网络错误"));
    } finally {
      state.serveBusy = false;
      renderSettings();
    }
  }

  async function applyNetwork(host, button) {
    state.networkBusy = true;
    button.disabled = true;
    try {
      const result = await apiWrite("PUT", "/api/network", { host });
      toast(result.restartRequired ? "已保存,重启后生效" : "已保存");
      await loadSettingsData();
    } catch (error) {
      toast("保存失败:" + (error.message || "网络错误"));
    } finally {
      state.networkBusy = false;
      renderSettings();
    }
  }

  function renderProfileSettings(body) {
    const draft = state.profileDraft || (state.profileDraft = { ...state.profile });

    body.appendChild(h("div", "settings-section", "头像与昵称"));
    const card = h("div", "settings-card");

    const head = h("div", "settings-row profile-head");
    const big = h("span", "avatar profile-avatar");
    paintAvatar(big, draft.name, SELF_ID, draft.avatar);
    head.appendChild(big);
    const main = h("div", "settings-row-main");
    main.appendChild(h("div", "settings-row-name", draft.name || "我"));
    main.appendChild(h("div", "settings-row-state", "头像会出现在左栏、群头像拼图和你的每条消息上"));
    head.appendChild(main);
    const pick = h("button", "btn-text secondary mini", "更换头像");
    pick.type = "button";
    pick.addEventListener("click", () => $("avatarInput").click());
    head.appendChild(pick);
    card.appendChild(head);

    const nameField = h("div", "settings-field");
    nameField.style.padding = "12px 14px 2px";
    const nameLabel = h("label", "", "昵称");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 24;
    nameInput.placeholder = "例如:阿哲";
    nameInput.value = draft.name === "我" ? "" : draft.name;
    nameInput.id = "set-profile-name";
    nameLabel.setAttribute("for", nameInput.id);
    nameInput.addEventListener("input", () => {
      draft.name = nameInput.value.trim();
    });
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    const sigField = h("div", "settings-field");
    sigField.style.padding = "6px 14px 14px";
    const sigLabel = h("label", "", "个性签名");
    const sigInput = document.createElement("input");
    sigInput.type = "text";
    sigInput.maxLength = 80;
    sigInput.placeholder = "一句话介绍自己(可选)";
    sigInput.value = draft.signature;
    sigInput.id = "set-profile-signature";
    sigLabel.setAttribute("for", sigInput.id);
    sigInput.addEventListener("input", () => {
      draft.signature = sigInput.value.trim();
    });
    sigField.appendChild(sigLabel);
    sigField.appendChild(sigInput);
    card.appendChild(sigField);
    body.appendChild(card);

    const actions = h("div", "settings-actions");
    actions.style.marginTop = "12px";
    actions.appendChild(h("span", "settings-note", "保存后立即生效,所有群共用这一份资料"));
    const save = h("button", "btn-text primary mini ready", "保存");
    save.type = "button";
    save.addEventListener("click", async () => {
      if (state.settingsSaving) return;
      state.settingsSaving = true;
      save.disabled = true;
      try {
        const saved = await apiWrite("PUT", "/api/profile", {
          name: draft.name,
          signature: draft.signature,
          avatar: draft.avatar,
        });
        state.profile = { ...saved };
        state.profileDraft = null;
        renderRailAvatar();
        renderGroups();
        renderSettings();
        toast("个人资料已保存");
      } catch (error) {
        toast("保存失败:" + (error.message || "网络错误"));
        save.disabled = false;
      } finally {
        state.settingsSaving = false;
      }
    });
    actions.appendChild(save);
    body.appendChild(actions);
    body.appendChild(
      h("div", "settings-note", "头像支持 JPG / PNG / WebP,选择后自动裁成方形再上传;不会保存到系统相册。")
    );
  }

  function renderDevicesSettings(body) {
    const devices = state.devices;
    if (!devices) {
      body.appendChild(h("div", "settings-empty", "加载中…"));
      return;
    }
    const bindHost = devices.bindHost;
    const pending = devices.host !== bindHost;

    /* 已连接:此刻连着 WS 的浏览器(同一浏览器合并成一行) */
    body.appendChild(h("div", "settings-section", "已连接"));
    const clients = devices.clients || [];
    const card = h("div", "settings-card");
    if (!clients.length) {
      card.appendChild(h("div", "settings-row", "还没有设备连接(刷新这个页面就会出现)"));
    }
    for (const client of clients) {
      const row = h("div", "settings-row");
      const icon = h("div", "settings-row-icon");
      icon.appendChild(svgIcon(["M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"], { width: "1.6" }));
      row.appendChild(icon);
      const main = h("div", "settings-row-main");
      main.appendChild(h("div", "settings-row-name", browserName(client.ua)));
      const count = Number(client.connections) > 1 ? ` · ${client.connections} 个标签页` : "";
      main.appendChild(
        h("div", "settings-row-state", `${client.ip || "本机"}${count} · 最近活动 ${relativeTime(client.lastAt)}`)
      );
      row.appendChild(main);
      card.appendChild(row);
    }
    body.appendChild(card);

    /* 访问地址:只列当前 bind 真的服务得到的 */
    body.appendChild(h("div", "settings-section", "访问地址"));
    const urlCard = h("div", "settings-card");
    for (const entry of devices.urls || []) {
      const row = h("div", "settings-row");
      const main = h("div", "settings-row-main");
      main.appendChild(h("div", "settings-row-name", entry.url));
      main.appendChild(h("div", "settings-row-state", entry.label === "本机" ? "这台电脑" : entry.label));
      row.appendChild(main);
      const copy = h("button", "btn-text secondary mini", "复制");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(entry.url);
          toast("已复制 " + entry.url);
        } catch (_) {
          toast("复制失败,手动选中吧");
        }
      });
      row.appendChild(copy);
      urlCard.appendChild(row);
    }
    body.appendChild(urlCard);
    body.appendChild(
      settingsKv([
        ["当前监听", bindHost === "0.0.0.0" ? "所有网卡(局域网 / tailnet 可访问)" : "仅本机 127.0.0.1"],
        ["这台电脑", state.hostName || "未命名"],
      ])
    );

    /* 这台电脑的名称(本地) */
    const nameEdit = h("div", "settings-field");
    const nameLabel = h("label", "", "这台电脑的名称");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 24;
    nameInput.placeholder = "例如:办公室 Mac mini";
    nameInput.value = state.hostName;
    nameInput.id = "set-host-name";
    nameLabel.setAttribute("for", nameInput.id);
    nameEdit.appendChild(nameLabel);
    nameEdit.appendChild(nameInput);
    const nameActions = h("div", "settings-actions");
    nameActions.style.marginTop = "8px";
    nameActions.appendChild(h("span", "settings-note", "只存在这台浏览器里"));
    const saveName = h("button", "btn-text primary mini ready", "保存");
    saveName.type = "button";
    saveName.addEventListener("click", () => {
      state.hostName = nameInput.value.trim().slice(0, 24);
      store.set("mb.hostName", state.hostName);
      renderSettings();
      toast("已保存");
    });
    nameActions.appendChild(saveName);
    nameEdit.appendChild(nameActions);
    body.appendChild(nameEdit);

    /* 高级模式才出现的组网入口 */
    if (!state.settingsAdv) {
      body.appendChild(h("div", "settings-note", "打开左栏底部「高级模式」可以看到远程访问(Tailscale)设置"));
      return;
    }
    const ts = devices.tailscale || {};
    body.appendChild(h("div", "settings-section", "远程访问"));
    const tsRow = h("div", "settings-row");
    const tsIcon = h("div", "settings-row-icon");
    tsIcon.appendChild(svgIcon(["M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z", "M12 12l8-4.5M12 12v9M12 12L4 7.5"], { width: "1.5" }));
    tsRow.appendChild(tsIcon);
    const tsMain = h("div", "settings-row-main");
    tsMain.appendChild(h("div", "settings-row-name", "Tailscale"));
    tsMain.appendChild(
      h("div", "settings-row-state " + (ts.ready ? "ok" : ts.installed ? "warn" : "warn"), ts.detail || "未检测")
    );
    tsRow.appendChild(tsMain);
    const recheck = h("button", "btn-text secondary mini", "重新检查");
    recheck.type = "button";
    recheck.addEventListener("click", async () => {
      recheck.disabled = true;
      recheck.textContent = "检查中…";
      await loadSettingsData();
      recheck.disabled = false;
      recheck.textContent = "重新检查";
      renderSettings();
    });
    tsRow.appendChild(recheck);
    const tsSwitch = h("button", "switch" + (devices.host === "0.0.0.0" ? " on" : ""));
    tsSwitch.type = "button";
    tsSwitch.setAttribute("role", "switch");
    tsSwitch.setAttribute("aria-checked", devices.host === "0.0.0.0" ? "true" : "false");
    tsSwitch.title = "允许通过局域网 / tailnet 访问本机服务";
    tsSwitch.addEventListener("click", () => {
      if (state.networkBusy) return;
      void applyNetwork(devices.host === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0", tsSwitch);
    });
    tsRow.appendChild(tsSwitch);
    body.appendChild(settingsCard([tsRow]));

    /* tailnet 访问:tailscale serve 的真实开关 */
    const serve = ts.serve || { enabled: false, entries: [] };
    const serveRow = h("div", "settings-row");
    const serveIcon = h("div", "settings-row-icon");
    serveIcon.appendChild(svgIcon(["M4 12a8 8 0 0 1 16 0", "M4 12a8 8 0 0 0 16 0", "M12 4v16"], { width: "1.5" }));
    serveRow.appendChild(serveIcon);
    const serveMain = h("div", "settings-row-main");
    serveMain.appendChild(h("div", "settings-row-name", "tailnet 访问"));
    const serveUrl = serve.enabled ? serve.entries.map((entry) => entry.url).join(" ") : "未开启";
    serveMain.appendChild(h("div", "settings-row-state " + (serve.enabled ? "ok" : ""), serveUrl));
    serveRow.appendChild(serveMain);
    const serveBtn = h("button", "btn-text secondary mini", serve.enabled ? "关闭" : "开启");
    serveBtn.type = "button";
    serveBtn.disabled = state.serveBusy || !ts.ready;
    if (!ts.ready) serveBtn.title = "Tailscale 未就绪";
    serveBtn.addEventListener("click", () => void toggleServe(!serve.enabled, serveBtn));
    serveRow.appendChild(serveBtn);
    body.appendChild(settingsCard([serveRow]));

    if (!ts.httpsReady && ts.ready) {
      body.appendChild(
        h(
          "div",
          "bot-note",
          "这台 tailnet 还没启用 HTTPS 证书,所以会用 http://<设备名>.ts.net:<端口>/;要 HTTPS 到 Tailscale 管理台 → DNS → HTTPS Certificates 打开后再点「重新检查」。"
        )
      );
    }
    if (state.serveResult) {
      const box = h("pre", "settings-pre");
      box.textContent = state.serveResult;
      body.appendChild(box);
    }
    if (ts.hint) body.appendChild(h("div", "settings-note", ts.hint));
    if (pending) {
      body.appendChild(
        h(
          "div",
          "settings-row-state warn",
          `已保存为 ${devices.host},但当前进程仍监听 ${bindHost} —— 重启 musebot 后生效`
        )
      );
    }
    body.appendChild(h("div", "settings-note", "musebot 不会自己去启动或登录 Tailscale;这里只控制本服务监听哪块网卡。"));
  }

  function renderImSettings(body) {
    const im = state.im;
    if (!im) {
      body.appendChild(h("div", "settings-empty", "加载中…"));
      return;
    }
    const origin = location.origin;
    const base = `${origin}/api/im/${encodeURIComponent(im.groupId)}`;

    body.appendChild(h("div", "settings-section", "这个群的中转地址"));
    const row = h("div", "settings-row");
    const main = h("div", "settings-row-main");
    main.appendChild(h("div", "settings-row-name", "入站 Webhook"));
    main.appendChild(h("div", "settings-row-state", `${base}/<token>`));
    row.appendChild(main);
    const copyBtn = h("button", "btn-text secondary mini", "复制");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`${base}/<token>`);
        toast("已复制(把 <token> 换成生成的那串)");
      } catch (_) {
        toast("复制失败");
      }
    });
    row.appendChild(copyBtn);
    body.appendChild(settingsCard([row]));

    const tokenRow = h("div", "settings-row");
    const tokenMain = h("div", "settings-row-main");
    tokenMain.appendChild(h("div", "settings-row-name", "Token"));
    tokenMain.appendChild(h("div", "settings-row-state", im.tokenSet ? "已生成 · " + im.tokenMask : "还没有生成"));
    tokenRow.appendChild(tokenMain);
    const rotate = h("button", "btn-text secondary mini", im.tokenSet ? "重新生成" : "生成");
    rotate.type = "button";
    rotate.addEventListener("click", async () => {
      rotate.disabled = true;
      try {
        const next = await apiWrite("POST", `/api/groups/${encodeURIComponent(im.groupId)}/im/rotate`, {});
        state.im = next;
        state.imToken = next.token;
        toast("新 token 已生成,旧 token 立即失效");
        renderSettings();
      } catch (error) {
        toast("生成失败:" + (error.message || "网络错误"));
      } finally {
        rotate.disabled = false;
      }
    });
    tokenRow.appendChild(rotate);
    body.appendChild(settingsCard([tokenRow]));

    if (state.imToken) {
      const box = h("pre", "settings-pre");
      box.textContent = [
        "只显示这一次,复制保存好:",
        "",
        `POST ${base}/${state.imToken}`,
        'content-type: application/json',
        "",
        '{"sender":"张三","text":"帮我整理一版周报"}',
      ].join("\n");
      body.appendChild(box);
    }

    body.appendChild(h("div", "settings-section", "行为"));
    body.appendChild(
      infoSwitch("启用这个桥", im.enabled, async () => {
        try {
          state.im = await apiWrite("PUT", `/api/groups/${encodeURIComponent(im.groupId)}/im`, { enabled: !im.enabled });
          renderSettings();
        } catch (error) {
          toast("保存失败:" + (error.message || "网络错误"));
        }
      })
    );
    body.appendChild(
      h(
        "div",
        "settings-note",
        "入站消息走和输入框同一个判断:像需求就交给领导分工(群里会出现「领导正在分工…」),闲聊就只落一条消息。token 放在 URL 里,只返回掩码,重新生成会让旧 token 立即失效。"
      )
    );

    body.appendChild(h("div", "settings-section", "出站(给中转服务拉)"));
    body.appendChild(
      settingsKv([
        ["拉取地址", `${base}/<token>/outbox?since=<lastId>`],
        ["返回", "id / kind / author / text 或 file / at,按 id 升序,最多 200 条"],
        ["回调 URL", im.callbackUrl || "(不用填:由你的中转服务主动拉)"],
      ])
    );
    if (im.recent && im.recent.length) {
      body.appendChild(h("div", "settings-section", "最近的入站"));
      for (const entry of im.recent) {
        body.appendChild(
          settingsKv([
            [entry.sender || "IM", `${entry.text}`.slice(0, 80) + ` · ${entry.routed === "requirement" ? "转成任务" : "只是消息"}`],
          ])
        );
      }
    }
  }

  function renderStatusSettings(body, status) {
    if (!status) {
      body.appendChild(h("div", "settings-empty", "加载中…"));
      return;
    }
    const uptime = Number(status.uptimeMs || 0);
    const mins = Math.floor(uptime / 60000);
    const human = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分 ${Math.floor((uptime % 60000) / 1000)} 秒`;
    body.appendChild(h("div", "settings-section", "进程"));
    body.appendChild(
      settingsCard([
        (() => {
          const row = h("div", "settings-row");
          const main = h("div", "settings-row-main");
          main.appendChild(h("div", "settings-row-name", status.mode === "viewer" ? "只读查看进程" : "写入进程"));
          main.appendChild(h("div", "settings-row-state", `127.0.0.1:${status.port} · 已运行 ${human}`));
          row.appendChild(main);
          return row;
        })(),
      ])
    );
    body.appendChild(settingsKv([
      ["数据库", status.storage],
      ["归档目录", status.archiveRoot],
      ["群 / bot", `${status.groups} 个群 / ${status.bots} 个 bot`],
      ["启动时间", new Date(status.startedAt).toLocaleString("zh-CN", { hour12: false })],
      ["版本", status.version],
    ]));
    if (state.settingsAdv) {
      const pre = h("pre", "settings-pre");
      pre.textContent = JSON.stringify(status, null, 2);
      body.appendChild(pre);
    }
  }

  function renderDataSettings(body, status) {
    const archive = status && status.archive ? status.archive : null;
    body.appendChild(h("div", "settings-section", "交付物归档"));
    body.appendChild(settingsKv([
      ["目录", status ? status.archiveRoot : ""],
      ["文件", archive ? `${archive.files} 个 · ${formatSize(archive.bytes)}` : ""],
    ]));
    body.appendChild(h("div", "settings-section", "导出"));
    const row = h("div", "settings-row");
    const main = h("div", "settings-row-main");
    main.appendChild(h("div", "settings-row-name", "当前群聊天记录"));
    main.appendChild(h("div", "settings-row-state", "markdown 给人看,json 用来归档"));
    row.appendChild(main);
    const md = h("button", "btn-text primary mini ready", "导出 md");
    md.type = "button";
    md.addEventListener("click", () => exportGroup());
    row.appendChild(md);
    const json = h("button", "btn-text secondary mini", "导出 json");
    json.type = "button";
    json.addEventListener("click", () => downloadExport("json"));
    row.appendChild(json);
    body.appendChild(settingsCard([row]));

    body.appendChild(h("div", "settings-section", "本地数据"));
    body.appendChild(settingsKv([
      ["已读记录", "localStorage · mb.read.*"],
      ["偏好", "昵称 / 备注 / 免打扰 / 置顶 / 草稿"],
    ]));
    const actions = h("div", "settings-actions");
    actions.style.marginTop = "10px";
    const note = h("span", "settings-note", "只影响这台电脑的浏览器");
    actions.appendChild(note);
    const clearRead = h("button", "btn-text secondary mini", "清空已读");
    clearRead.type = "button";
    clearRead.addEventListener("click", () => {
      state.groups.forEach((group) => store.del("mb.read." + group.id));
      renderGroups();
      toast("已清空本地已读");
    });
    actions.appendChild(clearRead);
    const clearPrefs = h("button", "btn-text secondary mini", "清空昵称/备注/免打扰");
    clearPrefs.type = "button";
    clearPrefs.addEventListener("click", () => {
      state.nick = "";
      state.remark = new Map();
      state.mute = new Set();
      store.del("mb.nick");
      store.del("mb.remark");
      store.del("mb.mute");
      renderGroups();
      renderHeader();
      renderSettings();
      toast("本地偏好已清空");
    });
    actions.appendChild(clearPrefs);
    body.appendChild(actions);
  }

  function renderKeysSettings(body) {
    body.appendChild(h("div", "settings-section", "键盘"));
    const card = h("div", "settings-card");
    for (const [key, desc] of SHORTCUTS) {
      const row = h("div", "settings-row");
      const main = h("div", "settings-row-main");
      main.appendChild(h("div", "settings-row-name", key));
      main.appendChild(h("div", "settings-row-state", desc));
      row.appendChild(main);
      card.appendChild(row);
    }
    body.appendChild(card);
  }

  function renderAboutSettings(body, status, config) {
    body.appendChild(h("div", "settings-section", "musebot"));
    body.appendChild(settingsKv([
      ["版本", status ? status.version : "0.4.1"],
      ["模型", config ? config.modelId : ""],
      ["协议", config ? config.api : ""],
      ["来源", config ? (config.source === "settings" ? "设置面板" : "环境变量") : ""],
      ["群聊模型", "群会话只写不跑;执行都在各 bot 的私有会话里"],
    ]));
    body.appendChild(h("div", "settings-section", "说明"));
    body.appendChild(
      h(
        "div",
        "",
        "musebot 是仿微信群聊的多 agent 客户端:领导 bot 拆任务、执行 bot 交付文件,群永远不阻塞。设置面板只放能真正生效的项;做不到的(深色模式、群二维码等)不摆假开关。"
      )
    );
  }

  function renderSettings() {
    if (!state.settingsOpen) return;
    renderSettingsNav();
    const section = settingsSection(state.settingsPage);
    settingsTitle.textContent = section.label;
    settingsSub.textContent =
      state.settingsPage === "profile"
        ? `${state.profile.name} · ${state.profile.signature || "还没写个性签名"}`
        : state.settingsPage === "im" && state.im
        ? `群 ${state.im.groupId} · ${state.im.enabled ? "已启用" : "已停用"}`
        : state.settingsPage === "devices" && state.devices
        ? `这台电脑 · ${state.devices.bindHost}`
        : state.settingsPage === "ai" && state.settingsStatus
        ? `适用于 ${state.settingsStatus.groups} 个群 · ${state.settingsStatus.bots} 个 bot`
        : state.settingsPage === "status" && state.settingsStatus
          ? `${state.settingsStatus.mode === "viewer" ? "只读查看" : "写入"} · 127.0.0.1:${state.settingsStatus.port}`
          : "";
    settingsVersion.textContent = state.settingsStatus
      ? `这个应用 ${state.settingsStatus.version} · ${state.settingsStatus.mode === "viewer" ? "只读" : "写入"}`
      : "这个应用";
    settingsAdvBtn.classList.toggle("on", state.settingsAdv);
    settingsAdvBtn.querySelector(".switch").classList.toggle("on", state.settingsAdv);

    settingsBody.textContent = "";
    if (state.settingsPage === "profile") renderProfileSettings(settingsBody);
    else if (state.settingsPage === "devices") renderDevicesSettings(settingsBody);
    else if (state.settingsPage === "im") renderImSettings(settingsBody);
    else if (state.settingsPage === "ai") renderAiSettings(settingsBody, state.settingsConfig);
    else if (state.settingsPage === "status") renderStatusSettings(settingsBody, state.settingsStatus);
    else if (state.settingsPage === "data") renderDataSettings(settingsBody, state.settingsStatus);
    else if (state.settingsPage === "keys") renderKeysSettings(settingsBody);
    else renderAboutSettings(settingsBody, state.settingsStatus, state.settingsConfig);
  }

  /** Same file the group menu produces, but for the current group with an explicit format. */
  function downloadExport(format) {
    const gid = state.groupId;
    if (!gid) return;
    const link = document.createElement("a");
    link.href = "/api/groups/" + encodeURIComponent(gid) + "/export?format=" + encodeURIComponent(format);
    link.setAttribute("download", "");
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast("正在导出 " + format);
  }

  /* ================= 新建群 / 新建 bot ================= */
  const CAP_LABELS = { finance: "财务", data: "数据", analysis: "分析", design: "设计", general: "通用" };

  function openBotCreator() {
    const group = findGroup(state.groupId);
    const caps = state.botCapabilities.length ? state.botCapabilities : Object.keys(CAP_LABELS);
    openSheet("新建 bot", (body) => {
      const form = h("div", "sheet-form creator-form");

      const avatarRow = h("div", "creator-avatar-row");
      const preview = h("span", "avatar creator-avatar");
      const glyph = document.createElement("input");
      glyph.type = "text";
      glyph.id = "creatorGlyph";
      glyph.maxLength = 4;
      glyph.placeholder = "首字";
      glyph.className = "creator-glyph";
      glyph.setAttribute("aria-label", "bot 头像字符");
      const avatarMain = h("div", "creator-avatar-main");
      avatarMain.appendChild(h("div", "creator-label", "头像"));
      avatarMain.appendChild(
        h("div", "creator-hint", "填一个 emoji 或字,例如 🧪;留空就用名称首字")
      );
      avatarRow.appendChild(preview);
      avatarRow.appendChild(avatarMain);
      avatarRow.appendChild(glyph);
      form.appendChild(avatarRow);

      const nameField = h("div", "settings-field");
      nameField.appendChild(h("label", "", "名称"));
      const name = document.createElement("input");
      name.type = "text";
      name.id = "creatorName";
      name.maxLength = 24;
      name.placeholder = "例如:调研 bot";
      nameField.appendChild(name);
      form.appendChild(nameField);

      const capField = h("div", "settings-field");
      capField.appendChild(h("label", "", "能力(领导按这个派活)"));
      const cap = document.createElement("select");
      cap.id = "creatorCap";
      for (const value of caps) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = CAP_LABELS[value] || value;
        cap.appendChild(option);
      }
      if (caps.includes("general")) cap.value = "general";
      capField.appendChild(cap);
      form.appendChild(capField);

      const instField = h("div", "settings-field");
      instField.appendChild(h("label", "", "人设 / 指令"));
      const instructions = document.createElement("textarea");
      instructions.className = "sheet-input";
      instructions.id = "creatorInstructions";
      instructions.rows = 5;
      instructions.placeholder = "这个 bot 负责什么、输出什么格式。例如:你是用户调研 bot,负责整理访谈记录并给出 3 条结论。";
      instField.appendChild(instructions);
      form.appendChild(instField);

      let join = null;
      if (group) {
        const joinLabel = h("label", "creator-join");
        join = document.createElement("input");
        join.type = "checkbox";
        join.checked = true;
        joinLabel.appendChild(join);
        joinLabel.appendChild(document.createTextNode(`创建后加入「${displayName(group)}」`));
        form.appendChild(joinLabel);
      }

      const err = h("div", "new-group-err");
      err.hidden = true;
      form.appendChild(err);

      const actions = h("div", "sheet-actions");
      const cancel = h("button", "btn-text secondary mini", "取消");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        overlay.hidden = true;
      });
      const ok = h("button", "btn-text primary mini ready", "创建");
      ok.type = "button";
      actions.appendChild(cancel);
      actions.appendChild(ok);
      form.appendChild(actions);
      body.appendChild(form);

      const paintPreview = () => {
        paintAvatar(preview, name.value.trim() || "新", "creator", glyph.value.trim());
      };
      glyph.addEventListener("input", paintPreview);
      name.addEventListener("input", paintPreview);
      paintPreview();

      ok.addEventListener("click", async () => {
        const botName = name.value.trim();
        if (!botName) {
          err.hidden = false;
          err.textContent = "名称不能为空";
          name.focus();
          return;
        }
        ok.disabled = true;
        ok.textContent = "创建中…";
        try {
          const created = await postJson("/api/bots", {
            name: botName,
            capability: cap.value,
            instructions: instructions.value,
            avatar: glyph.value.trim(),
            groupId: join && join.checked && group ? group.id : "",
          });
          if (created && created.bot) state.bots.push(created.bot);
          renderGroups();
          overlay.hidden = true;
          if (created.added && group) {
            const detail = await loadDetail(group.id, true);
            applyDetail(group.id, detail);
          }
          toast(created.added && group ? `已创建「${botName}」并加入本群` : `已创建「${botName}」`);
        } catch (error) {
          err.hidden = false;
          err.textContent = error.message || "创建失败";
          ok.disabled = false;
          ok.textContent = "创建";
        }
      });
      setTimeout(() => name.focus(), 0);
    });
  }

  /* ================= 新建群 / 搜索(列表 · 消息) ================= */
  function openNewGroup() {
    newGroupForm.hidden = false;
    newGroupErr.hidden = true;
    newGroupErr.textContent = "";
    newGroupName.value = "";
    setTimeout(() => newGroupName.focus(), 0);
  }

  function closeNewGroup() {
    newGroupForm.hidden = true;
    newGroupErr.hidden = true;
    newGroupName.value = "";
  }

  async function submitNewGroup(event) {
    event.preventDefault();
    const name = newGroupName.value.trim();
    if (!name) {
      newGroupErr.hidden = false;
      newGroupErr.textContent = "群名不能为空";
      newGroupName.focus();
      return;
    }
    newGroupOk.disabled = true;
    try {
      const created = await postJson("/api/groups", { name });
      closeNewGroup();
      await reloadGroups();
      const id = created && created.group ? created.group.id : null;
      if (id) selectGroup(id);
      toast("已建群:" + name);
    } catch (error) {
      newGroupErr.hidden = false;
      newGroupErr.textContent = "建群失败:" + (error.message || "网络错误");
    } finally {
      newGroupOk.disabled = false;
    }
  }

  function onListSearch() {
    state.search = searchInput.value || "";
    renderGroups();
  }

  function openMsgSearch() {
    msgSearch.hidden = false;
    state.msgSearch = "";
    msgSearchInput.value = "";
    renderStreamFull(state.items, { keepPosition: true });
    updateMsgSearchCount();
    setTimeout(() => msgSearchInput.focus(), 0);
  }

  function closeMsgSearch() {
    msgSearch.hidden = true;
    state.msgSearch = "";
    msgSearchInput.value = "";
    renderStreamFull(state.items, { keepPosition: true });
    input.focus();
  }

  function onMsgSearchInput() {
    state.msgSearch = msgSearchInput.value;
    renderStreamFull(state.items, { keepPosition: true });
    updateMsgSearchCount();
  }

  /* ================= 移动端 ================= */
  function setView(view) {
    app.dataset.view = view;
  }

  function openDrawer() {
    app.classList.add("list-open");
  }

  function closeDrawer() {
    app.classList.remove("list-open");
  }

  /* ================= 事件 ================= */
  let saveScrollTimer = null;
  function saveScrollDebounced() {
    if (saveScrollTimer) return;
    saveScrollTimer = setTimeout(() => {
      saveScrollTimer = null;
      saveScroll();
    }, 200);
  }

  function openEmojiPanel() {
    emojiPanel.textContent = "";
    EMOJIS.forEach((emoji) => {
      const btn = h("button", "", emoji);
      btn.type = "button";
      btn.addEventListener("click", () => {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + emoji.length;
        autosize();
        syncSendButtons();
        if (state.groupId) store.set("mb.draft." + state.groupId, input.value);
      });
      emojiPanel.appendChild(btn);
    });
    emojiPanel.hidden = !emojiPanel.hidden;
  }

  function bindEvents() {
    input.addEventListener("input", () => {
      autosize();
      syncSendButtons();
      if (state.groupId) store.set("mb.draft." + state.groupId, input.value);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (event.isComposing) return;
      if (event.shiftKey) return;
      event.preventDefault();
      void submitText("send");
    });

    input.addEventListener("paste", () => {
      setTimeout(autosize, 0);
    });

    sendBtn.addEventListener("click", () => void submitText("send"));

    newGroupBtn.addEventListener("click", () => {
      const rect = newGroupBtn.getBoundingClientRect();
      openMenuAt(rect.left, rect.bottom + 6, [
        { label: "新建群", run: openNewGroup },
        { label: "新建 bot", run: openBotCreator },
      ]);
    });
    newGroupForm.addEventListener("submit", submitNewGroup);
    newGroupCancel.addEventListener("click", closeNewGroup);
    newGroupName.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNewGroup();
      }
    });

    // 微信桌面端:点头部群名或「…」都是从右侧滑出群信息面板,不是居中弹窗。
    groupTitleBtn.addEventListener("click", toggleInfoPane);
    $("moreBtn").addEventListener("click", toggleInfoPane);

    pickerSearch.addEventListener("input", () => {
      state.pickerQuery = pickerSearch.value;
      renderPicker();
    });
    pickerCancel.addEventListener("click", closePicker);
    pickerOk.addEventListener("click", () => void submitPicker());
    $("pickerNew").addEventListener("click", () => {
      closePicker();
      openBotCreator();
    });

    $("searchMsgBtn").addEventListener("click", openMsgSearch);
    $("msgSearchClose").addEventListener("click", closeMsgSearch);
    msgSearchInput.addEventListener("input", onMsgSearchInput);
    msgSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMsgSearch();
      }
    });

    searchInput.addEventListener("input", onListSearch);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        searchInput.value = "";
        onListSearch();
        searchInput.blur();
      }
    });

    stream.addEventListener("scroll", () => {
      state.stick = isAtBottom();
      if (state.stick && state.newCount) {
        state.newCount = 0;
        updateNewMsgBtn();
      }
      updateLoadMore();
      if (state.stick) markRead();
      saveScrollDebounced();
    });

    loadMoreBtn.addEventListener("click", () => void loadEarlier());

    newMsgBtn.addEventListener("click", () => {
      stream.scrollTo({ top: stream.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
      state.newCount = 0;
      updateNewMsgBtn();
      markRead();
    });

    $("toolEmoji").addEventListener("click", (event) => {
      event.stopPropagation();
      openEmojiPanel();
    });
    $("toolFile").addEventListener("click", () => fileInput.click());
    $("toolImage").addEventListener("click", () => imageInput.click());
    fileInput.addEventListener("change", () => void sendPickedFiles(fileInput, false));
    imageInput.addEventListener("change", () => void sendPickedFiles(imageInput, true));
    toolVoice.addEventListener("click", () => void toggleVoice());

    document.addEventListener("click", (event) => {
      if (!emojiPanel.hidden && !emojiPanel.contains(event.target) && event.target !== $("toolEmoji")) {
        emojiPanel.hidden = true;
      }
    });

    // 点面板外部收起,但点在「…」/群名/菜单上时交给它们自己切换
    document.addEventListener("mousedown", (event) => {
      if (!state.infoOpen && !state.botOpen && !state.contactsOpen) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("#infoPane") || target.closest("#botPane") || target.closest("#contactsWindow") || target.closest("#menu")) return;
      if (target.closest("#moreBtn") || target.closest("#groupTitleBtn") || target.closest("#railContacts")) return;
      if (state.contactsOpen) closeContactsPane();
      if (state.botOpen) closeBotPane();
      if (state.infoOpen) closeInfoPane();
    });

    document.addEventListener("selectionchange", () => {
      if (state.deferredRender && !selectionActive()) flushDeferred();
    });

    document.addEventListener("keydown", (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      if (state.settingsOpen && event.key === "/" && document.activeElement !== settingsSearch) {
        event.preventDefault();
        settingsSearch.focus();
        return;
      }
      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openMsgSearch();
        return;
      }
      if (event.key === "Escape") {
        if (state.settingsOpen) {
          closeSettings();
          return;
        }
        if (!picker.hidden) {
          closePicker();
          return;
        }
        if (!menu.hidden) {
          closeMenu();
          return;
        }
        if (!overlay.hidden) {
          overlay.hidden = true;
          return;
        }
        if (state.contactsOpen) {
          closeContactsPane();
          return;
        }
        if (state.botOpen) {
          closeBotPane();
          return;
        }
        if (state.infoOpen) {
          closeInfoPane();
          return;
        }
        if (!emojiPanel.hidden) {
          emojiPanel.hidden = true;
          return;
        }
        if (!msgSearch.hidden) {
          closeMsgSearch();
          return;
        }
        if (!newGroupForm.hidden) {
          closeNewGroup();
          return;
        }
        if (searchInput.value) {
          searchInput.value = "";
          onListSearch();
        }
      }
    });

    $("railSettings").addEventListener("click", () => openSettings("ai"));
    $("railMe").addEventListener("click", () => openSettings("profile"));
    $("railContacts").addEventListener("click", openContactsPane);
    contactsClose.addEventListener("click", closeContactsPane);
    contactsSearch.addEventListener("input", () => {
      state.contactsQuery = contactsSearch.value || "";
      void renderContactsPane();
    });
    contactsManage.addEventListener("click", () => {
      state.contactsManage = !state.contactsManage;
      contactsManageText.textContent = state.contactsManage ? "完成管理" : "通讯录管理";
      contactsManage.classList.toggle("on", state.contactsManage);
      void renderContactsPane();
    });
    avatarInput.addEventListener("change", async () => {
      const file = (avatarInput.files || [])[0];
      avatarInput.value = "";
      if (!file) return;
      try {
        const draft = state.profileDraft || (state.profileDraft = { ...state.profile });
        draft.avatar = await squareAvatar(file);
        renderSettings();
        toast("头像已就绪,点「保存」生效");
      } catch (error) {
        toast(error.message || "图片处理失败");
      }
    });
    botAvatarInput.addEventListener("change", async () => {
      const file = (botAvatarInput.files || [])[0];
      botAvatarInput.value = "";
      if (!file || !state.botOpen || !state.botId) return;
      try {
        const data = await squareAvatar(file);
        await saveBotProfile({ avatar: data });
        toast("bot 头像已保存");
      } catch (error) {
        toast(error.message || "图片处理失败");
      }
    });

    settingsSearch.addEventListener("input", () => {
      state.settingsQuery = settingsSearch.value;
      renderSettingsNav();
    });
    settingsSearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        settingsSearch.value = "";
        state.settingsQuery = "";
        renderSettingsNav();
      }
      if (event.key === "Enter") {
        const first = settingsNav.querySelector(".settings-nav-item");
        if (first) first.click();
      }
    });
    settingsAdvBtn.addEventListener("click", () => {
      state.settingsAdv = !state.settingsAdv;
      store.set("mb.adv", state.settingsAdv);
      renderSettings();
    });
    $("settingsClose").addEventListener("click", closeSettings);
    $("railPhone").addEventListener("click", () => toast("手机端请直接访问同一端口"));

    backBtn.addEventListener("click", () => setView("list"));
    drawerBtn.addEventListener("click", () => {
      if (app.classList.contains("list-open")) closeDrawer();
      else openDrawer();
    });
    listBackdrop.addEventListener("click", closeDrawer);

    window.addEventListener("hashchange", () => {
      const wanted = parseHashId();
      const target = findGroup(wanted) || state.groups[0];
      if (!target) return;
      if (target.id !== wanted) replaceHash(target.id);
      if (target.id !== state.groupId) applyGroup(target.id);
      else renderGroups();
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 560) app.dataset.view = "list";
      if (window.innerWidth > 900) closeDrawer();
    });

    stream.addEventListener("dragover", (event) => event.preventDefault());
    stream.addEventListener("drop", (event) => {
      event.preventDefault();
      toast("文件发送暂未开放");
    });
  }

  /* ================= 初始化 ================= */
  async function boot() {
    state.groupsLoaded = false;
    state.pins = store.get("mb.pins", []) || [];
    state.pinsCollapsed = !!store.get("mb.pins.collapsed", false);
    state.botsCollapsed = !!store.get("mb.botsCollapsed", false);
    state.settingsAdv = !!store.get("mb.adv", false);
    state.hostName = str(store.get("mb.hostName", ""));
    state.nick = str(store.get("mb.nick", ""));
    state.mute = new Set(store.get("mb.mute", []) || []);
    state.remark = new Map(Object.entries(store.get("mb.remark", {}) || {}));
    bindEvents();
    autosize();
    syncSendButtons();
    showEmptyChat("加载中…");

    // Profile and custom-bot names must be in hand before the first paint: they feed
    // the rail avatar, the composite group avatar and every message avatar.
    await Promise.allSettled([loadProfile(), ensureBots()]);
    renderRailAvatar();
    renderGroups();

    try {
      await reloadGroups();
    } catch (error) {
      showEmptyChat("群列表加载失败");
      groupList.textContent = "";
      groupList.appendChild(h("div", "list-empty", "群列表加载失败 · " + (error.message || "")));
      return;
    }

    if (!state.groups.length) {
      showEmptyChat("还没有群");
      renderHeader();
      return;
    }

    const wanted = parseHashId();
    const target = findGroup(wanted) || state.groups[0];
    if (target.id !== wanted) replaceHash(target.id);
    applyGroup(target.id);

    window.addEventListener("beforeunload", () => {
      saveDraft();
      saveScroll();
    });
  }

  boot();
})();
