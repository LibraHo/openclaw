#!/usr/bin/env bash
set -e

# 修复 OpenClaw 升级后本地 memory search 找不到 node-llama-cpp：
# node-llama-cpp 实际持久化在 /home/node/.openclaw/node_modules，
# 运行时代码会从 /app/node_modules 解析模块。
# 容器启动时重建软链，避免每次升级后手动修。
mkdir -p /app/node_modules
ln -sfn /home/node/.openclaw/node_modules/node-llama-cpp /app/node_modules/node-llama-cpp

exec node dist/index.js gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port "${OPENCLAW_GATEWAY_PORT:-18789}"