# CHALK live server: FastAPI + Microsoft Agent Framework, ready for Azure Container Apps.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY chalk ./chalk
COPY web ./web
COPY data ./data
COPY scripts ./scripts
EXPOSE 8000
# Model settings come from environment variables (CHALK_BASE_URL, CHALK_API_KEY, CHALK_MODEL),
# set as secrets on the container app. Without them the server replays the recorded crew.
CMD ["uvicorn", "chalk.server:app", "--host", "0.0.0.0", "--port", "8000"]
