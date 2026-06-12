import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import * as schema from "./schema";

// 数据库文件路径，放在项目根目录的 data 目录下
const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "sqlite.db");
// 迁移文件目录（drizzle-kit generate 产出，随仓库提交）
const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

// 确保 data 目录存在
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// 创建 better-sqlite3 连接实例
const sqlite = new Database(DB_PATH);

// 开启 WAL 模式，提升并发读写性能
sqlite.pragma("journal_mode = WAL");
// 开启外键约束
sqlite.pragma("foreign_keys = ON");

// 创建 drizzle ORM 实例，绑定 schema 以支持关系查询
export const db = drizzle(sqlite, { schema });

// 开箱即用：启动时自动应用迁移，确保全新克隆/空库也能建好所有表
// （修复 issue #2「no such table: projects」——data/ 被 gitignore，开箱无表）
try {
  if (fs.existsSync(MIGRATIONS_DIR)) {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }
} catch (err) {
  console.error("数据库迁移失败:", err);
}

// 兼容函数式调用
export function getDb() {
  return db;
}
