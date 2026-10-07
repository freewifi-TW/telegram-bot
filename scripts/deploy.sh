#!/bin/bash
# 在 VM 上執行：第一次部署與之後更新都用同一支
set -euo pipefail
REPO=https://github.com/freewifi-TW/telegram-bot.git
DIR=$HOME/telegram-bot

sudo usermod -aG docker "$(whoami)" || true
command -v git >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq git)

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
[ -f "$HOME/bot.env" ] && mv "$HOME/bot.env" "$DIR/.env"
[ -f "$DIR/.env" ] || { echo "缺少 $DIR/.env"; exit 1; }

cd "$DIR"
sudo docker build -q -t machinechubbybot .
# 先 stop 讓 bot 有時間發下線通知（SIGTERM，最多等 10 秒），印出它的告別 log 再移除
if sudo docker stop machinechubbybot >/dev/null 2>&1; then
  echo "=== 舊容器關閉 log ==="
  sudo docker logs --tail 6 machinechubbybot 2>&1
fi
sudo docker rm -f machinechubbybot >/dev/null 2>&1 || true
sudo docker run -d --name machinechubbybot --restart unless-stopped \
  --env-file .env -v machinechubbybot-data:/app/data machinechubbybot >/dev/null
sleep 8
echo "=== 容器狀態 ==="
sudo docker ps --filter name=machinechubbybot --format "{{.Status}}"
echo "=== 最近 log ==="
sudo docker logs --tail 15 machinechubbybot 2>&1
