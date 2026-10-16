const $ = (id) => document.getElementById(id);
const files = {},
  urls = {};
let locked = false,
  validating = false,
  resultUrl,
  pollTimer,
  refreshing = false;
const names = {
  idle: "未提交",
  generating: "生成中",
  completed: "已完成",
  failed: "失败",
  unknown: "待核查",
};
function message(text, error = false) {
  $("image-message").textContent = text;
  $("image-message").className = `status-message${error ? " error" : ""}`;
}
function update() {
  $("image-form").disabled = locked || validating;
  $("generate-image").disabled =
    locked ||
    validating ||
    !files.person ||
    !files.garment ||
    !$("image-consent").checked;
}
function show(state) {
  locked = ["generating", "unknown"].includes(state.status);
  $("image-job-state").textContent = names[state.status] || "待核查";
  $("load-image-result").disabled = state.status !== "completed";
  message(
    state.error ||
      {
        idle: "选择人物照片和衣服图，点击一键换装。",
        generating: "云端正在生成图片，可离开页面，稍后刷新状态。",
        completed: "图片已生成，可加载结果、对比和下载。",
        failed: "平台拒绝了请求，请检查接入和账号状态。",
        unknown: "生成响应不明确，请先核对官方用量，勿重复生成。",
      }[state.status] ||
      "请刷新状态。",
    ["failed", "unknown"].includes(state.status),
  );
  clearTimeout(pollTimer);
  if (state.status === "generating") pollTimer = setTimeout(refreshImage, 3000);
  update();
}
async function responseJson(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "图片请求失败，请刷新状态。");
  return data;
}
async function refreshImage() {
  if (refreshing) return;
  refreshing = true;
  try {
    show(
      await responseJson(
        await fetch("/api/image-job", { signal: AbortSignal.timeout(10000) }),
      ),
    );
  } catch {
    message("无法读取图片任务状态，请检查本地后端，勿直接重复生成。", true);
  } finally {
    refreshing = false;
  }
}
export function enterImage() {
  refreshImage();
}
for (const kind of ["person", "garment"]) {
  $(`image-${kind}`).onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    validating = true;
    update();
    let bitmap;
    try {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        !file.size ||
        file.size > 10 * 1024 * 1024
      )
        throw new Error("请选择有效的JPG、PNG或WebP图片，最多10 MiB。");
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 16000000)
        throw new Error("每张图片不能超过1600万像素。");
      URL.revokeObjectURL(urls[kind]);
      files[kind] = file;
      urls[kind] = URL.createObjectURL(file);
      $(`image-${kind}-preview`).src = urls[kind];
      $(`image-${kind}-preview`).hidden = false;
      $(`image-${kind}-name`).textContent =
        `${file.name} · ${bitmap.width}×${bitmap.height}`;
      if (kind === "person") $("image-person-empty").hidden = true;
      message("素材已就绪，阅读费用说明后可一键换装。");
    } catch (error) {
      message(error.message || "无法解码图片，请重新选择。", true);
    } finally {
      bitmap?.close();
      validating = false;
      event.target.value = "";
      update();
    }
  };
}
$("image-consent").onchange = update;
$("refresh-image-job").onclick = refreshImage;
async function loadResult() {
  $("load-image-result").disabled = true;
  try {
    const response = await fetch("/api/image-result", {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error("结果加载失败，请重试加载，无需重新生成。");
    const blob = await response.blob();
    if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type))
      throw new Error("返回内容不是支持的图片。");
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    $("image-result-preview").src = resultUrl;
    $("image-result-preview").hidden = false;
    $("image-result-empty").hidden = true;
    const link = $("download-image");
    link.href = resultUrl;
    link.download = `tryon-image.${{ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type]}`;
    link.hidden = false;
    message("图片已返回。请对比脸、手和衣服细节，满意后下载保存。");
  } catch (error) {
    message(error.message || "图片无法解码，请重试加载。", true);
  } finally {
    $("load-image-result").disabled = false;
  }
}
$("load-image-result").onclick = loadResult;
$("generate-image").onclick = async () => {
  if ($("generate-image").disabled) return;
  show({ status: "generating" });
  $("image-result-preview").hidden = true;
  $("image-result-empty").hidden = false;
  $("download-image").hidden = true;
  const form = new FormData();
  form.set("data", files.person);
  form.set("reference_image", files.garment);
  form.set("prompt", $("image-prompt").value);
  try {
    show(
      await responseJson(
        await fetch("/api/image-job", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(140000),
        }),
      ),
    );
    await loadResult();
  } catch (error) {
    await refreshImage();
    message(
      `${error.message} 请先刷新状态或核对官方用量，勿直接重复生成。`,
      true,
    );
  }
};
