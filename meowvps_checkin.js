const { setTimeout: delay } = require("node:timers/promises");
const { setGlobalProxyFromEnv } = require("node:http");
const { spawnSync } = require("node:child_process");

const BASE_URL = (process.env.MEOWVPS_BASE_URL || "https://meowvps.com").replace(/\/$/, "");
const LOGIN_PATH = process.env.MEOWVPS_LOGIN_PATH || "/auth/login/local";
const CHECKIN_PATH = process.env.MEOWVPS_CHECKIN_PATH || "/auth/account/checkin";
const FETCH_TIMEOUT_MS = Number(process.env.MEOWVPS_TIMEOUT_MS || 20000);
const SCRIPT_NAME = "MeowVPS 每日签到";

function configureProxy() {
  const hasProxy = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
  ].some((name) => process.env[name]);
  if (!hasProxy || process.env.NODE_USE_ENV_PROXY === "1") return;

  if (typeof setGlobalProxyFromEnv === "function") {
    setGlobalProxyFromEnv();
    console.log("已启用 HTTP_PROXY / HTTPS_PROXY 环境代理。");
    return;
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  const supportsStartupProxy = (major === 22 && minor >= 21) || major >= 24;
  if (!supportsStartupProxy) {
    throw new Error("当前 Node.js 版本无法使用环境代理。请升级到 22.21+ 或 24+，或在启动 Node 前设置 NODE_USE_ENV_PROXY=1。");
  }

  const child = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    stdio: "inherit",
  });
  if (child.error) throw new Error(`无法使用环境代理重启签到脚本：${child.error.message}`);
  process.exit(child.status ?? 1);
}

function networkCodes(error) {
  if (!error) return [];
  return [
    error.code,
    ...networkCodes(error.cause),
    ...(error.errors || []).flatMap(networkCodes),
  ].filter((code) => typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code));
}

function networkError(step, hostname, error) {
  const codes = [...new Set(networkCodes(error))].join(", ");
  const detail = error.name === "TimeoutError"
    ? `请求超过 ${FETCH_TIMEOUT_MS} 毫秒`
    : codes || "连接失败（无底层错误码）";
  return new Error(`${step}无法访问 ${hostname}：${detail}`);
}

async function fetchWithTimeout(step, url, options, retryReset = false) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (!retryReset || attempt > 1 || !networkCodes(error).includes("ECONNRESET")) {
        throw networkError(step, url.hostname, error);
      }
      console.warn(`${step}连接被重置（ECONNRESET），1 秒后重试一次。`);
      await delay(1000);
    }
  }
}

function setCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? cookie.split(/, (?=[^;,]+=)/) : [];
}

function mergeCookies(jar, headers) {
  for (const value of setCookies(headers)) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const content = pair.slice(separator + 1).trim();
    if (!content || /max-age=0/i.test(value) || /expires=Thu, 01 Jan 1970/i.test(value)) {
      jar.delete(name);
    } else {
      jar.set(name, content);
    }
  }
}

function accountUrl(path) {
  const url = new URL(path, `${BASE_URL}/`);
  if (url.origin !== new URL(BASE_URL).origin) {
    throw new Error("配置的接口路径必须属于 MeowVPS 站点。");
  }
  return url;
}

const ACCOUNT_HEADERS = {
  Accept: "application/json",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/account/`,
};

async function request(step, path, body, jar, retryReset = false) {
  const url = accountUrl(path);
  const headers = { ...ACCOUNT_HEADERS, "Content-Type": "application/json" };
  if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const response = await fetchWithTimeout(step, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, retryReset);

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${step}接口返回意外跳转（HTTP ${response.status}）`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw networkError(step, url.hostname, error);
  }
  if (!response.ok || data?.error || data?.ok === false || data?.success === false) {
    const code = data?.error || data?.code;
    const detail = typeof code === "string" && /^[a-z_]{1,80}$/i.test(code) ? `，${code}` : "";
    throw new Error(`${step}接口报错（HTTP ${response.status}${detail}）`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${step}接口返回了意外内容（HTTP ${response.status}）`);
  }
  mergeCookies(jar, response.headers);
  return data;
}

async function diagnose() {
  console.log(`Node.js ${process.version}`);
  const probes = [
    { step: "账户探测", path: "/auth/me", method: "GET", expectedStatus: 200 },
    { step: "登录探测", path: LOGIN_PATH, method: "POST", body: "{}", expectedStatus: 401 },
  ];
  for (const { step, path, method, body, expectedStatus } of probes) {
    try {
      const url = accountUrl(path);
      const headers = body ? { ...ACCOUNT_HEADERS, "Content-Type": "application/json" } : ACCOUNT_HEADERS;
      const response = await fetchWithTimeout(step, url, { method, headers, body });
      console.log(`${step} ${url.hostname}${url.pathname} 返回 HTTP ${response.status}`);
      if (response.status !== expectedStatus) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

async function sendBark(status, summary) {
  const key = process.env.BARK;
  if (!key) {
    console.log("未设置 BARK，跳过通知推送。");
    return;
  }

  const response = await fetchWithTimeout("Bark 通知", new URL("https://api.day.app/push"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_key: key,
      title: `${SCRIPT_NAME}：${status}`,
      body: summary.slice(0, 1000),
      group: "MeowVPS",
    }),
  });
  if (!response.ok) throw new Error(`Bark 推送失败（HTTP ${response.status}）。`);
}

async function main() {
  const diagnostic = process.argv.includes("--diagnose");
  let status = "失败";
  let summary;
  try {
    if (typeof fetch !== "function" || typeof AbortSignal.timeout !== "function") {
      throw new Error("当前 Node.js 运行时不支持 fetch/AbortSignal.timeout，请升级到 Node.js 18 或更高版本。");
    }
    if (!Number.isInteger(FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS < 1 || FETCH_TIMEOUT_MS > 4294967295) {
      throw new Error("MEOWVPS_TIMEOUT_MS 必须是 1 到 4294967295 之间的整数。");
    }
    configureProxy();
    if (diagnostic) return await diagnose();

    const username = process.env.MEOWVPS_USERNAME;
    const password = process.env.MEOWVPS_PASSWORD;
    if (!username || !password) {
      throw new Error("缺少环境变量 MEOWVPS_USERNAME 或 MEOWVPS_PASSWORD。");
    }

    const jar = new Map();
    await request("登录", LOGIN_PATH, { username, password }, jar, true);
    if (!jar.size) throw new Error("登录接口没有返回会话 Cookie。");

    const result = await request("签到", CHECKIN_PATH, {}, jar);
    if (result.awarded === true) {
      status = "成功";
      const amount = Number(result.amount);
      summary = amount > 0 ? `签到数 +1，额外获得 ${amount} 猫币。` : "签到数 +1。";
    } else if (result.checkedIn === true) {
      status = "今日已签到";
      summary = "站点显示今日已完成签到。";
    } else {
      throw new Error("签到接口未确认今日签到状态。");
    }
    console.log(`${SCRIPT_NAME}：${status}，${summary}`);
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    console.error(`${SCRIPT_NAME}失败：${summary}`);
    process.exitCode = 1;
    if (diagnostic) return;
  }

  try {
    await sendBark(status, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${SCRIPT_NAME}：${message}`);
    process.exitCode = 1;
  }
}

main();
