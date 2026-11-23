#!/bin/sh
set -eu

prm_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case ${1-} in
  -h|--help)
    printf '%s\n' 'Usage: ./launch.sh [CONFIG] [--logout|--report] [--no-upload] [--no-browser] [--no-persist-session] [--disable-no-sleep] [--debug]'
    exit 0
    ;;
esac

prm_node=node
if ! "$prm_node" -e 'const v=Number(process.versions.node.split(".")[0]); process.exit(v>=24 && v<27 ? 0 : 1)' >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) prm_os=darwin ;;
    Linux) prm_os=linux ;;
    *) printf '%s\n' 'Use the Windows launcher or install Node.js 24 LTS.' >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) prm_arch=x64 ;;
    aarch64|arm64) prm_arch=arm64 ;;
    *) printf '%s\n' 'Install Node.js 24 LTS for this architecture.' >&2; exit 1 ;;
  esac
  umask 077
  prm_runtime="$prm_root/state/node-runtime/$prm_os-$prm_arch"
  prm_node="$prm_runtime/bin/node"
  if [ ! -x "$prm_node" ]; then
    [ -t 0 ] || { printf '%s\n' 'Run this launcher in a terminal to install a private copy of Node.js 24.' >&2; exit 1; }
    printf '%s' 'Install Node.js 24 in this project only? [y/N] '
    read -r prm_answer
    case "$prm_answer" in y|Y|yes|YES) ;; *) exit 1 ;; esac
    mkdir -p "$prm_root/state/node-runtime"
    prm_download=$(mktemp -d "$prm_root/state/node-runtime/.download.XXXXXXXX")
    trap 'rm -rf -- "$prm_download"' EXIT
    trap 'exit 1' HUP INT TERM
    prm_base=https://nodejs.org/dist/latest-v24.x
    curl -fsSL --proto '=https' --proto-redir '=https' "$prm_base/SHASUMS256.txt" -o "$prm_download/SHASUMS256.txt"
    prm_entry=$(awk -v suffix="-$prm_os-$prm_arch.tar.gz" 'length($1)==64 && $1 ~ /^[a-f0-9]+$/ && $2 ~ /^[A-Za-z0-9._-]+$/ && $2 ~ /^node-v24[.][0-9]+[.][0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix { print $1, $2; exit }' "$prm_download/SHASUMS256.txt")
    [ -n "$prm_entry" ] || { printf '%s\n' 'No compatible Node.js release found.' >&2; exit 1; }
    prm_hash=${prm_entry%% *}
    prm_archive=${prm_entry#* }
    curl -fsSL --proto '=https' --proto-redir '=https' "$prm_base/$prm_archive" -o "$prm_download/node.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
      prm_actual=$(sha256sum "$prm_download/node.tar.gz")
    else
      prm_actual=$(shasum -a 256 "$prm_download/node.tar.gz")
    fi
    [ "${prm_actual%% *}" = "$prm_hash" ] || { printf '%s\n' 'Node.js checksum did not match.' >&2; exit 1; }
    tar -xzf "$prm_download/node.tar.gz" -C "$prm_download"
    [ -x "$prm_node" ] || mv "$prm_download/${prm_archive%.tar.gz}" "$prm_runtime"
    rm -rf -- "$prm_download"
    trap - EXIT HUP INT TERM
  fi
fi
exec "$prm_node" "$prm_root/scripts/launch.mjs" "$@"
