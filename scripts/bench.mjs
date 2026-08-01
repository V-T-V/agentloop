#!/usr/bin/env node
/**
 * 离线性能基准报告：跑 src/bench.ts 的全部预置场景，输出格式化报告。
 *
 * 用法：
 *   node --import tsx scripts/bench.mjs            # 跑全部基准
 *   node --expose-gc --import tsx scripts/bench.mjs # 含 GC 后的内存测量更准
 *
 * 输出示例：
 *   [estimateTokens(10k chars)] 5000 次 | avg 12.34μs | p50 11.50μs | p95 18.20μs | 81000 ops/s
 */

import { runAllBenchmarks, BenchmarkRunner } from '../src/bench.ts';

async function main() {
  const runner = new BenchmarkRunner();
  console.log('agentloop 性能基准报告');
  console.log('='.repeat(60));
  console.log(`Node ${process.version} | ${process.platform}/${process.arch}`);
  console.log(`GC ${'gc' in globalThis ? '已暴露(--expose-gc)' : '未暴露(内存测量仅供参考)'}`);
  console.log('-'.repeat(60));

  const results = await runAllBenchmarks();
  for (const res of results) {
    console.log(runner.format(res));
  }
  console.log('-'.repeat(60));
  console.log(`共 ${results.length} 个场景`);
}

main().catch((e) => {
  console.error('基准测试失败：', e);
  process.exit(1);
});
