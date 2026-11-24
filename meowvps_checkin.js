const BASE_URL = (process.env.MEOWVPS_BASE_URL || "https://meowvps.com").replace(/\/$/, "");
const LOGIN_PATH = process.env.MEOWVPS_LOGIN_PATH || "/auth/login";
const CHECKIN_PATH = process.env.MEOWVPS_CHECKIN_PATH || "/auth/account/checkin";
const FETCH_TIMEOUT_MS = Number(process.env.MEOWVPS_TIMEOUT_MS || 20000);
const SCRIPT_NAME = "MeowVPS 每日签到";

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.slice(0, 300) };
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

async function request(path, { method = "GET", body, jar = new Map() } = {}) {
  const url = new URL(path, `${BASE_URL}/`);
  if (url.origin !== new URL(BASE_URL).origin) {
    throw new Error("配置的接口路径必须属于 MeowVPS 站点。");
  }

  const headers = {
    Accept: "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/account/`,
  };
  if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  mergeCookies(jar, response.headers);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      const redirectUrl = new URL(location, url);
      if (redirectUrl.origin !== url.origin) throw new Error("站点返回了非预期的跨域跳转。");
      return request(`${redirectUrl.pathname}${redirectUrl.search}`, { jar });
    }
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok || data.error || data.ok === false || data.success === false) {
    const detail = data.error || data.code || data.message || `HTTP ${response.status}`;
    throw new Error(String(detail).slice(0, 300));
  }
  return data;
}

async function sendBark(status, summary) {
  const key = process.env.BARK;
  if (!key) {
    console.log("未设置 BARK，跳过通知推送。");
    return;
  }

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_key: key,
      title: `${SCRIPT_NAME}：${status}`,
      body: summary.slice(0, 1000),
      group: "MeowVPS",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bark 推送失败（HTTP ${response.status}）。`);
}

async function main() {
  let status = "失败";
  let summary;
  try {
    const username = process.env.MEOWVPS_USERNAME;
    const password = process.env.MEOWVPS_PASSWORD;
    if (!username || !password) {
      throw new Error("缺少环境变量 MEOWVPS_USERNAME 或 MEOWVPS_PASSWORD。");
    }
    if (typeof fetch !== "function" || typeof AbortSignal.timeout !== "function") {
      throw new Error("当前 Node.js 运行时不支持 fetch/AbortSignal.timeout，请升级到 Node.js 18 或更高版本。");
    }

    const jar = new Map();
    await request(LOGIN_PATH, {
      method: "POST",
      body: { username, password },
      jar,
    });
    const result = await request(CHECKIN_PATH, { method: "POST", body: {}, jar });
    const details = [result.message, result.summary, result.reward ? `奖励：${result.reward}` : ""]
      .filter((value) => typeof value === "string" && value.trim())
      .join("；");
    status = "成功";
    summary = details || "签到请求已完成。";
    console.log(`${SCRIPT_NAME}成功：${summary}`);
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    console.error(`${SCRIPT_NAME}失败：${summary}`);
  }

  try {
    await sendBark(status, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${SCRIPT_NAME}：${message}`);
    if (status === "成功") process.exitCode = 1;
  }

  if (status === "失败") process.exitCode = 1;
}

main();
