import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { clipDuration } from "./src/video-validation.js";

const exec = promisify(execFile);
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export function validateVideo(metadata) {
  const video = metadata.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const duration = Math.max(
    Number(metadata.format?.duration || 0),
    Number(video?.duration || 0),
  );
  if (!video) throw new Error("视频缺少有效画面。");
  clipDuration(duration);
  if (
    !metadata.format?.format_name?.includes("mp4") ||
    !["h264", "vp8"].includes(video.codec_name)
  )
    throw new Error("请选择 MP4（H.264 或 VP8）视频；其他格式请先转换。");
  if (!video.width || !video.height || video.width * video.height > 3840 * 2160)
    throw new Error("视频分辨率不能超过 4K 总像素。");
  return duration;
}
export async function probe(file) {
  const directory = await mkdtemp(join(tmpdir(), "tryon-video-"));
  const target = join(directory, "input");
  try {
    await writeFile(target, Buffer.from(await file.arrayBuffer()));
    const { stdout } = await exec(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        target,
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      "无法解析媒体文件，请检查视频/图片是否有效，以及后端 ffprobe 是否可用。",
    );
  } finally {
    await unlink(target).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

export function videoProvider(apiKey, fetcher = fetch) {
  const request = async (path, options = {}) => {
    const response = await fetcher(`https://api.decart.ai/v1/jobs/${path}`, {
      ...options,
      headers: { "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error("PROVIDER_ERROR");
    return response;
  };
  return {
    submit: async (form) =>
      (await request("lucy-vton-3.5", { method: "POST", body: form })).json(),
    status: async (id) => (await request(encodeURIComponent(id))).json(),
    result: (id) => request(`${encodeURIComponent(id)}/content`),
  };
}

export function createVideoHandler({
  apiKey,
  provider = videoProvider(apiKey),
  inspect = probe,
  now = Date.now,
  ledger = null,
}) {
  let job = null,
    busy = false,
    attempts = 0,
    lastPoll = 0,
    polling = false;
  const publicJob = () =>
    job
      ? { status: job.status, duration: job.duration, error: job.error || null }
      : { status: "idle" };
  return async (request, response, send) => {
    const resultRoute = request.url === "/api/video-result";
    if (request.method === "GET") {
      if (!job)
        return send(
          resultRoute ? 404 : 200,
          resultRoute ? { error: "尚无视频结果。" } : publicJob(),
        );
      if (
        job.id &&
        ["pending", "processing"].includes(job.status) &&
        now() - lastPoll >= 2000 &&
        !polling
      ) {
        polling = true;
        lastPoll = now();
        try {
          const status = await provider.status(job.id);
          if (
            !["pending", "processing", "completed", "failed"].includes(
              status.status,
            )
          )
            throw new Error();
          job.status = status.status;
          ledger?.update(job.billId, { status: status.status });
          job.error =
            status.status === "failed"
              ? "平台报告生成失败，请检查官方任务记录。"
              : null;
        } catch {
          return send(502, {
            ...publicJob(),
            error: "查询暂时失败，可刷新任务状态；请勿重复提交。",
          });
        } finally {
          polling = false;
        }
      }
      if (!resultRoute) return send(200, publicJob());
      if (job.status !== "completed")
        return send(409, { error: "视频尚未生成完成。" });
      try {
        const result = await provider.result(job.id);
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        await pipeline(Readable.fromWeb(result.body), response);
      } catch {
        if (!response.headersSent)
          send(502, { error: "结果获取失败，请重试下载，无需重新生成。" });
        else response.destroy();
      }
      return;
    }
    if (request.method !== "POST" || resultRoute)
      return send(405, { error: "请求方式不支持。" });
    if (!apiKey) return send(503, { error: "后端未配置密钥。" });
    if (busy || (job && !["completed", "failed"].includes(job.status)))
      return send(409, { error: "已有视频正在提交或处理，请先查询当前任务。" });
    if (attempts >= 5)
      return send(429, {
        error: "本次后端启动最多尝试提交 5 个视频任务，确认官方用量后再重启。",
      });
    if (!request.headers["content-type"]?.startsWith("multipart/form-data;"))
      return send(400, { error: "需要视频和服装图片文件。" });
    busy = true;
    let submitted = false;
    const previous = job;
    try {
      let size = 0;
      const chunks = [];
      request.setTimeout(30000, () => request.destroy());
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 61 * 1024 * 1024)
          return send(413, {
            error: "上传过大：视频最多 50 MiB，参考图最多 10 MiB。",
          });
        chunks.push(chunk);
      }
      const form = await new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": request.headers["content-type"] },
        body: Buffer.concat(chunks),
      }).formData();
      const video = form.get("data"),
        image = form.get("reference_image"),
        prompt = form.get("prompt") || "";
      if (
        !(video instanceof File) ||
        !video.size ||
        video.size > MAX_VIDEO_BYTES ||
        !(image instanceof File) ||
        !image.size ||
        image.size > 10 * 1024 * 1024 ||
        typeof prompt !== "string" ||
        prompt.length > 500
      )
        throw new Error(
          "请选择有效视频（≤ 50 MiB）和服装图（≤ 10 MiB），指令最多 500 字。",
        );
      const duration = validateVideo(await inspect(video));
      const reference = (await inspect(image)).streams?.find(
        (stream) => stream.codec_type === "video",
      );
      if (
        !reference ||
        !["mjpeg", "png", "webp"].includes(reference.codec_name) ||
        reference.width * reference.height > 16000000
      )
        throw new Error(
          "参考图须为有效的 JPG、PNG 或 WebP，且不超过 1600 万像素。",
        );
      const upstream = new FormData();
      upstream.set("data", video, "person.mp4");
      upstream.set("reference_image", image, "garment");
      upstream.set(
        "prompt",
        prompt ||
          "Substitute the current top with the garment in the reference image. Preserve the person and background.",
      );
      upstream.set("resolution", "720p");
      upstream.set("enhance_prompt", "false");
      const billId = ledger?.start({
        kind: "video",
        units: duration,
        note: "按输入视频时长与公开价估算，平台实际生成秒数/扣费需核对。",
      });
      job = { duration, status: "submitting", billId };
      attempts++;
      submitted = true;
      const created = await provider.submit(upstream);
      if (
        typeof created.job_id !== "string" ||
        !created.job_id ||
        !["pending", "processing", "completed", "failed"].includes(
          created.status,
        )
      )
        throw new Error();
      job.id = created.job_id;
      job.status = created.status;
      ledger?.update(job.billId, {
        status: created.status,
        providerId: created.job_id,
      });
      lastPoll = 0;
      return send(201, publicJob());
    } catch (error) {
      if (submitted) {
        job.status = "unknown";
        ledger?.update(job.billId, {
          status: "unknown",
          note: "提交结果不明；平台可能已接收，费用待核对。",
        });
        job.error =
          "提交结果尚不能确认。平台可能已接收任务，请先检查官方记录，勿重复提交。";
        return send(502, publicJob());
      }
      job = previous;
      return send(400, {
        error:
          error.message?.startsWith("视频") ||
          error.message?.startsWith("请选择") ||
          error.message?.startsWith("参考图") ||
          error.message?.startsWith("无法解析") ||
          error.message?.startsWith("账单记录")
            ? error.message
            : "无法读取上传文件，请检查后重试。",
      });
    } finally {
      busy = false;
    }
  };
}
