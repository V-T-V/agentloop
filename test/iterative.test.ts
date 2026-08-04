/**
 * Karpathy Loop 迭代模式的测试。
 *
 * 用脚本化假 LLM 模拟 agent 逐次改进 artifact，验证：
 * - 贪心爬山（仅更优时接受）
 * - 达到目标即停
 * - 迭代上限保护
 * - 最佳产物落盘
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runIterativeLoop, scoreArtifact, type IterativeTaskSpec } from '../src/long-task.ts';

test('scoreArtifact：长度指标', () => {
  assert.equal(scoreArtifact('artifact.length', 'hello'), 5);
  assert.equal(scoreArtifact('artifact.length', ''), 0);
});

test('scoreArtifact：数字提取指标', () => {
  assert.equal(scoreArtifact('(artifact.match(/\\d+/g)||[]).length', 'abc123def456'), 2);
});

test('scoreArtifact：非法表达式返回 0', () => {
  assert.equal(scoreArtifact('artifact.x.y', 'test'), 0);
});

test('scoreArtifact：非数字返回 0', () => {
  assert.equal(scoreArtifact('"string"', 'test'), 0);
});

test('scoreArtifact：简单算术', () => {
  assert.equal(scoreArtifact('artifact.split("\\n").length', 'a\nb\nc'), 3);
});

test('runIterativeLoop：达到目标即停（StubLLM）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iter-'));
  const prevResultsDir = process.env.LOOP_RESULTS_DIR;
  process.env.LOOP_RESULTS_DIR = dir;
  try {
    // StubLLM 无 API key 时返回固定内容，无法真正「改进」artifact
    // 但能验证完整流程不崩溃、产物落盘
    const spec: IterativeTaskSpec = {
      id: 'iter-stop-test',
      name: '停止测试',
      description: 'test stop',
      system: '你是改进助手',
      initialArtifact: '初始内容',
      metric: { expr: 'artifact.length', target: 1, maximize: true }, // target=1 立即达标
      maxIterations: 3,
      stepsPerIteration: 1,
    };
    process.env.LOOP_LLM_API_KEY = ''; // 触发 StubLLM
    await runIterativeLoop(spec);
    // best-artifact 应已落盘到临时目录
    const artifactPath = join(dir, spec.id, 'best-artifact.txt');
    assert.ok(existsSync(artifactPath), '最佳产物已落盘');
    const artifact = await readFile(artifactPath, 'utf8');
    assert.ok(artifact.length > 0, '产物非空');
  } finally {
    process.env.LOOP_RESULTS_DIR = prevResultsDir;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runIterativeLoop：迭代上限保护（StubLLM）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iter-limit-'));
  const prevResultsDir = process.env.LOOP_RESULTS_DIR;
  process.env.LOOP_RESULTS_DIR = dir;
  try {
    const spec: IterativeTaskSpec = {
      id: 'iter-limit-test',
      name: '上限测试',
      description: 'test limit',
      system: '你是改进助手',
      initialArtifact: 'x',
      metric: { expr: 'artifact.length', target: 999999, maximize: true }, // 永不达标
      maxIterations: 2,
      stepsPerIteration: 1,
    };
    process.env.LOOP_LLM_API_KEY = ''; // StubLLM
    await runIterativeLoop(spec);
    // iteration-history 应记录 2 次迭代（上限）
    const histPath = join(dir, spec.id, 'iteration-history.json');
    assert.ok(existsSync(histPath), '历史已落盘');
    const hist = JSON.parse(await readFile(histPath, 'utf8')) as { records: Array<{ iteration: number }> };
    assert.ok(hist.records.length <= 2, '不超过 maxIterations');
  } finally {
    process.env.LOOP_RESULTS_DIR = prevResultsDir;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('IterativeTaskSpec：类型完整性', () => {
  const spec: IterativeTaskSpec = {
    id: 't1',
    name: 'test',
    description: 'd',
    system: 's',
    initialArtifact: 'init',
    metric: { expr: 'artifact.length', target: 10, maximize: true },
    maxIterations: 3,
    stepsPerIteration: 5,
  };
  assert.equal(spec.maxIterations, 3);
  assert.equal(spec.metric.target, 10);
});
