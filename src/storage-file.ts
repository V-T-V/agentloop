/**
 * 会话存储的文件实现。
 *
 * 每个 session 一个 JSON 文件，存于 LOOP_SESSION_DIR（默认 .agentloop/sessions）。
 * - 原子写：先写 <id>.json.tmp 再 rename，防中途崩溃损坏。
 * - list() 容错：损坏的 JSON 文件跳过而非整体失败。
 * - 零依赖：仅用 node:fs / node:path 的 promise 版。
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from './env.ts';
import type { SerializedSession, SessionMeta, SessionStore } from './storage.ts';

const SCHEMA_KEY = 'agentloop-session';

/** 完整持久化记录（带格式版本，便于未来迁移） */
interface PersistedRecord {
  __schema: typeof SCHEMA_KEY;
  version: number;
  data: SerializedSession;
}

export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? env('LOOP_SESSION_DIR', '.agentloop/sessions');
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(id: string, data: SerializedSession): Promise<void> {
    await this.ensureDir();
    const record: PersistedRecord = { __schema: SCHEMA_KEY, version: 1, data };
    const finalPath = this.path(id);
    const tmpPath = `${finalPath}.tmp`;
    // 原子写：先写 tmp，再 rename。rename 在同一文件系统上是原子的。
    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<SerializedSession | null> {
    try {
      const raw = await readFile(this.path(id), 'utf8');
      const record = JSON.parse(raw) as PersistedRecord;
      if (record.__schema !== SCHEMA_KEY) return null;
      return record.data;
    } catch {
      // 文件不存在或解析失败，统一返回 null
      return null;
    }
  }

  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // 目录不存在视为空
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp.json')) continue;
      const id = name.slice(0, -5); // 去掉 .json
      try {
        const raw = await readFile(join(this.dir, name), 'utf8');
        const record = JSON.parse(raw) as PersistedRecord;
        if (record.__schema !== SCHEMA_KEY) continue;
        metas.push({
          id,
          title: record.data.title,
          updatedAt: record.data.updatedAt,
          messageCount: record.data.messages.length,
        });
      } catch {
        // 损坏文件跳过，不阻塞列表
        continue;
      }
    }
    // 按更新时间倒序（最近在前）
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    try {
      await rm(this.path(id), { force: true });
    } catch {
      // 删除失败不抛（可能本就不存在）
    }
  }
}

/** 生成一个会话 id（时间戳 + 随机后缀，保证唯一且可排序） */
export function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${rand}`;
}

/** 从 Memory 生成 SerializedSession（带默认 title） */
export function makeSession(
  id: string,
  system: string,
  messages: { serializeMessages: () => unknown[] },
  title?: string,
): SerializedSession {
  const msgs = messages.serializeMessages() as SerializedSession['messages'];
  const now = new Date().toISOString();
  // 默认标题：首条用户消息前 30 字符
  const firstUser = msgs.find((m) => m.role === 'user');
  const defaultTitle = firstUser?.content
    ? String(firstUser.content).slice(0, 30)
    : '（新会话）';
  return {
    id,
    title: title || defaultTitle,
    system,
    messages: msgs,
    createdAt: now,
    updatedAt: now,
  };
}
