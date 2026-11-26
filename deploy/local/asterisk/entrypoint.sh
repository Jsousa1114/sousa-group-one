#!/bin/sh
# Starts the exchange once the application has written its settings into /sgo/etc.
set -e
mkdir -p /sgo/etc /sgo/spool/recording /sgo/sounds
chown -R 1000:1000 /sgo
ln -sfn /sgo/etc /etc/asterisk/sgo

# The control interface (ARI) and the browsers' connection are only offered to the application,
# through the address of the Docker host (docker0); never on the Internet.
BIND="${ASTERISK_HTTP_BIND:-}"
if [ -z "$BIND" ]; then
  BIND=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
fi
if [ -z "$BIND" ]; then
  echo "[telephone] docker0 introuvable : l'interface de contrôle écoute sur toutes les adresses (protégée par mot de passe)."
  BIND=0.0.0.0
fi
cat > /etc/asterisk/http.conf <<CONF
[general]
enabled = yes
bindaddr = $BIND
bindport = ${ASTERISK_HTTP_PORT:-8188}
CONF
# The manager interface, same address: the application reads the operator connection state.
cat > /etc/asterisk/manager.conf <<CONF
[general]
enabled = yes
bindaddr = $BIND
port = ${ASTERISK_AMI_PORT:-5038}
displayconnects = no
#tryinclude sgo/manager.conf
CONF
chown 1000:1000 /etc/asterisk/http.conf /etc/asterisk/manager.conf

i=0
while [ ! -f /sgo/etc/ready ]; do
  if [ $((i % 30)) -eq 0 ]; then echo "[telephone] En attente des réglages de l'application…"; fi
  i=$((i + 1))
  sleep 2
done
echo "[telephone] Démarrage du central (interface de contrôle sur $BIND:${ASTERISK_HTTP_PORT:-8188})."
exec asterisk -f -U ubuntu -G ubuntu
