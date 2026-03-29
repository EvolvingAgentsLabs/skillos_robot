#!/usr/bin/env bash
# Create the RoClaw navigation model in Ollama from a GGUF file.
#
# Prerequisites:
#   - Ollama installed and running (ollama serve)
#   - GGUF file downloaded from Google Drive or HuggingFace
#
# Usage:
#   ./scripts/create_ollama_model.sh                          # uses default paths
#   ./scripts/create_ollama_model.sh /path/to/model.gguf      # custom GGUF path
#   GGUF_PATH=/path/to/model.gguf ./scripts/create_ollama_model.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# GGUF file path — check CLI arg, then env var, then default
GGUF_PATH="${1:-${GGUF_PATH:-${PROJECT_DIR}/roclaw-nav-q8_0.gguf}}"
MODEL_NAME="${MODEL_NAME:-roclaw-nav:q8_0}"
MODELFILE="${PROJECT_DIR}/Modelfile"

echo "=== RoClaw Ollama Model Setup ==="
echo "GGUF:      ${GGUF_PATH}"
echo "Model:     ${MODEL_NAME}"
echo "Modelfile: ${MODELFILE}"
echo ""

# Check prerequisites
if ! command -v ollama &> /dev/null; then
  echo "Error: ollama not found. Install from https://ollama.com"
  exit 1
fi

if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "Error: Ollama server not running. Start with: ollama serve"
  exit 1
fi

if [ ! -f "$GGUF_PATH" ]; then
  echo "Error: GGUF file not found at ${GGUF_PATH}"
  echo ""
  echo "Download options:"
  echo "  1. From Google Drive (after Colab training)"
  echo "  2. From HuggingFace: huggingface-cli download <repo> --local-dir ."
  exit 1
fi

if [ ! -f "$MODELFILE" ]; then
  echo "Error: Modelfile not found at ${MODELFILE}"
  exit 1
fi

# Create a temporary Modelfile with the correct GGUF path
TEMP_MODELFILE=$(mktemp)
sed "s|FROM ./roclaw-nav-q8_0.gguf|FROM ${GGUF_PATH}|" "$MODELFILE" > "$TEMP_MODELFILE"

echo "Creating Ollama model '${MODEL_NAME}'..."
ollama create "${MODEL_NAME}" -f "$TEMP_MODELFILE"
rm -f "$TEMP_MODELFILE"

echo ""
echo "Model created successfully!"
echo ""

# Test inference
echo "Testing with a sample scene..."
SAMPLE_SCENE="=== SPATIAL ANALYSIS ===
POSE: x=125.0 y=45.5 heading=0.0deg
PROGRESS: approaching delta=-5.2cm | target=200cm at 3deg relative | frame 10
CLEARANCE:
  forward: 250cm clear
  forward-left: 200cm clear
  left: 30cm BLOCKED by left wall
  forward-right: 200cm clear
  right: 30cm BLOCKED by right wall
  backward: 45cm clear
OPTIONS:
  - FORWARD: clear for 250cm [TARGET is FORWARD]
  - LEFT: BLOCKED by left wall at 30cm
  - RIGHT: BLOCKED by right wall at 30cm
  - TARGET: right 3deg, 200cm away -> move_forward recommended

=== SCENE PERCEPTION ===
Location: Long corridor. A narrow corridor with white walls. Floor: tiled.
Walls: left wall 30cm to the left. right wall 30cm to the right.
TARGET VISIBLE: Red Cube is 200cm directly ahead (bearing +3deg relative)."

echo ""
echo "Input: (sample corridor scene)"
echo "Output:"
echo "$SAMPLE_SCENE" | ollama run "${MODEL_NAME}"
echo ""
echo "Setup complete! Run benchmarks with:"
echo "  npx tsx scripts/benchmark_distill.ts"
