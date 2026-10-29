#!/bin/sh
# Finder-launched Xcode does not inherit the terminal's toolchain PATH.
export PATH="${HOME}/.cargo/bin:${PNPM_HOME:-${HOME}/Library/pnpm}:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  if [ -s "${NVM_DIR}/nvm.sh" ]; then
    . "${NVM_DIR}/nvm.sh" --no-use
    nvm use --silent default >/dev/null || exit 1
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Xcode build requires Node.js on PATH or an nvm default version.' >&2
  exit 1
fi
exec node "$(dirname "$0")/mobile.mjs" ios xcode-script "$@"
