export const stopTracks = (stream) =>
  stream?.getTracks().forEach((track) => track.stop());

// One generation number invalidates every late result after stop, timeout or navigation.
export class Session {
  constructor({
    connect,
    token,
    onState,
    onStream,
    onTime,
    now = Date.now,
    interval = (fn, ms) => setInterval(fn, ms),
    clear = (timer) => clearInterval(timer),
    onUsage = () => {},
  }) {
    Object.assign(this, {
      connect,
      token,
      onState,
      onStream,
      onTime,
      now,
      interval,
      clear,
      onUsage,
    });
    this.sequence = 0;
    this.active = false;
  }
  async start(source, image, prompt, duration) {
    if (this.active) return;
    const sequence = ++this.sequence;
    const current = () => this.active && this.sequence === sequence;
    this.active = true;
    this.upload = source.clone();
    const upload = this.upload;
    this.started = this.now();
    this.hasFrame = false;
    this.receipt = null;
    this.onState("connecting", "正在获取连接凭证…");
    this.onTime(0, duration);
    this.timer = this.interval(() => {
      const elapsed = (this.now() - this.started) / 1000;
      this.onTime(Math.min(elapsed, duration), duration);
      if (elapsed >= duration) this.stop("本次时限已到，已停止。");
      else if (elapsed >= 15 && !this.hasFrame)
        this.stop("等待云端画面超时，请检查网络后重试。", "error");
    }, 200);
    try {
      const token = await this.token(duration);
      if (!current()) return;
      const credential = typeof token === "string" ? token : token.apiKey;
      if (token.billId) this.receipt = { id: token.billId, seconds: null };
      this.onState("connecting", "正在连接云端…");
      const client = await this.connect(upload, {
        credential,
        image,
        prompt,
        onRemoteStream: (stream) => {
          if (!current()) return stopTracks(stream);
          this.hasFrame = false;
          if (this.remote !== stream) stopTracks(this.remote);
          this.remote = stream;
          this.onStream(stream);
          this.onState("streaming", "云端视频流已到达，正在等待可播放画面。");
        },
        onConnectionChange: (state) => {
          if (current() && ["disconnected", "reconnecting"].includes(state))
            this.stop("云端连接已中断，请手动重试。", "error");
        },
      });
      if (!current()) {
        client.disconnect();
        return;
      }
      this.client = client;
      client.on("generationTick", ({ seconds }) => {
        if (
          !current() ||
          !this.receipt ||
          !Number.isFinite(seconds) ||
          seconds < 0
        )
          return;
        this.receipt.seconds = Math.min(
          duration,
          Math.max(this.receipt.seconds ?? 0, seconds),
        );
        this.onUsage({ ...this.receipt, status: "running" });
      });
      client.on(
        "error",
        () =>
          current() &&
          this.stop("云端连接出错，请检查网络或官方账号状态。", "error"),
      );
      client.on(
        "sessionEnded",
        ({ reason }) =>
          current() &&
          this.stop(
            reason === "insufficient_credits"
              ? "平台报告积分不足，请到官方控制台检查。"
              : "平台已结束本次会话。",
            "error",
          ),
      );
    } catch (error) {
      if (current())
        this.stop(
          error.userMessage ||
            "无法连接试穿服务，请检查网络、密钥权限或官方平台状态。",
          "error",
        );
    } finally {
      if (!current()) stopTracks(upload);
    }
  }
  stop(message = "已停止，可调整后重新开始。", state = "stopped") {
    this.sequence++;
    this.active = false;
    this.clear(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    if (this.receipt) this.onUsage({ ...this.receipt, status: "ended" });
    this.receipt = null;
    client?.disconnect();
    stopTracks(this.upload);
    stopTracks(this.remote);
    this.upload = this.remote = null;
    this.onStream(null);
    this.onState(state, message);
  }
}
