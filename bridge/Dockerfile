FROM python:3.11-slim
# Build: rode `docker compose build` de dentro de bridge/, o context é o repo raiz (../).
# Precisamos das duas pastas: `bridge/` (este) e `iqoptionapi/` (irmã na raiz).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
WORKDIR /app
# Instala dependências primeiro (camada cacheada)
COPY bridge/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# Copia biblioteca IQ Option local (cópia no repo, NÃO baixamos de git remoto)
COPY iqoptionapi /app/iqoptionapi
# Copia a ponte (FastAPI)
COPY bridge /app/bridge
WORKDIR /app/bridge
# Porta default do compose
EXPOSE 8000
# Suporta $PORT dinâmico do Render ou 8000 como padrão
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --ws websockets --proxy-headers --forwarded-allow-ips=*"]
