# The agents' image for sandbox.runtime docker. Build it with `node $R sandbox build`,
# which passes the host's claude and gh versions.
FROM node:24-bookworm-slim

ARG CLAUDE_VERSION
ARG GH_VERSION

RUN test -n "$CLAUDE_VERSION" && test -n "$GH_VERSION"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git iptables dnsutils procps util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
  && release="gh_${GH_VERSION}_linux_${arch}" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${release}.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 755 "/tmp/${release}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/${release}"

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && npm cache clean --force

RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node

# The agents' npm config. It lives in the image, so the runtime never writes into a home an agent controls.
RUN mkdir -p /etc/rollout && install -m 644 /dev/null /etc/rollout/npmrc

COPY entrypoint.sh init-firewall.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/init-firewall.sh

# No setuid or setgid file is left to hand an agent root back.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
