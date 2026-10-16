import { clipDuration } from "./video-validation.js";
const $ = (id) => document.getElementById(id);
let file = null,
  image = null,
  duration = 0,
  sourceUrl,
  resultUrl,
  choosing = 0;
let locked = false,
  remote = { status: "idle" },
  timer,
  polling = false;

function status(text, error = false) {
  $("video-message").textContent = text;
  $("video-message").className = `status-message${error ? " error" : ""}`;
}
function update() {
  $("video-form").disabled = locked;
  $("submit-video").disabled =
    locked || !file || !image || !$("video-consent").checked;
}
async function json(response) {
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "视频任务请求失败，请稍后刷新状态。");
  return data;
}
function showJob(job) {
  remote = job;
  locked = ["submitting", "pending", "processing", "unknown"].includes(
    job.status,
  );
  const names = {
    idle: "选择不超过 20 秒的视频和服装图后提交。",
    submitting: "正在上传并提交视频…",
    pending: "平台正在排队，提交后云端任务不会因离页取消。",
    processing: "平台正在生成视频，请稍候…",
    completed: "视频已生成完成，可加载预览并下载。",
    failed: "平台报告任务失败，请核对官方任务记录。",
    unknown: "提交结果不明确，请检查官方记录，勿重复提交。",
  };
  status(
    job.error || names[job.status] || "任务状态未知，请检查官方记录。",
    Boolean(job.error) || ["failed", "unknown"].includes(job.status),
  );
  $("video-job-state").textContent =
    {
      idle: "未提交",
      submitting: "提交中",
      pending: "排队中",
      processing: "生成中",
      completed: "已完成",
      failed: "失败",
      unknown: "待核查",
    }[job.status] || "待核查";
  $("load-video-result").disabled = job.status !== "completed";
  clearTimeout(timer);
  if (["pending", "processing"].includes(job.status))
    timer = setTimeout(refresh, 3000);
  update();
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    showJob(
      await json(
        await fetch("/api/video-job", { signal: AbortSignal.timeout(65000) }),
      ),
    );
  } catch (error) {
    status(
      `${error.message} 已提交的云端任务可能仍在继续，请勿重复提交。`,
      true,
    );
  } finally {
    polling = false;
  }
}
export function enterVideo() {
  refresh();
}

$("video-source").onchange = async (event) => {
  const chosen = event.target.files[0];
  if (!chosen) return;
  const version = ++choosing;
  let url, preview;
  locked = true;
  update();
  status("正在读取视频时长…");
  try {
    if (chosen.size > 50 * 1024 * 1024 || chosen.size === 0)
      throw new Error("视频必须非空且不超过 50 MiB。");
    if (
      chosen.type !== "video/mp4" &&
      !chosen.name.toLowerCase().endsWith(".mp4")
    )
      throw new Error("请选择 MP4 视频，其他格式请先转换。");
    url = URL.createObjectURL(chosen);
    preview = document.createElement("video");
    preview.preload = "metadata";
    const seconds = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error("读取视频超时，请检查文件或转换为 H.264 MP4 后重试。"),
          ),
        10000,
      );
      preview.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve(preview.duration);
      };
      preview.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("浏览器无法读取该视频，请转换为 H.264 MP4。"));
      };
      preview.src = url;
    });
    clipDuration(seconds);
    if (version !== choosing) return;
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = url;
    url = null;
    file = chosen;
    duration = seconds;
    $("uploaded-video").src = sourceUrl;
    $("uploaded-video").hidden = false;
    $("video-source-empty").hidden = true;
    $("video-file-info").textContent =
      `${chosen.name} · ${seconds.toFixed(2)} 秒 · ${(chosen.size / 1024 / 1024).toFixed(1)} MiB`;
    $("video-cost").textContent = `$${(seconds * 0.04).toFixed(2)}`;
    status("视频已就绪。时长由原视频决定，不需要选择固定秒数。");
  } catch (error) {
    status(error.message, true);
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (preview) {
      preview.removeAttribute("src");
      preview.load();
    }
    if (version === choosing) {
      locked = false;
      $("video-source").value = "";
      update();
    }
  }
};
$("video-garment").onchange = async (event) => {
  const chosen = event.target.files[0];
  if (!chosen) return;
  locked = true;
  update();
  let bitmap;
  try {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(chosen.type) ||
      chosen.size > 10 * 1024 * 1024
    )
      throw new Error("请选择不超过 10 MiB 的 JPG、PNG 或 WebP 服装图。");
    bitmap = await createImageBitmap(chosen);
    if (bitmap.width * bitmap.height > 16000000)
      throw new Error("服装图不能超过 1600 万像素。");
    image = chosen;
    $("video-image-info").textContent = chosen.name;
    status("服装图已选择。");
  } catch {
    status(
      "无法读取服装图，请选择有效 JPG、PNG 或 WebP（≤ 10 MiB、1600 万像素）。",
      true,
    );
  } finally {
    bitmap?.close();
    locked = false;
    $("video-garment").value = "";
    update();
  }
};
$("video-consent").onchange = update;
$("refresh-video-job").onclick = refresh;
$("submit-video").onclick = async () => {
  if ($("submit-video").disabled) return;
  showJob({ status: "submitting" });
  URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  $("generated-video").pause();
  $("generated-video").removeAttribute("src");
  $("generated-video").hidden = true;
  $("download-video").hidden = true;
  $("video-result-empty").hidden = false;
  const form = new FormData();
  form.set("data", file);
  form.set("reference_image", image);
  form.set("prompt", $("video-prompt").value);
  try {
    showJob(
      await json(
        await fetch("/api/video-job", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(80000),
        }),
      ),
    );
  } catch (error) {
    status(
      `${error.message} 如请求已经提交，请先刷新任务状态，勿直接再次生成。`,
      true,
    );
    // Keep submission disabled until a fresh server status establishes whether it was accepted.
    await refresh();
  }
};
$("load-video-result").onclick = async () => {
  $("load-video-result").disabled = true;
  try {
    const response = await fetch("/api/video-result", {
      signal: AbortSignal.timeout(65000),
    });
    if (!response.ok)
      throw new Error("结果获取失败，请重试加载，不要重新生成。");
    const blob = await response.blob();
    if (!blob.size) throw new Error("结果为空，请重试加载。");
    URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    $("generated-video").src = resultUrl;
    $("generated-video").hidden = false;
    $("video-result-empty").hidden = true;
    $("download-video").href = resultUrl;
    $("download-video").hidden = false;
    status("结果已加载，可播放和下载 MP4。刷新网页后可再次查询本次后端任务。");
  } catch (error) {
    status(error.message, true);
  } finally {
    $("load-video-result").disabled = remote.status !== "completed";
  }
};
window.addEventListener("hashchange", () => {
  if (location.hash !== "#video") {
    $("uploaded-video").pause();
    $("generated-video").pause();
  }
});
