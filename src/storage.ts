/**
 * 持久化存储抽象。
 *
 * 只定义接口与数据形状，不绑定具体后端——文件、SQLite、向量库都能实现。
 * 当前项目默认用文件实现（见 storage-file.ts，保持零依赖）。
 *
 * 设计为「整段会话」存取：一个 session = system + 全部消息 + 元信息，
 * 加载后可直接重建 Memory，对话上下文无损恢复。
 */

import type { Message } from './types.ts';

/** 一次序列化后的完整会话（可 JSON 化、可往返恢复） */
export interface SerializedSession {
  /** 会话 id（文件名主干，默认时间戳） */
  id: string;
  /** 展示标题（默认取首条用户消息截断） */
  title: string;
  /** 系统提示（Memory 首条 system 消息） */
  system: string;
  /** 全部消息（含 system 首条） */
  messages: Message[];
  /** 创建时间（ISO） */
  createdAt: string;
  /** 最后更新时间（ISO） */
  updatedAt: string;
}

/** 列表展示用的轻量元信息（不加载全部消息） */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** 存储后端接口：任何实现（文件/SQLite/远程）都需满足 */
export interface SessionStore {
  save(id: string, data: SerializedSession): Promise<void>;
  load(id: string): Promise<SerializedSession | null>;
  list(): Promise<SessionMeta[]>;
  delete(id: string): Promise<void>;
}

/** 序列化格式的版本号，便于未来迁移 */
export const SESSION_FORMAT_VERSION = 1;
