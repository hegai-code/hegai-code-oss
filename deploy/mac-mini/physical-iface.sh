#!/bin/bash
# Prints the physical interface carrying the default route. With a full-tunnel
# VPN up, netstat lists a scoped default for it after the utun one.
/usr/sbin/netstat -rn -f inet |
  /usr/bin/awk '$1 == "default" && $2 ~ /^[0-9]+\./ && $NF !~ /^utun/ { print $NF; exit }'
