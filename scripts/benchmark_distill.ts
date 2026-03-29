/**
 * Distill Benchmark — Compare teacher (Gemini) vs student (Ollama) on navigation
 *
 * Runs all 5 built-in SCENARIOS with both inference backends and produces a
 * comparison table showing success rate, frames to goal, collisions, etc.
 *
 * Usage:
 *   npx tsx scripts/benchmark_distill.ts
 *   npx tsx scripts/benchmark_distill.ts --ollama-model roclaw-nav:q4km
 *   npx tsx scripts/benchmark_distill.ts --verbose
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { DreamScenarioRunner, generateDreamReport, type RunnerConfig, type ScenarioResult } from '../src/3_llmunix_memory/dream_simulator/scenario_runner';
import { SCENARIOS } from '../src/3_llmunix_memory/dream_simulator/text_scene';
import { DreamInferenceRouter, type DreamInferenceRouterConfig } from '../src/3_llmunix_memory/dream_simulator/dream_inference_router';
import { TraceOutcome } from '../src/llmunix-core/types';

dotenv.config();

// =============================================================================
// CLI
// =============================================================================

let verbose = false;
let ollamaModel = 'roclaw-nav:q8_0';
let ollamaUrl = 'http://localhost:11434';
let textModel = 'gemini-3.1-flash-lite-preview';
let tracesDir = './traces/benchmark';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--verbose': verbose = true; break;
    case '--ollama-model': ollamaModel = args[++i] || ollamaModel; break;
    case '--ollama-url': ollamaUrl = args[++i] || ollamaUrl; break;
    case '--text-model': textModel = args[++i] || textModel; break;
    case '--help':
      console.log(`Usage: npx tsx scripts/benchmark_distill.ts [options]

Options:
  --verbose                Print per-scenario progress
  --ollama-model <name>    Ollama model name (default: roclaw-nav:q8_0)
  --ollama-url <url>       Ollama API URL (default: http://localhost:11434)
  --text-model <model>     Gemini text model for teacher (default: gemini-3.1-flash-lite-preview)
  --help                   Show this help
`);
      process.exit(0);
  }
}

// =============================================================================
// Benchmark Runner
// =============================================================================

interface BenchmarkEntry {
  scenario: string;
  backend: string;
  outcome: string;
  frames: number;
  maxFrames: number;
  collisions: number;
  stuckCount: number;
  durationMs: number;
  avgLatencyMs: number;
  finalDistance: number | null;
}

async function runBenchmark(backend: string, config: RunnerConfig): Promise<BenchmarkEntry[]> {
  const runner = new DreamScenarioRunner(config);
  const entries: BenchmarkEntry[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`  ${backend}: ${scenario.title}...`);

    try {
      const result = await runner.runScenario(scenario);
      const inferStats = runner.getInferenceStats();
      const avgLatency = inferStats.totalCalls > 0
        ? Math.round(inferStats.avgLatencyMs)
        : 0;

      entries.push({
        scenario: scenario.title,
        backend,
        outcome: result.outcome,
        frames: result.framesExecuted,
        maxFrames: result.maxFrames,
        collisions: result.collisionCount,
        stuckCount: result.stuckCount,
        durationMs: result.durationMs,
        avgLatencyMs: avgLatency,
        finalDistance: result.finalTargetDistance,
      });

      const icon = result.outcome === TraceOutcome.SUCCESS ? 'OK' : 'FAIL';
      console.log(`    [${icon}] ${result.framesExecuted}f, ${result.collisionCount} collisions, ${result.durationMs}ms`);
    } catch (err) {
      console.error(`    [ERR] ${err instanceof Error ? err.message : String(err)}`);
      entries.push({
        scenario: scenario.title,
        backend,
        outcome: 'ERROR',
        frames: 0,
        maxFrames: scenario.maxFrames,
        collisions: 0,
        stuckCount: 0,
        durationMs: 0,
        avgLatencyMs: 0,
        finalDistance: null,
      });
    }
  }

  return entries;
}

async function main(): Promise<void> {
  console.log('=== RoClaw Distill Benchmark ===');
  console.log(`Teacher: Gemini (${textModel})`);
  console.log(`Student: Ollama (${ollamaModel})`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log('');

  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY required for teacher baseline');
    process.exit(1);
  }

  // Check Ollama is running
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log('Ollama server: connected');
  } catch {
    console.error(`Error: Cannot reach Ollama at ${ollamaUrl}`);
    console.error('Start with: ollama serve');
    process.exit(1);
  }

  // --- Teacher (Gemini) ---
  console.log('\n--- Teacher: Gemini ---');
  const teacherConfig: RunnerConfig = {
    googleApiKey,
    tracesDir,
    verbose,
    textModel,
    skipLocalTraces: true,
  };
  const teacherResults = await runBenchmark('gemini', teacherConfig);

  // --- Student (Ollama) ---
  // For Ollama, we use DreamInferenceRouter with a custom text model
  // but since DreamInferenceRouter only supports Gemini, we need to use
  // a different approach — create a runner with Ollama inference
  console.log('\n--- Student: Ollama ---');

  // Import OllamaInference dynamically
  const { OllamaInference } = await import('../src/2_qwen_cerebellum/ollama_inference');
  const ollama = new OllamaInference({
    baseUrl: ollamaUrl,
    model: ollamaModel,
    temperature: 0.1,
    maxTokens: 128,
  });

  // We can't directly use DreamScenarioRunner with Ollama since it only
  // takes a DreamInferenceRouter (Gemini). Instead, run scenarios manually
  // using the same pipeline.
  const { TextSceneSimulator } = await import('../src/3_llmunix_memory/dream_simulator/text_scene');
  const { BytecodeCompiler, formatHex, encodeFrame, Opcode, OPCODE_NAMES } = await import('../src/2_qwen_cerebellum/bytecode_compiler');

  const compiler = new BytecodeCompiler('fewshot');
  const STOP_FRAME = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
  const ollamaInfer = ollama.createInferenceFunction();

  const studentResults: BenchmarkEntry[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`  ollama: ${scenario.title}...`);
    const startTime = Date.now();

    try {
      const sim = new TextSceneSimulator(scenario);
      let currentFrame = sim.renderFrame();
      const systemPrompt = compiler.getTextSceneSystemPrompt(scenario.goal);
      let framesExecuted = 0;
      let collisions = 0;
      let goalReached = false;

      for (let i = 0; i < scenario.maxFrames; i++) {
        const userMessage = currentFrame.sceneText;

        let vlmOutput: string;
        try {
          vlmOutput = await ollamaInfer(systemPrompt, userMessage);
        } catch {
          vlmOutput = 'TOOLCALL:{"name":"stop","args":{}}';
        }

        let bytecode = compiler.compile(vlmOutput);
        if (!bytecode) bytecode = STOP_FRAME;

        currentFrame = sim.step(bytecode);
        framesExecuted++;
        if (currentFrame.collision) collisions++;

        if (currentFrame.goalReached) {
          goalReached = true;
          break;
        }

        const opcode = bytecode[1];
        if (opcode === Opcode.STOP) {
          if (currentFrame.targetDistance !== null && currentFrame.targetDistance <= scenario.goalThresholdCm * 1.5) {
            goalReached = true;
          }
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      const outcome = goalReached ? TraceOutcome.SUCCESS : TraceOutcome.FAILURE;
      const ollamaStats = ollama.getStats();

      studentResults.push({
        scenario: scenario.title,
        backend: 'ollama',
        outcome,
        frames: framesExecuted,
        maxFrames: scenario.maxFrames,
        collisions,
        stuckCount: 0,
        durationMs,
        avgLatencyMs: ollamaStats.averageLatencyMs,
        finalDistance: currentFrame.targetDistance,
      });

      const icon = outcome === TraceOutcome.SUCCESS ? 'OK' : 'FAIL';
      console.log(`    [${icon}] ${framesExecuted}f, ${collisions} collisions, ${durationMs}ms`);
    } catch (err) {
      console.error(`    [ERR] ${err instanceof Error ? err.message : String(err)}`);
      studentResults.push({
        scenario: scenario.title,
        backend: 'ollama',
        outcome: 'ERROR',
        frames: 0,
        maxFrames: scenario.maxFrames,
        collisions: 0,
        stuckCount: 0,
        durationMs: 0,
        avgLatencyMs: 0,
        finalDistance: null,
      });
    }
  }

  // --- Comparison Table ---
  console.log('\n=== Comparison ===');
  console.log('');
  console.log('| Scenario | Backend | Outcome | Frames | Collisions | Latency/inf | Duration |');
  console.log('|----------|---------|---------|--------|------------|-------------|----------|');

  const allResults = [...teacherResults, ...studentResults];
  // Group by scenario
  for (const scenario of SCENARIOS) {
    const teacher = teacherResults.find(r => r.scenario === scenario.title);
    const student = studentResults.find(r => r.scenario === scenario.title);

    if (teacher) {
      console.log(`| ${teacher.scenario.slice(0, 20).padEnd(20)} | gemini  | ${teacher.outcome.padEnd(7)} | ${String(teacher.frames).padEnd(6)} | ${String(teacher.collisions).padEnd(10)} | ${String(teacher.avgLatencyMs + 'ms').padEnd(11)} | ${String(teacher.durationMs + 'ms').padEnd(8)} |`);
    }
    if (student) {
      console.log(`| ${''.padEnd(20)} | ollama  | ${student.outcome.padEnd(7)} | ${String(student.frames).padEnd(6)} | ${String(student.collisions).padEnd(10)} | ${String(student.avgLatencyMs + 'ms').padEnd(11)} | ${String(student.durationMs + 'ms').padEnd(8)} |`);
    }
  }

  // Summary
  const teacherSuccess = teacherResults.filter(r => r.outcome === TraceOutcome.SUCCESS).length;
  const studentSuccess = studentResults.filter(r => r.outcome === TraceOutcome.SUCCESS).length;
  const teacherAvgLatency = teacherResults.reduce((s, r) => s + r.avgLatencyMs, 0) / teacherResults.length;
  const studentAvgLatency = studentResults.reduce((s, r) => s + r.avgLatencyMs, 0) / studentResults.length;

  console.log('');
  console.log('=== Summary ===');
  console.log(`Teacher (Gemini): ${teacherSuccess}/${SCENARIOS.length} success, avg ${Math.round(teacherAvgLatency)}ms/inference`);
  console.log(`Student (Ollama): ${studentSuccess}/${SCENARIOS.length} success, avg ${Math.round(studentAvgLatency)}ms/inference`);
  console.log(`Student achieves ${(studentSuccess / Math.max(1, teacherSuccess) * 100).toFixed(0)}% of teacher success rate`);
  console.log(`Speedup: ${(teacherAvgLatency / Math.max(1, studentAvgLatency)).toFixed(1)}x`);

  // Save detailed results
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
  const outputPath = `distill_benchmark_${timestamp}.json`;
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    teacher: { model: textModel, results: teacherResults },
    student: { model: ollamaModel, results: studentResults },
    summary: {
      teacher_success: teacherSuccess,
      student_success: studentSuccess,
      teacher_avg_latency_ms: Math.round(teacherAvgLatency),
      student_avg_latency_ms: Math.round(studentAvgLatency),
    },
  }, null, 2));
  console.log(`\nDetailed results saved to ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
