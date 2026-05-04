FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . ./
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/python -m pip install --upgrade pip setuptools wheel \
  && /opt/venv/bin/pip install --no-cache-dir -r python/requirements.txt

ENV PYTHON_EXECUTABLE=/opt/venv/bin/python
ENV PATH=/opt/venv/bin:$PATH
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]