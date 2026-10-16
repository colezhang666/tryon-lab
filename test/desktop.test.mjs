import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createKeyStore, validateKey, checkKey } from "../desktop/key-store.mjs";
import { createApp } from "../server.mjs";

test("desktop package includes every local backend module dependency", async () => {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const shipped = new Set(pkg.build.files);
  for (const file of shipped) {
    if (!/\.[cm]?js$/.test(file) || file.includes("*")) continue;
    const text = await readFile(new URL(file, root), "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*\(|require\s*\()["'](\.{1,2}\/[^"']+)["']/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(shipped.has(dependency), `${file} imports unshipped module ${dependency}`);
    }
  }
});

test("desktop key store starts empty, encrypts, replaces and deletes without touching ledger", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tryon-key-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  };
  const store = createKeyStore(directory, encryption);
  assert.equal(await store.read(), "");
  await writeFile(path.join(directory, "billing.sqlite"), "fixture-ledger");
  await store.save("synthetic-desktop-key-123");
  assert.equal(await store.read(), "synthetic-desktop-key-123");
  assert.equal((await readFile(path.join(directory, "api-key.bin"))).includes(Buffer.from("synthetic-desktop-key-123")), false);
  await store.save("another-synthetic-key-456");
  assert.equal(await store.read(), "another-synthetic-key-456");
  await store.clear();
  assert.equal(await store.read(), "");
  assert.equal(await readFile(path.join(directory, "billing.sqlite"), "utf8"), "fixture-ledger");
});

test("invalid key, unavailable encryption and corrupted ciphertext fail closed", async (t) => {
  for (const key of [null, "", "short", "this key contains spaces", "a".repeat(513), "key-with\nembedded-newline"])
    assert.throws(() => validateKey(key));
  const directory = await mkdtemp(path.join(os.tmpdir(), "tryon-key-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailable = createKeyStore(directory, { isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.save("synthetic-desktop-key"), /加密不可用/);
  await writeFile(path.join(directory, "api-key.bin"), "corrupted");
  await assert.rejects(unavailable.read(), /加密不可用/);
  const corrupted = createKeyStore(directory, { isEncryptionAvailable: () => true, decryptString: () => { throw new Error("corrupted"); } });
  await assert.rejects(corrupted.read(), /corrupted/);
});

test("key verification uses only token endpoint; unsafe replies and secret errors are not returned", async () => {
  const input = "synthetic-desktop-key";
  assert.equal(await checkKey(input, async (url, options) => {
    assert.equal(url, "https://api.decart.ai/v1/client/tokens");
    assert.equal(options.headers["X-API-KEY"], input);
    assert.deepEqual(JSON.parse(options.body), { expiresIn: 10, allowedModels: ["lucy-vton-3.5"] });
    assert.ok(options.signal);
    return Response.json({ apiKey: "synthetic-short-token" });
  }), input);
  for (const result of [{ apiKey: input }, {}, { apiKey: 1 }])
    await assert.rejects(checkKey(input, async () => Response.json(result)), /有效的临时凭证/);
  await assert.rejects(checkKey(input, async () => Response.json({}, { status: 401 })), /没有接受/);
  await assert.rejects(checkKey(input, async () => { throw new Error(input); }), (error) => !error.message.includes(input));
});

test("desktop backend accepts only the app session on its random port; web mode stays compatible", async (t) => {
  const app = createApp({ apiKey: "synthetic-key-not-public", port: 0, desktopSession: "a".repeat(64) });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const url of ["/", "/api/config", "/api/billing"])
    assert.equal((await fetch(base + url)).status, 403);
  assert.equal((await fetch(base + "/api/config", { headers: { Cookie: "tryon_session=incorrect" } })).status, 403);
  const cookie = { Cookie: `tryon_session=${"a".repeat(64)}` };
  const config = await (await fetch(base + "/api/config", { headers: cookie })).json();
  assert.equal(config.configured, true);
  assert.equal(JSON.stringify(config).includes("synthetic-key-not-public"), false);
  const billing = await (await fetch(base + "/api/billing", { headers: cookie })).json();
  assert.deepEqual(billing.records, []);
  assert.equal(billing.snapshot, null);
  assert.equal((await fetch(base + "/api/realtime-token", {
    method: "POST", headers: { ...cookie, Origin: "https://evil.test", "Content-Type": "application/json" },
    body: JSON.stringify({ duration: 10 }),
  })).status, 403);
});
