/* musebot · 网络层（从旧 bot/web/app.js 的 fetch 帮助函数移植）。
   约定：所有请求 cache: "no-store"；非 2xx 抛 Error(errText)。 */

export function errText(data, status) {
  if (data && data.error) return String(data.error);
  return "HTTP " + status;
}

export function readJsonSafe(res) {
  return res.json().catch(() => null);
}

/** GET JSON（读接口）。 */
export async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(errText(data, res.status));
  return data;
}

/** POST JSON（写接口）。body 为 undefined 时不带 body。 */
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(errText(data, res.status));
  return data;
}

/** 群上下文的 PUT / DELETE 写接口，契约与 postJson 相同。 */
export async function apiWrite(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await readJsonSafe(res);
  if (!res.ok) throw new Error(errText(data, res.status));
  return data;
}

/** 读取 File 为 dataURL（头像裁剪用）。 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 读取 File 为 base64（不含 data: 前缀，上传路由直接收）。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
