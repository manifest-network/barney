# Stage 1: install Python packages
FROM python:3.12-slim AS builder

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt \
    --index-url https://download.pytorch.org/whl/cu124 \
    --extra-index-url https://pypi.org/simple/

# Stage 2: runtime with SSH support for debugging
FROM python:3.12-slim

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends openssh-server sudo && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/sshd && \
    rm -f /etc/ssh/ssh_host_*

COPY --from=builder /install /usr/local

WORKDIR /app

RUN useradd -m -s /bin/bash appuser
COPY --chown=root:root --chmod=700 10-sshd /etc/sudoers.d/10-sshd
COPY --chown=root:root --chmod=755 entrypoint.sh /app/entrypoint.sh
COPY main.py .
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8000 22

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
