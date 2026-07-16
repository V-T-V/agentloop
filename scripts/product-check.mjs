import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shouldWrite = process.argv.includes("--write");

const gates = [
  {
    id: "agent-loop-core",
    label: "LLM tool-calling loop and typed contracts",
    required: ["src/loop.ts", "src/llm.ts", "src/types.ts", "src/memory.ts", "src/schema.ts", "test/loop.test.ts", "test/schema.test.ts"],
  },
  {
    id: "context-streaming-trace",
    label: "Context engineering, streaming, observability",
    required: [
      "src/compact.ts",
      "src/tokens.ts",
      "src/streaming.ts",
      "src/trace.ts",
      "src/otel.ts",
      "src/metrics.ts",
      "test/compact.test.ts",
      "test/streaming.test.ts",
      "test/trace.test.ts",
      "test/otel.test.ts",
      "test/metrics.test.ts",
    ],
  },
  {
    id: "execution-safety",
    label: "Budget, retry, checkpoint, HITL-ready safety",
    required: [
      "src/budget.ts",
      "src/retry.ts",
      "src/checkpoint.ts",
      "src/errors.ts",
      "src/tools/http_get.ts",
      "test/budget.test.ts",
      "test/checkpoint.test.ts",
      "test/http_get.test.ts",
    ],
  },
  {
    id: "subagents-and-long-tasks",
    label: "Sub-agent fanout and long-task support",
    required: [
      "src/fanout.ts",
      "src/subagent.ts",
      "src/long-task.ts",
      "src/run-task.ts",
      "tasks/l1-days.json",
      "tasks/l3-collatz.json",
      "long-tasks/deep-research-example.json",
      "test/fanout.test.ts",
      "test/subagent.test.ts",
      "test/long-task.test.ts",
    ],
  },
  {
    id: "memory-trajectory-eval",
    label: "Persistent memory, trajectory replay, evaluation",
    required: [
      "src/storage.ts",
      "src/storage-file.ts",
      "src/trace-store.ts",
      "src/trajectory.ts",
      "src/eval.ts",
      "src/verify.ts",
      "test/storage.test.ts",
      "test/trace-store.test.ts",
      "test/trajectory.test.ts",
      "test/eval.test.ts",
      "test/verify.test.ts",
    ],
  },
  {
    id: "tool-and-mcp-surface",
    label: "Built-in tools, search, and MCP adapter",
    required: [
      "src/tools/registry.ts",
      "src/tools/calculator.ts",
      "src/tools/datetime.ts",
      "src/tools/iterate.ts",
      "src/tools/web_search.ts",
      "src/tools/search/backends.ts",
      "src/mcp/client.ts",
      "src/mcp/adapter.ts",
      "test/calculator.test.ts",
      "test/iterate.test.ts",
      "test/web_search.test.ts",
      "test/mcp.test.ts",
    ],
  },
  {
    id: "operator-surface",
    label: "CLI, docs, and product direction",
    required: ["src/cli.ts", "README.md", "PRODUCT.md", ".env.example", "research/long-running-agents.md"],
  },
];

function abs(file) {
  return join(root, file);
}

function countTests() {
  return readdirSync(abs("test")).filter((name) => name.endsWith(".test.ts")).length;
}

const checkedAt = new Date().toISOString();
const results = gates.map((gate) => {
  const missing = gate.required.filter((file) => !existsSync(abs(file)));
  return { id: gate.id, label: gate.label, status: missing.length ? "fail" : "pass", missing };
});

const summary = {
  checkedAt,
  project: "agentloop",
  product: "Reusable LLM tool-calling execution kernel",
  gates: results.length,
  passed: results.filter((item) => item.status === "pass").length,
  failed: results.filter((item) => item.status === "fail").length,
  tests: countTests(),
  results,
};

for (const result of results) {
  console.log(`${result.status === "pass" ? "PASS" : "FAIL"} ${result.id} - ${result.label}`);
  for (const file of result.missing) console.log(`  missing: ${file}`);
}
console.log(`\nProduct gates: ${summary.passed}/${summary.gates} passed`);
console.log(`Test files: ${summary.tests}`);

if (shouldWrite) {
  const out = abs(".agentloop/product-status.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

if (summary.failed > 0) process.exit(1);
