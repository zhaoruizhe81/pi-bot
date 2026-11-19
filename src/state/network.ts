// Where the server listens, and whether this machine is on a tailnet. Both are read from
// the real system: `os.networkInterfaces()` and the `tailscale` CLI. Nothing is simulated.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";

export const HOST_CHOICES = ["127.0.0.1", "0.0.0.0"];

export const isHostChoice = (value) => HOST_CHOICES.includes(String(value));

/** Non-internal IPv4 addresses, so the panel can print a URL a phone can actually open. */
export function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      out.push({ iface: name, address: entry.address });
    }
  }
  return out;
}

/** The macOS app ships the CLI inside the bundle; Linux installs put it on PATH. */
const CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

let cachedBin;
export function tailscaleBin() {
  if (cachedBin !== undefined) return cachedBin;
  cachedBin = null;
  for (const candidate of CANDIDATES) {
    if (!candidate.includes("/")) {
      cachedBin = candidate; // resolved through PATH by execFile
      break;
    }
    if (existsSync(candidate)) {
      cachedBin = candidate;
      break;
    }
  }
  return cachedBin;
}

const run = (args, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const bin = tailscaleBin();
    if (!bin) {
      resolve({ ok: false, missing: true, error: "没有装 Tailscale(或不在 PATH / 应用目录里)" });
      return;
    }
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          error: String(error.message || error),
          timedOut: error.killed === true || error.signal === "SIGTERM",
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/**
 * `tailscale status --json` is the only reliable way to know whether this host is on a
 * tailnet. Reported as-is: not installed / not running / ready with its ts.net name.
 */
export async function tailscaleStatus() {
  const version = await run(["version"]);
  if (!version.ok) {
    return {
      installed: false,
      running: false,
      detail: "没有装 Tailscale(或不在 PATH 里)",
      hint: "安装后 `tailscale up` 登录,再点「重新检查」",
    };
  }
  const status = await run(["status", "--json"]);
  if (!status.ok) {
    return {
      installed: true,
      running: false,
      detail: "Tailscale 已安装但没有运行 / 未登录",
      hint: "先 `tailscale up` 登录,再点「重新检查」",
      version: version.stdout.trim().split("\n")[0],
    };
  }
  try {
    const parsed = JSON.parse(status.stdout);
    const self = parsed.Self ?? {};
    const dnsName = String(self.DNSName ?? "").replace(/\.$/, "");
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [];
    const state = String(parsed.BackendState ?? "");
    const certDomains = Array.isArray(self.CertDomains) ? self.CertDomains.map(String) : [];
    const ready = state === "Running" && Boolean(dnsName || ips.length);
    return {
      installed: true,
      running: state === "Running",
      ready,
      backendState: state,
      dnsName,
      ips,
      certDomains,
      httpsReady: certDomains.length > 0,
      version: version.stdout.trim().split("\n")[0],
      detail: ready ? `已在 ${dnsName || ips[0]} 就绪` : `Tailscale 状态:${state || "未知"}`,
      hint: ready ? `在手机上打开 http://${ips[0] ?? dnsName}:<端口>,或做 tailscale serve` : "先 `tailscale up` 登录",
    };
  } catch (error) {
    return { installed: true, running: false, detail: `解析 tailscale status 失败:${String(error?.message ?? error)}` };
  }
}

/** Current `tailscale serve` config, reduced to what the panel needs. */
export async function serveStatus() {
  const status = await run(["serve", "status", "--json"], 5000);
  if (!status.ok) return { enabled: false, config: {}, detail: status.missing ? "没有 tailscale CLI" : status.error };
  let parsed = {};
  try {
    parsed = JSON.parse(status.stdout || "{}");
  } catch {
    return { enabled: false, config: {}, detail: "解析 serve status 失败" };
  }
  const web = parsed.Web ?? {};
  const entries = [];
  for (const [hostPort, value] of Object.entries(web)) {
    const handlers = value?.Handlers ?? {};
    const proxy = Object.values(handlers)[0]?.Proxy ?? "";
    const isHttps = hostPort.endsWith(":443");
    entries.push({
      url: `${isHttps ? "https" : "http"}://${hostPort}/`,
      proxy,
      mode: isHttps ? "https" : "http",
    });
  }
  return { enabled: entries.length > 0, entries, config: parsed };
}

/** Serve the local port over the tailnet. HTTPS needs certificates for the tailnet. */
export async function enableServe(port) {
  const status = await tailscaleStatus();
  if (!status.installed) return { ok: false, detail: "没有装 Tailscale" };
  if (!status.ready) return { ok: false, detail: status.detail || "Tailscale 未就绪" };

  const httpsReady = Boolean(status.httpsReady);
  const args = httpsReady
    ? ["serve", "--bg", "--yes", String(port)]
    : ["serve", "--bg", "--yes", `--http=${port}`, `http://127.0.0.1:${port}`];
  const result = await run(args, 20000);
  const after = await serveStatus();
  if (!result.ok) {
    const reason = result.timedOut
      ? `命令 20 秒没有返回,已放弃(${result.stderr || result.stdout || "无输出"})`
      : String(result.stderr || result.stdout || result.error);
    return { ok: false, detail: reason.slice(0, 400), https: httpsReady, serve: after };
  }
  return {
    ok: true,
    https: httpsReady,
    mode: httpsReady ? "https" : "http",
    detail: (result.stdout || "").trim().slice(0, 400),
    serve: after,
  };
}

/**
 * Turn our serve mapping off. `reset` is used only when the whole config is ours —
 * a foreign serve setup is never wiped by a button in this UI.
 */
export async function disableServe(port) {
  const current = await serveStatus();
  if (!current.enabled) return { ok: true, detail: "本来就没有开启", serve: current };
  const ours = (current.entries ?? []).every((entry) =>
    [":443", `:${port}`].some((suffix) => entry.url.includes(`.ts.net${suffix}/`)) &&
    entry.proxy.replace(/\/+$/, "").endsWith(`:${port}`),
  );
  if (!ours) {
    return {
      ok: false,
      detail: "当前 tailnet 上还有别的 serve 配置,不在这个按钮里替你清掉;请用 tailscale serve reset 手动处理",
      serve: current,
    };
  }
  const result = await run(["serve", "reset"], 10000);
  const after = await serveStatus();
  return {
    ok: result.ok,
    detail: result.ok ? "已关闭 tailnet 访问" : String(result.stderr || result.error).slice(0, 400),
    serve: after,
  };
}
