#!/bin/sh
# Builds the container's egress rules in a new chain and then switches to it:
# loopback, open connections, DNS to the resolvers and HTTPS to the IPv4
# addresses of ALLOWED_DOMAINS. Everything else is rejected.
set -eu
set -f

IPV4='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'

fail() {
  echo "init-firewall: $1" >&2
  exit 1
}

# A failure prints one line, with the first line of what iptables said.
rule() {
  if ! output="$(iptables "$@" 2>&1)"; then
    fail "iptables $*: $(printf '%s\n' "$output" | head -n 1)"
  fi
}

current="$(iptables -S OUTPUT 2>/dev/null | sed -n 's/^-A OUTPUT -j ROLLOUT_OUT_\([0-9][0-9]*\)$/\1/p' | sort -n | tail -n 1)"
# A chain name has at most 28 characters, which leaves 16 digits.
chain="ROLLOUT_OUT_$((${current:-0} + 1))"

# Until the jump to the new chain is in place, a failed step removes it and the old chain stays in force.
trap 'iptables -F "$chain" 2>/dev/null || true; iptables -X "$chain" 2>/dev/null || true' EXIT

rule -N "$chain"
rule -A "$chain" -o lo -j ACCEPT
# A rebuild never drops an open connection.
rule -A "$chain" -m state --state ESTABLISHED,RELATED -j ACCEPT

for server in $(sed -n 's/^nameserver[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*$/\1/p' /etc/resolv.conf | grep -E "$IPV4" || true); do
  rule -A "$chain" -d "$server" -p udp --dport 53 -j ACCEPT
  rule -A "$chain" -d "$server" -p tcp --dport 53 -j ACCEPT
done

resolved=0

for host in ${ALLOWED_DOMAINS:-}; do
  for address in $(dig +short +time=3 +tries=2 "$host" A 2>/dev/null | grep -E "$IPV4" || true); do
    rule -A "$chain" -d "$address" -p tcp --dport 443 -j ACCEPT
    resolved=$((resolved + 1))
  done
done

# A resolver that is down would otherwise replace working rules with none.
if [ -n "${ALLOWED_DOMAINS:-}" ] && [ "$resolved" -eq 0 ]; then
  fail "no address for any of: $ALLOWED_DOMAINS"
fi

rule -A "$chain" -j REJECT --reject-with icmp-port-unreachable
rule -P OUTPUT DROP
rule -I OUTPUT 1 -j "$chain"
trap - EXIT

for old in $(iptables -S 2>/dev/null | sed -n 's/^-N \(ROLLOUT_OUT_[0-9][0-9]*\)$/\1/p'); do
  if [ "$old" != "$chain" ]; then
    while iptables -D OUTPUT -j "$old" 2>/dev/null; do :; done
    rule -F "$old"
    rule -X "$old"
  fi
done

# IPv6 reaches no allowed host, only loopback. A kernel without ip6tables support has no IPv6 rules to set.
if ip6tables -S OUTPUT >/dev/null 2>&1; then
  ip6tables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
fi
