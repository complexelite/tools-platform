#!/bin/sh
set -eu
set -a
. /etc/complexelite/tools-apps.env
set +a
docker stack deploy --compose-file deploy/tools-apps.yml complexelite-tools
