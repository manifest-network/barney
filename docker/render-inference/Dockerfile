# Stage 1: install Python packages + download model
FROM python:3.12-slim AS builder

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt \
    --index-url https://download.pytorch.org/whl/cu124 \
    --extra-index-url https://pypi.org/simple/

# Pre-download SDXL-Turbo model weights into the image
ENV HF_HOME=/model-cache
RUN PYTHONPATH=/install/lib/python3.12/site-packages \
    python3 -c "from diffusers import AutoPipelineForText2Image; AutoPipelineForText2Image.from_pretrained('stabilityai/sdxl-turbo', variant='fp16')"

# Stage 2: ubuntu base (matches Render's compute_examples pattern)
FROM ubuntu:22.04

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-distutils \
        openssh-server sudo && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/sshd && \
    rm -f /etc/ssh/ssh_host_*

# Copy Python packages from builder
COPY --from=builder /install/lib /usr/local/lib
COPY --from=builder /install/bin /usr/local/bin

# Copy pre-downloaded model cache
COPY --from=builder /model-cache /model-cache
ENV HF_HOME=/model-cache

# Follow Render's compute_examples user/workdir pattern
RUN groupadd -r duser && \
    useradd -r -g duser -d /opt/dispersedworker/ -s /bin/bash duser && \
    mkdir -p /opt/dispersedworker/ && \
    chown -R duser:duser /opt/dispersedworker/

WORKDIR /opt/dispersedworker/

COPY --chown=root:root --chmod=700 10-sshd /etc/sudoers.d/10-sshd
COPY --chown=root:root --chmod=755 entrypoint.sh /opt/dispersedworker/entrypoint.sh
COPY --chown=duser:duser main.py /opt/dispersedworker/main.py

USER duser

EXPOSE 8000 22

ENTRYPOINT ["/opt/dispersedworker/entrypoint.sh"]
