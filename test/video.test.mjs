import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { validateVideo, probe, videoProvider } from "../video-jobs.mjs";
import { clipDuration } from "../src/video-validation.js";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const metadata = (duration) => ({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 320,
      height: 180,
      duration,
    },
  ],
  format: { duration, format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
});
test("positive arbitrary durations <=20, including 5 and fractional seconds, are accepted", () => {
  for (const seconds of [0.1, 1, 5, 7.5, 19.99, 20]) {
    assert.equal(clipDuration(seconds), seconds);
    assert.equal(validateVideo(metadata(seconds)), seconds);
  }
  for (const seconds of [0, -1, 20.001, 30, NaN, Infinity])
    assert.throws(() => validateVideo(metadata(seconds)));
  assert.throws(() =>
    validateVideo({
      ...metadata(5),
      format: { duration: 21, format_name: "mp4" },
    }),
  );
  assert.throws(() =>
    validateVideo({
      ...metadata(5),
      format: { duration: 5, format_name: "matroska" },
    }),
  );
});

test("ffprobe measures actual 5s, 7.5s, 20s files and rejects 20.1s before generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tryon-fixture-"));
  const execute = promisify(execFile);
  const files = [];
  try {
    for (const seconds of [5, 7.5, 20, 20.1]) {
      const target = join(directory, `clip-${seconds}.mp4`);
      files.push(target);
      await execute(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=320x180:r=10",
          "-t",
          String(seconds),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-y",
          target,
        ],
        { windowsHide: true },
      );
      const inspected = await probe(
        new File([await readFile(target)], "clip.mp4", { type: "video/mp4" }),
      );
      if (seconds > 20) assert.throws(() => validateVideo(inspected));
      else assert.equal(validateVideo(inspected), seconds);
    }
  } finally {
    // Only explicit files created by this test, never a recursive computed deletion.
    for (const target of files) await rm(target, { force: true });
    await rmdir(directory);
  }
});

async function testServer(t, overrides = {}) {
  let calls = 0;
  const app = createApp({
    apiKey: "test-key",
    videoProvider: {
      submit: async () => {
        calls++;
        return { job_id: "job-test", status: "pending" };
      },
      status: async () => ({ status: "completed" }),
      result: async () =>
        new Response("video-result", {
          headers: { "Content-Type": "video/mp4" },
        }),
      ...overrides.provider,
    },
    inspectVideo: async (file) =>
      file.name === "person.mp4"
        ? metadata(overrides.seconds ?? 5)
        : {
            streams: [
              { codec_type: "video", codec_name: "png", width: 16, height: 16 },
            ],
          },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  // Native HTTP allows a controlled Host for an ephemeral test port.
  const { request } = await import("node:http");
  const call = async (url, init = {}) => {
    const form = init.form;
    let body, contentType;
    if (form) {
      const request = new Request("http://localhost", {
        method: "POST",
        body: form,
      });
      contentType = request.headers.get("content-type");
      body = Buffer.from(await request.arrayBuffer());
    }
    return new Promise((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${app.address().port}${url}`,
        {
          method: form ? "POST" : "GET",
          headers: {
            Host: "127.0.0.1:4180",
            Origin: init.origin || "http://127.0.0.1:4180",
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (data) => chunks.push(data));
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
  return { call, calls: () => calls };
}
function form() {
  const form = new FormData();
  form.set(
    "data",
    new File(["video-fixture"], "person.mp4", { type: "video/mp4" }),
  );
  form.set(
    "reference_image",
    new File(["image-fixture"], "garment.png", { type: "image/png" }),
  );
  return form;
}
test("valid 5s job is submitted once; can poll and fetch MP4; foreign origin rejected", async (t) => {
  const { call, calls } = await testServer(t);
  assert.equal(
    (
      await call("/api/video-job", {
        form: form(),
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(calls(), 0);
  assert.equal((await call("/api/video-job", { form: form() })).status, 201);
  assert.equal((await call("/api/video-job", { form: form() })).status, 409);
  const status = await (await call("/api/video-job")).json();
  assert.equal(status.status, "completed");
  assert.equal(status.duration, 5);
  assert.equal(await (await call("/api/video-result")).text(), "video-result");
  assert.equal(calls(), 1);
});
test("over-20s metadata never reaches supplier; ambiguous submit blocks charged retries", async (t) => {
  const invalid = await testServer(t, { seconds: 20.1 });
  assert.equal(
    (await invalid.call("/api/video-job", { form: form() })).status,
    400,
  );
  assert.equal(invalid.calls(), 0);
  const unknown = await testServer(t, {
    provider: {
      submit: async () => {
        throw new Error("secret details");
      },
    },
  });
  const failed = await unknown.call("/api/video-job", { form: form() });
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes("secret details"), false);
  assert.equal(
    (await unknown.call("/api/video-job", { form: form() })).status,
    409,
  );
});
test("video provider uses documented job endpoints with server-only key and no retries", async () => {
  const requests = [];
  const provider = videoProvider("server-key", async (url, init) => {
    requests.push({ url, init });
    return Response.json({ job_id: "job-safe", status: "pending" });
  });
  await provider.submit(form());
  await provider.status("job-safe");
  await provider.result("job-safe");
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.decart.ai/v1/jobs/lucy-vton-3.5",
      "https://api.decart.ai/v1/jobs/job-safe",
      "https://api.decart.ai/v1/jobs/job-safe/content",
    ],
  );
  assert.equal(requests[0].init.headers["X-API-KEY"], "server-key");
});
