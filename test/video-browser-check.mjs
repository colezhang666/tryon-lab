import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
await mkdir("work", { recursive: true });
for (const seconds of [5, 7.5, 20, 20.1])
  await promisify(execFile)(
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
      `work/clip-${seconds}.mp4`,
    ],
    { windowsHide: true },
  );
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
let submitted = false,
  posts = 0;
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/video-job", async (route) => {
  if (route.request().method() === "POST") {
    posts++;
    submitted = true;
    await route.fulfill({
      status: 201,
      json: { status: "pending", duration: 5 },
    });
  } else
    await route.fulfill({
      json: { status: submitted ? "completed" : "idle", duration: 5 },
    });
});
await page.route("**/api/video-result", async (route) =>
  route.fulfill({
    contentType: "video/mp4",
    body: await readFile("work/clip-5.mp4"),
  }),
);
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};
try {
  await page.goto("http://127.0.0.1:4180/#video");
  check(
    "视频页面存在，默认不提交生成",
    (await page.locator("#video-title").isVisible()) && posts === 0,
  );
  for (const seconds of [5, 7.5, 20]) {
    await page
      .locator("#video-source")
      .setInputFiles(`work/clip-${seconds}.mp4`);
    await page.waitForFunction(
      (seconds) =>
        document
          .getElementById("video-file-info")
          .textContent.includes(seconds.toFixed(2) + " 秒"),
      seconds,
    );
    check(
      `${seconds} 秒可正常选择`,
      (await page.locator("#video-cost").textContent()) ===
        `$${(seconds * 0.04).toFixed(2)}`,
    );
  }
  await page.locator("#video-source").setInputFiles("work/clip-20.1.mp4");
  await page.waitForFunction(() =>
    document.getElementById("video-message").textContent.includes("不超过 20"),
  );
  check(
    "20.1 秒拒绝，保留上一有效视频",
    (await page.locator("#video-file-info").textContent()).includes(
      "20.00 秒",
    ) && posts === 0,
  );
  await page.locator("#video-source").setInputFiles("work/clip-5.mp4");
  await page.waitForFunction(() =>
    document.getElementById("video-file-info").textContent.includes("5.00 秒"),
  );
  const png = Buffer.from(
    (
      await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = c.height = 16;
        return c.toDataURL();
      })
    ).split(",")[1],
    "base64",
  );
  await page
    .locator("#video-garment")
    .setInputFiles({ name: "garment.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(
    () =>
      document.getElementById("video-image-info").textContent === "garment.png",
  );
  check(
    "未确认上传费用时禁止提交",
    await page.locator("#submit-video").isDisabled(),
  );
  await page.locator("#video-consent").check();
  await page.locator("#submit-video").click();
  await page.waitForFunction(
    () => document.getElementById("video-job-state").textContent === "排队中",
  );
  check(
    "一次提交且排队期间锁定重复提交",
    posts === 1 && (await page.locator("#submit-video").isDisabled()),
  );
  await page.locator("#refresh-video-job").click();
  await page.waitForFunction(
    () => document.getElementById("video-job-state").textContent === "已完成",
  );
  await page.locator("#load-video-result").click();
  await page.waitForFunction(
    () => !document.getElementById("generated-video").hidden,
  );
  check(
    "完成后可加载返回的 MP4",
    await page.locator("#download-video").isVisible(),
  );
  const download = page.waitForEvent("download");
  await page.locator("#download-video").click();
  const result = await download;
  await result.saveAs("work/video-result-test.mp4");
  check(
    "下载文件与测试端返回字节一致",
    (await readFile("work/video-result-test.mp4")).equals(
      await readFile("work/clip-5.mp4"),
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "390px 视频页无横向溢出",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "work/video-mobile-test.png", fullPage: true });
  check("没有浏览器未捕获异常", errors.length === 0);
  await writeFile(
    "work/video-browser-results.json",
    JSON.stringify(
      { passed: checks.length, checks, realGeneration: false, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, errors, realGeneration: false }),
  );
} finally {
  await browser.close();
}
