import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export function validateKey(input) {
  if (typeof input !== "string" || !/^[\x21-\x7e]{12,512}$/.test(input.trim()))
    throw new Error("请粘贴完整的 API Key，不要包含空格或换行。");
  return input.trim();
}

export function createKeyStore(directory, encryption) {
  const file = path.join(directory, "api-key.bin");
  const ensureEncryption = () => {
    if (!encryption.isEncryptionAvailable())
      throw new Error("Windows 密钥加密不可用，无法保存。请检查系统后重试。");
  };
  return {
    async read() {
      let bytes;
      try { bytes = await readFile(file); }
      catch (error) { if (error.code === "ENOENT") return ""; throw error; }
      ensureEncryption();
      return validateKey(encryption.decryptString(bytes));
    },
    async save(input) {
      const key = validateKey(input);
      ensureEncryption();
      await mkdir(directory, { recursive: true });
      await writeFile(`${file}.tmp`, encryption.encryptString(key), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      return key;
    },
    async clear() { await rm(file, { force: true }); },
  };
}

export async function checkKey(input, fetcher = fetch) {
  const key = validateKey(input);
  let response;
  try {
    response = await fetcher("https://api.decart.ai/v1/client/tokens", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 10, allowedModels: ["lucy-vton-3.5"] }),
      signal: AbortSignal.timeout(12000),
    });
  } catch { throw new Error("连接平台超时或失败，请检查网络后重试。"); }
  if (!response.ok)
    throw new Error(response.status === 401 || response.status === 403
      ? "平台没有接受这个 Key，请检查 Key 和账号权限。"
      : "平台暂时无法验证 Key，请核对账号状态后重试。");
  let result;
  try { result = await response.json(); } catch { throw new Error("平台返回了无法识别的响应。"); }
  if (typeof result.apiKey !== "string" || !result.apiKey || result.apiKey === key)
    throw new Error("平台没有返回有效的临时凭证。");
  // A token check confirms authentication, not image access, available credits or generation quality.
  return key;
}
