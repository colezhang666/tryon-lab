import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const png = await readFile(new URL("./fixtures/image.png", import.meta.url));
await mkdir("work", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const errors = [],
  checks = [];
let posts = 0,
  current = "idle",
  finish;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/image-job", async (route) => {
  if (route.request().method() === "POST") {
    posts++;
    current = "generating";
    await new Promise((resolve) => (finish = resolve));
    current = "completed";
    await route.fulfill({ status: 201, json: { status: current } });
  } else await route.fulfill({ json: { status: current } });
});
await page.route("**/api/image-result", (route) =>
  route.fulfill({ contentType: "image/png", body: png }),
);
try {
  await page.goto("http://127.0.0.1:4180/#image");
  check(
    "一键换装入口存在，初次进入不生成",
    (await page.locator("#image-title").isVisible()) &&
      posts === 0 &&
      (await page.locator("#generate-image").isDisabled()),
  );
  for (const kind of ["person", "garment"])
    await page.locator(`#image-${kind}`).setInputFiles({
      name: `${kind}.png`,
      mimeType: "image/png",
      buffer: png,
    });
  await page.waitForFunction(
    () => document.getElementById("image-garment-preview").hidden === false,
  );
  check(
    "双图预览正常，未勾选费用确认不可生成",
    (await page.locator("#image-person-preview").isVisible()) &&
      (await page.locator("#generate-image").isDisabled()),
  );
  await page.locator("#image-person").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("broken"),
  });
  await page.waitForFunction(() =>
    document.getElementById("image-message").classList.contains("error"),
  );
  check(
    "坏图被拒绝，旧人物照片保留",
    (await page.locator("#image-person-name").textContent()).includes(
      "person.png",
    ),
  );
  await page.locator("#image-consent").check();
  await page.locator("#generate-image").click();
  for (let i = 0; i < 1000 && !finish; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  check(
    "生成中禁止重复点击，只有一个POST",
    posts === 1 && (await page.locator("#generate-image").isDisabled()),
  );
  finish();
  await page.waitForFunction(
    () => document.getElementById("image-result-preview").hidden === false,
  );
  check(
    "真实返回图解码后展示并允许下载",
    await page.locator("#download-image").isVisible(),
  );
  const pendingDownload = page.waitForEvent("download");
  await page.locator("#download-image").click();
  const downloaded = await pendingDownload;
  await downloaded.saveAs("work/image-test.png");
  check(
    "下载字节与接口返回一致",
    (await readFile("work/image-test.png")).equals(png),
  );
  await page.locator("[data-nav=settings]").click();
  await page.locator("[data-nav=image]").click();
  check(
    "切页回到图片模块仍能加载结果",
    (await page.locator("#load-image-result").isEnabled()) && posts === 1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "390px图片页无横向溢出",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "work/image-mobile-test.png", fullPage: true });
  check("无浏览器未捕获异常", errors.length === 0);
  await writeFile(
    "work/image-browser-results.json",
    JSON.stringify(
      { passed: checks.length, checks, errors, realGeneration: false },
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
