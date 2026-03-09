FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt \
    --index-url https://download.pytorch.org/whl/cu124 \
    --extra-index-url https://pypi.org/simple/

COPY main.py .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD python3 -c "import urllib.request,json; d=json.load(urllib.request.urlopen('http://localhost:8000/health')); exit(0 if d.get('status') in ('ready','loading') else 1)" || exit 1

CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
