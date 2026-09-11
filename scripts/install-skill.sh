#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_NAME="chatgpt-driven-iteration"
TARGET=""
FORCE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/install-skill.sh (--cursor | --codex | --all) [--force]

Install the repository's ChatGPT-driven iteration Skill as a symbolic link.

  --cursor  Install to ~/.cursor/skills
  --codex   Install to ${CODEX_HOME:-~/.codex}/skills
  --all     Install to both locations
  --force   Replace an existing destination that is not this Skill's link
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cursor|--codex|--all)
      if [[ -n "${TARGET}" ]]; then
        echo "error: choose exactly one of --cursor, --codex, or --all" >&2
        exit 2
      fi
      TARGET="${1#--}"
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "${TARGET}" ]]; then
  usage >&2
  exit 2
fi

install_skill() {
  local platform="$1"
  local skill_src="${REPO_ROOT}/.${platform}/skills/${SKILL_NAME}"
  local skill_dest_root
  local skill_dest

  if [[ "${platform}" == "codex" ]]; then
    skill_dest_root="${CODEX_HOME:-${HOME}/.codex}/skills"
  else
    skill_dest_root="${HOME}/.cursor/skills"
  fi
  skill_dest="${skill_dest_root}/${SKILL_NAME}"

  if [[ ! -f "${skill_src}/SKILL.md" ]]; then
    echo "error: ${platform} Skill not found at ${skill_src}" >&2
    exit 1
  fi

  mkdir -p "${skill_dest_root}"

  if [[ -L "${skill_dest}" ]]; then
    if [[ "$(readlink -f "${skill_dest}")" == "$(readlink -f "${skill_src}")" ]]; then
      echo "Already installed: ${skill_dest} -> ${skill_src}"
      return
    fi
    if [[ "${FORCE}" -ne 1 ]]; then
      echo "error: destination is an existing link: ${skill_dest}; use --force to replace it" >&2
      exit 1
    fi
    rm "${skill_dest}"
  elif [[ -e "${skill_dest}" ]]; then
    if [[ "${FORCE}" -ne 1 ]]; then
      echo "error: destination already exists: ${skill_dest}; use --force to replace it" >&2
      exit 1
    fi
    rm -rf "${skill_dest}"
  fi

  ln -s "${skill_src}" "${skill_dest}"
  echo "Installed: ${skill_dest} -> ${skill_src}"
}

case "${TARGET}" in
  cursor) install_skill cursor ;;
  codex) install_skill codex ;;
  all)
    install_skill cursor
    install_skill codex
    ;;
esac
