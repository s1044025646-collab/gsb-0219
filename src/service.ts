import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Db, BookRow } from './db';
import { parseEpub, Issue, NavNode } from './epub';
import { ApiError } from './errors';

export interface ImportResult {
  bookId: number;
  duplicate: boolean;
  title: string | null;
  author: string | null;
  language: string | null;
  importIssues: Issue[];
}

export class Service {
  constructor(
    public db: Db,
    private dataDir: string,
  ) {}

  async importBook(filePath: string): Promise<ImportResult> {
    if (!filePath || typeof filePath !== 'string') {
      throw new ApiError('INVALID_ARGUMENT', '缺少参数: path');
    }
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ApiError('NOT_FOUND', `文件不存在: ${abs}`, 404);
    }
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const existing = this.db.findBookByHash(sha256);
    if (existing) {
      return { bookId: existing.id, duplicate: true, title: existing.title, author: existing.author, language: existing.language, importIssues: [] };
    }
    // 解析失败（坏 ZIP/XML）不会让服务退出，只抛出带错误码的异常
    const structure = await parseEpub(buf);
    const dest = path.join(this.dataDir, 'books', `${sha256}.epub`);
    fs.copyFileSync(abs, dest);
    const bookId = this.db.insertBook({
      sha256,
      title: structure.title,
      author: structure.author,
      language: structure.language,
      file_path: dest,
      opf_path: structure.opfPath,
      nav_json: JSON.stringify(structure.navTree),
      manifest_json: JSON.stringify(structure.manifest),
      spine_json: JSON.stringify(structure.spine),
    });
    return { bookId, duplicate: false, title: structure.title, author: structure.author, language: structure.language, importIssues: structure.issues };
  }

  listBooks() {
    return this.db.listBooks().map((b) => ({
      id: b.id, title: b.title, author: b.author, language: b.language, sha256: b.sha256, importedAt: b.imported_at,
    }));
  }

  private mustBook(id: number): BookRow {
    const b = this.db.getBook(id);
    if (!b) throw new ApiError('NOT_FOUND', `书籍不存在: ${id}`, 404);
    return b;
  }

  getBook(id: number) {
    const b = this.mustBook(id);
    return {
      id: b.id, title: b.title, author: b.author, language: b.language,
      sha256: b.sha256, opfPath: b.opf_path, importedAt: b.imported_at,
    };
  }

  getChapters(id: number) {
    const b = this.mustBook(id);
    const spine = JSON.parse(b.spine_json) as { idref: string; href: string | null }[];
    return spine.map((s, i) => ({ position: i + 1, idref: s.idref, href: s.href }));
  }

  getNav(id: number): NavNode[] {
    const b = this.mustBook(id);
    return JSON.parse(b.nav_json) as NavNode[];
  }

  async runCheck(id: number) {
    const b = this.mustBook(id);
    const buf = fs.readFileSync(b.file_path);
    const structure = await parseEpub(buf);
    const checkId = this.db.insertCheck(id, structure.issues);
    return { checkId, bookId: id, issueCount: structure.issues.length, issues: structure.issues };
  }

  listChecks(bookId: number) {
    this.mustBook(bookId);
    return this.db.listChecks(bookId);
  }

  listIssues(checkId: number, severity?: string, code?: string) {
    const check = this.db.getCheck(checkId);
    if (!check) throw new ApiError('NOT_FOUND', `检查记录不存在: ${checkId}`, 404);
    if (severity && !['error', 'warning', 'info'].includes(severity)) {
      throw new ApiError('INVALID_ARGUMENT', `非法 severity: ${severity}`);
    }
    return this.db.listIssues(checkId, severity, code);
  }

  getReport(checkId: number) {
    const check = this.db.getCheck(checkId);
    if (!check) throw new ApiError('NOT_FOUND', `检查记录不存在: ${checkId}`, 404);
    const book = this.mustBook(check.book_id);
    const issues = this.db.listIssues(checkId) as Issue[];
    return {
      checkId,
      bookId: book.id,
      title: book.title,
      author: book.author,
      language: book.language,
      sha256: book.sha256,
      runAt: check.run_at,
      summary: {
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
        infos: issues.filter((i) => i.severity === 'info').length,
      },
      issues,
    };
  }
}
