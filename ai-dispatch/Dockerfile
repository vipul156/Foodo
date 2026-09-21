FROM python:3.12-slim

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd -r -u 10001 foodo
USER foodo

EXPOSE 3010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3010", "--workers", "2"]
