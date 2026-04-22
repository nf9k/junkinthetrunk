# Custom trunk-recorder image with the tr-plugin-mqtt status plugin built in.
# Mirrors the upstream Dockerfile (ubuntu:24.04 multi-stage, gnuradio 3.10) and
# adds the Paho MQTT C/C++ libs plus a git-clone of the plugin into
# user_plugins/ so cmake picks it up during the main build.
#
# Upstream: github.com/robotastic/trunk-recorder
# Plugin:   github.com/TrunkRecorder/tr-plugin-mqtt

ARG TR_REF=master
ARG PLUGIN_REF=main

# ── Builder ─────────────────────────────────────────────────────────────────
FROM debian:trixie AS builder

ARG TR_REF
ARG PLUGIN_REF

RUN apt-get update && \
    apt-get -y upgrade && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install --no-install-recommends -y \
      build-essential ca-certificates cmake curl git \
      gnuradio-dev gr-osmosdr libosmosdr-dev \
      libairspy-dev libairspyhf-dev libbladerf-dev libboost-all-dev \
      libcurl4-openssl-dev libfreesrp-dev libgmp-dev libhackrf-dev \
      libmirisdr-dev liborc-0.4-dev libpthread-stubs0-dev librtlsdr-dev \
      libsndfile1-dev libsoapysdr-dev libssl-dev libuhd-dev libusb-dev \
      libusb-1.0-0-dev libxtrx-dev libpaho-mqtt-dev libpaho-mqttpp-dev \
      pkg-config wget python3-six ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch ${TR_REF} https://github.com/robotastic/trunk-recorder . && \
    git clone --depth 1 --branch ${PLUGIN_REF} https://github.com/TrunkRecorder/tr-plugin-mqtt user_plugins/tr-plugin-mqtt

COPY patches/arc4-decrypt.patch /src/arc4-decrypt.patch
RUN git apply /src/arc4-decrypt.patch

WORKDIR /src/build
RUN cmake .. && make -j$(nproc) && make DESTDIR=/newroot install

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM debian:trixie-slim

RUN apt-get update && \
    apt-get -y upgrade && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install --no-install-recommends -y \
      ca-certificates gr-funcube gr-iqbal curl wget docker.io ffmpeg jq \
      libboost-log1.83.0 libboost-chrono1.83.0t64 \
      libgnuradio-digital3.10.12 libgnuradio-analog3.10.12 \
      libgnuradio-filter3.10.12 libgnuradio-network3.10.12 \
      libgnuradio-uhd3.10.12 libgnuradio-osmosdr0.2.0t64 \
      libsoapysdr0.8 soapysdr0.8-module-all libairspyhf1 libfreesrp0 \
      librtlsdr0 libxtrx0 libpaho-mqtt1.3 libpaho-mqttpp3-1 && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /usr/share/{doc,man,info} /usr/local/share/{doc,man,info}

COPY --from=builder /newroot /
COPY decoder/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--config=/app/config.json"]
