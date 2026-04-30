---
id: strat_3_llmos-hello-world-bootstrap
version: 1
hierarchy_level: 3
title: LLM-OS Hello World Bootstrap on macOS/Linux
trigger_goals: ["llm_os demo", "hello world", "boot macOS", "local development", "feasibility check", "quickstart", "llm_os onboarding"]
preconditions:
  - "macOS or Linux development machine with Rust toolchain"
  - "llm_os repository cloned with runtime/ directory"
  - "llama.cpp available (or willing to build from source)"
  - "A GGUF model file (e.g., Qwen2.5-0.5B-Q4_K_M or Llama-3.2-1B)"
confidence: 0.50
success_count: 1
failure_count: 0
source_traces: ["tr_hello_world_001", "tr_hello_world_002", "tr_hello_world_003", "tr_hello_world_004", "tr_hello_world_005"]
deprecated: false
---

# LLM-OS Hello World Bootstrap on macOS/Linux

## Steps

1. **Install Rust toolchain**: Ensure Rust 1.95+ is installed (`rustup update stable`). The iod daemon requires edition 2021.

2. **Build the Rust iod daemon**: Run `cargo build --release` in the `runtime/` directory. Expect and fix compilation errors for any recently-added opcodes (check capability.rs opcode_string(), iod.rs handle_statement(), and DaemonConfig fields for missing match arms). Apply Constraint 50: verify wiring through ALL dispatch layers.

3. **Skip the C bootloader on macOS**: The C bootloader (`bootloader.c`) targets Linux/Pi OS only. It uses `INADDR_LOOPBACK` and `memmem()` which are not available on macOS. This is by design -- the bootloader is a convenience launcher, not architecturally required.

4. **Run mock E2E tests first (no model required)**: Execute `cargo test` to run the 6 integration tests with MockServer. These validate the ISA dispatch loop, stop-and-inject, syscall roundtrip, schema violation handling, token budget preemption, and RoClaw motor opcode compilation. All should pass without any LLM.

5. **Set up llama-server for real inference**: Build llama.cpp from source (`cmake -B build && cmake --build build`). Do NOT use Ollama -- its `/v1/chat/completions` endpoint is incompatible with llm_os (see Constraint 49). llm_os requires `/v1/completions` with per-request GBNF grammar injection. Start llama-server with: `./llama-server -m <model.gguf> --port 8080`.

6. **Boot the iod daemon against llama-server**: Run the iod binary pointing at `http://localhost:8080/v1/completions`. The daemon will load a cartridge (start with `system/demo`), send the ISA grammar, and begin the dispatch loop.

7. **Document feasibility findings**: Record which platform (Mac/Linux/Docker/Pi) was tested, which tests passed, and any friction points. Create a demo scenario document if this is for onboarding.

## Three Demo Tiers

| Tier | Requirements | Proves |
|------|-------------|--------|
| Mock (Tier 1) | Rust only, no model | ISA dispatch loop works, grammar validates |
| Real Model (Tier 2) | Rust + llama-server + GGUF model | Full boot-to-dispatch on real hardware |
| Docker (Tier 3) | Docker with ARM64 or x86 image | Portable deployment without native toolchain |

## Negative Constraints

- Do not use Ollama for llm_os inference (Constraint 49: incompatible API)
- Do not assume Rust build success means semantic completeness (Constraint 50: check all match arms)
- Do not attempt to compile bootloader.c on macOS (by design, Linux-only)
- Do not skip mock tests before real model testing -- mock tests validate ISA correctness without model noise

## Notes

This strategy was extracted from the first successful llm_os Hello World execution on 2026-04-27. The key insight is that the llm_os architecture separates cleanly into testable layers: the Rust iod daemon (portable, testable without a model), the C bootloader (Linux-only, optional), and the inference backend (llama-server with GBNF support). This separation enables a 3-tier demo approach where each tier adds one dependency.

The Hello World demo also validates the layer-cake convergence architecture (strat_1_multi_project_convergence_architecture): llm_os (Layer 2: Infrastructure) can be demonstrated independently of RoClaw (Layer 3: I/O) and skillos (Layer 1: Platform), proving that the layers are correctly decoupled.

82/89 unit tests pass; 7 failures are in tool_parser regex lookahead (unrelated to ISA core). Integration tests are the authoritative validation.
