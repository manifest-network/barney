#!/bin/bash
set -e

echo "=== Container starting ==="
echo "Python: $(python3 --version 2>&1)"
echo "Working dir: $(pwd)"
echo "User: $(whoami)"
echo "NVIDIA driver: $(cat /proc/driver/nvidia/version 2>/dev/null || echo 'not found')"
echo "nvidia-smi: $(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null || echo 'not available')"

# Quick import check
echo "=== Checking Python imports ==="
python3 -c "
import sys; print(f'Python {sys.version}')
try:
    import torch; print(f'PyTorch {torch.__version__}, CUDA available: {torch.cuda.is_available()}')
    if torch.cuda.is_available():
        print(f'GPU: {torch.cuda.get_device_name(0)}, VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB')
except Exception as e:
    print(f'torch import/check failed: {e}')
try:
    import diffusers; print(f'diffusers {diffusers.__version__}')
except Exception as e:
    print(f'diffusers import failed: {e}')
try:
    import fastapi; print(f'fastapi {fastapi.__version__}')
except Exception as e:
    print(f'fastapi import failed: {e}')
" 2>&1

# Uncomment for SSH debugging (also uncomment openssh-server in Dockerfile):
# if [[ -n "${SSH_PUBKEY}" ]]; then
#     echo "=== Setting up SSH ==="
#     mkdir -p ~/.ssh
#     echo -e "${SSH_PUBKEY}" > ~/.ssh/authorized_keys
#     chmod 700 ~/.ssh
#     chmod 600 ~/.ssh/authorized_keys
#     /usr/bin/sudo /usr/sbin/dpkg-reconfigure openssh-server > /dev/null 2>&1
#     /usr/bin/sudo /usr/sbin/sshd -D &
#     echo "sshd started"
# fi

echo "=== Starting uvicorn ==="
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 &

# Keep container alive until any background process exits
wait -n
exit $?
