export function clipDuration(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 20)
    throw new Error("视频时长必须大于 0 且不超过 20 秒。");
  return value;
}
