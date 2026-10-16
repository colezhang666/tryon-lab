import { probe } from "./video-jobs.mjs";

export async function generateImage(apiKey, form, fetcher = fetch) {
  const response = await fetcher(
    "https://api.decart.ai/v1/generate/lucy-image-2",
    {
      method: "POST",
      headers: { "X-API-KEY": apiKey },
      body: form,
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!response.ok)
    throw Object.assign(
      new Error("图片模型请求被平台拒绝，请核对账号权限、额度或官方服务状态。"),
      { rejected: true },
    );
  const mime = response.headers.get("content-type")?.split(";")[0];
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
    throw new Error("INVALID_IMAGE_RESPONSE");
  if (Number(response.headers.get("content-length")) > 20 * 1024 * 1024)
    throw new Error("RESULT_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error("RESULT_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const valid =
    mime === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216
      : mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("INVALID_IMAGE_RESPONSE");
  return { bytes, mime };
}

export function createImageHandler({
  apiKey,
  generate = (form) => generateImage(apiKey, form),
  inspect = probe,
  ledger = null,
}) {
  let state = { status: "idle" },
    result = null,
    busy = false,
    attempts = 0;
  return async (request, response, send) => {
    const resultRoute = request.url === "/api/image-result";
    if (request.method === "GET") {
      if (!resultRoute)
        return send(200, busy ? { ...state, status: "generating" } : state);
      if (busy || state.status !== "completed" || !result)
        return send(409, { error: "尚无已完成的图片结果。" });
      response.writeHead(200, {
        "Content-Type": result.mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return response.end(result.bytes);
    }
    if (resultRoute || request.method !== "POST")
      return send(405, { error: "请求方式不支持。" });
    if (!apiKey) return send(503, { error: "后端尚未配置密钥。" });
    if (busy || state.status === "unknown")
      return send(409, {
        error:
          "正在处理或上次提交结果不明，请先查询状态与官方用量，勿重复生成。",
      });
    if (attempts >= 5)
      return send(429, {
        error: "本次后端启动最多生成5张图片，确认官方用量后再重启。",
      });
    if (!request.headers["content-type"]?.startsWith("multipart/form-data;"))
      return send(400, { error: "请上传人物照片和服装图。" });
    busy = true;
    let submitted = false;
    let billId;
    try {
      const chunks = [];
      let size = 0;
      request.setTimeout(30000, () => request.destroy());
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 21 * 1024 * 1024)
          return send(413, { error: "每张图片最多10 MiB。" });
        chunks.push(chunk);
      }
      request.setTimeout(0);
      const form = await new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": request.headers["content-type"] },
        body: Buffer.concat(chunks),
      }).formData();
      const person = form.get("data"),
        garment = form.get("reference_image"),
        prompt = form.get("prompt") || "";
      if (typeof prompt !== "string" || prompt.length > 500)
        throw new Error("换装要求最多500字。");
      for (const file of [person, garment]) {
        if (
          !(file instanceof File) ||
          !file.size ||
          file.size > 10 * 1024 * 1024
        )
          throw new Error("人物照片和服装图都必须非空且不超过10 MiB。");
        const stream = (await inspect(file)).streams?.find(
          (stream) => stream.codec_type === "video",
        );
        if (
          !stream ||
          !["png", "mjpeg", "webp"].includes(stream.codec_name) ||
          !stream.width ||
          !stream.height ||
          stream.width * stream.height > 16000000
        )
          throw new Error(
            "请选择有效的JPG、PNG或WebP图片，每张不超过1600万像素。",
          );
      }
      const upstream = new FormData();
      upstream.set("data", person, person.name);
      upstream.set("reference_image", garment, garment.name);
      upstream.set(
        "prompt",
        prompt.trim() ||
          "Replace only the upper-body clothing with the garment shown in the reference image. Preserve the original person's face, hair, pose, hands and background.",
      );
      upstream.set("resolution", "720p");
      billId = ledger?.start({
        kind: "image",
        units: 1,
        note: "720p单张参考价；图片结果不代表平台实扣金额。",
      });
      state = {
        status: "generating",
        model: "lucy-image-2",
        resolution: "720p",
      };
      attempts++;
      submitted = true;
      result = await generate(upstream);
      ledger?.update(billId, { status: "completed" });
      state = { ...state, status: "completed" };
      return send(201, state);
    } catch (error) {
      if (!submitted)
        return send(400, {
          error: [
            "账单记录",
            "换装要求",
            "人物照片",
            "请选择",
            "无法解析",
          ].some((prefix) => error.message?.startsWith(prefix))
            ? error.message
            : "上传图片无效，请重新选择。",
        });
      state = {
        ...state,
        status: error.rejected ? "failed" : "unknown",
        error: error.rejected
          ? error.message
          : "生成响应未能确认，平台可能已处理，请先检查官方用量，勿重复提交。",
      };
      ledger?.update(billId, {
        status: state.status,
        note: "失败或响应不明，实际扣费待平台核对，不能按零计费。",
      });
      return send(502, state);
    } finally {
      busy = false;
    }
  };
}
