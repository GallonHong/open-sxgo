import { it, expect } from 'vitest';
import { publicAddress, resolveTarget } from '../../packages/link-checker/src/index';
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '192.168.0.1',
  '172.16.0.1',
  '169.254.169.254',
  '0.0.0.0',
  '100.64.0.1',
  '::1',
  'fe80::1',
  'fc00::1',
  '::ffff:127.0.0.1',
  '2001:db8::1',
])('AC-030/031 阻止内网与保留地址 %s', (ip) => expect(publicAddress(ip)).toBe(false));
it('允许公网地址', () => {
  expect(publicAddress('1.1.1.1')).toBe(true);
  expect(publicAddress('2606:4700:4700::1111')).toBe(true);
});
it.each([
  'https://127.1/',
  'https://[::ffff:7f00:1]/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://1.1.1.1:8443/',
])('规范化 URL 后拒绝绕过 %s', async (url) => await expect(resolveTarget(url)).rejects.toThrow());
