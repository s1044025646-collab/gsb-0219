import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSamples } from '../src/samples';
import { Service } from '../src/service';
import { Db } from '../src/db';
import { startServer } from '../src/api';

function req(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      port, host: '127.0.0.1', path: p, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('HTTP API：导入、章节、导航、检查、筛选、报告', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epubchk-api-'));
  const samples = makeSamples(path.join(dir, 'samples'));
  const svc = new Service(new Db(path.join(dir, 'data')));
  const server = await startServer(svc, 0);
  const port = (server.address() as any).port;
  assert.ok(port > 0); // 端口 0 时自动选择空闲端口

  try {
  const imp = await req(port, 'POST', '/books', { path: byName(samples, 'broken-missing-anchor.epub') });
  assert.equal(imp.status, 201);
  const bookId = imp.body.bookId;

  const chapters = await req(port, 'GET', `/books/${bookId}/chapters`);
  assert.deepEqual(chapters.body.map((c: any) => c.idref), ['ch1', 'ch2', 'ch3']);

  const nav = await req(port, 'GET', `/books/${bookId}/nav`);
  assert.equal(nav.body[0].children.length, 2);

  const check = await req(port, 'POST', `/books/${bookId}/checks`);
  assert.equal(check.status, 201);
  assert.ok(check.body.check.errors > 0);

  const issues = await req(port, 'GET', `/books/${bookId}/issues?severity=error&code=NAV_ANCHOR_MISSING`);
  assert.equal(issues.body.length, 1);

  const report = await req(port, 'GET', `/books/${bookId}/report`);
  assert.equal(report.body.book.title, '样例：山间小站');

  const notFound = await req(port, 'GET', '/books/9999/report');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'BOOK_NOT_FOUND');

  const badParam = await req(port, 'GET', '/books/abc/chapters');
  assert.equal(badParam.status, 400);
  assert.equal(badParam.body.error.code, 'INVALID_PARAM');

  const badImport = await req(port, 'POST', '/books', { path: path.join(dir, 'nope.epub') });
  assert.equal(badImport.status, 404);
  assert.equal(badImport.body.error.code, 'FILE_NOT_FOUND');
  } catch (e) {
    console.error('TESTFAIL', e);
    throw e;
  } finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  svc.db.close();
  }
});

function byName(samples: string[], n: string): string {
  return samples.find((s) => s.endsWith(n))!;
}

