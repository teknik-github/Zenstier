#!/usr/bin/env bash
# Generates a development CA and a Mosquitto server certificate.
# Production uses real ACME certificates instead — see docs/security.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CERT_DIR="${REPO_ROOT}/infra/mosquitto/certs"
LAN_IP="${ZENSTIER_LAN_IP:-$(ip -4 -o addr show scope global | awk 'NR==1{split($4,a,"/"); print a[1]}')}"

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

if [[ -f server.crt && "${FORCE:-0}" != "1" ]]; then
  echo "Certificates already exist in $CERT_DIR (set FORCE=1 to regenerate)."
  exit 0
fi

echo "==> Generating root CA"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
chmod 600 ca.key

openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/C=ID/O=Zenstier/OU=Development/CN=Zenstier Dev Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -out ca.crt

echo "==> Generating server key + CSR"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
chmod 600 server.key

openssl req -new -key server.key \
  -subj "/C=ID/O=Zenstier/OU=Development/CN=mqtt.zenstier.local" \
  -out server.csr

# Go ignores the certificate CN entirely (since 1.15) — SANs are mandatory.
SANS="DNS:mqtt.zenstier.local,DNS:mosquitto,DNS:localhost,IP:127.0.0.1"
if [[ -n "$LAN_IP" ]]; then
  SANS="${SANS},IP:${LAN_IP}"
fi
echo "==> SANs: $SANS"

echo "==> Signing server certificate"
openssl x509 -req -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -out server.crt \
  -extfile <(printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid,issuer" \
    "subjectAltName=${SANS}")

rm -f server.csr

# The official image runs Mosquitto as uid/gid 1883.
chown 1883:1883 server.key server.crt ca.crt 2>/dev/null || true
chmod 640 server.key
chmod 644 server.crt ca.crt

echo "==> Verifying"
openssl verify -CAfile ca.crt server.crt
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative Name"
echo "==> Certificates written to $CERT_DIR"
