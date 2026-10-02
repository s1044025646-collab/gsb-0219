import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db';
import { Service } from '../src/service';
import { buildSample, Variant } from '../scripts/make-samples';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epub-test-'));
}

async function makeService(): Promise<{ service: Service; dir: string; sampleDir: string }> {
  const dir = tmpDir();
  const sampleDir = path.join(dir, 'samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const service = new Service(new Db(path.join(dir, 'data')), path.join(dir, 'data'));
  return { service, dir, sampleDir };
}

async function sample(sampleDir: string, v: Variant): Promise<string> {
  return buildSample(v, path.join(sampleDir, `${v}.epub`));
}

test('导入合法样例：元数据、章节顺序、导航嵌套', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'valid'));
  assert.equal(r.duplicate, false);
  assert.equal(r.title, '样例：山间小记');
  assert.equal(r.author, '王小山');
  assert.equal(r.language, 'zh-CN');

  const chapters = service.getChapters(r.bookId);
  assert.deepEqual(chapters.map((c) => c.href), ['text/chapter1.xhtml', 'text/chapter2.xhtml']);
  assert.deepEqual(chapters.map((c) => c.position), [1, 2]);

  const nav = service.getNav(r.bookId);
  assert.equal(nav.length, 3);
  assert.equal(nav[0].label, '第一章 出发');
  assert.equal(nav[0].children.length, 2);
  assert.equal(nav[0].children[0].label, '第一节 清晨');
  assert.equal(nav[0].children[0].href, 'text/chapter1.xhtml#sec-1-1');
  assert.equal(nav[1].children[0].href, 'text/chapter2.xhtml#sec-2-1');
  service.db.close();
});

test('合法样例检查：仅远程链接 info，无错误', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'valid'));
  const check = await service.runCheck(r.bookId);
  const errors = check.issues.filter((i) => i.severity === 'error');
  assert.equal(errors.length, 0);
  const remote = check.issues.filter((i) => i.code === 'REMOTE_LINK');
  assert.equal(remote.length, 1);
  assert.equal(remote[0].severity, 'info');
  service.db.close();
});

test('缺失资源：RESOURCE_MISSING 定位到包内路径', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'missing-resource'));
  const check = await service.runCheck(r.bookId);
  const issue = check.issues.find((i) => i.code === 'RESOURCE_MISSING');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.equal(issue.file, 'OEBPS/images/cover.png');
  assert.equal(issue.ref, 'images/cover.png');
  service.db.close();
});

test('坏 spine 引用：SPINE_IDREF_MISSING', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'bad-spine'));
  const check = await service.runCheck(r.bookId);
  const issue = check.issues.find((i) => i.code === 'SPINE_IDREF_MISSING');
  assert.ok(issue);
  assert.equal(issue.ref, 'ch-ghost');
  assert.equal(issue.file, 'OEBPS/content.opf');
  service.db.close();
});

test('错误相对路径：NAV_LINK_TARGET_MISSING', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'bad-relative-path'));
  const check = await service.runCheck(r.bookId);
  const issue = check.issues.find((i) => i.code === 'NAV_LINK_TARGET_MISSING');
  assert.ok(issue);
  assert.equal(issue.file, 'OEBPS/nav.xhtml');
  assert.equal(issue.ref, 'chapter1.xhtml');
  service.db.close();
});

test('缺锚点：NAV_ANCHOR_MISSING 定位到目标文件', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'missing-anchor'));
  const check = await service.runCheck(r.bookId);
  const issue = check.issues.find((i) => i.code === 'NAV_ANCHOR_MISSING');
  assert.ok(issue);
  assert.equal(issue.file, 'OEBPS/text/chapter2.xhtml');
  assert.equal(issue.ref, 'text/chapter2.xhtml#sec-nope');
  service.db.close();
});

test('重复导入同一内容返回原书记录', async () => {
  const { service, sampleDir } = await makeService();
  const p = await sample(sampleDir, 'valid');
  const r1 = await service.importBook(p);
  const r2 = await service.importBook(p);
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r1.bookId, r2.bookId);
  assert.equal(service.listBooks().length, 1);
  service.db.close();
});

test('损坏文件：坏 ZIP 与非 EPUB 均报错且不退出', async () => {
  const { service, dir } = await makeService();
  const badZip = path.join(dir, 'bad.epub');
  fs.writeFileSync(badZip, 'this is not a zip');
  await assert.rejects(service.importBook(badZip), (e: { code: string }) => e.code === 'INVALID_ZIP');

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('readme.txt', 'hello');
  const noContainer = path.join(dir, 'nocontainer.epub');
  fs.writeFileSync(noContainer, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(service.importBook(noContainer), (e: { code: string }) => e.code === 'CONTAINER_MISSING');

  // 服务仍然可用
  const ok = await service.importBook(await sample(path.join(dir, 's2'), 'valid').catch(async () => {
    fs.mkdirSync(path.join(dir, 's2'), { recursive: true });
    return buildSample('valid', path.join(dir, 's2', 'valid.epub'));
  }));
  assert.equal(ok.duplicate, false);
  service.db.close();
});

test('服务重启后可查看既有书籍与报告', async () => {
  const { service, dir, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'missing-anchor'));
  const check = await service.runCheck(r.bookId);
  service.db.close();

  const service2 = new Service(new Db(path.join(dir, 'data')), path.join(dir, 'data'));
  const books = service2.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].title, '样例：山间小记');
  const report = service2.getReport(check.checkId);
  assert.equal(report.summary.errors, 1);
  assert.ok(report.issues.some((i) => i.code === 'NAV_ANCHOR_MISSING'));
  service2.db.close();
});

test('重新检查不改写源文件', async () => {
  const { service, sampleDir } = await makeService();
  const p = await sample(sampleDir, 'valid');
  const before = fs.readFileSync(p);
  const r = await service.importBook(p);
  await service.runCheck(r.bookId);
  await service.runCheck(r.bookId);
  assert.deepEqual(fs.readFileSync(p), before);
  assert.equal((service.listChecks(r.bookId) as unknown[]).length, 2);
  service.db.close();
});

test('问题筛选与报告汇总', async () => {
  const { service, sampleDir } = await makeService();
  const r = await service.importBook(await sample(sampleDir, 'valid'));
  const check = await service.runCheck(r.bookId);
  const infos = service.listIssues(check.checkId, 'info');
  assert.ok((infos as unknown[]).length >= 1);
  const errors = service.listIssues(check.checkId, 'error');
  assert.equal((errors as unknown[]).length, 0);
  const report = service.getReport(check.checkId);
  assert.equal(report.summary.errors, 0);
  assert.ok(report.summary.infos >= 1);
  service.db.close();
});
