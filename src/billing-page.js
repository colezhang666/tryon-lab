const $ = (id) => document.getElementById(id);
const decimal = (value) =>
  value == null
    ? "待核对"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
function note(text, error = false) {
  $("billing-message").textContent = text;
  $("billing-message").className = `status-message${error ? " error" : ""}`;
}
let latest;
export async function enterBilling() {
  $("refresh-billing").disabled = true;
  try {
    const response = await fetch("/api/billing", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    latest = data;
    const snapshot = data.snapshot;
    $("official-spent").textContent = decimal(snapshot?.spent);
    $("official-balance").textContent = decimal(snapshot?.balance);
    $("official-image-spent").textContent = decimal(snapshot?.imageSpent);
    $("official-video-spent").textContent = decimal(snapshot?.videoSpent);
    $("billing-checked").textContent = snapshot
      ? `官方控制台人工核对 · ${date(snapshot.checkedAt)} · 账号全部 API Key`
      : "尚无平台核对值，请打开官方用量页核对后录入。";
    $("billing-records").replaceChildren();
    const records = data.records ?? [];
    const subtotal = records
      .filter(
        (row) =>
          ["completed", "ended"].includes(row.status) &&
          row.estimatedCredits !== null,
      )
      .reduce((sum, row) => sum + row.estimatedCredits, 0);
    $("local-estimate").textContent = `${decimal(subtotal)} 积分（估算）`;
    $("billing-empty").hidden = records.length > 0;
    for (const row of records) {
      const tr = document.createElement("tr");
      const status =
        {
          submitted:
            row.kind === "realtime" ? "凭证已签发，未确认生成" : "已提交",
          pending: "排队中",
          processing: "生成中",
          completed: "已完成",
          failed: "失败，扣费待核对",
          unknown: "结果待核对",
          running: "生成中（客户端统计）",
          ended: "已结束（客户端统计）",
        }[row.status] || "待核对";
      for (const text of [
        date(row.createdAt),
        { image: "图片", video: "视频", realtime: "相机实时" }[row.kind],
        row.model,
        status,
        row.units === null
          ? "未知"
          : `${decimal(row.units)} ${row.kind === "image" ? "张" : "秒"}`,
        row.estimatedCredits === null
          ? "未知，不代表0"
          : `约 ${decimal(row.estimatedCredits)}`,
        "待平台逐笔核对",
        row.origin === "historical_log" ? "历史测试日志补录" : "本地自动记录",
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      tr.title = row.note || "";
      $("billing-records").append(tr);
    }
    note(
      data.warning ||
        "刷新只读取本地账单，不会生成素材或自动扣费。平台积分为带时间的核对快照，不是实时余额。",
      Boolean(data.warning),
    );
  } catch {
    note("无法读取账单数据库，请检查后端服务。", true);
  } finally {
    $("refresh-billing").disabled = false;
  }
}
$("refresh-billing").onclick = enterBilling;
$("open-reconcile").onclick = () => {
  $("reconcile-panel").hidden = !$("reconcile-panel").hidden;
  if (!$("reconcile-panel").hidden) {
    for (const [id, key] of [
      ["reconcile-spent", "spent"],
      ["reconcile-balance", "balance"],
      ["reconcile-image", "imageSpent"],
      ["reconcile-video", "videoSpent"],
    ])
      $(id).value = latest?.snapshot?.[key] ?? "";
  }
};
$("reconcile-form").onsubmit = async (event) => {
  event.preventDefault();
  $("save-reconcile").disabled = true;
  const input = {};
  for (const [id, key] of [
    ["reconcile-spent", "spent"],
    ["reconcile-balance", "balance"],
    ["reconcile-image", "imageSpent"],
    ["reconcile-video", "videoSpent"],
  ])
    input[key] = $(id).value === "" ? null : Number($(id).value);
  try {
    const response = await fetch("/api/billing/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    $("reconcile-panel").hidden = true;
    await enterBilling();
    note("平台核对值已保存到本机数据库。");
  } catch (error) {
    note(error.message || "保存失败，请检查积分数字。", true);
  } finally {
    $("save-reconcile").disabled = false;
  }
};
$("export-billing").onclick = () => {
  if (!latest) return;
  const blob = new Blob([JSON.stringify(latest, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tryon-billing.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};
