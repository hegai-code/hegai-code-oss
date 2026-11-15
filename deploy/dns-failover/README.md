# Public hub DNS failover

The hub lives on Contabo, `198.51.100.233`. Cloud, `203.0.113.133`, is its
preferred raw TLS relay for Russian networks that block the direct address.
On 2 November 2026 Cloud stopped answering while the hub remained healthy.
`code.example.com` was switched directly to Contabo to restore access.

Gcore Free rejected native healthcheck configuration: TTL must be at least
120 seconds, checks at least 300 seconds, and the account's single dynamic
RRset is already occupied by the apex. Do not remove the apex routing or
change the billing plan to install this watchdog.

## Behaviour

`ccr-dns-failover.timer` runs on **vps-box-1 (198.51.100.127)**, independently
of both relay and hub, with the Gcore key already on that host. It manages only
the A RRsets for `code.example.com`, `claude.example.com` and `remote.example.com`.
All three are names for the same hub; legacy clients and agents use the aliases.
The apex, platform and other projects are outside its scope.

Each run probes both addresses for each name concurrently with HTTPS `/health`,
pinning IPs while retaining that name's Host, SNI and certificate verification. It accepts
only HTTP 200 and `{"ok":true}`, with no redirects or environment proxy.
Each name has independent streaks: a broken alias-specific SNI route cannot
borrow the main hostname's successful checks or hold up its recovery.

- Three consecutive relay failures **and** three consecutive origin successes
  select Contabo. Both unavailable leaves DNS unchanged.
- Twenty consecutive relay successes select Cloud again (about 10 minutes).
- Runs start 30 seconds after the previous run ends; failures, gaps over
  90 seconds and clock rollback reset the relevant streaks. With healthy DNS
  API access, failover normally takes roughly 1–2 minutes plus resolver caches
  (TTL 120 seconds). This is not instant connection-level failover.
- The target is checked again before each write. Unchanged DNS makes no PUT.
- Extra addresses, metadata, pickers, changed TTL/ID or a foreign destination
  stop all writes. Drift before a PUT is refused; Gcore has no documented
  conditional PUT, so stop the timer before manual DNS maintenance.
- Partial API failures are retried on the next run; PUT readback is mandatory.
  Atomic state and a nonblocking file lock prevent overlapping writers.

Direct Contabo remains blocked by some Russian ISPs. A second independent
Russian relay would be needed to retain access from those networks during a
Cloud outage. A monitor running on vps-box-1 also cannot act while that host
or the DNS API is unavailable.

## Install and verify

Use reviewed, pushed source. No hub/agent binary or nginx restart is involved.
The key stays in `/root/.secrets/gcore-apikey.txt`, supplied by systemd as a
temporary credential to a DynamicUser; never put its value in Git or the unit.

```bash
python3 deploy/test/dns_failover_test.py
install -d -m 755 /opt/ccr-dns-failover
install -m 644 deploy/dns-failover/failover.py /opt/ccr-dns-failover/failover.py
install -m 644 deploy/dns-failover/ccr-dns-failover.{service,timer} /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/ccr-dns-failover.{service,timer}
systemctl daemon-reload
systemctl enable --now ccr-dns-failover.timer
systemctl start ccr-dns-failover.service
journalctl -u ccr-dns-failover.service -n 20 --no-pager
dig +short code.example.com A @1.1.1.1
curl --fail https://code.example.com/health
```

Read-only observation (no DNS or state changes; creates only the scratch lock):

```bash
python3 /opt/ccr-dns-failover/failover.py \
  --key-file /root/.secrets/gcore-apikey.txt --state-dir /tmp/ccr-dns-observation
```

Before manual maintenance, `systemctl stop ccr-dns-failover.timer` and wait for
the oneshot service to finish. To uninstall, disable the timer with
`systemctl disable --now ccr-dns-failover.timer`; leave the current healthy DNS
address in place. Changing DNS back to a down relay is not a safe rollback.
The pre-incident `code` RRset is backed up on vps-box-1 in
`/root/dns-backups/code.example.com-A-20261102T065739Z.json` (0600).
