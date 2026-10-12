import assert from "node:assert/strict";
import test from "node:test";
import { clientIpRateKey } from "../src/hosted/client-ip.ts";

test("malformed client IPs are rejected", () => {
  for (const bad of ["abcd", "::::", ":::", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4 ", "fe80::1%eth0",
    "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::1", "::1.2.3", "1.2.3.4::", "g::1", "", "1".repeat(46), `2001:db8::${"0:".repeat(10)}1`]) {
    assert.equal(clientIpRateKey(bad), null, bad);
  }
});

test("valid IPv4 keys canonically", () => {
  assert.equal(clientIpRateKey("203.0.113.7"), "v4:203.0.113.7");
  assert.equal(clientIpRateKey("0.0.0.0"), "v4:0.0.0.0");
  assert.equal(clientIpRateKey("::ffff:203.0.113.7"), "v4:203.0.113.7");
});

test("valid IPv6 keys by /64", () => {
  assert.equal(clientIpRateKey("2001:db8::1"), "v6:2001:db8:0:0::/64");
  assert.equal(clientIpRateKey("::1"), "v6:0:0:0:0::/64");
  assert.equal(clientIpRateKey("2001:0db8:0001:0002:0003:0004:0005:0006"), "v6:2001:db8:1:2::/64");
  assert.equal(clientIpRateKey("64:ff9b::192.0.2.33"), "v6:64:ff9b:0:0::/64");
  assert.equal(clientIpRateKey("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"), "v6:ffff:ffff:ffff:ffff::/64");
});

test("IPv6 addresses in one /64 share a key; other /64s do not", () => {
  const key = clientIpRateKey("2001:db8:a:b::1");
  assert.equal(clientIpRateKey("2001:db8:a:b:ffff:1234:5678:9abc"), key);
  assert.notEqual(clientIpRateKey("2001:db8:a:c::1"), key);
});

test("mixed case normalizes to the same key", () => {
  assert.equal(clientIpRateKey("2001:DB8:A:B::Ff"), clientIpRateKey("2001:db8:a:b::ff"));
  assert.equal(clientIpRateKey("::FFFF:192.0.2.1"), "v4:192.0.2.1");
});
