FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

RUN mkdir -p /config/logs

ENV CONFIG_DIR=/config

EXPOSE 8099

CMD ["python", "-m", "app.main"]
