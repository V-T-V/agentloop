/**
 * 持久化向量记忆：跨会话的事实存储与检索（简易 RAG）。
 *
 * 动机：当前 Memory 是纯内存消息缓冲，进程结束即丢失。长任务需要记住之前调研过的
 * 事实——避免重复搜索同样的内容。
 *
 * 设计（零依赖）：
 * - 用词频统计（TF）构造简易「向量」——不是真正的 embedding，但对关键词检索足够
 * - 余弦相似度匹配
 * - 文件持久化（JSON），原子写
 *
 * 这不是生产级向量库（无 embedding model），而是零依赖的轻量替代。
 * 未来可替换为真正的 embedding 后端，接口不变。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.ts';

/** 单条记忆记录 */
export interface MemoryRecord {
  /** 唯一 id（时间戳+随机） */
  id: string;
  /** 原文内容 */
  text: string;
  /** 词频向量（text 的 TF 表示） */
  vector: Map<string, number>;
  /** 元信息（如来源、时间、关联任务） */
  metadata?: Record<string, unknown>;
  /** 创建时间（ISO） */
  createdAt: string;
}

/** 搜索结果 */
export interface MemorySearchResult {
  record: MemoryRecord;
  /** 相似度分数（0-1，越高越相关） */
  score: number;
}

const SCHEMA_KEY = 'agentloop-memory-store';

interface PersistedStore {
  __schema: typeof SCHEMA_KEY;
  version: number;
  records: MemoryRecord[];
}

/**
 * 分词：把文本拆成词频 Map（简易 TF 向量）。
 * 中文按字符 + 英文按单词，小写化，去停用词。
 */
function tokenize(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', 'a', 'an', 'the', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but']);
  // 英文单词
  const words = text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  for (const w of words) {
    if (stopWords.has(w)) continue;
    vec.set(w, (vec.get(w) ?? 0) + 1);
  }
  // 中文字符（按 2-gram 提升匹配质量）
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const segment of cjk) {
    for (let i = 0; i < segment.length - 1; i++) {
      const bigram = segment.slice(i, i + 2);
      vec.set(bigram, (vec.get(bigram) ?? 0) + 1);
    }
    // 单字也加（覆盖短查询）
    for (const ch of segment) {
      if (stopWords.has(ch)) continue;
      vec.set(ch, (vec.get(ch) ?? 0) + 0.5); // 单字权重低
    }
  }
  return vec;
}

/** 余弦相似度（两个词频 Map） */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  // 遍历较小的 map 提升性能
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [key, val] of small) {
    const other = large.get(key);
    if (other !== undefined) dot += val * other;
    normA += val * val;
  }
  for (const [, val] of large) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 持久化向量记忆存储。
 * 文件路径：LOOP_MEMORY_DIR（默认 .agentloop/memory），原子写。
 */
export class MemoryStore {
  private readonly dir: string;
  private records: MemoryRecord[] = [];

  constructor(dir?: string) {
    this.dir = dir ?? env('LOOP_MEMORY_DIR', '.agentloop/memory');
  }

  private get path(): string {
    return join(this.dir, 'store.json');
  }

  /** 从磁盘加载（若文件存在） */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PersistedStore;
      if (parsed.__schema !== SCHEMA_KEY) return;
      // JSON 中 Map 变成普通对象，需还原
      this.records = parsed.records.map((r) => ({
        ...r,
        vector: new Map(Object.entries(r.vector)),
      }));
    } catch {
      // 文件不存在或损坏，从空开始
      this.records = [];
    }
  }

  /** 持久化到磁盘（原子写） */
  async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const record: PersistedStore = {
      __schema: SCHEMA_KEY,
      version: 1,
      // Map 序列化为普通对象
      records: this.records.map((r) => ({
        ...r,
        vector: Object.fromEntries(r.vector) as unknown as Map<string, number>,
      })),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, this.path);
  }

  /** 添加一条记忆 */
  add(text: string, metadata?: Record<string, unknown>): MemoryRecord {
    const record: MemoryRecord = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      text,
      vector: tokenize(text),
      metadata,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }

  /** 搜索最相关的 k 条记忆 */
  search(query: string, k = 3): MemorySearchResult[] {
    const queryVec = tokenize(query);
    const scored = this.records
      .map((record) => ({
        record,
        score: cosineSimilarity(queryVec, record.vector),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored;
  }

  /** 当前记忆总数 */
  get size(): number {
    return this.records.length;
  }

  /** 清空全部记忆 */
  clear(): void {
    this.records = [];
  }

  /** 按条件删除（metadata 匹配） */
  delete(predicate: (r: MemoryRecord) => boolean): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => !predicate(r));
    return before - this.records.length;
  }
}
