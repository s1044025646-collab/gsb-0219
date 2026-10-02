import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { makeSamples } from '../src/samples';
import { Service } from '../src/service';
import { Db } from '../src/db';
import { AppError } from '../src/errors';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epubchk-'));
}

function setup(): { dir: string; samples: string[]; svc: Service } {
  const dir = tmpDir();
  const samples = makeSamples(path.join(dir, 'samples'));
  const svc = new Service(new Db(path.join(dir, 'data')));
  return { dir, samples, svc };
}

const byName = (samples: string[], n: string) => samples.find((s) => s.endsWith(n))!;

test('合法样例：元数据、章节顺序与两级导航', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'valid-sample.epub'));
  assert.equal(imp.duplicate, false);
  assert.equal(imp.title, '样例：山间小站');
  assert.equal(imp.creator, '王小川');
  assert.equal(imp.language, 'zh-CN');

  const chapters = svc.chapters(imp.bookId);
  assert.deepEqual(chapters.map((c) => c.path), [
    'OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml', 'OEBPS/text/ch3.xhtml',
  ]);
  assert.deepEqual(chapters.map((c) => c.idref), ['ch1', 'ch2', 'ch3']);

  const nav = svc.navTree(imp.bookId);
  assert.equal(nav.length, 3);
  assert.equal(nav[0].label, '第一章 出发');
  assert.deepEqual(nav[0].children.map((c: any) => c.label), ['第一节 清晨', '第二节 站台']);
  assert.equal(nav[0].children[0].href, 'text/ch1.xhtml#s1');
  assert.equal(nav[1].children.length, 0);
  assert.deepEqual(nav[2].children.map((c: any) => c.href), ['text/ch3.xhtml#s1']);

  const report = svc.runCheck(imp.bookId);
  assert.equal(report.check.errors, 0);
  svc.db.close();
});

test('缺资源：报告 RESOURCE_MISSING 并定位到 OPF 与 href', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'broken-missing-resource.epub'));
  const report = svc.runCheck(imp.bookId);
  const issue = report.issues.find((i) => i.code === 'RESOURCE_MISSING');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.equal(issue.filePath, 'OEBPS/content.opf');
  assert.equal(issue.refValue, 'css/style.css');
  svc.db.close();
});

test('坏 spine 引用：SPINE_IDREF_MISSING', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'broken-spine-ref.epub'));
  const report = svc.runCheck(imp.bookId);
  const issue = report.issues.find((i) => i.code === 'SPINE_IDREF_MISSING');
  assert.ok(issue);
  assert.equal(issue.refValue, 'ch99');
  assert.equal(issue.filePath, 'OEBPS/content.opf');
  svc.db.close();
});

test('错误相对路径：NAV_TARGET_MISSING，以 nav 所在目录为基准', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'broken-wrong-path.epub'));
  const report = svc.runCheck(imp.bookId);
  const issue = report.issues.find((i) => i.code === 'NAV_TARGET_MISSING');
  assert.ok(issue);
  assert.equal(issue.refValue, 'text/chapter2.xhtml');
  assert.equal(issue.filePath, 'OEBPS/nav.xhtml');
  svc.db.close();
});

test('缺锚点：NAV_ANCHOR_MISSING，先核对文件再核对锚点', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'broken-missing-anchor.epub'));
  const report = svc.runCheck(imp.bookId);
  const issue = report.issues.find((i) => i.code === 'NAV_ANCHOR_MISSING');
  assert.ok(issue);
  assert.equal(issue.refValue, 'text/ch3.xhtml#s99');
  // 目标文件存在，不应同时报 NAV_TARGET_MISSING
  assert.equal(report.issues.filter((i) => i.code === 'NAV_TARGET_MISSING').length, 0);
  svc.db.close();
});

test('损坏 ZIP：导入失败且不写库', () => {
  const { dir, svc } = setup();
  const bad = path.join(dir, 'bad.epub');
  fs.writeFileSync(bad, 'this is not a zip file at all');
  assert.throws(() => svc.importBook(bad), (e: AppError) => e.code === 'ZIP_INVALID');
  assert.equal(svc.db.listBooks().length, 0);
  svc.db.close();
});

test('包路径越界：拒绝导入', () => {
  const { dir, svc } = setup();
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="../evil.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  const p = path.join(dir, 'traversal.epub');
  zip.writeZip(p);
  assert.throws(() => svc.importBook(p), (e: AppError) => e.code === 'PATH_TRAVERSAL' || e.code === 'OPF_NOT_FOUND');
  svc.db.close();
});

test('重复导入同一内容：返回已有记录', () => {
  const { samples, svc } = setup();
  const a = svc.importBook(byName(samples, 'valid-sample.epub'));
  const b = svc.importBook(byName(samples, 'valid-sample.epub'));
  assert.equal(b.duplicate, true);
  assert.equal(b.bookId, a.bookId);
  assert.equal(svc.db.listBooks().length, 1);
  svc.db.close();
});

test('远程链接只标注为 info，不访问', () => {
  const { dir, samples, svc } = setup();
  // 在合法样例基础上替换 nav，加入远程链接
  const src = byName(samples, 'valid-sample.epub');
  const zip = new AdmZip(src);
  const nav = zip.readAsText('OEBPS/nav.xhtml').replace(
    '<li><a href="text/ch2.xhtml">第二章 山间</a></li>',
    '<li><a href="https://example.com/ch2">第二章 山间</a></li>');
  zip.updateFile('OEBPS/nav.xhtml', Buffer.from(nav));
  const p = path.join(dir, 'remote.epub');
  zip.writeZip(p);
  const imp = svc.importBook(p);
  const report = svc.runCheck(imp.bookId);
  const remote = report.issues.find((i) => i.code === 'REMOTE_LINK');
  assert.ok(remote);
  assert.equal(remote.severity, 'info');
  assert.equal(report.check.errors, 0);
  svc.db.close();
});

test('服务重启后可查看既有书籍与报告', () => {
  const dir = tmpDir();
  const samples = makeSamples(path.join(dir, 'samples'));
  const dataDir = path.join(dir, 'data');
  const svc1 = new Service(new Db(dataDir));
  const imp = svc1.importBook(byName(samples, 'broken-missing-anchor.epub'));
  svc1.runCheck(imp.bookId);
  svc1.db.close();

  const svc2 = new Service(new Db(dataDir));
  const books = svc2.db.listBooks();
  assert.equal(books.length, 1);
  const report = svc2.latestReport(imp.bookId);
  assert.ok(report.issues.some((i) => i.code === 'NAV_ANCHOR_MISSING'));
  assert.deepEqual(svc2.chapters(imp.bookId).map((c) => c.idref), ['ch1', 'ch2', 'ch3']);
  svc2.db.close();
});

test('重新检查不改写源文件，且产生新检查记录', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'valid-sample.epub'));
  const before = fs.statSync(svc.getBook(imp.bookId).file_path).mtimeMs;
  svc.runCheck(imp.bookId);
  svc.runCheck(imp.bookId);
  const after = fs.statSync(svc.getBook(imp.bookId).file_path).mtimeMs;
  assert.equal(after, before);
  assert.equal(svc.db.checksForBook(imp.bookId).length, 2);
  svc.db.close();
});

test('问题筛选：按 severity 与 code', () => {
  const { samples, svc } = setup();
  const imp = svc.importBook(byName(samples, 'broken-missing-resource.epub'));
  svc.runCheck(imp.bookId);
  const errors = svc.listIssues(imp.bookId, 'error');
  assert.ok(errors.every((i) => i.severity === 'error'));
  const filtered = svc.listIssues(imp.bookId, undefined, 'RESOURCE_MISSING');
  assert.equal(filtered.length, 1);
  assert.throws(() => svc.listIssues(imp.bookId, 'bogus'), (e: AppError) => e.code === 'INVALID_PARAM');
  svc.db.close();
});
