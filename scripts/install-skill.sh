#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="${REPO_ROOT}/.cursor/skills/chatgpt-driven-iteration"
SKILL_DEST="${HOME}/.cursor/skills/chatgpt-driven-iteration"

if [[ ! -f "${SKILL_SRC}/SKILL.md" ]]; then
  echo "error: Skill not found at ${SKILL_SRC}" >&2
  exit 1
fi

mkdir -p "${HOME}/.cursor/skills"

if [[ -e "${SKILL_DEST}" || -L "${SKILL_DEST}" ]]; then
  rm -rf "${SKILL_DEST}"
fi

ln -s "${SKILL_SRC}" "${SKILL_DEST}"

echo "Installed: ${SKILL_DEST} -> ${SKILL_SRC}"
