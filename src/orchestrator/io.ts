// src/orchestrator/io.ts
// Pluggable I/O adapters for the ISA orchestrator.
// Handles speech output (fd=5) and speech input (fd=4).
//
// Adapters:
//   ConsoleIOAdapter — prints to stdout, reads from stdin (interactive)
//   MacOSSayAdapter  — uses macOS `say` command for TTS, stdin for input
//   StubIOAdapter    — canned responses for automated dataset generation

import { logger } from '../shared/logger';
import { execFile } from 'child_process';
import * as readline from 'readline';

// ── Interface ───────────────────────────────────────────────────

export interface IOAdapter {
  /** Speak text aloud (or print it). Resolves when speech completes. */
  speak(text: string): Promise<void>;
  /** Listen for user input. Resolves with transcribed/typed text. */
  listen(timeoutMs?: number): Promise<string>;
  /** Clean up resources (close readline, etc). */
  destroy(): void;
}

// ── ConsoleIOAdapter ────────────────────────────────────────────

export class ConsoleIOAdapter implements IOAdapter {
  private rl: readline.Interface | null = null;

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async speak(text: string): Promise<void> {
    console.log(`\n🔊 Robot: ${text}\n`);
  }

  async listen(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const rl = this.getRL();
      const timer = setTimeout(() => {
        resolve('[silence]');
      }, timeoutMs);

      rl.question('🎤 You: ', (answer) => {
        clearTimeout(timer);
        resolve(answer.trim() || '[silence]');
      });
    });
  }

  destroy(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── MacOSSayAdapter ─────────────────────────────────────────────

export class MacOSSayAdapter implements IOAdapter {
  private rl: readline.Interface | null = null;
  private voice: string;

  constructor(voice = 'Samantha') {
    this.voice = voice;
  }

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async speak(text: string): Promise<void> {
    console.log(`\n🔊 Robot: ${text}\n`);
    return new Promise<void>((resolve, reject) => {
      execFile('say', ['-v', this.voice, text], (err) => {
        if (err) {
          logger.warn('MacOSSay', `TTS failed: ${err.message}`);
          // Don't reject — speech is best-effort
        }
        resolve();
      });
    });
  }

  async listen(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = this.getRL();
      const timer = setTimeout(() => {
        resolve('[silence]');
      }, timeoutMs);

      rl.question('🎤 You: ', (answer) => {
        clearTimeout(timer);
        resolve(answer.trim() || '[silence]');
      });
    });
  }

  destroy(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── StubIOAdapter ───────────────────────────────────────────────

export interface StubScenario {
  /** Sequence of canned responses. Cycles when exhausted. */
  responses: string[];
}

export class StubIOAdapter implements IOAdapter {
  private responses: string[];
  private index = 0;
  private spoken: string[] = [];

  constructor(scenario?: StubScenario) {
    this.responses = scenario?.responses ?? [
      'Hello, I need help getting to the kitchen.',
      'Yes, please guide me there.',
      'Thank you, that was helpful.',
      'I want to go back to the living room.',
      'Goodbye.',
    ];
  }

  async speak(text: string): Promise<void> {
    this.spoken.push(text);
    logger.debug('StubIO', `[speak] ${text}`);
  }

  async listen(_timeoutMs?: number): Promise<string> {
    const response = this.responses[this.index % this.responses.length];
    this.index++;
    logger.debug('StubIO', `[listen] → "${response}"`);
    return response;
  }

  /** Get all text the robot has spoken (for assertions/traces). */
  getSpoken(): string[] {
    return [...this.spoken];
  }

  /** Reset the response cycle. */
  reset(): void {
    this.index = 0;
    this.spoken = [];
  }

  destroy(): void {
    // Nothing to clean up
  }
}

// ── Factory ─────────────────────────────────────────────────────

export type IOAdapterType = 'console' | 'macos' | 'stub';

export function createIOAdapter(type: IOAdapterType, scenario?: StubScenario): IOAdapter {
  switch (type) {
    case 'console':
      return new ConsoleIOAdapter();
    case 'macos':
      return new MacOSSayAdapter();
    case 'stub':
      return new StubIOAdapter(scenario);
    default:
      return new ConsoleIOAdapter();
  }
}
