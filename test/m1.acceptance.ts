// M1 acceptance: the group is never blocked while bots work.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createMusebot } from "../src/app.ts";

const app = await createMusebot({ storageFile: ":memory:", workDelayMs: 400, retryMs: 300 }, ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [group] = await app.listGroups();

const t0 = Date.now();
await app.requirement(group.id, "出季度财报");
const firstMs = Date.now() - t0;

await sleep(60);

const t1 = Date.now();
await app.send(group.id, { text: "我先说一句,不阻塞" });
await app.requirement(group.id, "再来一份营销分析");
const secondMs = Date.now() - t1;

const deadline = Date.now() + 30000;
let cards = [];
let delivered = 0;
let done = 0;
while (Date.now() < deadline) {
  const items = await app.readItems(group.id);
  cards = items.filter((i) => i.kind === "work.event").map((i) => i.data);
  delivered = cards.filter((c) => c.ev === "delivered").length;
  done = cards.filter((c) => c.ev === "done").length;
  if (delivered >= 8) break;
  await sleep(100);
}

const chat = (await app.readItems(group.id)).filter((i) => i.kind === "chat.message").length;
console.log("first submit ms :", firstMs);
console.log("second submit ms:", secondMs);
console.log("delivered       :", delivered);
console.log("done            :", done);
console.log("chat entries    :", chat);
console.log("cards           :", cards.map((c) => c.ev).join(", "));

await app.close();

if (firstMs > 2000 || secondMs > 2000) throw new Error("submit was blocked");
if (delivered < 8) throw new Error(`expected 8 delivered cards, got ${delivered}`);
console.log("M1 ACCEPTANCE OK");
