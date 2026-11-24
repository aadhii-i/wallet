import { describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { openKv } from './idb';

describe.skipIf(process.env.QD_BITCOIN_BROWSER_TESTS !== '1')('atomic Bitcoin storage in a real browser', () => {
  it('serializes two tabs and rolls back a failed signature/storage callback', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route('http://qd-bitcoin.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage test</title>' }),
      );
      await context.addInitScript({ content: `globalThis.openKv = ${openKv.toString()};` });
      const pages = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all(pages.map((page) => page.goto('http://qd-bitcoin.test/')));
      const reserve = `async () => {
        const kv=globalThis.openKv('atomic-test');
        try {
          await kv.update('coin',value=>{if(value)throw new Error('reserved');return {signed:1};});
          return 'signed';
        } catch { return 'reserved'; }
      }`;
      const results = await Promise.all(pages.map((page) => page.evaluate(`(${reserve})()`)));
      expect(results.sort()).toEqual(['reserved', 'signed']);
      const rollback = await pages[0]!.evaluate(`(async () => {
        const kv=globalThis.openKv('atomic-test');
        try {await kv.update('coin',value=>{value.signed=99;throw new Error('signing failed');});}catch{}
        return (await kv.get('coin')).signed;
      })()`);
      expect(rollback).toBe(1);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
