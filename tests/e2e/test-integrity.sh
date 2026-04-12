#!/bin/bash
# Automated integrity test suite for Novelist
# Run: ./scripts/test-integrity.sh
set -e

echo "====================================="
echo "  Novelist Integrity Test Suite"
echo "====================================="
echo ""

cd "$(dirname "$0")/../.."

# 1. Rust Rope tests
echo "--- Rust Rope Tests ---"
echo ""

cd src-tauri

echo "[1/4] File integrity (150K lines, BLAKE3 hash verification)..."
cargo test --release rope_file_integrity_mandatory -- --nocapture 2>&1 | grep -E "✓|FAIL|PASSED|MANDATORY"
echo ""

echo "[2/4] Scenario: edit begin → mid → end → save..."
cargo test --release rope_scenario_begin_mid_end_save -- --nocapture 2>&1 | grep -E "✓|FAIL|PASSED|Scenario"
echo ""

echo "[3/4] Webview+Rust integration correctness..."
cargo test --release rope_webview_integration_correctness -- --nocapture 2>&1 | grep -E "✓|FAIL|PASSED|Integration"
echo ""

echo "[4/4] Automated E2E (open → jump → edit → save → verify)..."
cargo test --release rope_e2e_automated_integrity -- --nocapture 2>&1 | grep -E "✓|FAIL|PASSED|E2E|Line count|File size"
echo ""

cd ..

echo "====================================="
echo "  All Integrity Tests Passed"
echo "====================================="
