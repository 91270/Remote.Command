#!/bin/sh
set -eu

rcm_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case ${1-} in
  -h|--help)
    printf '%s\n' 'Usage: ./launch.sh [CONFIG] [--logout|--report] [--no-browser] [--no-persist-session] [--disable-no-sleep] [--debug]'
    exit 0
    ;;
esac

rcm_node=node
if ! "$rcm_node" -e 'const v=Number(process.versions.node.split(".")[0]); process.exit(v>=24 && v<27 ? 0 : 1)' >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) rcm_os=darwin ;;
    Linux) rcm_os=linux ;;
    *) printf '%s\n' 'Use the Windows launcher or install Node.js 24 LTS.' >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) rcm_arch=x64 ;;
    aarch64|arm64) rcm_arch=arm64 ;;
    *) printf '%s\n' 'Install Node.js 24 LTS for this architecture.' >&2; exit 1 ;;
  esac
  umask 077
  rcm_runtime="$rcm_root/state/node-runtime/$rcm_os-$rcm_arch"
  rcm_node="$rcm_runtime/bin/node"
  if [ ! -x "$rcm_node" ]; then
    [ -t 0 ] || { printf '%s\n' 'Run this launcher in a terminal to install a private copy of Node.js 24.' >&2; exit 1; }
    printf '%s' 'Install Node.js 24 in this project only? [y/N] '
    read -r rcm_answer
    case "$rcm_answer" in y|Y|yes|YES) ;; *) exit 1 ;; esac
    mkdir -p "$rcm_root/state/node-runtime"
    rcm_download=$(mktemp -d "$rcm_root/state/node-runtime/.download.XXXXXXXX")
    trap 'rm -rf -- "$rcm_download"' EXIT
    trap 'exit 1' HUP INT TERM
    rcm_base=https://nodejs.org/dist/latest-v24.x
    curl -fsSL --proto '=https' --proto-redir '=https' "$rcm_base/SHASUMS256.txt" -o "$rcm_download/SHASUMS256.txt"
    rcm_entry=$(awk -v suffix="-$rcm_os-$rcm_arch.tar.gz" 'length($1)==64 && $1 ~ /^[a-f0-9]+$/ && $2 ~ /^[A-Za-z0-9._-]+$/ && $2 ~ /^node-v24[.][0-9]+[.][0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix { print $1, $2; exit }' "$rcm_download/SHASUMS256.txt")
    [ -n "$rcm_entry" ] || { printf '%s\n' 'No compatible Node.js release found.' >&2; exit 1; }
    rcm_hash=${rcm_entry%% *}
    rcm_archive=${rcm_entry#* }
    curl -fsSL --proto '=https' --proto-redir '=https' "$rcm_base/$rcm_archive" -o "$rcm_download/node.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
      rcm_actual=$(sha256sum "$rcm_download/node.tar.gz")
    else
      rcm_actual=$(shasum -a 256 "$rcm_download/node.tar.gz")
    fi
    [ "${rcm_actual%% *}" = "$rcm_hash" ] || { printf '%s\n' 'Node.js checksum did not match.' >&2; exit 1; }
    tar -xzf "$rcm_download/node.tar.gz" -C "$rcm_download"
    [ -x "$rcm_node" ] || mv "$rcm_download/${rcm_archive%.tar.gz}" "$rcm_runtime"
    rm -rf -- "$rcm_download"
    trap - EXIT HUP INT TERM
  fi
fi
exec "$rcm_node" "$rcm_root/scripts/launch.mjs" "$@"
