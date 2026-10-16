ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:trixie-2026.10.0
FROM ${BUILD_FROM}

# Python 3.13 from Debian trixie, in a venv (Debian marks the system Python as externally managed)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

WORKDIR /app
COPY luminorium/ /app/luminorium/

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH="/app" \
    PYTHONUNBUFFERED=1

RUN python3 -c "import luminorium; print('Luminorium', luminorium.__version__)"

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
