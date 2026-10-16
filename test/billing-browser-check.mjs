import { createRequire } from "node:module";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
await mkdir("work", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const errors = [],
  checks = [];
let saves = 0;
const data = {
  snapshot: {
    spent: 30,
    balance: 970,
    imageSpent: 2,
    videoSpent: 28,
    checkedAt: "2025-01-01T00:00:00Z",
  },
  records: [
    {
      id: "fixture",
      createdAt: "2025-01-01T00:00:00Z",
      kind: "image",
      model: "lucy-image-2",
      status: "completed",
      units: 1,
      estimatedCredits: 2,
      origin: "historical_log",
      note: "test only",
    },
  ],
};
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/billing", (r) => r.fulfill({ json: data }));
await page.route("**/api/billing/snapshot", async (r) => {
  saves++;
  Object.assign(data.snapshot, r.request().postDataJSON(), {
    checkedAt: new Date().toISOString(),
  });
  await r.fulfill({ json: { saved: true } });
});
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};
try {
  await page.goto("http://127.0.0.1:4180/#billing");
  await page.waitForFunction(
    () => document.getElementById("official-spent").textContent === "30",
  );
  check(
    "平台实际积分及余额与本地估算分开显示",
    (await page.locator("#official-balance").textContent()) === "970" &&
      (await page.locator("#local-estimate").textContent()).includes("估算"),
  );
  check(
    "逐笔实际金额不会伪装为预估积分",
    (await page
      .locator("#billing-records")
      .getByText("待平台逐笔核对")
      .count()) === 1,
  );
  await page.locator("#refresh-billing").click();
  check("只读刷新不会写入核对值", saves === 0);
  await page.locator("#open-reconcile").click();
  await page.locator("#reconcile-spent").fill("-1");
  await page.locator("#save-reconcile").click();
  check("负积分被原生表单拦住", saves === 0);
  await page.locator("#reconcile-spent").fill("50");
  await page.locator("#reconcile-balance").fill("950");
  await page.locator("#reconcile-image").fill("6");
  await page.locator("#save-reconcile").click();
  await page.waitForFunction(
    () => document.getElementById("official-spent").textContent === "50",
  );
  check("有效核对值写入后更新显示", saves === 1);
  const download = page.waitForEvent("download");
  await page.locator("#export-billing").click();
  const file = await download;
  await file.saveAs("work/billing-test.json");
  check(
    "导出包含核对值与记录来源",
    JSON.parse(await readFile("work/billing-test.json", "utf8")).snapshot
      .spent === 50,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "390px账单表在自身容器横向滚动，无整页溢出",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "work/billing-mobile-test.png",
    fullPage: true,
  });
  check("无浏览器未捕获异常", errors.length === 0);
  await writeFile(
    "work/billing-browser-results.json",
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
