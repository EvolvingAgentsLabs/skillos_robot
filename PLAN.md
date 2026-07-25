# Plan — replace prompt-and-parse with decode-time constraint

## What this repo does today

The orchestrator asks the model for an opcode in the prompt, caps generation with
stop sequences, and parses the result with a regex. Nothing constrains the model;
something is requested and then checked.

That is the arm the lab measured and found unreliable, and it fails here in a way
that is on record. On 2026-07-24, driving `sim/sim2d.html` against a Google model,
one run produced **28 consecutive `unknown` opcodes** after the provider capped
stop sequences from fourteen to five. The model chained instructions the parser
could not follow, and the run degenerated without erroring — the simulator kept
going, emitting nothing usable.

## What changes

[`token-trie`](https://github.com/EvolvingAgentsLabs/token-trie) enforces the same
ISA at the decoder: every legal instruction is pre-tokenized into a trie and the
sampler's valid-next set is masked at each step, so a malformed opcode has no path.

**The two repos already speak the same language.** The opcode regex here and there
is character-for-character identical:

```
/<\|call\|>([a-zA-Z_][\w-]*)\.([a-zA-Z_][\w-]*)\s*([\s\S]*?)\s*<\|\/call\|>/
```

They were one codebase; only enforcement diverged. So this is not a port — it is
putting back a piece that was separated.

## Why it matters more here than there

The validated mechanism currently runs a Tetris demo in a browser tab. The
unvalidated one drives motors over UDP at 20 Hz. A malformed JSON in a chatbot is
a retry; a malformed motor command is a robot hitting something.

## The blocker, and why it is the right one

`Sampler` needs a `Backend` exposing `getLogits(idx) → Array<{token, p}>`.
`src/orchestrator/backend.ts` has **zero** references to logits, because it talks
to OpenRouter and Google, and neither returns per-token probabilities.

So this change **requires a local model**. That is the direction this work already
argues for; it turns on-device from a preference into a technical requirement.

## Tasks — week of 2026-07-27

Sequenced and detailed in
[`token-trie/PLAN.md` §Phase 5](https://github.com/EvolvingAgentsLabs/token-trie/blob/main/PLAN.md).
Summary of what lands in *this* repo:

1. **`_cart/io/robot/manifest.json`** — the six exposed methods (`navigate`,
   `observe`, `describe`, `speak`, `listen`, `stop`) declared as `args_schema`
   files. Enums for fixed choices, bounded integers for distance and heading, a
   slot for `speak`'s free text. *Done when every compiled opcode is accepted by
   `parseOpcode`, asserted in a test.*
2. **A local `Backend`** wired into `src/orchestrator/`. *Done when it returns
   per-token probabilities and its tokenizer treats `<|call|>` and `<|halt|>` as
   single tokens — check that second part first, it is the one that fails.*
3. **Swap `generate()` for `Sampler.generate()`**, cloud path behind a flag.
   *Done when a full simulator run completes with the trie in the loop.*
4. **Measure against the 28-unknown baseline.** Report `fellBackSteps` alongside
   the unparseable rate: a trie run with a high fallback count is syntactically
   perfect and strategically blind, and publishing only the zero would repeat the
   mistake this lab keeps writing about.

## Also outstanding here

- **No demo media.** 795 tests, four ESP32 firmware projects, CAD and six MuJoCo
  scenes, and not one image of the thing working. The 2D simulator runs — it was
  driven end to end on 2026-07-24, greeting a person, asking which door, and
  navigating to it — so this is a recording, not a build.
- **`gemini-3.6-flash` cannot drive this repo.** It requires a `thought_signature`
  on function-call parts replayed in history, which the backend does not preserve,
  so turn 2 fails with 400. Use 2.5-flash until that is handled.

## What none of this changes

The Program layer still plans. A hand-written scorer ranks the options and the
model picks from the ranked list. Constraining the decoder makes the output
well-formed; it does not make the model a planner.
