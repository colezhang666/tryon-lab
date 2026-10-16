import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createLedger } from "../billing.mjs";
import { createApp } from "../server.mjs";
const png = await readFile(new URL("./fixtures/image.png", import.meta.url));

test("ledger persists; official snapshots stay distinct from per-call estimates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tryon-ledger-"));
  const file = join(directory, "billing.sqlite");
  let ledger = createLedger(file);
  try {
    const id = ledger.start({ kind: "video", units: 5 });
    ledger.update(id, { status: "completed" });
    ledger.snapshot({ spent: 30, balance: 970, imageSpent: 2, videoSpent: 28 });
    ledger.close();
    ledger = createLedger(file);
    const data = ledger.read();
    assert.equal(data.snapshot.spent, 30);
    assert.equal(data.snapshot.balance, 970);
    assert.equal(data.automaticOfficialSync, false);
    assert.equal(data.records[0].usdMicros, 200000);
    assert.equal(data.records[0].estimatedCredits, 20);
    assert.equal("actualCredits" in data.records[0], false);
    const later = ledger.start({ kind: "image", units: 1 });
    ledger.update(later, { status: "completed" });
    assert.equal(
      ledger.read().snapshot.balance,
      970,
      "Do not subtract local estimates from an official balance snapshot",
    );
  } finally {
    ledger.close();
    for (const suffix of ["", "-wal", "-shm"])
      await rm(file + suffix, { force: true });
    await rmdir(directory);
  }
});
test("snapshot rejects negative numbers and inconsistent totals", () => {
  const ledger = createLedger();
  try {
    for (const input of [
      { spent: -1, balance: 10 },
      { spent: NaN, balance: 10 },
      { spent: 1, balance: Infinity },
      { spent: 4, balance: 10, imageSpent: 3, videoSpent: 3 },
    ])
      assert.throws(() => ledger.snapshot(input));
    assert.equal(ledger.read().snapshot, null);
  } finally {
    ledger.close();
  }
});
test("token issuance is not charged use; realtime reports are bounded and monotonic", () => {
  const ledger = createLedger();
  try {
    const id = ledger.start({ kind: "realtime", cap: 10 });
    let row = ledger.read().records[0];
    assert.equal(row.units, null);
    assert.equal(row.estimatedCredits, null);
    ledger.reportRealtime({ id, seconds: 3, status: "running" });
    ledger.reportRealtime({ id, seconds: 2, status: "running" });
    ledger.reportRealtime({ id, seconds: null, status: "ended" });
    row = ledger.read().records[0];
    assert.equal(row.units, 3);
    assert.equal(row.status, "ended");
    assert.equal(row.estimatedCredits, 6);
    assert.throws(() =>
      ledger.reportRealtime({ id, seconds: 11, status: "running" }),
    );
    assert.throws(() =>
      ledger.reportRealtime({ id: "missing", seconds: 1, status: "running" }),
    );
  } finally {
    ledger.close();
  }
});

async function setup(t, options = {}) {
  const ledger = createLedger();
  const app = createApp({
    apiKey: "test-key",
    ledger,
    inspectImage: async () => ({
      streams: [
        { codec_type: "video", codec_name: "png", width: 32, height: 32 },
      ],
    }),
    imageGenerate: async () => ({ mime: "image/png", bytes: png }),
    ...options,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(() => {
          ledger.close();
          resolve();
        });
      }),
  );
  const call = async (
    url,
    { form, json, origin = "http://127.0.0.1:4180" } = {},
  ) => {
    let body, contentType;
    if (form) {
      const req = new Request("http://localhost", {
        method: "POST",
        body: form,
      });
      body = Buffer.from(await req.arrayBuffer());
      contentType = req.headers.get("content-type");
    }
    if (json) {
      body = Buffer.from(JSON.stringify(json));
      contentType = "application/json";
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${app.address().port}${url}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Host: "127.0.0.1:4180",
            Origin: origin,
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
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
  return { ledger, call };
}
function imageForm() {
  const form = new FormData();
  form.set("data", new File([png], "person.png", { type: "image/png" }));
  form.set(
    "reference_image",
    new File([png], "garment.png", { type: "image/png" }),
  );
  return form;
}
test("image generation is logged once; downloading and refreshing do not add charges", async (t) => {
  const { ledger, call } = await setup(t);
  assert.equal(
    (await call("/api/image-job", { form: imageForm() })).status,
    201,
  );
  await call("/api/image-result");
  await call("/api/image-result");
  await call("/api/billing");
  assert.equal(ledger.read().records.length, 1);
  assert.equal(ledger.read().records[0].status, "completed");
  assert.equal(ledger.read().records[0].estimatedCredits, 2);
  assert.equal((await call("/data/billing.sqlite")).status, 404);
});
test("unconfirmed failure remains visible instead of becoming a zero-cost success", async (t) => {
  const { ledger, call } = await setup(t, {
    imageGenerate: async () => {
      throw new Error("secret vendor context");
    },
  });
  assert.equal(
    (await call("/api/image-job", { form: imageForm() })).status,
    502,
  );
  const row = ledger.read().records[0];
  assert.equal(row.status, "unknown");
  assert.equal(row.estimatedCredits, 2);
  assert.equal(JSON.stringify(row).includes("secret vendor"), false);
});
test("video is recorded once from submit through completion and downloads", async (t) => {
  const { ledger, call } = await setup(t, {
    videoProvider: {
      submit: async () => ({ job_id: "test-job", status: "pending" }),
      status: async () => ({ status: "completed" }),
      result: async () => new Response("test-result"),
    },
    inspectVideo: async (file) =>
      file.name === "person.mp4"
        ? {
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                width: 320,
                height: 180,
                duration: "5",
              },
            ],
            format: { duration: "5", format_name: "mp4" },
          }
        : {
            streams: [
              { codec_type: "video", codec_name: "png", width: 32, height: 32 },
            ],
          },
  });
  const form = new FormData();
  form.set("data", new File(["video"], "person.mp4", { type: "video/mp4" }));
  form.set(
    "reference_image",
    new File([png], "image.png", { type: "image/png" }),
  );
  assert.equal((await call("/api/video-job", { form })).status, 201);
  await call("/api/video-job");
  await call("/api/video-result");
  const records = ledger.read().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "completed");
  assert.equal(records[0].estimatedCredits, 20);
  assert.equal(records[0].providerId, "test-job");
});

test("bill writes require same origin; invalid SDK seconds cannot change stored usage", async (t) => {
  const { ledger, call } = await setup(t);
  assert.equal(
    (
      await call("/api/billing/snapshot", {
        origin: "https://evil.test",
        json: { spent: 30, balance: 970 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/billing/snapshot", {
        json: { spent: 30, balance: 970, imageSpent: 2, videoSpent: 28 },
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/api/billing/snapshot", { json: { spent: -1, balance: 970 } }))
      .status,
    400,
  );
  const id = ledger.start({ kind: "realtime", cap: 10 });
  assert.equal(
    (
      await call("/api/billing/realtime", {
        json: { id, seconds: 11, status: "ended" },
      })
    ).status,
    400,
  );
  assert.equal(ledger.read().records[0].units, null);
});
