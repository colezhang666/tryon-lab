import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";

// Test-only provider replacement; never included by build.mjs or served by the local backend.
const runtime = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = createRequire(import.meta.url)(runtime);
await mkdir("work/browser", { recursive: true });
const out = path.resolve("work/browser");
const mockProvider = `export const cameraConstraints={video:true,audio:false};
export async function connect(input,options){
  if(window.testMode==='pending') await new Promise(r=>window.resolveConnection=r);
  if(window.testMode==='failure') throw new Error('simulated supplier failure');
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#b74635';ctx.fillRect(0,0,640,480);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText('REMOTE TEST STREAM',100,240);
  const remote=canvas.captureStream(12);window.lastRemote=remote;window.mockDisconnected=false;
  const tick=setInterval(()=>ctx.fillRect(10,10,2,2),80);
  const rt={on(){},disconnect(){clearInterval(tick);remote.getTracks().forEach(t=>t.stop());window.mockDisconnected=true;}};
  options.onRemoteStream(remote);return rt;
}`;
const bundle = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  write: false,
  plugins: [
    {
      name: "test-provider",
      setup(builder) {
        builder.onLoad({ filter: /provider\.js$/ }, () => ({
          contents: mockProvider,
          loader: "js",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  permissions: ["camera"],
});
const page = await context.newPage();
await page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    context.fillStyle = "#245bc2";
    context.fillRect(0, 0, 640, 480);
    const stream = canvas.captureStream(12);
    const timer = setInterval(() => {
      if (stream.getTracks().every((track) => track.readyState === "ended"))
        clearInterval(timer);
      else context.fillRect(0, 0, 4, 4);
    }, 80);
    return stream;
  };
});
const report = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let tokens = 0,
  tokenMode = "ok",
  resolveToken;
await page.route("**/app.js", (route) =>
  route.fulfill({
    body: bundle.outputFiles[0].text,
    contentType: "text/javascript",
  }),
);
await page.route("**/api/config", (route) =>
  route.fulfill({
    json: {
      configured: true,
      model: "lucy-vton-3.5",
      durations: [10, 20, 30],
      creditsPerSecond: 2,
    },
  }),
);
await page.route("**/api/realtime-token", async (route) => {
  tokens++;
  if (tokenMode === "pending")
    await new Promise((resolve) => (resolveToken = resolve));
  await route
    .fulfill({ json: { apiKey: "ephemeral-test-token" } })
    .catch(() => {});
});
const check = (name, result) => {
  assert.ok(result, name);
  report.push(name);
};
const png = Buffer.from(
  (
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#245bc2";
      ctx.fillRect(0, 0, 16, 16);
      return canvas.toDataURL("image/png");
    })
  ).split(",")[1],
  "base64",
);
const fixture = { name: "garment.png", mimeType: "image/png", buffer: png };
try {
  await page.goto("http://127.0.0.1:4180");
  await page.waitForFunction(
    () => document.getElementById("key-status").textContent === "密钥已配置",
  );
  check(
    "初次进入无 token 请求，相机未开启，开始禁用",
    tokens === 0 &&
      (await page.locator("#start").isDisabled()) &&
      (await page
        .locator("#input-video")
        .evaluate((video) => video.srcObject === null)),
  );
  await page.screenshot({
    path: path.join(out, "desktop.png"),
    fullPage: true,
  });
  check(
    "1440×900 首屏可见开始按钮",
    await page
      .locator("#start")
      .evaluate(
        (button) => button.getBoundingClientRect().bottom <= innerHeight,
      ),
  );
  await page.locator("#duration").selectOption("10");
  check("时限与费用联动", (await page.locator("#cost").textContent()) === "20");
  await page.locator("#garment").setInputFiles(fixture);
  await page.waitForFunction(
    () => !document.getElementById("garment-preview").hidden,
  );
  await page.locator("#garment").setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("broken"),
  });
  await page.waitForFunction(() =>
    document.getElementById("file-error").textContent.includes("有效"),
  );
  check(
    "坏图被拒绝，上一张有效服装图保留",
    (await page.locator("#file-name").textContent()).startsWith("garment.png"),
  );
  await page.locator("#garment").setInputFiles({
    name: "bad.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg/>"),
  });
  await page.waitForFunction(() =>
    document.getElementById("file-error").textContent.includes("JPG"),
  );
  check("非支持格式被拒绝", true);
  await page.locator("#open-camera").click();
  await page.waitForFunction(
    () =>
      document.getElementById("input-video").srcObject?.getVideoTracks()
        .length === 1,
  );
  check(
    "仅本地相机预览，尚无云端连接",
    tokens === 0 &&
      (await page
        .locator("#output-video")
        .evaluate((video) => video.srcObject === null)),
  );
  await page.locator("#consent").check();
  check("必要条件满足后开始可用", await page.locator("#start").isEnabled());
  await page.locator("#start").click();
  await page.waitForFunction(
    () => !document.getElementById("capture").disabled,
  );
  check(
    "独立远端画面出现，锁定参数，允许停止和截图",
    tokens === 1 &&
      (await page
        .locator("#parameters")
        .evaluate((fieldset) => fieldset.disabled)) &&
      (await page.locator("#stop").isEnabled()),
  );
  await page.locator("#capture").click();
  await page.waitForFunction(
    () => document.getElementById("result-count").textContent === "1",
  );
  await page.screenshot({
    path: path.join(out, "mock-stream.png"),
    fullPage: true,
  });
  await page.locator("#stop").click();
  check(
    "停止结束远端、保留本地相机",
    await page.evaluate(
      () =>
        window.mockDisconnected &&
        document.getElementById("output-video").srcObject === null &&
        document.getElementById("input-video").srcObject.getVideoTracks()[0]
          .readyState === "live",
    ),
  );
  await page.locator("[data-nav=results]").click();
  check(
    "切页关闭相机，截图跨页保留",
    (await page
      .locator("#input-video")
      .evaluate((video) => video.srcObject === null)) &&
      (await page.locator(".result").count()) === 1,
  );
  await page.locator(".thumbnail").click();
  check(
    "截图原图预览可打开",
    await page.locator("#preview-dialog").isVisible(),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape 关闭预览",
    !(await page.locator("#preview-dialog").isVisible()),
  );
  const downloaded = page.waitForEvent("download");
  await page.locator("#results").getByText("下载原图", { exact: true }).click();
  const download = await downloaded;
  await download.saveAs(path.join(out, "remote-test.png"));
  const data = await readFile(path.join(out, "remote-test.png"));
  check(
    "截图下载为有效 PNG，尺寸来自远端 640×480",
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.readUInt32BE(16) === 640 &&
      data.readUInt32BE(20) === 480,
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  check("取消删除保留截图", (await page.locator(".result").count()) === 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  check("确认删除恢复空状态", await page.locator("#results-empty").isVisible());
  await page.locator("[data-nav=settings]").click();
  await page.locator("#refresh-config").click();
  check("接入说明刷新不创建 token", tokens === 1);
  await page.screenshot({
    path: path.join(out, "settings.png"),
    fullPage: true,
  });
  await page.locator("[data-nav=studio]").click();
  await page.locator("#open-camera").click();
  await page.waitForFunction(
    () => document.getElementById("input-video").srcObject,
  );
  await page.evaluate(() => (window.testMode = "pending"));
  await page.locator("#start").click();
  await page.waitForFunction(() => Boolean(window.resolveConnection));
  await page.locator("#stop").click();
  await page.evaluate(() => window.resolveConnection());
  await page.waitForFunction(() => window.mockDisconnected);
  check(
    "连接未完成时停止，迟到连接及远端流被清理",
    (await page
      .locator("#output-video")
      .evaluate((video) => video.srcObject === null)) &&
      (await page.locator("#start").isEnabled()),
  );
  await page.evaluate(() => (window.testMode = "failure"));
  await page.locator("#start").click();
  await page.waitForFunction(() =>
    document.getElementById("session-message").classList.contains("error"),
  );
  check(
    "供应商失败不显示假画面或原始错误",
    (await page
      .locator("#output-video")
      .evaluate((video) => video.srcObject === null)) &&
      !(await page.locator("#session-message").textContent()).includes(
        "simulated",
      ),
  );
  tokenMode = "pending";
  await page.evaluate(() => (window.testMode = "ok"));
  await page.locator("#start").click();
  await page.waitForFunction(
    () => document.getElementById("stop").disabled === false,
  );
  while (!resolveToken) await new Promise((resolve) => setTimeout(resolve, 5));
  await page.locator("#stop").click();
  resolveToken();
  tokenMode = "ok";
  await page.waitForTimeout(100);
  check(
    "等待 token 时取消不启动后续云端连接",
    await page
      .locator("#output-video")
      .evaluate((video) => video.srcObject === null),
  );
  const issueTokens = tokens;
  await page.evaluate(() => (window.testMode = "ok"));
  await page.locator("#start").click();
  await page.waitForFunction(
    () => !document.getElementById("capture").disabled,
  );
  await page.waitForFunction(
    () => document.getElementById("stop").disabled,
    null,
    {
      timeout: 12000,
    },
  );
  check(
    "10 秒自动停止且没有自动 token 重试",
    tokens === issueTokens + 1 &&
      (await page.evaluate(() => window.mockDisconnected)),
  );
  await page.locator("#close-camera").click();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  await page.locator("#open-camera").click();
  await page.waitForFunction(() =>
    document
      .getElementById("session-message")
      .textContent.includes("权限未允许"),
  );
  check("相机权限拒绝可理解，不开启云端", true);
  await page.locator("#remove-garment").click();
  check(
    "移除服装回到空状态并禁用开始",
    (await page.locator("#upload-placeholder").isVisible()) &&
      (await page.locator("#start").isDisabled()),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["studio", "results", "settings"]) {
    await page.locator(`[data-nav=${view}]`).click();
    check(
      `390px ${view} 无横向溢出`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(out, `mobile-${view}.png`),
      fullPage: true,
    });
  }
  check("无浏览器未捕获异常", errors.length === 0);
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify(
      { passed: report.length, checks: report, errors, realGeneration: false },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: report.length, errors, realGeneration: false }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      checks: report,
      errors,
      visibleStatus: await page.locator("#session-message").textContent(),
      readyHint: await page.locator("#ready-hint").textContent(),
    }),
  );
  await page.screenshot({
    path: path.join(out, "failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
