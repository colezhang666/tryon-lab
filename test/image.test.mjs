import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createApp } from "../server.mjs";
import { generateImage } from "../image-generation.mjs";
const png = await readFile(new URL("./fixtures/image.png", import.meta.url));
function form() {
  const f = new FormData();
  f.set("data", new File([png], "person.png", { type: "image/png" }));
  f.set(
    "reference_image",
    new File([png], "garment.png", { type: "image/png" }),
  );
  return f;
}
async function server(t, options = {}) {
  const app = createApp({
    apiKey: "test-private-key",
    imageGenerate: async () => ({ bytes: png, mime: "image/png" }),
    ...options,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  return async (url, input = {}) => {
    let body, contentType;
    if (input.form) {
      const req = new Request("http://localhost", {
        method: "POST",
        body: input.form,
      });
      body = Buffer.from(await req.arrayBuffer());
      contentType = req.headers.get("content-type");
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${app.address().port}${url}`,
        {
          method: input.form ? "POST" : "GET",
          headers: {
            Host: "127.0.0.1:4180",
            Origin: input.origin || "http://127.0.0.1:4180",
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}
test("image upload uses real image validation; returns result without key; origin blocked", async (t) => {
  let supplied;
  const call = await server(t, {
    imageGenerate: async (f) => {
      supplied = f;
      return { bytes: png, mime: "image/png" };
    },
  });
  assert.equal((await call("/api/image-result")).status, 409);
  assert.equal(
    (
      await call("/api/image-job", {
        form: form(),
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/image-job", { form: form() })).status, 201);
  const state = await (await call("/api/image-job")).json();
  assert.equal(state.status, "completed");
  assert.equal(JSON.stringify(state).includes("test-private-key"), false);
  assert.equal(supplied.get("resolution"), "720p");
  assert.ok(supplied.get("prompt"));
  const result = await call("/api/image-result");
  assert.equal(result.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
});
test("concurrent requests rejected; timeout uncertainty prevents automatic charged retries", async (t) => {
  let reject;
  const call = await server(t, {
    inspectImage: async () => ({
      streams: [
        { codec_type: "video", codec_name: "png", width: 32, height: 32 },
      ],
    }),
    imageGenerate: () => new Promise((_, fail) => (reject = fail)),
  });
  const first = call("/api/image-job", { form: form() });
  for (let i = 0; i < 1000 && !reject; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(reject);
  assert.equal((await call("/api/image-job", { form: form() })).status, 409);
  assert.equal(
    (await (await call("/api/image-job")).json()).status,
    "generating",
  );
  reject(new Error("private supplier error"));
  assert.equal((await first).status, 502);
  const state = await (await call("/api/image-job")).json();
  assert.equal(state.status, "unknown");
  assert.equal(JSON.stringify(state).includes("private supplier"), false);
  assert.equal((await call("/api/image-job", { form: form() })).status, 409);
});
test("bad image, oversize dimensions, missing key and long prompt never call provider", async (t) => {
  let calls = 0;
  const call = await server(t, { imageGenerate: async () => calls++ });
  const bad = form();
  bad.set("data", new File(["broken"], "x.png", { type: "image/png" }));
  assert.equal((await call("/api/image-job", { form: bad })).status, 400);
  const long = form();
  long.set("prompt", "x".repeat(501));
  assert.equal((await call("/api/image-job", { form: long })).status, 400);
  const oversized = await server(t, {
    inspectImage: async () => ({
      streams: [
        { codec_type: "video", codec_name: "png", width: 5000, height: 5000 },
      ],
    }),
    imageGenerate: async () => calls++,
  });
  assert.equal(
    (await oversized("/api/image-job", { form: form() })).status,
    400,
  );
  const noKey = await server(t, { apiKey: "" });
  assert.equal((await noKey("/api/image-job", { form: form() })).status, 503);
  assert.equal(calls, 0);
});
test("a sixth image submission is rejected before the supplier is called", async (t) => {
  let calls = 0;
  const call = await server(t, {
    inspectImage: async () => ({
      streams: [
        { codec_type: "video", codec_name: "png", width: 32, height: 32 },
      ],
    }),
    imageGenerate: async () => {
      calls++;
      return { bytes: png, mime: "image/png" };
    },
  });
  for (let i = 0; i < 5; i++)
    assert.equal((await call("/api/image-job", { form: form() })).status, 201);
  assert.equal((await call("/api/image-job", { form: form() })).status, 429);
  assert.equal(calls, 5);
});

test("official image request uses correct fields, binary response and no blind retry", async () => {
  let request,
    calls = 0;
  const result = await generateImage(
    "backend-secret",
    form(),
    async (url, init) => {
      calls++;
      request = { url, init };
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    },
  );
  assert.equal(request.url, "https://api.decart.ai/v1/generate/lucy-image-2");
  assert.equal(request.init.headers["X-API-KEY"], "backend-secret");
  assert.deepEqual(result.bytes, png);
  assert.equal(calls, 1);
  await assert.rejects(
    generateImage("secret", form(), async () =>
      Response.json({ error: "not an image" }),
    ),
    /INVALID_IMAGE_RESPONSE/,
  );
  await assert.rejects(
    generateImage(
      "secret",
      form(),
      async () => new Response("", { status: 403 }),
    ),
    (error) => error.rejected === true,
  );
});
