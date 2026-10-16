import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp, mintToken, MODEL } from "../server.mjs";

async function server(t, options = {}) {
  const app = createApp({ apiKey: "private-test-value", ...options });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${app.address().port}`;
  return (url, options = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        base + url,
        { ...options, headers: { Host: "127.0.0.1:4180", ...options.headers } },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve(
              new Response(text, {
                status: response.statusCode,
                headers: response.headers,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(options.body);
    });
}
const post = (duration) => ({
  method: "POST",
  headers: {
    Origin: "http://127.0.0.1:4180",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ duration }),
});

test("config never exposes a key, and private files are not served", async (t) => {
  const call = await server(t);
  const config = await (await call("/api/config")).json();
  assert.deepEqual(config, {
    configured: true,
    model: MODEL,
    durations: [10, 20, 30],
    creditsPerSecond: 2,
  });
  for (const file of [
    "/.env",
    "/server.mjs",
    "/src/provider.js",
    "/api/../.env",
    "/package.json",
  ])
    assert.equal((await call(file)).status, 404);
  assert.equal(
    (await call("/api/config", { headers: { Host: "attacker.test" } })).status,
    403,
  );
  assert.equal((await call("/")).headers.get("x-frame-options"), "DENY");
  assert.match(
    (await call("/")).headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});

test("source, media type and duration rejected before calling supplier", async (t) => {
  let calls = 0;
  const call = await server(t, {
    mint: async () => {
      calls++;
    },
  });
  for (const input of [
    {
      ...post(10),
      headers: { ...post(10).headers, Origin: "https://evil.test" },
    },
    { ...post(10), headers: { "Content-Type": "application/json" } },
  ])
    assert.equal((await call("/api/realtime-token", input)).status, 403);
  for (const duration of [0, 9, 60, "20", null])
    assert.equal(
      (await call("/api/realtime-token", post(duration))).status,
      400,
    );
  assert.equal(
    (await call("/api/realtime-token", { ...post(10), body: "{" })).status,
    400,
  );
  assert.equal(
    (await call("/api/realtime-token", { ...post(10), body: "x".repeat(1025) }))
      .status,
    413,
  );
  assert.equal(calls, 0);
});

test("one outstanding mint; correct constraints; cooldown and five-attempt ceiling", async (t) => {
  let time = 0,
    finish,
    passed;
  const call = await server(t, {
    now: () => time,
    mint: (options) => {
      passed = options;
      return new Promise((resolve) => (finish = resolve));
    },
  });
  const first = call("/api/realtime-token", post(20));
  await new Promise((resolve) => setImmediate(resolve));
  // Wait for the first request to reach the injected mint, without depending on network timing.
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await call("/api/realtime-token", post(20))).status, 409);
  finish({ apiKey: "short-test-token", expiresAt: "test" });
  assert.equal((await first).status, 200);
  assert.deepEqual(passed, {
    expiresIn: 10,
    allowedModels: [MODEL],
    allowedOrigins: ["http://127.0.0.1:4180"],
    constraints: { realtime: { maxSessionDuration: 20 } },
  });
  assert.equal((await call("/api/realtime-token", post(20))).status, 429);
  for (let i = 0; i < 4; i++) {
    time += 36000;
    finish = null;
    const request = call("/api/realtime-token", post(20));
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    finish({ apiKey: "short-test-token" });
    assert.equal((await request).status, 200);
  }
  time += 36000;
  assert.equal((await call("/api/realtime-token", post(20))).status, 429);
});

test("missing key and provider errors are safe; failed calls also consume a reservation", async (t) => {
  const noKey = await server(t, { apiKey: "" });
  assert.equal((await noKey("/api/realtime-token", post(10))).status, 503);
  const call = await server(t, {
    mint: async () => {
      throw new Error("private-test-value");
    },
  });
  const failed = await call("/api/realtime-token", post(10));
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes("private-test-value"), false);
  assert.equal((await call("/api/realtime-token", post(10))).status, 429);
});

test("provider adapter uses native documented endpoint, abort signal and fails closed on constraints", async () => {
  const options = {
    allowedModels: [MODEL],
    allowedOrigins: ["http://127.0.0.1:4180"],
    constraints: { realtime: { maxSessionDuration: 10 } },
  };
  let request;
  const fetcher = async (url, init) => {
    request = { url, init };
    return Response.json({
      apiKey: "short-token",
      permissions: {
        models: options.allowedModels,
        origins: options.allowedOrigins,
      },
      constraints: options.constraints,
    });
  };
  assert.equal(
    (await mintToken("secret", options, fetcher)).apiKey,
    "short-token",
  );
  assert.equal(request.url, "https://api.decart.ai/v1/client/tokens");
  assert.equal(request.init.headers["X-API-KEY"], "secret");
  assert.ok(request.init.signal instanceof AbortSignal);
  await assert.rejects(
    mintToken("secret", options, async () =>
      Response.json({ apiKey: "short-token" }),
    ),
    /TOKEN_CONSTRAINTS/,
  );
  await assert.rejects(
    mintToken("secret", options, async () =>
      Response.json({ apiKey: "secret" }),
    ),
    /INVALID_TOKEN/,
  );
  await assert.rejects(
    mintToken("secret", options, async () => new Response("", { status: 403 })),
    /TOKEN_REJECTED/,
  );
});
