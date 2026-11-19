// Seeds a demo database over HTTP so the web UI can be judged against real content.
const base = process.env.BASE ?? "http://127.0.0.1:18860";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path, init) => {
  const res = await fetch(base + path, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
};
const post = (path, body) =>
  json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const ME = { type: "human", id: "u1", name: "我" };
const LIN = { type: "human", id: "u2", name: "小林" };
const ZHE = { type: "human", id: "u3", name: "阿哲" };

const groups = (await json("/api/groups")).groups;
const main = groups[0];
const mk = async (name) => (await post("/api/groups", { name })).group;

const ops = groups.find((g) => g.name.includes("运营")) ?? (await mk("运营增长群"));
const care = groups.find((g) => g.name.includes("客服")) ?? (await mk("客服值班群"));

const script = [
  [main, ME, "早上好,今天把 Q3 财报收个尾"],
  [main, LIN, "财务那边的底稿我拿到了,口径是合并抵消后、未审计"],
  [main, LIN, "收入 12,480 万,同比 +18.6%,环比 +7.2%"],
  [main, ZHE, "不错啊,利润呢?"],
  [main, LIN, "净利 920 万,同比 +21.1%。毛利率 41.3%,比 Q2 高 0.8 个点"],
  [main, ME, "那就按这个数出,给老板汇报用。模板走设计那边"],
  [main, ZHE, "收到,我先拉一版图表"],
  [main, ME, "另外提醒一下,别在群里发过程稿,发成品就行"],
  [ops, ME, "运营群这边,双十一的素材什么时候能出?"],
  [ops, ZHE, "预售页今天下午,主图明天上午"],
  [ops, LIN, "投放预算我按渠道拆好了,稍后同步"],
  [ops, ME, "好,先按 8 个点 ROI 算"],
  [care, ME, "客服群今天人手够吗"],
  [care, ZHE, "够,两个人值班,晚高峰我再盯一会儿"],
  [care, LIN, "工单系统刚才有 3 分钟抖动,现在已经恢复"],
];

// Backdate history across a few days so the UI shows real time separators.
const now = Date.now();
const stamp = (index) => {
  if (index < 4) return now - 4 * 86_400_000 + (index - 3) * 40_000;   // 4 天前 22:00 左右
  if (index < 8) return now - 86_400_000 - 36_000_000 + index * 30_000; // 昨天 13:00 左右
  if (index < 12) return now - 6 * 3_600_000 + (index - 8) * 45_000;   // 今天早上
  return now - 3 * 3_600_000 + (index - 12) * 20_000;                  // 3 小时前
};

for (const [index, [group, author, text]] of script.entries()) {
  await post(`/api/groups/${group.id}/send`, { text, author, at: stamp(index) });
  await sleep(60);
}

// Plan A: let it finish so the UI has delivered cards with real content.
await post(`/api/groups/${main.id}/requirements`, { text: "出 Q3 季度财报:拉数据、做图、写结论、套模板" });
const items = async () => (await json(`/api/groups/${main.id}/items?limit=100`)).items;
for (let i = 0; i < 240; i += 1) {
  const evs = (await items()).filter((e) => e.kind === "work.event").map((e) => e.data.ev);
  if (evs.filter((ev) => ev === "delivered").length >= 1) break;
  await sleep(1000);
}

// Plan B: leave it mid-flight for the UI to show running cards.
await post(`/api/groups/${main.id}/requirements`, { text: "再做一版给投资人看的一页纸摘要" });

// Plan C: cancel its first dispatched item immediately, so a cancelled card exists.
await post(`/api/groups/${main.id}/requirements`, { text: "整理一版客服值班周报" });
let cancelled = false;
for (let i = 0; i < 90 && !cancelled; i += 1) {
  const finished = new Set(
    (await items())
      .filter((e) => ["delivered", "done", "failed", "cancelled"].includes(e.data?.ev))
      .map((e) => e.data.workId),
  );
  const live = (await items()).filter(
    (e) => e.kind === "work.event" && ["assigned", "started"].includes(e.data.ev) && !finished.has(e.data.workId),
  );
  if (live.length) {
    const result = await post(`/api/groups/${main.id}/work/${encodeURIComponent(live[live.length - 1].data.workId)}/cancel`, {});
    if (result.status === "marked") {
      for (let j = 0; j < 20; j += 1) {
        const evs = (await items()).map((e) => e.data?.ev);
        if (evs.includes("cancelled")) { cancelled = true; break; }
        await sleep(400);
      }
    }
    if (!cancelled) await sleep(800);
  } else {
    await sleep(500);
  }
}
console.log("seeded:", [main.name, ops.name, care.name].join(" / "), "cancelled:", cancelled);
