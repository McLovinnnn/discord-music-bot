#!/bin/bash
# Discord Music Bot - Pterodactyl install script.
# Runs once (and on manual "Reinstall Server") inside the installer container.
# Clones/updates the repo into /mnt/server. Dependencies are installed on
# first *startup* instead (the egg's startup command is "npm install && node
# boot.js"), since this installer container doesn't necessarily have Node.

set -e

apt-get update -y >/dev/null 2>&1 || true
apt-get install -y git ca-certificates >/dev/null 2>&1 || true

cd /mnt/server

GIT_ADDRESS="${GIT_ADDRESS:-https://github.com/McLovinnnn/discord-music-bot.git}"
BRANCH="${UPDATE_BRANCH:-main}"

if [ -d .git ]; then
  echo "Existing git checkout found - resetting to origin/${BRANCH}..."
  git remote set-url origin "${GIT_ADDRESS}"
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git reset --hard "origin/${BRANCH}"
else
  echo "Cloning ${GIT_ADDRESS} (branch: ${BRANCH})..."
  rm -rf /tmp/clone-target
  git clone --branch "${BRANCH}" "${GIT_ADDRESS}" /tmp/clone-target
  cp -a /tmp/clone-target/. /mnt/server/
  rm -rf /tmp/clone-target
fi

echo "Install complete. Dependencies install automatically on first startup."
