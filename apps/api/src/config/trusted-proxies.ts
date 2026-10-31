import { isIP } from 'node:net';

/** Explicit addresses/CIDRs only: no blanket trust, hop counts, or proxy-addr aliases. */
export function isProxyAddress(value: string): boolean {
  const [address = '', mask, ...extra] = value.split('/');
  const version = isIP(address);
  if (!version || extra.length) return false;
  if (mask === undefined) return true;
  if (!/^\d+$/.test(mask)) return false;
  const bits = Number(mask);
  return bits > 0 && bits <= (version === 4 ? 32 : 128);
}
