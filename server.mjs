import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createVideoHandler } from "./video-jobs.mjs";
import { createImageHandler } from "./image-generation.mjs";
import { createLedger } from "./billing.mjs";

export const MODEL = "lucy-vton-3.5";
export const DURATIONS = [10, 20, 30];
export const PORT = 4180;
const root = fileURLToPath(new URL("./dist/", import.meta.url));
const staticFiles = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

export async function mintToken(apiKey, options, fetcher = fetch) {
  // Matches the official SDK tokens.create endpoint, with an abortable local timeout.
  const response = await fetcher("https://api.decart.ai/v1/client/tokens", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error("TOKEN_REJECTED");
  const result = await response.json();
  if (
    typeof result.apiKey !== "string" ||
    !result.apiKey ||
    result.apiKey === apiKey
  )
    throw new Error("INVALID_TOKEN");
  // Fail closed if the provider did not echo the requested restrictions.
  if (
    result.constraints?.realtime?.maxSessionDuration !==
      options.constraints.realtime.maxSessionDuration ||
    JSON.stringify(result.permissions?.models) !==
      JSON.stringify(options.allowedModels) ||
    JSON.stringify(result.permissions?.origins) !==
      JSON.stringify(options.allowedOrigins)
  )
    throw new Error("TOKEN_CONSTRAINTS");
  return { apiKey: result.apiKey, expiresAt: result.expiresAt };
}

export function createApp({
  apiKey = "",
  mint = (options) => mintToken(apiKey, options),
  now = Date.now,
  videoProvider,
  inspectVideo,
  imageGenerate,
  inspectImage,
  ledger = null,
  port = PORT,
  desktopSession = "",
} = {}) {
  const imageHandler = createImageHandler({
    apiKey,
    generate: imageGenerate,
    inspect: inspectImage,
    ledger,
  });
  const videoHandler = createVideoHandler({
    apiKey,
    provider: videoProvider,
    inspect: inspectVideo,
    now,
    ledger,
  });
  let busy = false,
    issued = 0,
    nextAllowed = 0;
  return http.createServer(async (request, response) => {
    const boundPort = port || request.socket.localPort;
    const origins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
    const hosts = origins.map((origin) => new URL(origin).host);
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const send = (status, body) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(body));
    };
    if (!hosts.includes(request.headers.host))
      return send(403, { error: "只允许本机访问。" });
    if (desktopSession) {
      const cookie = request.headers.cookie?.split(";").map((item) => item.trim())
        .find((item) => item.startsWith("tryon_session="))?.slice(14) || "";
      const supplied = Buffer.from(cookie), expected = Buffer.from(desktopSession);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return send(403, { error: "请从桌面应用进入工作台。" });
    }
    if (request.url === "/api/billing" && request.method === "GET") {
      try {
        return send(
          200,
          ledger?.read() ?? {
            snapshot: null,
            records: [],
            automaticOfficialSync: false,
          },
        );
      } catch {
        return send(503, {
          error: "账单数据库暂时无法读取，请保留data目录并检查本机服务。",
        });
      }
    }
    if (
      ["/api/billing/snapshot", "/api/billing/realtime"].includes(request.url)
    ) {
      if (request.method !== "POST")
        return send(405, { error: "需要POST请求。" });
      if (
        !origins.includes(request.headers.origin) ||
        new URL(request.headers.origin).host !== request.headers.host
      )
        return send(403, { error: "账单写入只允许本机网页。" });
      if (!ledger) return send(503, { error: "账单数据库未启用。" });
      if (request.headers["content-type"]?.split(";")[0] !== "application/json")
        return send(400, { error: "需要JSON参数。" });
      try {
        let text = "";
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 2048) return send(413, { error: "账单参数过大。" });
        }
        const input = JSON.parse(text);
        if (request.url.endsWith("snapshot")) ledger.snapshot(input);
        else ledger.reportRealtime(input);
        return send(200, { saved: true });
      } catch {
        return send(400, {
          error: "账单数据无效，请检查非负积分、模型小计或实时秒数。",
        });
      }
    }
    if (["/api/image-job", "/api/image-result"].includes(request.url)) {
      if (
        request.method === "POST" &&
        (!origins.includes(request.headers.origin) ||
          new URL(request.headers.origin).host !== request.headers.host)
      )
        return send(403, { error: "图片生成必须来自本机网页。" });
      return imageHandler(request, response, send);
    }
    if (["/api/video-job", "/api/video-result"].includes(request.url)) {
      if (
        request.method === "POST" &&
        (!origins.includes(request.headers.origin) ||
          new URL(request.headers.origin).host !== request.headers.host)
      )
        return send(403, { error: "视频提交必须来自本机网页。" });
      return videoHandler(request, response, send);
    }
    if (request.url === "/api/config" && request.method === "GET")
      return send(200, {
        configured: Boolean(apiKey),
        model: MODEL,
        durations: DURATIONS,
        creditsPerSecond: 2,
      });
    if (request.url === "/api/realtime-token") {
      if (request.method !== "POST")
        return send(405, { error: "请求方式不支持。" });
      if (
        !origins.includes(request.headers.origin) ||
        new URL(request.headers.origin).host !== request.headers.host
      )
        return send(403, { error: "连接请求必须来自本机网页。" });
      if (request.headers["content-type"]?.split(";")[0] !== "application/json")
        return send(400, { error: "需要 JSON 参数。" });
      let body = "";
      try {
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 1024) return send(413, { error: "请求过大。" });
        }
        const input = JSON.parse(body);
        if (
          !input ||
          Object.keys(input).length !== 1 ||
          !DURATIONS.includes(input.duration)
        )
          return send(400, { error: "请选择 10、20 或 30 秒。" });
        if (!apiKey)
          return send(503, { error: "后端尚未配置密钥，请查看接入说明。" });
        if (busy) return send(409, { error: "正在创建连接凭证，请稍后。" });
        if (issued >= 5)
          return send(429, {
            error: "本次后端启动最多尝试签发 5 次；确认平台用量后再重启。",
          });
        if (now() < nextAllowed)
          return send(429, {
            error: `请在 ${Math.ceil((nextAllowed - now()) / 1000)} 秒后重试。`,
          });
        busy = true;
        issued++;
        // The short credential remains dialable for 10s, then the session has its own time cap.
        nextAllowed = now() + (10 + input.duration + 5) * 1000;
        try {
          const token = await mint({
            expiresIn: 10,
            allowedModels: [MODEL],
            allowedOrigins: [request.headers.origin],
            constraints: { realtime: { maxSessionDuration: input.duration } },
          });
          const billId = ledger?.start({
            kind: "realtime",
            cap: input.duration,
            note: "仅签发连接凭证，尚未确认是否生成；不据此计为已扣费。",
          });
          return send(200, {
            apiKey: token.apiKey,
            expiresAt: token.expiresAt,
            ...(billId ? { billId } : {}),
          });
        } catch (error) {
          return send(error.name === "TimeoutError" ? 504 : 502, {
            error:
              error.message === "TOKEN_CONSTRAINTS"
                ? "平台未返回所需会话约束，已停止连接。"
                : "无法创建凭证，请核对密钥、账号权限、网络与官方平台状态。",
          });
        } finally {
          busy = false;
        }
      } catch {
        return send(400, { error: "请求参数无效。" });
      }
    }
    const file = staticFiles.get(request.url);
    if (!file || request.method !== "GET")
      return send(404, { error: "页面不存在。" });
    try {
      const content = await readFile(path.join(root, file[0]));
      response.writeHead(200, {
        "Content-Type": `${file[1]}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(self), microphone=()",
      });
      response.end(content);
    } catch {
      send(503, { error: "请先运行 npm run build。" });
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  createApp({
    apiKey: process.env.DECART_API_KEY?.trim(),
    ledger: createLedger(
      process.env.BILLING_DB_PATH ||
        fileURLToPath(new URL("./data/billing.sqlite", import.meta.url)),
    ),
  }).listen(PORT, "127.0.0.1", () =>
    console.log(
      `TryOn Lab: http://127.0.0.1:${PORT} · 密钥${process.env.DECART_API_KEY ? "已配置" : "未配置"}`,
    ),
  );
}
