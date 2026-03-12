---
id: strat_2_additive-backend-integration
version: 1
hierarchy_level: 2
title: Additive Backend Integration -- New Provider Alongside Existing
trigger_goals: ["backend integration", "new provider", "additive integration", "gemini backend", "inference backend", "API integration"]
preconditions: ["InferenceFunction interface abstraction exists", "New provider API is accessible and documented", "Integration tests can be written against the new provider"]
confidence: 0.5
success_count: 1
failure_count: 0
source_traces: ["tr_002_gemini_backend_add"]
deprecated: false
---

# Additive Backend Integration -- New Provider Alongside Existing

## Steps
1. Create a dedicated adapter file for the new backend (e.g., gemini_robotics.ts) implementing the existing InferenceFunction interface -- use native fetch, avoid adding npm SDK dependencies
2. Implement provider-specific features as configuration options: tool calling declarations, thinking budget, output token limits, auto-scaling (e.g., 0-1 to 0-255 normalization)
3. Add a new compilation mode to the downstream consumer if the new backend produces different output format (e.g., TOOLCALL mode in BytecodeCompiler with first-priority parsing)
4. Activate the new backend via environment variable or CLI flag (e.g., GOOGLE_API_KEY + --gemini) -- keep the existing backend as default
5. Write live integration tests against the real API to validate the adapter before any routing changes
6. Update dependent components to support the new backend's features (e.g., spatial grounding on SemanticMap nodes)
7. Only after live tests pass, proceed to routing changes (separate step/strategy)

## Negative Constraints
- Do not remove the existing backend until the new one is fully validated in production routing
- Do not introduce npm SDK dependencies for REST APIs with simple request/response shapes
- Do not assume the new backend's output format matches the old one -- add format-specific parsing (TOOLCALL vs hex vs text)
- Do not skip live integration tests -- unit tests with mocks cannot catch API behavior differences

## Notes
- The GeminiRoboticsInference adapter was 405 lines including 7 tool declarations mapping to ISA v1 opcodes, thinking budget control, and normalized auto-scaling.
- The TOOLCALL compilation mode was given first-priority in BytecodeCompiler (before hex and text parsing) because tool calling outputs are more structured and reliable.
- Zero new npm dependencies were added -- native fetch with manual type assertions was sufficient for the Gemini REST API.
- SpatialFeature interface and bounding box grounding were added as domain-specific enhancements enabled by the new backend's capabilities.
