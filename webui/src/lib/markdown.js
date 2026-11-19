/* musebot · Markdown 渲染（旧 renderMarkdown 的「可渲染节点数组」版）。
   旧版直接拼 DOM/CSS；Vue 版返回结构化节点，由 MarkdownView.vue 渲染，
   绝不把原文塞进 v-html，避免 XSS。

   节点形状：
     块级: {type:"h1".."h6"|"p"|"blockquote", children:[inline...]}
           {type:"pre", lang, text}
           {type:"table", head:[ [inline...] ], rows:[[ [inline...] ]]}
           {type:"ul"|"ol", items:[ node[] ]}   // 每项是行内节点数组
           {type:"hr"}
     行内: {type:"text", value}
           {type:"strong"|"em", children:[inline...]}
           {type:"code", value}
           {type:"a", href, children:[inline...]}
   安全：链接 href 仅保留 http(s)/mailto/相对/锚点，其余降级为纯文本。 */

const MD_INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function inlineNodes(text) {
  const out = [];
  const parts = String(text).split(MD_INLINE);
  for (const part of parts) {
    if (!part) continue;
    let m;
    if ((m = /^\*\*([\s\S]+)\*\*$/.exec(part))) {
      out.push({ type: "strong", children: inlineNodes(m[1]) });
    } else if ((m = /^`([\s\S]+)`$/.exec(part))) {
      out.push({ type: "code", value: m[1] });
    } else if ((m = /^\*([^*\n]+)\*$/.exec(part))) {
      out.push({ type: "em", children: inlineNodes(m[1]) });
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part))) {
      const href = /^(https?:|mailto:|\/|#)/i.test(m[2]) ? m[2] : "";
      if (href) out.push({ type: "a", href, children: inlineNodes(m[1]) });
      else out.push({ type: "text", value: m[1] });
    } else {
      out.push({ type: "text", value: part });
    }
  }
  return out;
}

const mdCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** 极简 CommonMark：标题 / 粗斜体 / 行内码 / 链接 / 代码块 / 表格 / 引用 / 有序无序列表(一层缩进) / 分隔线。 */
export function renderMarkdownNodes(source) {
  const nodes = [];
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para = null;
  const breakPara = () => {
    para = null;
  };
  const paragraph = () => {
    if (!para) {
      para = { type: "p", children: [] };
      nodes.push(para);
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
      nodes.push({ type: "pre", lang: fence[1] || "", text: body.join("\n") });
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
      nodes.push({ type: "h" + heading[1].length, children: inlineNodes(heading[2]) });
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      breakPara();
      nodes.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/\|/.test(line) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1])) {
      breakPara();
      const head = mdCells(line).map((cell) => inlineNodes(cell));
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(mdCells(lines[i]).map((cell) => inlineNodes(cell)));
        i += 1;
      }
      nodes.push({ type: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      breakPara();
      const children = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        if (children.length) children.push({ type: "text", value: "\n" });
        for (const n of inlineNodes(lines[i].replace(/^\s*>\s?/, ""))) children.push(n);
        i += 1;
      }
      nodes.push({ type: "blockquote", children });
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      breakPara();
      const ordered = /\d/.test(bullet[2]);
      const baseIndent = bullet[1].length;
      const top = { type: ordered ? "ol" : "ul", items: [] };
      const stack = [{ list: top, indent: baseIndent }];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const depth = m[1].length;
        if (depth > stack[stack.length - 1].indent) {
          const nested = { type: /\d/.test(m[2]) ? "ol" : "ul", items: [] };
          const cur = stack[stack.length - 1].list;
          const lastItem = cur.items[cur.items.length - 1];
          if (lastItem) lastItem.push(nested);
          else cur.items.push([nested]);
          stack.push({ list: nested, indent: depth });
        } else {
          while (stack.length > 1 && depth < stack[stack.length - 1].indent) stack.pop();
        }
        stack[stack.length - 1].list.items.push(inlineNodes(m[3]));
        i += 1;
      }
      nodes.push(top);
      continue;
    }

    const p = paragraph();
    if (p.children.length) p.children.push({ type: "text", value: "\n" });
    for (const n of inlineNodes(line.trim())) p.children.push(n);
    i += 1;
  }
  return nodes;
}

/** 兼容旧调用名：返回相同节点数组（Vue 版不再返回 DOM）。 */
export const renderMarkdown = renderMarkdownNodes;
