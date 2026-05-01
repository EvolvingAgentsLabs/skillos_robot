/**
 * Dream Loop Experiment — Bio-Inspired Learning Cycle
 *
 * Tests the core thesis: does dreaming on navigation traces produce
 * strategies that improve subsequent performance?
 *
 * Phases:
 *   1. BASELINE   — 3 trials (no strategies loaded)
 *   2. DREAM      — Read traces, call Gemini, write strategies
 *   3. POST-DREAM — 3 trials (with learned strategies)
 *   4. REPORT     — Compare metrics, print improvement table
 *
 * Prerequisites:
 *   1. Scene server on :8000  (cd sim && python build_scene.py)
 *   2. Bridge on :9090/:8081/:4210  (npm run sim:3d)
 *   3. Browser open at http://localhost:8000?bridge=ws://localhost:9090
 *
 * Usage:
 *   GOOGLE_API_KEY=... npm run dream:loop
 *   GOOGLE_API_KEY=... npx tsx scripts/dream_loop.ts
 *   GOOGLE_API_KEY=... npx tsx scripts/dream_loop.ts --trials 5
 *   GOOGLE_API_KEY=... npx tsx scripts/dream_loop.ts --goal "find the blue box"
 */

import { spawnSync } from 'child_process';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const ROCLAW_ROOT = path.resolve(__dirname, '..');
const TRACES_DIR = path.join(ROCLAW_ROOT, 'traces', 'sim3d');
const STRATEGIES_DIR = path.join(ROCLAW_ROOT, 'src', 'brain', 'memory', 'strategies');
const LEVEL_2_DIR = path.join(STRATEGIES_DIR, 'level_2_routes');
const LEVEL_4_DIR = path.join(STRATEGIES_DIR, 'level_4_motor');
const CONSTRAINTS_FILE = path.join(STRATEGIES_DIR, '_negative_constraints.md');
const JOURNAL_FILE = path.join(STRATEGIES_DIR, '_dream_journal.md');

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || '';
const DREAM_MODEL = process.env.DREAM_MODEL || 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const INTER_TRIAL_PAUSE_MS = 5000;

// CLI args
let TRIALS_PER_PHASE = 3;
let GOAL = 'navigate to the red cube';
let USE_LOCAL = false;
let LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
let OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--trials') TRIALS_PER_PHASE = parseInt(args[++i] || '3', 10);
  if (args[i] === '--goal') GOAL = args[++i] || GOAL;
  if (args[i] === '--local') USE_LOCAL = true;
  if (args[i] === '--model') LOCAL_MODEL = args[++i] || LOCAL_MODEL;
  if (args[i] === '--ollama-url') OLLAMA_BASE_URL = args[++i] || OLLAMA_BASE_URL;
  if (args[i] === '--help') {
    console.log(`Usage: npx tsx scripts/dream_loop.ts [OPTIONS]

Options:
  --trials N         Trials per phase (default: 3)
  --goal "..."       Navigation goal (default: "navigate to the red cube")
  --local            Use local Ollama model instead of Gemini ($0 cost)
  --model NAME       Ollama model name (default: qwen3:8b)
  --ollama-url URL   Ollama base URL (default: http://localhost:11434)
  --help             Show this help message
`);
    process.exit(0);
  }
}

// =============================================================================
// Types
// =============================================================================

interface TraceMeta {
  filename: string;
  timestamp: string;
  goal: string;
  outcome: string;
  frames: number;
  duration_ms: number;
  confidence: number;
  outcome_reason: string;
  body: string;
}

interface TrialResult {
  trialNumber: number;
  phase: 'baseline' | 'post-dream';
  outcome: string;
  frames: number;
  durationSec: number;
  confidence: number;
  tracePath: string;
}

interface DreamResult {
  tracesProcessed: number;
  strategiesCreated: number;
  constraintsLearned: number;
  summaryText: string;
}

// =============================================================================
// Helpers
// =============================================================================

function log(phase: string, msg: string): void {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse YAML frontmatter from a trace .md file. */
function parseTraceMeta(filepath: string): TraceMeta | null {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  const endIdx = lines.indexOf('---', 1);
  if (endIdx < 0) return null;

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, endIdx)) {
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (match) {
      frontmatter[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }

  const body = lines.slice(endIdx + 1).join('\n');

  return {
    filename: path.basename(filepath),
    timestamp: frontmatter.timestamp || '',
    goal: frontmatter.goal || '',
    outcome: frontmatter.outcome || 'unknown',
    frames: parseInt(frontmatter.frames || '0', 10),
    duration_ms: parseInt(frontmatter.duration_ms || '0', 10),
    confidence: parseFloat(frontmatter.confidence || '0'),
    outcome_reason: frontmatter.outcome_reason || '',
    body,
  };
}

/** List trace files sorted by modification time (newest first). */
function listTraces(): string[] {
  if (!fs.existsSync(TRACES_DIR)) return [];
  return fs.readdirSync(TRACES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(TRACES_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// =============================================================================
// RAG-Style Strategy Retrieval (Phase 4b)
// =============================================================================

interface ScoredStrategy {
  title: string;
  content: string;
  score: number;
}

/**
 * Load existing strategies, score by keyword overlap with the given context
 * (goal + detected objects/patterns), return top-N as context injection.
 * This reduces prompt bloat from ~2000 tokens to ~400 tokens.
 */
function retrieveRelevantStrategies(contextKeywords: string[], topN: number = 3): string {
  const allStrategies: ScoredStrategy[] = [];

  // Scan all level directories for strategy markdown files
  const levelDirs = ['level_1_goals', 'level_2_routes', 'level_3_tactical', 'level_4_motor'];
  for (const dir of levelDirs) {
    const dirPath = path.join(STRATEGIES_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(dirPath, f), 'utf-8');
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);
      const title = titleMatch ? titleMatch[1] : f.replace('.md', '');

      // Score by keyword overlap
      const contentLower = content.toLowerCase();
      let score = 0;
      for (const kw of contextKeywords) {
        const kwLower = kw.toLowerCase();
        // Count occurrences (capped at 3 per keyword to avoid single-keyword dominance)
        const matches = contentLower.split(kwLower).length - 1;
        score += Math.min(matches, 3);
      }

      if (score > 0) {
        // Truncate content to essential parts (frontmatter + first 500 chars of body)
        const truncated = content.slice(0, 500);
        allStrategies.push({ title, content: truncated, score });
      }
    }
  }

  // Also check _negative_constraints.md
  if (fs.existsSync(CONSTRAINTS_FILE)) {
    const constraintContent = fs.readFileSync(CONSTRAINTS_FILE, 'utf-8');
    const sections = constraintContent.split(/^###\s+/m).filter(Boolean);
    for (const section of sections.slice(0, 10)) { // Cap at 10 constraints
      const sectionLower = section.toLowerCase();
      let score = 0;
      for (const kw of contextKeywords) {
        if (sectionLower.includes(kw.toLowerCase())) score++;
      }
      if (score > 0) {
        allStrategies.push({
          title: `Constraint: ${section.split('\n')[0].trim()}`,
          content: section.slice(0, 200),
          score,
        });
      }
    }
  }

  // Sort by score descending, take top-N
  allStrategies.sort((a, b) => b.score - a.score);
  const topStrategies = allStrategies.slice(0, topN);

  if (topStrategies.length === 0) return '';

  const injection = topStrategies.map(s =>
    `### Previously Learned: ${s.title}\n${s.content.trim()}`
  ).join('\n\n');

  return `\n\n---\n## Relevant Prior Knowledge (top ${topStrategies.length} strategies)\n\n${injection}\n\n---\n`;
}

/** Extract keywords from traces for RAG scoring. */
function extractKeywords(traces: TraceMeta[]): string[] {
  const keywords = new Set<string>();
  // Add goal words
  for (const t of traces) {
    for (const word of t.goal.split(/\s+/)) {
      if (word.length > 3) keywords.add(word.toLowerCase());
    }
  }
  // Add common navigation terms found in trace bodies
  const navTerms = ['rotate', 'forward', 'backward', 'obstacle', 'target', 'stuck', 'collision', 'turn'];
  for (const t of traces) {
    const bodyLower = t.body.toLowerCase();
    for (const term of navTerms) {
      if (bodyLower.includes(term)) keywords.add(term);
    }
  }
  return Array.from(keywords);
}

/** Call Gemini text API (no images, no tool calling). */
async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required for dream consolidation');
  }

  const url = `${GEMINI_API_BASE}/models/${DREAM_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.4,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw new Error(`Gemini API error ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

/** Call Ollama local model API (text-only, $0 cost). */
async function callOllama(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${OLLAMA_BASE_URL}/api/generate`;

  const body = {
    model: LOCAL_MODEL,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: {
      temperature: 0.4,
      num_predict: 2048,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout for local models

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama API error ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    const data = await response.json() as {
      response: string;
      done: boolean;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    if (!data.response) {
      throw new Error('Empty response from Ollama');
    }

    return data.response.trim();
  } finally {
    clearTimeout(timeout);
  }
}

/** Unified LLM call — routes to Gemini or Ollama based on --local flag. */
async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  return USE_LOCAL ? callOllama(systemPrompt, userPrompt) : callGemini(systemPrompt, userPrompt);
}

// =============================================================================
// Scatter: drive robot away from target before each trial
// =============================================================================

const UDP_HOST = '127.0.0.1';
const UDP_PORT = 4210;
const FRAME_START = 0xAA;
const FRAME_END = 0xFF;

/** Encode a bytecode frame: [0xAA, opcode, paramL, paramR, checksum, 0xFF] */
function encodeFrame(opcode: number, paramLeft: number, paramRight: number): Buffer {
  const checksum = (opcode + paramLeft + paramRight) & 0xFF;
  return Buffer.from([FRAME_START, opcode, paramLeft & 0xFF, paramRight & 0xFF, checksum, FRAME_END]);
}

/** Send a single bytecode frame via UDP and wait. */
function sendUDP(frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.send(frame, UDP_PORT, UDP_HOST, (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Query the bridge for current distance to target via GET_STATUS. */
async function queryDistance(): Promise<number> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const GET_STATUS = 0x08;
    const frame = encodeFrame(GET_STATUS, 0, 0);
    const timeout = setTimeout(() => { sock.close(); resolve(-1); }, 2000);

    sock.on('message', (msg) => {
      clearTimeout(timeout);
      try {
        const status = JSON.parse(msg.toString());
        sock.close();
        resolve(typeof status.targetDistance === 'number' ? status.targetDistance : -1);
      } catch {
        sock.close();
        resolve(-1);
      }
    });

    sock.bind(0, '0.0.0.0', () => {
      sock.send(frame, UDP_PORT, UDP_HOST);
    });
  });
}

/**
 * Scatter the robot away from the target until it's at least MIN_DIST away.
 * Retries with random motor sequences until the distance condition is met.
 */
const MIN_SCATTER_DIST = 0.5; // must be > target radius (0.25m)
const MAX_SCATTER_ATTEMPTS = 5;

async function scatterRobot(): Promise<void> {
  log('SCATTER', 'Moving robot away from target...');

  const ROTATE_CW = 0x05;
  const ROTATE_CCW = 0x06;
  const MOVE_FORWARD = 0x01;
  const MOVE_BACKWARD = 0x02;
  const STOP = 0x07;

  for (let attempt = 1; attempt <= MAX_SCATTER_ATTEMPTS; attempt++) {
    // Check current distance
    const dist = await queryDistance();
    if (dist >= MIN_SCATTER_DIST) {
      log('SCATTER', `Already ${dist.toFixed(2)}m away (>= ${MIN_SCATTER_DIST}m). Ready.`);
      return;
    }
    log('SCATTER', `Attempt ${attempt}: ${dist >= 0 ? dist.toFixed(2) + 'm' : 'unknown distance'} — need >= ${MIN_SCATTER_DIST}m`);

    // Random rotation direction and angle
    const rotOpcode = Math.random() > 0.5 ? ROTATE_CW : ROTATE_CCW;
    const degrees = 90 + Math.floor(Math.random() * 180);
    await sendUDP(encodeFrame(rotOpcode, degrees, 200));
    await sleep(2000);

    // Drive forward or backward randomly for 3s at max speed
    const driveOpcode = Math.random() > 0.3 ? MOVE_FORWARD : MOVE_BACKWARD;
    await sendUDP(encodeFrame(driveOpcode, 255, 255));
    log('SCATTER', `  ${rotOpcode === ROTATE_CW ? 'CW' : 'CCW'} ${degrees}° → ${driveOpcode === MOVE_FORWARD ? 'FWD' : 'BWD'} 3s`);
    await sleep(3000);

    // Stop and settle
    await sendUDP(encodeFrame(STOP, 0, 0));
    await sleep(1500);
  }

  // Final distance check
  const finalDist = await queryDistance();
  log('SCATTER', `Final distance: ${finalDist >= 0 ? finalDist.toFixed(2) + 'm' : 'unknown'} (target: ${MIN_SCATTER_DIST}m)`);
  if (finalDist >= 0 && finalDist < MIN_SCATTER_DIST) {
    log('SCATTER', `WARNING: Could not scatter far enough after ${MAX_SCATTER_ATTEMPTS} attempts. Arena may be too small.`);
  }
}

// =============================================================================
// Phase 1 & 3: Run Trials
// =============================================================================

function runTrial(trialNumber: number, phase: 'baseline' | 'post-dream'): TrialResult {
  log(phase.toUpperCase(), `--- Trial ${trialNumber} starting ---`);

  const beforeTraces = new Set(listTraces());

  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/run_sim3d.ts', '--gemini', '--goal', GOAL],
    {
      cwd: ROCLAW_ROOT,
      stdio: 'inherit',
      env: { ...process.env },
      timeout: 300_000, // 5 min max per trial
    },
  );

  if (result.error) {
    log(phase.toUpperCase(), `Trial ${trialNumber} process error: ${result.error.message}`);
  }

  // Find the new trace file written by this trial
  const afterTraces = listTraces();
  const newTraces = afterTraces.filter(f => !beforeTraces.has(f));

  if (newTraces.length === 0) {
    log(phase.toUpperCase(), `Trial ${trialNumber}: WARNING - no trace file produced`);
    return {
      trialNumber,
      phase,
      outcome: 'no_trace',
      frames: 0,
      durationSec: 0,
      confidence: 0,
      tracePath: '',
    };
  }

  const tracePath = newTraces[0];
  const meta = parseTraceMeta(tracePath);

  if (!meta) {
    log(phase.toUpperCase(), `Trial ${trialNumber}: WARNING - could not parse trace`);
    return {
      trialNumber,
      phase,
      outcome: 'parse_error',
      frames: 0,
      durationSec: 0,
      confidence: 0,
      tracePath,
    };
  }

  const durationSec = Math.round(meta.duration_ms / 1000);
  log(phase.toUpperCase(), `Trial ${trialNumber}: ${meta.outcome.toUpperCase()}  ${meta.frames} frames  ${durationSec}s  conf=${meta.confidence}`);

  return {
    trialNumber,
    phase,
    outcome: meta.outcome,
    frames: meta.frames,
    durationSec,
    confidence: meta.confidence,
    tracePath,
  };
}

// =============================================================================
// Phase 2: Dream Consolidation
// =============================================================================

const FAILURE_ANALYSIS_SYSTEM = `You are a robot learning system analyzing failed navigation traces.

Extract negative constraints: specific things the robot should NOT do in the future.

Output ONLY a JSON array of constraints:
[
  {"description": "Do not rotate more than 360 degrees when scanning", "context": "target seeking", "severity": "high"},
  {"description": "Do not repeatedly issue the same turn command more than 5 times", "context": "general navigation", "severity": "medium"}
]

Be specific and actionable. Base constraints on actual patterns in the trace data.`;

const STRATEGY_ABSTRACTION_SYSTEM = `You are a robot learning system analyzing successful navigation traces.

From the trace data, extract a reusable navigation strategy. Focus on:
1. The sequence of motor actions that led to success
2. Key decision points (when to rotate vs move forward vs turn)
3. How the robot corrected its heading during approach

Output ONLY valid JSON:
{
  "title": "Short descriptive name",
  "steps": ["Step 1 description", "Step 2 description", "..."],
  "negative_constraints": ["Things to avoid"],
  "spatial_rules": ["When target is left, turn_left with speed_l < speed_r", "..."],
  "trigger_goals": ["keyword1", "keyword2"]
}

Be specific about motor behaviors. Reference actual command patterns from the traces.`;

const DREAM_SUMMARY_SYSTEM = `You are a robot's dream journal writer. Summarize what was learned during this dream consolidation cycle.

Be concise (2-4 sentences). Focus on the key insight: what pattern was extracted and how it should improve future navigation.`;

async function dreamConsolidate(traceFiles: string[]): Promise<DreamResult> {
  log('DREAM', `=== Dream Consolidation Starting ===`);
  log('DREAM', `Processing ${traceFiles.length} traces`);

  const traces: TraceMeta[] = [];
  for (const f of traceFiles) {
    const meta = parseTraceMeta(f);
    if (meta) traces.push(meta);
  }

  if (traces.length === 0) {
    log('DREAM', 'No parseable traces found');
    return { tracesProcessed: 0, strategiesCreated: 0, constraintsLearned: 0, summaryText: 'No traces to process' };
  }

  const successes = traces.filter(t => t.outcome === 'success');
  const failures = traces.filter(t => t.outcome === 'failure');

  log('DREAM', `Phase 1 (SWS): ${successes.length} successes, ${failures.length} failures`);

  // RAG: Extract keywords and retrieve relevant prior strategies
  const keywords = extractKeywords(traces);
  const ragContext = retrieveRelevantStrategies(keywords, 3);
  if (ragContext) {
    log('DREAM', `  RAG: Injecting ${keywords.length} keywords → found relevant prior strategies`);
  }

  let constraintsLearned = 0;
  let strategiesCreated = 0;

  // ---- REM Phase: Failure Analysis ----
  if (failures.length > 0) {
    log('DREAM', 'Phase 2a (REM/Failures): Analyzing failure patterns...');

    const failureContext = failures.map(t =>
      `## Trace: ${t.filename}\nGoal: ${t.goal}\nOutcome: ${t.outcome} (${t.outcome_reason})\nFrames: ${t.frames}, Duration: ${t.duration_ms}ms\n\n${t.body.slice(0, 2000)}`
    ).join('\n\n---\n\n') + ragContext;

    try {
      const response = await callLLM(FAILURE_ANALYSIS_SYSTEM, failureContext);
      let cleanedFailure = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const arrayMatch = cleanedFailure.match(/\[[\s\S]*\]/);
      if (!arrayMatch) throw new Error('No JSON array found in Gemini response');
      const constraints = JSON.parse(arrayMatch[0]);

      if (Array.isArray(constraints) && constraints.length > 0) {
        // Append to _negative_constraints.md
        const existing = fs.readFileSync(CONSTRAINTS_FILE, 'utf-8');
        const newEntries = constraints.map((c: { description: string; context: string; severity: string }) =>
          `\n### ${c.description}\n**Context:** ${c.context}\n**Severity:** ${c.severity}\n**Learned from:** ${failures.map(f => f.filename).join(', ')}`
        ).join('\n');

        fs.writeFileSync(CONSTRAINTS_FILE, existing + '\n' + newEntries + '\n');
        constraintsLearned = constraints.length;
        log('DREAM', `  Learned ${constraintsLearned} negative constraints`);

        // Also write a level 4 reactive strategy for critical constraints
        const critical = constraints.filter((c: { severity: string }) => c.severity === 'high');
        if (critical.length > 0) {
          ensureDir(LEVEL_4_DIR);
          const reactiveContent = buildStrategyMarkdown({
            title: 'Failure-Learned Reactive Guards',
            level: 4,
            triggerGoals: ['navigate', 'go to', 'find', 'explore'],
            confidence: 0.6,
            source: 'dream',
            evidenceCount: failures.length,
            steps: critical.map((c: { description: string }) => `Guard: ${c.description}`),
            negativeConstraints: constraints.map((c: { description: string }) => c.description),
            spatialRules: [],
          });
          const reactiveFile = path.join(LEVEL_4_DIR, `dream_reactive_${dateSlug()}.md`);
          fs.writeFileSync(reactiveFile, reactiveContent);
          strategiesCreated++;
          log('DREAM', `  Created reactive strategy: ${path.basename(reactiveFile)}`);
        }
      }
    } catch (err) {
      log('DREAM', `  Failure analysis error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- REM Phase: Strategy Abstraction ----
  if (successes.length > 0) {
    log('DREAM', 'Phase 2b (REM/Successes): Abstracting navigation strategy...');

    const successContext = successes.map(t =>
      `## Trace: ${t.filename}\nGoal: ${t.goal}\nOutcome: ${t.outcome} (${t.outcome_reason})\nFrames: ${t.frames}, Duration: ${t.duration_ms}ms, Confidence: ${t.confidence}\n\n${t.body.slice(0, 3000)}`
    ).join('\n\n---\n\n') + ragContext;

    try {
      const response = await callLLM(STRATEGY_ABSTRACTION_SYSTEM, successContext);
      // Extract JSON from response — handle markdown fences and surrounding text
      let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in Gemini response');
      const strategy = JSON.parse(jsonMatch[0]);

      if (strategy.title && strategy.steps) {
        ensureDir(LEVEL_2_DIR);
        const content = buildStrategyMarkdown({
          title: strategy.title,
          level: 2,
          triggerGoals: strategy.trigger_goals || ['navigate', 'red cube', 'find', 'go to'],
          confidence: 0.7,
          source: 'dream',
          evidenceCount: successes.length,
          steps: strategy.steps,
          negativeConstraints: strategy.negative_constraints || [],
          spatialRules: strategy.spatial_rules || [],
        });

        const filename = `dream_${strategy.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${dateSlug()}.md`;
        const filepath = path.join(LEVEL_2_DIR, filename);
        fs.writeFileSync(filepath, content);
        strategiesCreated++;
        log('DREAM', `  Created strategy: ${filename}`);
        log('DREAM', `  Steps: ${strategy.steps.join(' -> ')}`);
      }
    } catch (err) {
      log('DREAM', `  Strategy abstraction error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Consolidation Phase: Dream Summary ----
  log('DREAM', 'Phase 3 (Consolidation): Writing dream journal...');

  let summaryText = `Processed ${traces.length} traces (${successes.length} success, ${failures.length} failure). Created ${strategiesCreated} strategies, learned ${constraintsLearned} constraints.`;

  try {
    const journalPrompt = [
      `Dream cycle completed at ${new Date().toISOString()}`,
      `Traces processed: ${traces.length} (${successes.length} success, ${failures.length} failure)`,
      `Strategies created: ${strategiesCreated}`,
      `Constraints learned: ${constraintsLearned}`,
      `Goals covered: ${Array.from(new Set(traces.map(t => t.goal))).join(', ')}`,
      `Average frames (success): ${successes.length > 0 ? Math.round(successes.reduce((a, t) => a + t.frames, 0) / successes.length) : 'N/A'}`,
      `Average duration (success): ${successes.length > 0 ? Math.round(successes.reduce((a, t) => a + t.duration_ms, 0) / successes.length / 1000) + 's' : 'N/A'}`,
    ].join('\n');

    summaryText = await callLLM(DREAM_SUMMARY_SYSTEM, journalPrompt);
  } catch {
    // Use default summary
  }

  // Append to dream journal
  const journalEntry = [
    '',
    `## Dream Cycle — ${new Date().toISOString()}`,
    '',
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Traces processed:** ${traces.length}`,
    `**Strategies created:** ${strategiesCreated}`,
    `**Constraints learned:** ${constraintsLearned}`,
    '',
    summaryText,
    '',
  ].join('\n');

  const existingJournal = fs.readFileSync(JOURNAL_FILE, 'utf-8');
  fs.writeFileSync(JOURNAL_FILE, existingJournal + journalEntry);
  log('DREAM', `Dream journal updated`);

  log('DREAM', `=== Dream Consolidation Complete ===`);
  return { tracesProcessed: traces.length, strategiesCreated, constraintsLearned, summaryText };
}

// =============================================================================
// Strategy file builder
// =============================================================================

interface StrategyDef {
  title: string;
  level: number;
  triggerGoals: string[];
  confidence: number;
  source: string;
  evidenceCount: number;
  steps: string[];
  negativeConstraints: string[];
  spatialRules: string[];
}

function buildStrategyMarkdown(def: StrategyDef): string {
  const now = new Date().toISOString().split('T')[0];
  const lines = [
    '---',
    `title: "${def.title}"`,
    `level: ${def.level}`,
    `trigger_goals: ${JSON.stringify(def.triggerGoals)}`,
    `confidence: ${def.confidence}`,
    `source: ${def.source}`,
    `created: "${now}"`,
    `evidence_count: ${def.evidenceCount}`,
    '---',
    '',
    `# ${def.title}`,
    '',
    '## Steps',
  ];

  def.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));

  if (def.negativeConstraints.length > 0) {
    lines.push('', '## Negative Constraints');
    for (const nc of def.negativeConstraints) {
      lines.push(`- ${nc}`);
    }
  }

  if (def.spatialRules.length > 0) {
    lines.push('', '## Spatial Rules');
    for (const sr of def.spatialRules) {
      lines.push(`- ${sr}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function dateSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// Phase 4: Report
// =============================================================================

function printReport(
  baselineResults: TrialResult[],
  postDreamResults: TrialResult[],
  dreamResult: DreamResult,
): void {
  const divider = '='.repeat(55);

  console.log(`\n${divider}`);
  console.log('  DREAM LOOP RESULTS');
  console.log(divider);

  // Baseline
  console.log('\nBASELINE (pre-dream):');
  for (const r of baselineResults) {
    const outcomeStr = r.outcome.toUpperCase().padEnd(10);
    console.log(`  Trial ${r.trialNumber}: ${outcomeStr} ${String(r.frames).padStart(3)} frames  ${String(r.durationSec).padStart(4)}s  conf=${r.confidence}`);
  }
  const baseSuccesses = baselineResults.filter(r => r.outcome === 'success');
  const baseAvgFrames = baseSuccesses.length > 0 ? Math.round(baseSuccesses.reduce((a, r) => a + r.frames, 0) / baseSuccesses.length) : 0;
  const baseAvgDur = baseSuccesses.length > 0 ? Math.round(baseSuccesses.reduce((a, r) => a + r.durationSec, 0) / baseSuccesses.length) : 0;
  const baseSuccessRate = baselineResults.length > 0 ? Math.round(baseSuccesses.length / baselineResults.length * 100) : 0;
  console.log(`  Avg: ${baseAvgFrames} frames, ${baseAvgDur}s, success rate ${baseSuccessRate}%`);

  // Dream
  console.log('\nDREAM CONSOLIDATION:');
  console.log(`  Traces processed: ${dreamResult.tracesProcessed}`);
  console.log(`  Strategies created: ${dreamResult.strategiesCreated}`);
  console.log(`  Constraints learned: ${dreamResult.constraintsLearned}`);

  // Post-dream
  console.log('\nPOST-DREAM:');
  for (const r of postDreamResults) {
    const outcomeStr = r.outcome.toUpperCase().padEnd(10);
    console.log(`  Trial ${r.trialNumber}: ${outcomeStr} ${String(r.frames).padStart(3)} frames  ${String(r.durationSec).padStart(4)}s  conf=${r.confidence}`);
  }
  const postSuccesses = postDreamResults.filter(r => r.outcome === 'success');
  const postAvgFrames = postSuccesses.length > 0 ? Math.round(postSuccesses.reduce((a, r) => a + r.frames, 0) / postSuccesses.length) : 0;
  const postAvgDur = postSuccesses.length > 0 ? Math.round(postSuccesses.reduce((a, r) => a + r.durationSec, 0) / postSuccesses.length) : 0;
  const postSuccessRate = postDreamResults.length > 0 ? Math.round(postSuccesses.length / postDreamResults.length * 100) : 0;
  console.log(`  Avg: ${postAvgFrames} frames, ${postAvgDur}s, success rate ${postSuccessRate}%`);

  // Improvement
  console.log('\nIMPROVEMENT:');
  if (baseAvgFrames > 0 && postAvgFrames > 0) {
    const frameDelta = ((postAvgFrames - baseAvgFrames) / baseAvgFrames * 100).toFixed(1);
    const durDelta = ((postAvgDur - baseAvgDur) / baseAvgDur * 100).toFixed(1);
    const frameSign = parseFloat(frameDelta) <= 0 ? '' : '+';
    const durSign = parseFloat(durDelta) <= 0 ? '' : '+';
    console.log(`  Frames: ${frameSign}${frameDelta}% ${parseFloat(frameDelta) < 0 ? '(fewer VLM inferences needed)' : '(more inferences needed)'}`);
    console.log(`  Duration: ${durSign}${durDelta}% ${parseFloat(durDelta) < 0 ? '(faster navigation)' : '(slower navigation)'}`);
  } else {
    console.log('  (insufficient successful trials for comparison)');
  }
  if (baseSuccessRate !== postSuccessRate) {
    console.log(`  Success rate: ${baseSuccessRate}% -> ${postSuccessRate}%`);
  }

  console.log(`\n${divider}\n`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const inferenceLabel = USE_LOCAL ? `Ollama (${LOCAL_MODEL})` : `Gemini (${DREAM_MODEL})`;
  console.log(`
${'='.repeat(55)}
  DREAM LOOP EXPERIMENT
  Bio-Inspired Learning Cycle
${'='.repeat(55)}
  Goal: "${GOAL}"
  Trials per phase: ${TRIALS_PER_PHASE}
  Dream inference: ${inferenceLabel}
  ${USE_LOCAL ? `Ollama URL: ${OLLAMA_BASE_URL}` : ''}
${'='.repeat(55)}
`);

  if (!USE_LOCAL && !GEMINI_API_KEY) {
    console.error('ERROR: GOOGLE_API_KEY environment variable is required (or use --local for Ollama)');
    process.exit(1);
  }

  // Clean any existing dream-generated strategies so baseline is clean
  if (fs.existsSync(LEVEL_2_DIR)) {
    const dreamFiles = fs.readdirSync(LEVEL_2_DIR).filter(f => f.startsWith('dream_'));
    for (const f of dreamFiles) {
      fs.unlinkSync(path.join(LEVEL_2_DIR, f));
      log('SETUP', `Removed previous dream strategy: ${f}`);
    }
  }

  // Record which traces exist before we start (don't process pre-existing ones)
  const preExistingTraces = new Set(listTraces());

  // =========================================================================
  // Phase 1: BASELINE
  // =========================================================================
  log('BASELINE', `=== Phase 1: BASELINE (${TRIALS_PER_PHASE} trials, no dream strategies) ===`);

  const baselineResults: TrialResult[] = [];
  for (let i = 1; i <= TRIALS_PER_PHASE; i++) {
    await scatterRobot();
    const result = runTrial(i, 'baseline');
    baselineResults.push(result);

    if (i < TRIALS_PER_PHASE) {
      log('BASELINE', `Pausing ${INTER_TRIAL_PAUSE_MS / 1000}s for bridge to settle...`);
      await sleep(INTER_TRIAL_PAUSE_MS);
    }
  }

  // =========================================================================
  // Phase 2: DREAM CONSOLIDATION
  // =========================================================================
  log('DREAM', `=== Phase 2: DREAM CONSOLIDATION ===`);

  // Only dream on traces created during this experiment
  const newTraces = listTraces().filter(f => !preExistingTraces.has(f));
  const dreamResult = await dreamConsolidate(newTraces);

  // =========================================================================
  // Phase 3: POST-DREAM
  // =========================================================================
  log('POST-DREAM', `=== Phase 3: POST-DREAM (${TRIALS_PER_PHASE} trials, with learned strategies) ===`);

  // Verify strategies were written
  if (fs.existsSync(LEVEL_2_DIR)) {
    const stratFiles = fs.readdirSync(LEVEL_2_DIR).filter(f => f.endsWith('.md'));
    log('POST-DREAM', `Strategy store has ${stratFiles.length} level 2 strategies`);
  }

  const postDreamResults: TrialResult[] = [];
  for (let i = 1; i <= TRIALS_PER_PHASE; i++) {
    await scatterRobot();
    const trialNum = TRIALS_PER_PHASE + i;
    const result = runTrial(trialNum, 'post-dream');
    postDreamResults.push(result);

    if (i < TRIALS_PER_PHASE) {
      log('POST-DREAM', `Pausing ${INTER_TRIAL_PAUSE_MS / 1000}s for bridge to settle...`);
      await sleep(INTER_TRIAL_PAUSE_MS);
    }
  }

  // =========================================================================
  // Phase 4: REPORT
  // =========================================================================
  printReport(baselineResults, postDreamResults, dreamResult);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
