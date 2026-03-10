FROM ubuntu:22.04

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-distutils && \
        # Uncomment for SSH debugging:
        # openssh-server sudo && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Uncomment for SSH debugging:
# RUN mkdir -p /var/run/sshd && \
#     rm -f /etc/ssh/ssh_host_*

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt \
    --index-url https://download.pytorch.org/whl/cu124 \
    --extra-index-url https://pypi.org/simple/ && \
    rm /tmp/requirements.txt

# Copy pre-downloaded model (download once locally, reuse across builds)
COPY model-cache /model-cache
ENV HF_HOME=/model-cache

# Follow Render's compute_examples user/workdir pattern
RUN groupadd -r duser && \
    useradd -r -g duser -d /opt/dispersedworker/ -s /bin/bash duser && \
    mkdir -p /opt/dispersedworker/ && \
    chown -R duser:duser /opt/dispersedworker/

WORKDIR /opt/dispersedworker/

# Uncomment for SSH debugging:
# COPY --chown=root:root --chmod=700 10-sshd /etc/sudoers.d/10-sshd
COPY --chown=root:root --chmod=755 entrypoint.sh /opt/dispersedworker/entrypoint.sh
COPY --chown=duser:duser main.py /opt/dispersedworker/main.py

USER duser

EXPOSE 8000
# Uncomment for SSH debugging:
# EXPOSE 22

ENTRYPOINT ["/opt/dispersedworker/entrypoint.sh"]
