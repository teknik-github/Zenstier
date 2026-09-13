/**
 * SSRF guard suite.
 *
 * A webhook URL is set with `device:update`, and a team Owner is not the
 * server administrator — so an unguarded URL would let a team member make the
 * server POST to its own network. Run after any change to safe-fetch.ts.
 */
import "dotenv/config";
import { assertPublicUrl, describeBlockedAddress } from "../src/server/infrastructure/net/safe-fetch";

let pass = 0, fail = 0;
async function blocked(url: string, why: string) {
  try {
    await assertPublicUrl(url);
    console.log(`  ✗ ALLOWED ${url}  (${why})`); fail++;
  } catch (e) {
    console.log(`  ✓ ${url.padEnd(46)} ${(e as Error).message}`); pass++;
  }
}
async function allowed(url: string) {
  try { await assertPublicUrl(url); console.log(`  ✓ ${url} allowed`); pass++; }
  catch (e) { console.log(`  ✗ BLOCKED ${url}: ${(e as Error).message}`); fail++; }
}

async function main() {
  console.log("Cloud metadata and loopback:");
  await blocked("http://169.254.169.254/latest/meta-data/", "AWS/GCP metadata");
  await blocked("http://[fd00::1]/", "unique-local v6");
  await blocked("http://127.0.0.1:5480/", "postgres on loopback");
  await blocked("http://localhost:6385/", "redis via hostname");
  await blocked("http://[::1]:3020/", "loopback v6");
  await blocked("http://0.0.0.0/", "this host");

  console.log("\nPrivate ranges:");
  await blocked("http://10.0.0.5/hook", "RFC1918 10/8");
  await blocked("http://172.16.4.4/hook", "RFC1918 172.16/12");
  await blocked("http://192.168.1.104:3020/", "the Zenstier host itself");
  await blocked("http://100.64.1.1/", "CGNAT");

  console.log("\nEvasion attempts:");
  await blocked("http://[::ffff:127.0.0.1]/", "ipv4-mapped loopback");
  await blocked("http://[::ffff:169.254.169.254]/", "ipv4-mapped metadata");
  await blocked("http://[::ffff:a9fe:a9fe]/", "ipv4-mapped metadata, hex form");
  await blocked("http://[::ffff:10.0.0.1]/", "ipv4-mapped private");
  await blocked("http://2130706433/", "decimal-encoded 127.0.0.1");
  await blocked("http://user:pass@example.com/", "credentials in URL");
  await blocked("file:///etc/passwd", "non-http scheme");
  await blocked("gopher://127.0.0.1:5480/_x", "gopher scheme");

  console.log("\nLegitimate destinations:");
  await allowed("https://hooks.slack.com/services/T000/B000/xxx");
  await allowed("https://discord.com/api/webhooks/1/abc");

  console.log("\nRange classification spot-checks:");
  for (const [ip, expect] of [["8.8.8.8", null], ["169.254.169.254", "link-local / cloud metadata"], ["172.15.0.1", null], ["172.16.0.1", "private network"], ["172.32.0.1", null]] as [string, string|null][]) {
    const got = describeBlockedAddress(ip);
    const ok = got === expect;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? "✓" : "✗"} ${ip.padEnd(16)} -> ${got ?? "allowed"}`);
  }

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
