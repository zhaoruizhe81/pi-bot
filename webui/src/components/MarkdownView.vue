<script setup>
/* MarkdownView —— 旧 renderMarkdown 的结构化节点版渲染。
   数据来自 lib/markdown.js 的 renderMarkdownNodes(source)，只用 h() 构造
   vnode / 文本节点来渲染，绝不把原始 Markdown 塞进 v-html（防 XSS）。 */
import { computed, h } from "vue";
import { renderMarkdownNodes } from "../lib/markdown.js";

const props = defineProps({
  source: { type: String, default: "" },
});

const nodes = computed(() => renderMarkdownNodes(props.source));

/* 行内节点 → 文本或 vnode。旧版用 <br> 表示行内换行（"\n" 文本节点）。 */
function inlineNode(n) {
  if (!n) return null;
  if (n.type === "text") return n.value === "\n" ? h("br") : n.value;
  if (n.type === "strong") return h("strong", null, renderInline(n.children));
  if (n.type === "em") return h("em", null, renderInline(n.children));
  if (n.type === "code") return h("code", null, n.value);
  if (n.type === "a")
    return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, renderInline(n.children));
  if (n.type === "ul" || n.type === "ol") return blockNode(n);
  return null;
}

function renderInline(list) {
  return (list || []).map(inlineNode);
}

/* 块级节点 → vnode。 */
function blockNode(n) {
  if (!n) return null;
  switch (n.type) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return h(n.type, null, renderInline(n.children));
    case "p":
      return h("p", null, renderInline(n.children));
    case "blockquote":
      return h("blockquote", null, renderInline(n.children));
    case "pre":
      return h("pre", null, [h("code", null, n.text)]);
    case "hr":
      return h("hr");
    case "table":
      return h("table", null, [
        h("thead", null, [h("tr", null, (n.head || []).map((cell) => h("th", null, renderInline(cell))))]),
        h(
          "tbody",
          null,
          (n.rows || []).map((row) => h("tr", null, row.map((cell) => h("td", null, renderInline(cell)))))
        ),
      ]);
    case "ul":
    case "ol":
      return h(n.type, null, (n.items || []).map((item) => h("li", null, renderInline(item))));
    default:
      return null;
  }
}

/* 递归渲染：函数式组件，节点数组 → vnode 数组。 */
const Nodes = (p) => (p.nodes || []).map(blockNode);
</script>

<template>
  <div class="md"><Nodes :nodes="nodes" /></div>
</template>
