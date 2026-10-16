import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const profile = await mkdtemp(path.join(os.tmpdir(), "tryon-desktop-check-"));
const env = { ...process.env, DECART_API_KEY: "synthetic-inherited-key-must-be-ignored" };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.TRYON_DESKTOP_EXECUTABLE;
const options = { env, timeout: 30000,
  args: [...(executablePath ? ["-r", path.join(root, "node_modules/playwright-core/lib/server/electron/loader.js")] : [root]), `--user-data-dir=${profile}`,
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  ...(executablePath ? { executablePath } : {}),
};
let application;
let count = 0;
const checked = (value, description) => { assert.ok(value, description); count++; };
const screenshotDirectory = path.join(root, "work", "desktop-check");
await mkdir(screenshotDirectory, { recursive: true });
try {
  application = await electron.launch(options);
  let page = await application.firstWindow();
  await page.locator("#api-key").waitFor();
  const userData = await application.evaluate(({ app }) => app.getPath("userData"));
  checked(path.resolve(userData) === path.resolve(profile), "test profile is isolated");
  checked(await page.locator("#api-key").inputValue() === "", "first key field is blank");
  checked(await page.locator("#enter-workbench").isHidden(), "no inherited key");
  checked(await page.evaluate(() => typeof window.require === "undefined"), "renderer cannot access Node");
  checked((await page.evaluate(() => window.tryonDesktop.status())).configured === false, "clean first boot");
  await page.screenshot({ path: path.join(screenshotDirectory, "first-launch.png") });

  await application.evaluate(async ({ shell }) => {
    globalThis.openedOfficial = [];
    shell.openExternal = async (url) => { globalThis.openedOfficial.push(url); };
  });
  await page.getByRole("button", { name: "打开官网" }).click();
  await page.getByRole("button", { name: "创建 Key" }).click();
  checked((await application.evaluate(() => globalThis.openedOfficial)).join(",") ===
    "https://platform.decart.ai,https://platform.decart.ai/api-keys", "official links target real signup and key pages");
  checked(!(await page.evaluate(() => window.tryonDesktop.openOfficial("https://evil.test"))).ok, "arbitrary links rejected");

  await page.locator("#api-key").fill("short");
  await page.getByRole("button", { name: "保存并进入工作台" }).click();
  await page.getByText("请粘贴完整的 API Key", { exact: false }).waitFor();
  checked(await page.locator("#api-key").inputValue() === "", "input cleared after submitting");
  await application.evaluate(() => { globalThis.fetch = async () => Response.json({}, { status: 401 }); });
  await page.locator("#api-key").fill("synthetic-desktop-key-123");
  await page.getByRole("button", { name: "保存并进入工作台" }).click();
  await page.getByText("平台没有接受这个 Key", { exact: false }).waitFor();
  checked((await page.evaluate(() => window.tryonDesktop.status())).configured === false, "rejected key not saved");
  const syntheticImage = await readFile(path.join(root, "test", "fixtures", "image.png"));
  await application.evaluate((_, encoded) => {
    const bytes = Buffer.from(encoded, "base64");
    globalThis.fetch = async (url) => {
      if (url.includes("/v1/generate/")) return new Response(bytes, { headers: { "Content-Type": "image/png" } });
      if (url.includes("/v1/jobs/")) return Response.json({ job_id: "synthetic-desktop-video-job", status: "pending" });
      return Response.json({ apiKey: "synthetic-short-token" });
    };
  }, syntheticImage.toString("base64"));
  await page.locator("#api-key").fill("synthetic-desktop-key-123");
  await page.getByRole("button", { name: "保存并进入工作台" }).click();
  await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\/#studio/);
  const url = new URL(page.url());
  checked(url.port !== "4180", "desktop does not use developer demo port");
  const data = await page.evaluate(async () => ({
    config: await (await fetch("/api/config")).json(),
    billing: await (await fetch("/api/billing")).json(),
    denied: await window.tryonDesktop.status(),
  }));
  checked(data.config.configured && !JSON.stringify(data.config).includes("synthetic-desktop-key"), "config exposes no permanent key");
  checked(data.billing.records.length === 0 && data.billing.snapshot === null, "desktop ledger has no developer data");
  checked(!data.denied.ok, "workbench cannot invoke configuration IPC");
  checked((await fetch(`${url.origin}/api/config`)).status === 403, "other browsers cannot access desktop backend");
  const bytes = await readFile(path.join(profile, "api-key.bin"));
  checked(!bytes.includes(Buffer.from("synthetic-desktop-key-123")), "Windows encrypted key has no plaintext secret");
  await page.screenshot({ path: path.join(screenshotDirectory, "workbench.png") });
  // Real ffprobe is tested with synthetic media; no paid supplier calls are made.
  const probe = await application.evaluate(async () => {
    const { execFileSync } = process.getBuiltinModule("child_process");
    return execFileSync(process.env.FFPROBE_PATH, ["-version"], { encoding: "utf8", windowsHide: true }).split("\n")[0];
  });
  checked(probe.includes("ffprobe version"), "bundled ffprobe executes");
  await page.locator("#open-camera").click();
  try { await page.waitForFunction(() => document.getElementById("input-video").videoWidth > 0, { timeout: 10000 }); }
  catch (error) { console.log(await page.locator("#session-message").textContent()); throw error; }
  checked(await page.locator("#close-camera").isEnabled(), "desktop camera permission permits video preview");
  await page.locator("#close-camera").click();
  checked(await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop()); return false;
    } catch { return true; }
  }), "microphone access is denied");
  await page.locator('[data-nav="image"]').click();
  await page.locator("#image-person").setInputFiles(path.join(root, "test", "fixtures", "image.png"));
  await page.locator("#image-garment").setInputFiles(path.join(root, "test", "fixtures", "image.png"));
  await page.locator("#image-consent").check();
  await page.locator("#generate-image").click();
  await page.locator("#download-image").waitFor({ state: "visible" });
  checked(await page.locator("#download-image").isVisible(), "packaged image validation and mocked generation work");
  const syntheticVideoPath = path.join(profile, "synthetic-video.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", syntheticVideoPath], { windowsHide: true });
  const videoReply = await page.evaluate(async ({ video, image }) => {
    const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("data", new Blob([bytes(video)], { type: "video/mp4" }), "synthetic.mp4");
    form.append("reference_image", new Blob([bytes(image)], { type: "image/png" }), "synthetic.png");
    form.append("prompt", "Replace the top with the reference garment.");
    const response = await fetch("/api/video-job", { method: "POST", body: form });
    return { status: response.status, body: await response.json() };
  }, { video: (await readFile(syntheticVideoPath)).toString("base64"), image: syntheticImage.toString("base64") });
  checked(videoReply.status === 201, `bundled ffprobe validates MP4 and video submits to mocked supplier: ${JSON.stringify(videoReply)}`);

  await application.close(); application = null;
  application = await electron.launch(options);
  page = await application.firstWindow();
  await page.waitForURL(/#studio/);
  checked((await page.evaluate(async () => (await (await fetch("/api/config")).json()).configured)), "saved key decrypts on restart");
  await application.evaluate(async ({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.locator('[data-nav="settings"]').click();
  checked(!(await page.locator("#key-configuration-help").textContent()).includes(".env"), "desktop help uses app configuration, not source file edits");
  await page.locator("#desktop-key-settings").click();
  await page.locator("#api-key").waitFor();
  checked(await page.locator("#api-key").inputValue() === "", "settings never refill permanent key into renderer");
  await page.getByRole("button", { name: "删除已保存的 Key" }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByText("已删除，请填写你自己的新 Key。").waitFor();
  checked((await page.evaluate(() => window.tryonDesktop.status())).configured === false, "key deletion works");
  await application.close(); application = null;
  application = await electron.launch(options);
  page = await application.firstWindow();
  await page.locator("#api-key").waitFor();
  checked(await page.locator("#enter-workbench").isHidden(), "deleted key stays deleted on restart");
  console.log(JSON.stringify({ checks: count, passed: true, packaged: Boolean(executablePath), paidCalls: 0 }));
} finally {
  await application?.close();
  await rm(profile, { recursive: true, force: true });
}
