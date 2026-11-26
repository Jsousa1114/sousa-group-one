# The company's telephone exchange (Asterisk 20, Ubuntu 24.04 package).
# It connects to the Swiss operator (SIP) and to the browsers (WebRTC); the application
# drives every call through its control interface (ARI) and writes its settings into the
# shared folder /sgo (see entrypoint.sh).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-core-sounds-fr-wav iproute2 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sfn fr_CA_f_June /usr/share/asterisk/sounds/fr \
 && rm -rf /etc/asterisk/* \
 && mkdir -p /sgo /var/run/asterisk /var/lib/asterisk/keys \
 && chown -R ubuntu:ubuntu /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk /etc/asterisk /sgo

COPY deploy/local/asterisk/etc/ /etc/asterisk/
COPY deploy/local/asterisk/entrypoint.sh /usr/local/bin/sgo-asterisk
RUN chmod 755 /usr/local/bin/sgo-asterisk && chown -R ubuntu:ubuntu /etc/asterisk

ENTRYPOINT ["/usr/local/bin/sgo-asterisk"]
