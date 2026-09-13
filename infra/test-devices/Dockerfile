# A throwaway "managed host" for local development.
#
# It is a normal Debian userland with the statically-linked agent dropped in,
# so commands issued from the dashboard behave like they would on a real box.
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates procps curl iproute2 \
 && rm -rf /var/lib/apt/lists/*

COPY zenstier /usr/local/bin/zenstier
RUN chmod 0755 /usr/local/bin/zenstier && install -d -m 0700 /etc/zenstier

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
