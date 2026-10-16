import { cameraConstraints, connect } from "./provider.js";
import { Session, stopTracks } from "./session.js";
import { enterVideo } from "./video-page.js";
import { enterImage } from "./image-page.js";
import { enterBilling } from "./billing-page.js";

const $ = (id) => document.getElementById(id);
const input = $("input-video"),
  output = $("output-video");
let config = null,
  local = null,
  garment = null,
  garmentUrl = null;
let opening = false,
  validating = false,
  state = "idle",
  cameraVersion = 0,
  fileVersion = 0;
let captures = [],
  noticeTimer,
  view = "studio";
const defaultPrompt =
  "Substitute the current top with the garment in the reference image. Preserve the person and background.";
const formatTime = (seconds) =>
  `00:${String(Math.floor(seconds)).padStart(2, "0")}`;
const notify = (text) => {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("toast").hidden = true), 4500);
};
const message = (text, type = "") => {
  $("session-message").textContent = text;
  $("session-message").className = `status-message ${type}`;
};
const session = new Session({
  connect,
  onUsage: (usage) => {
    fetch("/api/billing/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usage),
      keepalive: true,
    }).catch(() => {});
  },
  token: async (duration) => {
    try {
      const response = await fetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(), { userMessage: data.error });
      if (typeof data.apiKey !== "string" || !data.apiKey) throw new Error();
      return { apiKey: data.apiKey, billId: data.billId };
    } catch (error) {
      if (!error.userMessage)
        error.userMessage = "本机服务未响应或连接超时，请检查后端启动状态。";
      throw error;
    }
  },
  onState: (next, text) => {
    state = next;
    message(text, next);
    $("cloud-status").textContent =
      next === "connecting"
        ? "连接中"
        : next === "streaming"
          ? "等待画面"
          : next === "error"
            ? "连接已结束"
            : "等待开始";
    $("output-note").textContent =
      next === "connecting"
        ? "连接中，停止随时可用"
        : next === "streaming"
          ? "云端流已返回"
          : "尚未连接云端";
    updateControls();
  },
  onStream: (stream) => {
    output.srcObject = stream;
    $("play-output").hidden = true;
    $("output-empty").hidden = false;
    $("capture").disabled = true;
    if (stream)
      output.play().catch(() => {
        if (output.srcObject === stream) $("play-output").hidden = false;
      });
  },
  onTime: (elapsed, duration) => {
    $("timer").replaceChildren(
      document.createTextNode(`${formatTime(elapsed)} `),
      Object.assign(document.createElement("span"), {
        textContent: `/ ${formatTime(duration)}`,
      }),
    );
  },
});

function hasCamera() {
  return Boolean(
    local?.getVideoTracks().some((track) => track.readyState === "live"),
  );
}
function updateControls() {
  const active = session.active;
  $("parameters").disabled = active;
  $("garment").disabled = active;
  $("remove-garment").disabled = active || !garment;
  $("open-camera").disabled = opening || active;
  $("close-camera").disabled = !local && !opening;
  $("stop").disabled = !active;
  $("consent").disabled = active;
  const missing = !config
    ? "接入状态尚未读取成功，请前往接入说明刷新。"
    : !config.configured
      ? "后端未配置密钥，请查看接入说明。"
      : opening
        ? "正在等待浏览器摄像头权限…"
        : !hasCamera()
          ? "请先打开摄像头。"
          : validating
            ? "正在检查图片…"
            : !garment
              ? "请选择服装参考图。"
              : !$("consent").checked
                ? "请阅读并勾选画面上传与费用说明。"
                : "已准备好，可开始本次试穿。";
  $("start").disabled =
    active ||
    !config?.configured ||
    !hasCamera() ||
    !garment ||
    validating ||
    !$("consent").checked;
  $("ready-hint").textContent = active
    ? "本次参数已锁定，停止后可修改。"
    : missing;
  $("capture").disabled =
    !active ||
    output.readyState < 2 ||
    !output.videoWidth ||
    !output.srcObject ||
    captures.length >= 12;
}

async function loadConfig() {
  $("refresh-config").disabled = true;
  try {
    const response = await fetch("/api/config", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (
      typeof data.configured !== "boolean" ||
      data.model !== "lucy-vton-3.5" ||
      data.creditsPerSecond !== 2
    )
      throw new Error();
    config = data;
    $("key-status").textContent = data.configured ? "密钥已配置" : "密钥未配置";
    $("setting-key").textContent = data.configured
      ? "已配置 · 仅保存在本地后端"
      : "未配置 · 请设置 .env 后重启服务";
  } catch {
    config = null;
    $("key-status").textContent = "接入状态读取失败";
    $("setting-key").textContent = "状态读取失败，请检查后端并重试";
    message("无法读取本机接入状态，请确认服务正在运行。", "error");
  } finally {
    $("refresh-config").disabled = false;
    updateControls();
  }
}

async function openCamera() {
  if (opening || local) return;
  opening = true;
  const version = ++cameraVersion;
  $("open-camera").textContent = "正在打开…";
  updateControls();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw Object.assign(new Error(), { name: "InsecureContext" });
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    if (version !== cameraVersion || view !== "studio")
      return stopTracks(stream);
    local = stream;
    input.srcObject = stream;
    $("input-empty").hidden = true;
    $("local-note").textContent = "仅本地预览，开始后才上传";
    $("camera-status").textContent = "摄像头已开启";
    stream.getVideoTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (local === stream) closeCamera("摄像头已断开，请检查设备。", true);
      }),
    );
    input.play().catch(() => {
      if (local === stream) $("play-input").hidden = false;
    });
    message("本地预览已就绪，尚未上传画面。");
  } catch (error) {
    if (version !== cameraVersion) return;
    const errors = {
      NotAllowedError: "相机权限未允许，请在浏览器地址栏开启后重试。",
      NotFoundError: "未找到摄像头，请连接或启用设备。",
      NotReadableError: "摄像头无法读取，请关闭其他占用相机的程序。",
      InsecureContext:
        "当前环境不能使用相机，请通过 localhost、127.0.0.1 或 HTTPS 打开。",
    };
    message(
      errors[error.name] || "无法打开摄像头，请检查设备与系统权限后重试。",
      "error",
    );
  } finally {
    if (version === cameraVersion) {
      opening = false;
      $("open-camera").textContent = "打开摄像头";
      updateControls();
    }
  }
}

function closeCamera(text = "摄像头已关闭。", error = false) {
  cameraVersion++;
  opening = false;
  session.stop(text, error ? "error" : "stopped");
  const previous = local;
  local = null;
  stopTracks(previous);
  input.srcObject = null;
  $("input-empty").hidden = false;
  $("play-input").hidden = true;
  $("open-camera").textContent = "打开摄像头";
  $("camera-status").textContent = "本地预览";
  $("local-note").textContent = "摄像头尚未开启";
  updateControls();
}

async function chooseGarment(file) {
  if (!file || session.active) return;
  const version = ++fileVersion;
  validating = true;
  $("file-error").textContent = "";
  updateControls();
  let bitmap;
  try {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("请选择 JPG、PNG 或 WebP 图片。");
    if (file.size > 10 * 1024 * 1024 || file.size === 0)
      throw new Error("图片不能为空且不能超过 10 MiB。");
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("无法读取图片，请选择有效图片文件。");
    }
    if (bitmap.width * bitmap.height > 16000000)
      throw new Error("图片总像素不能超过 1600 万，请缩小后重试。");
    if (version !== fileVersion) return;
    URL.revokeObjectURL(garmentUrl);
    garment = file;
    garmentUrl = URL.createObjectURL(file);
    $("garment-preview").src = garmentUrl;
    $("garment-preview").hidden = false;
    $("upload-placeholder").hidden = true;
    $("file-name").textContent =
      `${file.name} · ${(file.size / 1024).toFixed(1)} KiB`;
  } catch (error) {
    if (version === fileVersion) $("file-error").textContent = error.message;
  } finally {
    bitmap?.close();
    if (version === fileVersion) {
      validating = false;
      $("garment").value = "";
      updateControls();
    }
  }
}

function removeGarment() {
  fileVersion++;
  validating = false;
  garment = null;
  URL.revokeObjectURL(garmentUrl);
  garmentUrl = null;
  $("garment-preview").removeAttribute("src");
  $("garment-preview").hidden = true;
  $("upload-placeholder").hidden = false;
  $("file-name").textContent = "JPG / PNG / WebP，≤ 10 MiB";
  $("file-error").textContent = "";
  updateControls();
}

function renderResults() {
  $("results-grid").replaceChildren();
  $("results-empty").hidden = captures.length > 0;
  $("result-count").textContent = captures.length;
  for (const item of captures) {
    const article = document.createElement("article");
    article.className = "result";
    const thumbnail = document.createElement("button");
    thumbnail.className = "thumbnail";
    thumbnail.setAttribute("aria-label", `预览 ${item.time}`);
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = `试穿截图 ${item.time}`;
    thumbnail.append(image);
    thumbnail.onclick = () => {
      $("preview-image").src = item.url;
      $("preview-dialog").showModal();
    };
    const info = document.createElement("div");
    info.className = "result-info";
    const title = document.createElement("strong");
    title.textContent = item.time;
    const detail = document.createElement("p");
    detail.textContent = "Lucy VTON 3.5 · PNG";
    const actions = document.createElement("div");
    actions.className = "result-actions";
    const download = document.createElement("a");
    download.href = item.url;
    download.download = item.name;
    download.textContent = "下载原图";
    const remove = document.createElement("button");
    remove.className = "text-button";
    remove.textContent = "删除";
    remove.onclick = () => {
      if (!confirm("删除这张本次截图？已下载的文件不受影响。")) return;
      captures = captures.filter((capture) => capture !== item);
      URL.revokeObjectURL(item.url);
      renderResults();
      updateControls();
      const next =
        $("results-grid").querySelector("button") ||
        $("results-empty").querySelector("a");
      next?.focus();
    };
    actions.append(download, remove);
    info.append(title, detail, actions);
    article.append(thumbnail, info);
    $("results-grid").append(article);
  }
}

async function capture() {
  if ($("capture").disabled || !session.active) return;
  const stream = output.srcObject;
  $("capture").disabled = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = output.videoWidth;
    canvas.height = output.videoHeight;
    canvas.getContext("2d").drawImage(output, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error();
    if (!session.active || stream !== output.srcObject) return;
    if (captures.length >= 12)
      return notify("本次最多保留 12 张，请先删除已有截图。");
    const now = new Date();
    captures.unshift({
      url: URL.createObjectURL(blob),
      name: `tryon-${now.toISOString().replace(/[:.]/g, "-")}.png`,
      time: now.toLocaleString("zh-CN", { hour12: false }),
    });
    renderResults();
    notify("截图已保存在本次页面，可前往“本次截图”下载。");
  } catch {
    notify("保存截图失败，请等待画面稳定后重试。");
  } finally {
    updateControls();
  }
}

function navigate(initial = false) {
  const requested = location.hash.slice(1) || "studio";
  const next = [
    "studio",
    "image",
    "video",
    "results",
    "billing",
    "settings",
  ].includes(requested)
    ? requested
    : "studio";
  if (next !== view) closeCamera("已离开工作台，云端连接和摄像头均已关闭。");
  view = next;
  for (const name of [
    "studio",
    "image",
    "video",
    "results",
    "billing",
    "settings",
  ])
    $(name).hidden = name !== view;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.title = `${{ studio: "实时试穿", image: "一键换装", video: "视频试穿", results: "本次截图", billing: "账单用量", settings: "接入说明" }[view]} · TryOn Lab`;
  if (view === "video") enterVideo();
  if (view === "image") enterImage();
  if (view === "billing") enterBilling();
  if (!initial) $(`${view}-title`).focus({ preventScroll: true });
}

$("open-camera").onclick = openCamera;
$("close-camera").onclick = () => closeCamera();
$("garment").onchange = (event) => chooseGarment(event.target.files[0]);
$("remove-garment").onclick = removeGarment;
$("consent").onchange = updateControls;
$("duration").onchange = () => {
  $("cost").textContent = Number($("duration").value) * 2;
  $("timer").lastElementChild.textContent =
    `/ ${formatTime($("duration").value)}`;
};
$("start").onclick = () => {
  updateControls();
  if ($("start").disabled) return;
  session.start(
    local,
    garment,
    $("prompt").value.trim() || defaultPrompt,
    Number($("duration").value),
  );
};
$("stop").onclick = () => session.stop();
$("capture").onclick = capture;
$("refresh-config").onclick = loadConfig;
if (window.tryonDesktop) {
  document.querySelector(".local-label").textContent = "桌面应用";
  $("key-configuration-help").textContent = "API Key 已由桌面应用加密保存，不会在工作台显示。点击“API Key 设置”即可更换或删除。相机仅使用受限的临时连接凭证。";
  $("desktop-key-settings").hidden = false;
  $("desktop-key-settings").onclick = async () => {
    const result = await window.tryonDesktop.openSettings();
    if (!result.ok) notify(result.error);
  };
}
$("close-preview").onclick = () => $("preview-dialog").close();
for (const [video, name] of [
  [input, "input"],
  [output, "output"],
]) {
  $(`play-${name}`).onclick = () =>
    video
      .play()
      .then(() => ($(`play-${name}`).hidden = true))
      .catch(() => notify("浏览器未能播放视频，请检查设备后重新开始。"));
}
output.addEventListener("loadeddata", () => {
  if (!session.active || !output.srcObject || output.readyState < 2) return;
  $("output-empty").hidden = true;
  session.hasFrame = true;
  $("cloud-status").textContent = "画面已到达";
  $("output-note").textContent = "真实云端视频";
  message("云端画面已到达，可观察试穿效果或保存截图。", "streaming");
  updateControls();
});
window.addEventListener("hashchange", () => navigate());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) closeCamera("页面进入后台，已结束连接并关闭摄像头。");
});
window.addEventListener("pagehide", () => closeCamera());
navigate(true);
renderResults();
loadConfig();
