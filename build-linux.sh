#!/usr/bin/env bash
set -euo pipefail

# Build Linux x86_64 (glibc) release binary.
# - On Linux x86_64 hosts: builds natively
# - Otherwise: falls back to Docker (linux/amd64)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BIN_NAME="dlkn-socket-bridge"
TARGET_TRIPLE="x86_64-unknown-linux-gnu"
DIST_DIR="$ROOT_DIR/dist"
OUT_BIN="$DIST_DIR/${BIN_NAME}-linux-x86_64"

DOCKER_IMAGE="${DOCKER_IMAGE:-rust:1-bookworm}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
FORCE_DOCKER="${FORCE_DOCKER:-0}"

print_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$OUT_BIN"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$OUT_BIN"
  fi
}

build_native() {
  echo "==> Using native build (Linux x86_64)"

  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found. Install Rust first (https://rustup.rs)." >&2
    exit 1
  fi

  # `reqwest` + native-tls on Linux typically requires OpenSSL dev headers at build time.
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "warning: pkg-config not found. You may need:" >&2
    echo "  sudo apt-get update && sudo apt-get install -y pkg-config libssl-dev" >&2
  fi

  if command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists openssl 2>/dev/null; then
    echo "warning: OpenSSL development files not detected. You may need:" >&2
    echo "  sudo apt-get update && sudo apt-get install -y pkg-config libssl-dev" >&2
  fi

  if command -v rustup >/dev/null 2>&1; then
    echo "==> Ensuring Rust target is installed: $TARGET_TRIPLE"
    rustup target add "$TARGET_TRIPLE" >/dev/null
  fi

  echo "==> Building release binary"
  cargo build --release --target "$TARGET_TRIPLE"

  mkdir -p "$DIST_DIR"
  cp "target/$TARGET_TRIPLE/release/$BIN_NAME" "$OUT_BIN"
  chmod +x "$OUT_BIN"

  echo "==> Built: $OUT_BIN"
  print_sha256
}

build_docker() {
  echo "==> Falling back to Docker build"

  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found. Install Docker Desktop / Docker Engine first." >&2
    exit 1
  fi

  mkdir -p "$DIST_DIR"

  echo "==> Docker image: $DOCKER_IMAGE"
  echo "==> Docker platform: $DOCKER_PLATFORM"

  # Notes:
  # - We mount cargo caches to speed up repeated builds.
  # - Container runs as root so on native Linux you may get root-owned target/dist files.
  docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -v "$ROOT_DIR:/work" \
    -v "${HOME}/.cargo/registry:/usr/local/cargo/registry" \
    -v "${HOME}/.cargo/git:/usr/local/cargo/git" \
    -w /work \
    "$DOCKER_IMAGE" \
    bash -c "
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      CONTAINER_OUT_BIN=\"/work/dist/$BIN_NAME-linux-x86_64\"
      apt-get update
      apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates
      if command -v rustup >/dev/null 2>&1; then
        rustup target add \"$TARGET_TRIPLE\" >/dev/null
      fi
      cargo build --release --target \"$TARGET_TRIPLE\"
      cp \"target/$TARGET_TRIPLE/release/$BIN_NAME\" \"\$CONTAINER_OUT_BIN\"
      chmod +x \"\$CONTAINER_OUT_BIN\"
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum \"\$CONTAINER_OUT_BIN\"
      fi
    "

  echo "==> Built: $OUT_BIN"
}

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
echo "==> Host: $HOST_OS $HOST_ARCH"

if [[ "$FORCE_DOCKER" == "1" ]]; then
  build_docker
elif [[ "$HOST_OS" == "Linux" && "$HOST_ARCH" == "x86_64" ]]; then
  build_native
else
  build_docker
fi
