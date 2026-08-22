import type os from 'node:os';
import { describe, expect, it } from 'vitest';

import { machineInfo, networkAddresses } from './connection.js';

const iface = (
  address: string,
  family: 'IPv4' | 'IPv6',
  internal = false,
): os.NetworkInterfaceInfo =>
  ({
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  }) as os.NetworkInterfaceInfo;

describe('networkAddresses (phase 10)', () => {
  it('classe tailnet (100.64/10, fd7a:115c:a1e0::/48) et globales (2000::/3, IPv4 publique), ignore le reste', () => {
    const out = networkAddresses({
      lo: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
      eth: [
        iface('192.168.1.10', 'IPv4'),
        iface('fe80::1%eth', 'IPv6'),
        iface('2a01:cb00:1234::42', 'IPv6'),
        iface('2A01:CB00:1234::42', 'IPv6'),
        iface('fd00::5', 'IPv6'),
      ],
      tailscale0: [iface('100.101.102.103', 'IPv4'), iface('fd7a:115c:a1e0::ab:cd', 'IPv6')],
      wan: [iface('203.0.113.7', 'IPv4'), iface('169.254.1.1', 'IPv4'), iface('10.0.0.1', 'IPv4')],
    });
    expect(out).toEqual({
      tailnet: ['100.101.102.103', 'fd7a:115c:a1e0::ab:cd'],
      global: ['2a01:cb00:1234::42', '203.0.113.7'],
    });
  });

  it('est embarqué dans machineInfo() (listes toujours présentes)', () => {
    const info = machineInfo();
    expect(Array.isArray(info.addresses?.tailnet)).toBe(true);
    expect(Array.isArray(info.addresses?.global)).toBe(true);
  });
});
