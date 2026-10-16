const $ = (id) => document.getElementById(id);
const api = window.tryonDesktop;
let busy = false;
const message = (text, error = false) => {
  $("setup-status").textContent = text;
  $("setup-status").className = error ? "error" : "";
};
function configured(value) {
  $("enter-workbench").hidden = !value;
  $("clear-key").hidden = !value;
}
async function operate(operation, text) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button, input").forEach((element) => element.disabled = true);
  message(text);
  try {
    const result = await operation();
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) { message(error.message || "操作失败，请重试。", true); }
  finally {
    busy = false;
    document.querySelectorAll("button, input").forEach((element) => element.disabled = false);
  }
}
$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("api-key").value;
  $("api-key").value = "";
  await operate(() => api.save(key), "正在检查平台认证并保存…");
});
$("toggle-key").onclick = () => {
  const show = $("api-key").type === "password";
  $("api-key").type = show ? "text" : "password";
  $("toggle-key").textContent = show ? "隐藏" : "显示";
  $("toggle-key").setAttribute("aria-pressed", String(show));
};
$("enter-workbench").onclick = () => operate(() => api.enter(), "正在打开工作台…");
$("clear-key").onclick = () => $("delete-dialog").showModal();
$("cancel-delete").onclick = () => $("delete-dialog").close();
$("confirm-delete").onclick = async () => {
  $("delete-dialog").close();
  const result = await operate(() => api.clear(), "正在删除…");
  if (result) { configured(false); message("已删除，请填写你自己的新 Key。"); }
};
document.querySelectorAll("[data-page]").forEach((button) => {
  button.onclick = async () => {
    const result = await api.openOfficial(button.dataset.page);
    if (!result.ok) message(result.error, true);
  };
});
api.status().then((result) => {
  if (!result.ok) return message(result.error, true);
  configured(result.configured);
  message(result.warning || (result.configured ? "已保存 Key。可以直接进入，也可以填写新 Key 替换。" : "安装包未附带任何账号 Key，请使用自己的账号。"), Boolean(result.warning));
}).catch(() => message("无法读取配置，请重启应用。", true));
