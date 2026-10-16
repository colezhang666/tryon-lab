import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const rates = {
  image: { model: "lucy-image-2", usd: 20000, credits: 2 },
  video: { model: "lucy-vton-3.5", usd: 40000, credits: 4 },
  realtime: { model: "lucy-vton-3.5", usd: 20000, credits: 2 },
};
export function createLedger(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,createdAt TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,units REAL,cap REAL,usdMicros INTEGER,estimatedCredits REAL,origin TEXT NOT NULL,note TEXT NOT NULL,providerId TEXT);
  CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY,checkedAt TEXT NOT NULL,spent REAL NOT NULL,balance REAL NOT NULL,imageSpent REAL,videoSpent REAL,source TEXT NOT NULL);`);
  let warning = null;
  const costs = (kind, units) =>
    units === null
      ? [null, null]
      : [
          Math.round(units * rates[kind].usd),
          Math.round(units * rates[kind].credits * 1000) / 1000,
        ];
  const ledger = {
    start({
      kind,
      units = null,
      cap = null,
      note = "",
      origin = "automatic",
      createdAt = new Date().toISOString(),
      id = randomUUID(),
    }) {
      if (
        !rates[kind] ||
        (units !== null && (!Number.isFinite(units) || units < 0))
      )
        throw new Error("账单记录参数无效。");
      const [usd, credits] = costs(kind, units);
      try {
        db.prepare("INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
          id,
          createdAt,
          kind,
          rates[kind].model,
          "submitted",
          units,
          cap,
          usd,
          credits,
          origin,
          note,
          null,
        );
      } catch {
        throw new Error("账单记录写入失败，本次未提交生成。");
      }
      return id;
    },
    update(id, { status, units, providerId, note } = {}) {
      try {
        const row = db.prepare("SELECT * FROM calls WHERE id=?").get(id);
        if (!row) return false;
        const quantity = units === undefined ? row.units : units;
        const [usd, credits] = costs(row.kind, quantity);
        db.prepare(
          "UPDATE calls SET status=?,units=?,usdMicros=?,estimatedCredits=?,providerId=?,note=? WHERE id=?",
        ).run(
          status ?? row.status,
          quantity,
          usd,
          credits,
          providerId ?? row.providerId,
          note ?? row.note,
          id,
        );
        return true;
      } catch {
        warning = "部分账单记录更新失败，请到官方用量页核对。";
        return false;
      }
    },
    reportRealtime({ id, seconds, status }) {
      const row = db
        .prepare("SELECT * FROM calls WHERE id=? AND kind=?")
        .get(id, "realtime");
      if (
        !row ||
        !["running", "ended"].includes(status) ||
        (seconds !== null &&
          (!Number.isFinite(seconds) || seconds < 0 || seconds > row.cap))
      )
        throw new Error("实时用量报告无效。");
      const units =
        seconds === null ? row.units : Math.max(row.units ?? 0, seconds);
      return ledger.update(id, {
        units,
        status: row.status === "ended" ? "ended" : status,
        note: "客户端SDK生成秒数；不是平台实扣账单。未收到秒数不代表免费。",
      });
    },
    snapshot(input, checkedAt = new Date().toISOString()) {
      for (const key of ["spent", "balance"])
        if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1e9)
          throw new Error("平台积分必须为非负数字。");
      for (const key of ["imageSpent", "videoSpent"])
        if (
          input[key] != null &&
          (!Number.isFinite(input[key]) ||
            input[key] < 0 ||
            input[key] > input.spent)
        )
          throw new Error("模型消耗不能超过总消耗。");
      if (
        input.imageSpent != null &&
        input.videoSpent != null &&
        input.imageSpent + input.videoSpent > input.spent + 0.001
      )
        throw new Error("模型消耗之和不能超过总消耗。");
      db.prepare(
        "INSERT INTO snapshots(checkedAt,spent,balance,imageSpent,videoSpent,source) VALUES(?,?,?,?,?,?)",
      ).run(
        checkedAt,
        input.spent,
        input.balance,
        input.imageSpent ?? null,
        input.videoSpent ?? null,
        "official_console_manual",
      );
    },
    read() {
      return {
        snapshot:
          db
            .prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1")
            .get() ?? null,
        records: db
          .prepare("SELECT * FROM calls ORDER BY createdAt DESC LIMIT 500")
          .all(),
        warning,
        scope: "official_snapshot_all_api_keys",
        automaticOfficialSync: false,
        ratesNote:
          "公开美元价格估算；积分参考2/张、视频4/秒、实时2/秒，仅作参考换算，逐笔实扣待平台核对。",
      };
    },
    close() {
      db.close();
    },
  };
  return ledger;
}
