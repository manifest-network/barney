#!/bin/bash

# SSH setup (Render passes SSH_PUBKEY env var for remote access)
if [[ -n "${SSH_PUBKEY}" ]]; then
    echo "Setting up SSH access..."
    mkdir -p ~/.ssh
    echo -e "${SSH_PUBKEY}" > ~/.ssh/authorized_keys
    chmod 700 ~/.ssh
    chmod 600 ~/.ssh/authorized_keys
    echo "Generating host keys"
    /usr/bin/sudo /usr/sbin/dpkg-reconfigure openssh-server > /dev/null 2>&1
    echo "Starting sshd"
    /usr/bin/sudo /usr/sbin/sshd -D &
fi

echo "Starting inference server..."
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
