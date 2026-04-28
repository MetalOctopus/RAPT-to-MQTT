FROM python:3.11-slim

LABEL org.opencontainers.image.title="RAPT2MQTT" \
      org.opencontainers.image.description="Bridge between Kegland RAPT brewing devices and MQTT for Home Assistant" \
      org.opencontainers.image.source="https://github.com/MetalOctopus/RAPT-to-MQTT" \
      org.opencontainers.image.icon="https://raw.githubusercontent.com/MetalOctopus/RAPT-to-MQTT/main/app/static/icon.png"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

ENV CONFIG_DIR=/config

EXPOSE 8099

CMD ["python", "-m", "app.main"]
