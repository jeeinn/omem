#!/usr/bin/env bash
# omem 定时采集：跑一次 omem run（幂等，未变化的会话会被跳过）。
# 用法：./collect.sh [--since 7d] [--dry-run]
# cron 示例（每 30 分钟）：*/30 * * * * /path/to/omem/scripts/collect.sh >> /tmp/omem-collect.log 2>&1
set -u

run_args=()
since_flag=()
dry_flag=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --since) shift; [ "$#" -gt 0 ] && since_flag=(--since "$1") ;;
    --dry-run) dry_flag="--dry-run" ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

printf '[%s] omem run %s %s\n' "$(date -Is)" "${since_flag[*]}" "$dry_flag"
omem run "${since_flag[@]}" ${dry_flag:+$dry_flag}
