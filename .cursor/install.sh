#!/usr/bin/env bash
# Idempotent Cloud Agent setup for the x402 monorepo.
# Installs the toolchains the base image lacks (Go 1.24+, uv, Maven, Foundry),
# then installs/builds dependencies for every SDK (TypeScript, Python, Go, Java)
# plus the TypeScript examples workspace.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_VERSION="1.24.1"

log() { echo "[install] $*"; }

ensure_symlink() {
  # ensure_symlink <target> <link-in-/usr/local/bin>
  sudo ln -sf "$1" "/usr/local/bin/$2"
}

install_go() {
  local have=""
  have="$(go version 2>/dev/null | awk '{print $3}' | sed 's/go//')" || true
  if [ "$have" = "$GO_VERSION" ]; then
    log "Go $GO_VERSION already installed"
    return
  fi
  log "Installing Go $GO_VERSION"
  local arch tgz
  arch="$(dpkg --print-architecture)"
  tgz="/tmp/go-${GO_VERSION}.tar.gz"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o "$tgz"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tgz"
  rm -f "$tgz"
  ensure_symlink /usr/local/go/bin/go go
  ensure_symlink /usr/local/go/bin/gofmt gofmt
}

install_uv() {
  if command -v uv >/dev/null 2>&1; then
    log "uv already installed"
  else
    log "Installing uv"
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  ensure_symlink "$HOME/.local/bin/uv" uv
  ensure_symlink "$HOME/.local/bin/uvx" uvx
}

install_maven() {
  if command -v mvn >/dev/null 2>&1; then
    log "Maven already installed"
    return
  fi
  log "Installing Maven"
  sudo apt-get update -qq
  sudo apt-get install -y -qq maven
}

install_foundry() {
  if [ ! -x "$HOME/.foundry/bin/forge" ]; then
    log "Installing Foundry"
    curl -L https://foundry.paradigm.xyz | bash
    "$HOME/.foundry/bin/foundryup"
  else
    log "Foundry already installed"
  fi
  for bin in forge cast anvil chisel; do
    ensure_symlink "$HOME/.foundry/bin/$bin" "$bin"
  done
}

log "Setting up toolchains"
install_go
install_uv
install_maven
install_foundry

export PATH="/usr/local/go/bin:$HOME/.local/bin:$HOME/.foundry/bin:$PATH"

log "TypeScript SDK: pnpm install"
(cd "$REPO_ROOT/typescript" && pnpm install --frozen-lockfile)

log "TypeScript examples: pnpm install"
(cd "$REPO_ROOT/examples/typescript" && pnpm install)

log "Python SDK: uv sync"
(cd "$REPO_ROOT/python/x402" && uv sync --all-extras --dev)

log "Go SDK: download modules and build"
(cd "$REPO_ROOT/go" && make deps && go build ./...)

log "Java SDK: resolve dependencies and compile"
(cd "$REPO_ROOT/java" && mvn -q -B -DskipTests test-compile)

log "Done"
