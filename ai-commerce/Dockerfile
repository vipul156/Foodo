FROM python:3.12-slim

WORKDIR /srv

# Deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Non-root
RUN useradd -r -u 10001 foodo
USER foodo

EXPOSE 3009
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3009", "--workers", "2"]
