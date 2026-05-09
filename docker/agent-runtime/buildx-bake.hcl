group "default" {
  targets = ["base", "claude", "codex", "gemini"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
