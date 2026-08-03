/**
 * mcp/registry.ts 测试 —— MCP 配置文件加载与解析。
 *
 * 不启动真实子进程，只测纯文件解析逻辑：
 *   - findMcpConfig：LOOP_MCP_CONFIG 环境变量优先；默认路径回退；找不到返回 null
 *   - loadMcpConfig：正常 JSON 解析 / 缺 mcpServers 字段 / 坏 JSON / 空 servers
 *   - 兼容 Claude Desktop 格式（同结构）
 *   - toolPrefix 以 server 名为前缀 / requiresApproval 默认 true
 *   - loadMcpFromConfig：无配置文件时返回空工具列表（不抛错）
 *
 * 全部用临时目录 + 绝对路径，避免污染工作区。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { findMcpConfig, loadMcpConfig, loadMcpFromConfig } from '../src/mcp/registry.ts';
import { env } from '../src/env.ts';

/** 写一个临时配置文件，返回绝对路径与清理函数 */
async function writeConfig(content: string, filename = 'mcp-servers.json'): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf8');
  return [path, () => rm(dir, { recursive: true, force: true })];
}

// —————————— findMcpConfig ——————————

test('findMcpConfig：LOOP_MCP_CONFIG 指定存在的路径 → 返回该路径', async () => {
  const [path, cleanup] = await writeConfig('{}');
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = path;
  try {
    const found = await findMcpConfig();
    assert.equal(found, path);
  } finally {
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
    await cleanup();
  }
});

test('findMcpConfig：LOOP_MCP_CONFIG 指定不存在的路径 → 返回 null（兜底默认路径也找不到）', async () => {
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = '/definitely/does/not/exist/xyz.json';
  try {
    // 切到临时空目录，确保默认路径也找不到
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'mcp-empty-'));
    process.chdir(dir);
    try {
      const found = await findMcpConfig();
      assert.equal(found, null);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
  }
});

test('findMcpConfig：env() 返回空串时跳过该候选', async () => {
  // LOOP_MCP_CONFIG 为空时，候选列表不应包含空串
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = '';
  try {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'mcp-empty2-'));
    process.chdir(dir);
    try {
      const found = await findMcpConfig();
      assert.equal(found, null);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
  }
});

test('findMcpConfig：默认路径 mcp-servers.json 存在时返回它', async () => {
  const old = process.env.LOOP_MCP_CONFIG;
  delete process.env.LOOP_MCP_CONFIG;
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'mcp-default-'));
  process.chdir(dir);
  await writeFile(join(dir, 'mcp-servers.json'), '{"mcpServers":{}}', 'utf8');
  try {
    const found = await findMcpConfig();
    assert.equal(found, 'mcp-servers.json');
  } finally {
    process.chdir(cwd);
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  }
});

// —————————— loadMcpConfig ——————————

test('loadMcpConfig：正常配置 → 解析为 McpToolsConfig 字典', async () => {
  const content = JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { FOO: 'bar' },
      },
      git: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-git'],
      },
    },
  });
  const [path, cleanup] = await writeConfig(content);
  try {
    const config = await loadMcpConfig(path);
    assert.ok(config);
    assert.ok(config!.filesystem);
    assert.equal(config!.filesystem.command, 'npx');
    assert.deepEqual(config!.filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    assert.deepEqual(config!.filesystem.env, { FOO: 'bar' });
    // toolPrefix 自动为 server 名
    assert.equal(config!.filesystem.toolPrefix, 'filesystem');
    assert.equal(config!.git!.toolPrefix, 'git');
    // requiresApproval 默认 true
    assert.equal(config!.filesystem.requiresApproval, true);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：requiresApproval 显式 false 时保留', async () => {
  const content = JSON.stringify({
    mcpServers: {
      trusted: {
        command: 'node',
        args: ['server.js'],
        requiresApproval: false,
      },
    },
  });
  const [path, cleanup] = await writeConfig(content);
  try {
    const config = await loadMcpConfig(path);
    assert.equal(config!.trusted!.requiresApproval, false);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：缺 mcpServers 字段 → 返回 null', async () => {
  const [path, cleanup] = await writeConfig(JSON.stringify({ other: {} }));
  try {
    const config = await loadMcpConfig(path);
    assert.equal(config, null);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：mcpServers 不是对象 → 返回 null', async () => {
  const [path, cleanup] = await writeConfig(JSON.stringify({ mcpServers: 'not-an-object' }));
  try {
    const config = await loadMcpConfig(path);
    assert.equal(config, null);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：坏 JSON → 返回 null（不抛错）', async () => {
  const [path, cleanup] = await writeConfig('{ this is not valid json');
  try {
    const config = await loadMcpConfig(path);
    assert.equal(config, null);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：空 mcpServers → 返回空字典', async () => {
  const [path, cleanup] = await writeConfig(JSON.stringify({ mcpServers: {} }));
  try {
    const config = await loadMcpConfig(path);
    assert.ok(config);
    assert.equal(Object.keys(config!).length, 0);
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：兼容 Claude Desktop 格式（同结构）', async () => {
  const content = JSON.stringify({
    mcpServers: {
      'claude-fs': {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      },
    },
  });
  const [path, cleanup] = await writeConfig(content, 'claude_desktop_config.json');
  try {
    const config = await loadMcpConfig(path);
    assert.ok(config);
    assert.equal(config!['claude-fs']!.command, 'npx');
    assert.equal(config!['claude-fs']!.toolPrefix, 'claude-fs');
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：cwd 字段透传', async () => {
  const content = JSON.stringify({
    mcpServers: {
      repo: {
        command: 'git',
        args: ['status'],
        cwd: '/some/repo',
      },
    },
  });
  const [path, cleanup] = await writeConfig(content);
  try {
    const config = await loadMcpConfig(path);
    assert.equal(config!.repo!.cwd, '/some/repo');
  } finally {
    await cleanup();
  }
});

test('loadMcpConfig：文件不存在（无 path 参数且 findMcpConfig 返回 null）→ 返回 null', async () => {
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = '/no/such/path/abc.json';
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'mcp-none-'));
  process.chdir(dir);
  try {
    const config = await loadMcpConfig();
    assert.equal(config, null);
  } finally {
    process.chdir(cwd);
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  }
});

// —————————— loadMcpFromConfig ——————————

test('loadMcpFromConfig：无配置文件 → 返回空工具列表（不抛错）', async () => {
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = '/no/such/path/def.json';
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'mcp-nocfg-'));
  process.chdir(dir);
  try {
    const { tools, closeAll } = await loadMcpFromConfig();
    assert.deepEqual(tools, []);
    await closeAll(); // 应为空操作
  } finally {
    process.chdir(cwd);
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('env：LOOP_MCP_CONFIG 读取（间接验证 env 函数被使用）', () => {
  const old = process.env.LOOP_MCP_CONFIG;
  process.env.LOOP_MCP_CONFIG = '/test/path/from/env';
  try {
    assert.equal(env('LOOP_MCP_CONFIG', ''), '/test/path/from/env');
    assert.equal(env('LOOP_MCP_CONFIG', 'fallback'), '/test/path/from/env');
  } finally {
    if (old === undefined) delete process.env.LOOP_MCP_CONFIG;
    else process.env.LOOP_MCP_CONFIG = old;
  }
});

test('loadMcpConfig：resolve 路径处理（相对 vs 绝对）', async () => {
  // 给绝对路径应能正常解析
  const [path, cleanup] = await writeConfig(
    JSON.stringify({ mcpServers: { a: { command: 'x' } } }),
  );
  try {
    const config = await loadMcpConfig(resolve(path));
    assert.ok(config);
    assert.equal(config!.a!.command, 'x');
  } finally {
    await cleanup();
  }
});
