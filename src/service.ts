import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Db, BookRow } from './db';
import { openEpub, chapterList, EpubPackage } from './epub';
import { checkPackage, Issue } from './checker';
import { AppError } from './errors';

export interface ImportResult {
  bookId: number;
  duplicate: boolean;
  sha256: string;
  title: string;
  creator: string;
  language: string;
}

export class Service {
  constructor(public readonly db: Db) {}

  private bookPath(sha256: string): string {
    return path.join(this.db.dataDir, 'books', `${sha256}.epub`);
  }

  importBook(filePath: string): ImportResult {
    if (!filePath) throw new AppError('INVALID_PARAM', '缺少文件路径参数');
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new AppError('FILE_NOT_FOUND', `文件不存在: ${abs}`, 404);
    }
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    const existing = this.db.bookByHash(sha256);
    if (existing) {
      return { bookId: existing.id, duplicate: true, sha256, title: existing.title, creator: existing.creator, language: existing.language };
    }

    const storedPath = this.bookPath(sha256);
    fs.copyFileSync(abs, storedPath);
    try {
      const pkg = openEpub(storedPath);
      const structure = {
        opfPath: pkg.opfPath,
        manifest: pkg.manifest,
        spine: pkg.spine,
        navPath: pkg.navPath,
        navTree: pkg.navTree,
        navParseError: pkg.navParseError,
        duplicateManifestIds: pkg.duplicateManifestIds,
        entries: [...pkg.entries.keys()],
      };
      const id = this.db.insertBook({
        sha256, title: pkg.title, creator: pkg.creator, language: pkg.language,
        opf_path: pkg.opfPath, file_path: storedPath, file_size: buf.length,
        imported_at: new Date().toISOString(), structure_json: JSON.stringify(structure),
      });
      return { bookId: id, duplicate: false, sha256, title: pkg.title, creator: pkg.creator, language: pkg.language };
    } catch (e) {
      fs.rmSync(storedPath, { force: true });
      throw e;
    }
  }

  getBook(bookId: number): BookRow {
    const book = this.db.bookById(bookId);
    if (!book) throw new AppError('BOOK_NOT_FOUND', `书籍不存在: id=${bookId}`, 404);
    return book;
  }

  private structure(book: BookRow): any {
    return JSON.parse(book.structure_json);
  }

  chapters(bookId: number) {
    const book = this.getBook(bookId);
    const s = this.structure(book);
    const byId = new Map<string, any>(s.manifest.map((m: any) => [m.id, m]));
    return (s.spine as any[]).map((sp: any, i: number) => {
      const item = byId.get(sp.idref);
      return { index: i, idref: sp.idref, linear: sp.linear, path: item?.resolvedPath ?? null, mediaType: item?.mediaType ?? null };
    });
  }

  navTree(bookId: number) {
    const book = this.getBook(bookId);
    return this.structure(book).navTree;
  }

  /** 重新打开包内文件执行检查；不修改源文件 */
  runCheck(bookId: number) {
    const book = this.getBook(bookId);
    const pkg = openEpub(book.file_path);
    const issues = checkPackage(pkg);
    const count = (sev: string) => issues.filter((i) => i.severity === sev).length;
    const checkId = this.db.insertCheck({
      book_id: bookId, run_at: new Date().toISOString(),
      error_count: count('error'), warning_count: count('warning'), info_count: count('info'),
    });
    this.db.insertIssues(checkId, issues.map((i) => ({
      severity: i.severity, code: i.code, message: i.message, file_path: i.filePath, ref_value: i.refValue,
    })));
    return this.reportForCheck(bookId, checkId);
  }

  reportForCheck(bookId: number, checkId: number) {
    const book = this.getBook(bookId);
    const check = this.db.checkById(checkId);
    if (!check || check.book_id !== bookId) throw new AppError('CHECK_NOT_FOUND', `检查记录不存在: id=${checkId}`, 404);
    const issues = this.db.issuesForCheck(checkId);
    return {
      book: { id: book.id, title: book.title, creator: book.creator, language: book.language, sha256: book.sha256, opfPath: book.opf_path },
      check: { id: check.id, runAt: check.run_at, errors: check.error_count, warnings: check.warning_count, infos: check.info_count },
      issues: issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message, filePath: i.file_path, refValue: i.ref_value })),
    };
  }

  latestReport(bookId: number) {
    this.getBook(bookId);
    const checks = this.db.checksForBook(bookId);
    if (checks.length === 0) throw new AppError('CHECK_NOT_FOUND', '该书籍尚未运行检查', 404);
    return this.reportForCheck(bookId, checks[0].id);
  }

  listIssues(bookId: number, severity?: string, code?: string) {
    this.getBook(bookId);
    if (severity && !['error', 'warning', 'info'].includes(severity)) {
      throw new AppError('INVALID_PARAM', `无效的 severity: ${severity}（可选 error|warning|info）`);
    }
    const checks = this.db.checksForBook(bookId);
    if (checks.length === 0) return [];
    return this.db.issuesForCheck(checks[0].id, severity, code).map((i) => ({
      severity: i.severity, code: i.code, message: i.message, filePath: i.file_path, refValue: i.ref_value,
    }));
  }
}
