<script setup>
/* 群信息边栏：对照旧 app.js 的 openInfoPane / closeInfoPane / renderInfoPane /
   infoRow / infoSwitch / infoEditor / infoActions / renderMembersSection / openMemberMenu。
   DOM/class 与旧完全一致：#infoPane > .info-scroll#infoBody。
   - 搜索成员：.info-search input
   - 成员九宫格：.info-member（末尾 .info-member.add 打开 MemberPicker）
   - 群聊名称 / 群公告 / 群置顶 / 我在本群昵称 / 备注 / 查找聊天内容 / 开关 / 导出 / 清空已读
   - 点外部 / × / Esc 关闭；写操作全部走 store actions。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { state, actions, ui } from "../store.js";
import Avatar from "./Avatar.vue";
import Icon from "./Icon.vue";

const editBox = ref(null);

const group = computed(() => ui.findGroup(state.groupId));
const detail = computed(() => (state.groupId ? state.detailByGroup[state.groupId] : null));
const announcement = computed(() => ui.str(detail.value && detail.value.announcement));
const pins = computed(() => (detail.value && Array.isArray(detail.value.pins) ? detail.value.pins : []));

const members = computed(() => {
  const d = detail.value;
  if (d && Array.isArray(d.members) && d.members.length) return d.members;
  const g = group.value;
  return (g ? g.roster : []).map((id) => ({ id, name: ui.botName(id), capabilities: [], busy: false }));
});

const shownMembers = computed(() => {
  const q = state.infoQuery.trim().toLowerCase();
  if (!q) return members.value;
  return members.value.filter((m) => ui.str(m.name || m.id).toLowerCase().includes(q));
});

const announcementPreview = computed(() =>
  announcement.value ? clampText(announcement.value.replace(/\s+/g, " "), 36) : "未设置"
);
const pinsPreview = computed(() =>
  pins.value.length ? `${pins.value.length} 条 · 每个 bot 都会读到` : "未设置"
);

function clampText(text, max) {
  const s = ui.str(text);
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

/* ---------- 就地编辑 ---------- */
function toggleEdit(kind) {
  state.infoEdit = state.infoEdit === kind ? null : kind;
}
function cancelEdit() {
  state.infoEdit = null;
}
function editValue() {
  const box = editBox.value;
  if (!box) return "";
  const field = box.querySelector("input, textarea");
  return field ? field.value : "";
}

async function saveName() {
  const next = await actions.renameGroup(state.groupId, editValue());
  if (next) {
    const g = ui.findGroup(state.groupId);
    if (g && next.group && next.group.name) g.name = next.group.name;
    state.infoEdit = null;
  }
}
async function saveAnnouncement() {
  const next = await actions.setAnnouncement(state.groupId, editValue());
  if (next) state.infoEdit = null;
}
function saveNick() {
  const value = ui.str(editValue()).trim().slice(0, 20);
  actions.setNick(value);
  state.infoEdit = null;
  actions.toast("昵称已改:" + ui.nickName());
}
function saveRemark() {
  const value = ui.str(editValue()).trim().slice(0, 20);
  actions.setRemark(state.groupId, value);
  state.infoEdit = null;
  actions.toast(value ? "备注已保存" : "已清除备注");
}
async function savePin() {
  const box = editBox.value;
  const area = box ? box.querySelector(".sheet-form textarea") : null;
  if (!area) return;
  const text = area.value.trim();
  if (!text) return;
  const next = await actions.addPin(state.groupId, text);
  if (next && area) area.value = "";
}
async function removePinRow(pinId) {
  await actions.removePin(state.groupId, pinId);
}

/* ---------- 开关 / 导出 / 清空 ---------- */
function toggleMute() {
  actions.toggleMute(state.groupId);
}
function togglePinChat() {
  const gid = state.groupId;
  const next = state.pins.includes(gid)
    ? state.pins.filter((id) => id !== gid)
    : [gid, ...state.pins];
  actions.setPins(next);
}
function exportChat() {
  actions.exportGroup(state.groupId);
}
function openMsgSearch() {
  actions.closeInfo();
  const btn = document.getElementById("searchMsgBtn");
  if (btn) btn.click();
}
function clearReads() {
  state.groups.forEach((g) => ui.store.del("mb.read." + g.id));
  actions.toast("已清空本地已读");
  void actions.refreshGroups();
}

/* ---------- 成员 ---------- */
function openPicker() {
  actions.openPicker();
  void actions.ensureBots();
}
function openMember(m) {
  actions.closeInfo();
  actions.openBot(state.groupId, m.id);
}
function memberMenu(m, event) {
  const gid = state.groupId;
  const name = m.name || m.id;
  const busy = !!m.busy || state.busyBots.includes(m.id);
  if (m.role === "leader") {
    actions.openMenuAt(event.clientX, event.clientY, [{ label: "领导负责分工,不能移出", run: () => undefined }]);
    return;
  }
  if (busy) {
    actions.openMenuAt(event.clientX, event.clientY, [{ label: "正在执行任务,先取消再移出", run: () => undefined }]);
    return;
  }
  actions.openMenuAt(event.clientX, event.clientY, [
    {
      label: "移出群聊",
      danger: true,
      run: async () => {
        const next = await actions.removeMember(gid, m.id);
        if (next) actions.toast("已移出 " + name);
      },
    },
  ]);
}

/* ---------- 打开编辑时聚焦 ---------- */
watch(
  () => state.infoEdit,
  async (kind) => {
    if (!kind) return;
    await nextTick();
    const box = editBox.value;
    const field = box && box.querySelector("input, textarea");
    if (field) field.focus();
  }
);

/* ---------- 点外部关闭 ---------- */
function onDocMouseDown(event) {
  if (!state.infoOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest("#infoPane") ||
    target.closest("#botPane") ||
    target.closest("#contactsWindow") ||
    target.closest("#picker") ||
    target.closest("#overlay") ||
    target.closest("#menu")
  )
    return;
  if (target.closest("#moreBtn") || target.closest("#groupTitleBtn") || target.closest("#railContacts")) return;
  actions.closeInfo();
}
onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <aside class="info-pane" id="infoPane" :hidden="!state.infoOpen" aria-label="群信息">
    <div class="info-scroll" id="infoBody">
      <template v-if="group">
        <!-- 搜索群成员 -->
        <div class="info-search">
          <input
            v-model="state.infoQuery"
            type="search"
            placeholder="搜索群成员"
            autocomplete="off"
            aria-label="搜索群成员"
          />
          <button class="info-close" type="button" title="关闭" aria-label="关闭群信息" @click="actions.closeInfo()">
            <Icon :paths="['M6 6l12 12M18 6 6 18']" width="1.8" />
          </button>
        </div>

        <!-- 成员九宫格 -->
        <div class="info-grid">
          <button
            v-for="m in shownMembers"
            :key="m.id"
            class="info-member"
            type="button"
            :title="m.name || m.id"
            @click="openMember(m)"
            @contextmenu.prevent="memberMenu(m, $event)"
          >
            <Avatar :name="m.name || m.id" :seed="m.id" :avatar="m.avatar" />
            <span class="info-member-name">{{ m.name || m.id }}</span>
          </button>
          <button
            v-if="!state.infoQuery.trim()"
            class="info-member add"
            type="button"
            title="添加成员"
            @click="openPicker()"
          >
            <span class="info-add-box">+</span>
            <span class="info-member-name">添加</span>
          </button>
        </div>
        <div class="info-gap"></div>

        <!-- 群聊名称 -->
        <button class="info-row" type="button" @click="toggleEdit('name')">
          <div class="info-main">
            <div class="info-label">群聊名称</div>
            <div class="info-value">{{ group.name }}</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>
        <div v-if="state.infoEdit === 'name'" class="info-edit" ref="editBox">
          <input type="text" maxlength="40" :value="group.name" />
          <div class="info-edit-actions">
            <button class="btn-text primary mini ready" type="button" @click="saveName">保存</button>
            <button class="btn-text secondary mini" type="button" @click="cancelEdit">取消</button>
          </div>
        </div>

        <!-- 群公告 -->
        <button class="info-row" type="button" @click="toggleEdit('announcement')">
          <div class="info-main">
            <div class="info-label">群公告</div>
            <div class="info-value">{{ announcementPreview }}</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>
        <div v-if="state.infoEdit === 'announcement'" class="info-edit" ref="editBox">
          <textarea rows="5" placeholder="写点什么给全群看,每个 bot 都会读到" :value="announcement"></textarea>
          <div class="info-edit-actions">
            <button class="btn-text primary mini ready" type="button" @click="saveAnnouncement">保存</button>
            <button class="btn-text secondary mini" type="button" @click="cancelEdit">取消</button>
          </div>
        </div>

        <!-- 群置顶 -->
        <button class="info-row" type="button" @click="toggleEdit('pins')">
          <div class="info-main">
            <div class="info-label">群置顶</div>
            <div class="info-value">{{ pinsPreview }}</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>
        <div v-if="state.infoEdit === 'pins'" class="info-edit" ref="editBox">
          <div class="info-pin">
            <div v-if="!pins.length" class="info-value">还没有置顶</div>
            <div v-for="pin in pins" :key="pin.id" class="info-pin-row">
              <span class="info-pin-text">{{ pin.text }}</span>
              <button class="row-action danger" type="button" @click="removePinRow(pin.id)">取消</button>
            </div>
            <div class="sheet-form">
              <textarea class="sheet-input" rows="2" placeholder="比如:对外数字统一用 Q3 财报口径"></textarea>
              <div class="info-edit-actions">
                <button class="btn-text primary mini ready" type="button" @click="savePin">置顶</button>
                <button class="btn-text secondary mini" type="button" @click="cancelEdit">取消</button>
              </div>
            </div>
          </div>
        </div>

        <div class="info-gap"></div>

        <!-- 我在本群的昵称 -->
        <button class="info-row" type="button" @click="toggleEdit('nick')">
          <div class="info-main">
            <div class="info-label">我在本群的昵称</div>
            <div class="info-value">{{ state.nick || "未设置" }}</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>
        <div v-if="state.infoEdit === 'nick'" class="info-edit" ref="editBox">
          <input type="text" maxlength="20" :value="state.nick" />
          <div class="info-edit-actions">
            <button class="btn-text primary mini ready" type="button" @click="saveNick">保存</button>
            <button class="btn-text secondary mini" type="button" @click="cancelEdit">取消</button>
          </div>
        </div>

        <!-- 备注（仅自己可见） -->
        <button class="info-row" type="button" @click="toggleEdit('remark')">
          <div class="info-main">
            <div class="info-label">备注</div>
            <div class="info-value">{{ ui.remarkOf(state.groupId) || "仅自己可见" }}</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>
        <div v-if="state.infoEdit === 'remark'" class="info-edit" ref="editBox">
          <input type="text" maxlength="20" :value="ui.remarkOf(state.groupId)" />
          <div class="info-edit-actions">
            <button class="btn-text primary mini ready" type="button" @click="saveRemark">保存</button>
            <button class="btn-text secondary mini" type="button" @click="cancelEdit">取消</button>
          </div>
        </div>

        <!-- 查找聊天内容 -->
        <button class="info-row" type="button" @click="openMsgSearch">
          <div class="info-main">
            <div class="info-label">查找聊天内容</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>

        <div class="info-gap"></div>

        <!-- 开关 -->
        <button class="info-row" type="button" @click="toggleMute">
          <div class="info-main">
            <div class="info-label">消息免打扰</div>
          </div>
          <span class="switch" :class="{ on: ui.isMuted(state.groupId) }"></span>
        </button>
        <button class="info-row" type="button" @click="togglePinChat">
          <div class="info-main">
            <div class="info-label">置顶聊天</div>
          </div>
          <span class="switch" :class="{ on: state.pins.includes(state.groupId) }"></span>
        </button>
        <button class="info-row" type="button" @click="exportChat">
          <div class="info-main">
            <div class="info-label">导出聊天记录</div>
          </div>
          <span class="info-chevron"><Icon :paths="['m10 6 6 6-6 6']" width="1.8" /></span>
        </button>

        <div class="info-gap"></div>
        <div class="info-foot">
          <button type="button" @click="clearReads">清空本地已读记录</button>
        </div>
      </template>
    </div>
  </aside>
</template>
