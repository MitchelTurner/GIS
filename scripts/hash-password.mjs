#!/usr/bin/env node
// Prints an argon2 hash for ADMIN_PASSWORD_HASH. The password is read from stdin, not argv,
// so it stays out of shell history: `npm run hash-password` then type it and press Enter.
import argon2 from 'argon2';

const chunks = [];
if (process.stdin.isTTY) process.stderr.write('Password: ');
for await (const chunk of process.stdin) {
  chunks.push(chunk);
  if (process.stdin.isTTY && String(chunk).includes('\n')) break;
}
const password = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('Use a password of at least 12 characters.');
  process.exit(1);
}
console.log(await argon2.hash(password, { type: argon2.argon2id }));
process.exit(0);
