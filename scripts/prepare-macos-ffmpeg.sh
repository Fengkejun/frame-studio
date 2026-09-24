#!/bin/bash
set -euo pipefail

version=ffmpeg-2026.06.11
arch=$(uname -m)
case "$arch" in
  arm64) archive=ffmpeg-macos-arm64.tar.gz ;;
  x86_64) archive=ffmpeg-macos-x64.tar.gz ;;
  *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac
base="https://github.com/vanloctech/ffmpeg-macos/releases/download/$version"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
curl --fail --location --retry 3 "$base/$archive" --output "$workdir/$archive"
curl --fail --location --retry 3 "$base/$archive.sha256" --output "$workdir/$archive.sha256"
(cd "$workdir" && shasum -a 256 --check "$archive.sha256")
mkdir "$workdir/extracted"
tar -xzf "$workdir/$archive" -C "$workdir/extracted"
ffmpeg=$(find "$workdir/extracted" -type f -name ffmpeg -print -quit)
ffprobe=$(find "$workdir/extracted" -type f -name ffprobe -print -quit)
if [[ -z "$ffmpeg" || -z "$ffprobe" ]]; then
  echo 'Release archive must contain ffmpeg and ffprobe' >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/artifacts/macos-ffmpeg/bin"
cp "$ffmpeg" "$ffprobe" "$root/artifacts/macos-ffmpeg/bin/"
chmod 755 "$root/artifacts/macos-ffmpeg/bin/ffmpeg" "$root/artifacts/macos-ffmpeg/bin/ffprobe"
curl --fail --location --retry 3 \
  https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.0/COPYING.GPLv2 \
  --output "$root/artifacts/macos-ffmpeg/LICENSE"
cp "$root/docs/ffmpeg-macos-notice.txt" "$root/artifacts/macos-ffmpeg/README.txt"
echo "FRAME_STUDIO_FFMPEG_DIR=$root/artifacts/macos-ffmpeg/bin" >> "$GITHUB_ENV"
