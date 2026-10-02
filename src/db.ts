import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface BookRow {
  id: number;
  sha256: string;
  title: string;
  creator: string;
  language: string;
  opf_path: string;
  file_path: string;
  file_size: number;
  imported_at: string;
  structure_json: string;
}
export interface CheckRow {
  id: number;
  book_id: number;
  run_at: string;
  error_count: number;
  warning_count: number;
  info_count: number;
}
export interface IssueRow {
  id: number;
  check_id: number;
  severity: string;
  code: string;
  message: string;
  file_path: string;
  ref_value: string;
}

export class Db {
  readonly db: Database.Database;
  constructor(public readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'books'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'epubcheck.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        creator TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        opf_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        structure_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id),
        run_at TEXT NOT NULL,
        error_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        info_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id INTEGER NOT NULL REFERENCES checks(id),
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        file_path TEXT NOT NULL DEFAULT '',
        ref_value TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_issues_check ON issues(check_id);
      CREATE INDEX IF NOT EXISTS idx_checks_book ON checks(book_id);
    `);
  }

  insertBook(b: Omit<BookRow, 'id'>): number {
    const r = this.db.prepare(`INSERT INTO books (sha256,title,creator,language,opf_path,file_path,file_size,imported_at,structure_json)
      VALUES (@sha256,@title,@creator,@language,@opf_path,@file_path,@file_size,@imported_at,@structure_json)`).run(b);
    return Number(r.lastInsertRowid);
  }
  bookByHash(sha256: string): BookRow | undefined {
    return this.db.prepare('SELECT * FROM books WHERE sha256=?').get(sha256) as BookRow | undefined;
  }
  bookById(id: number): BookRow | undefined {
    return this.db.prepare('SELECT * FROM books WHERE id=?').get(id) as BookRow | undefined;
  }
  listBooks(): BookRow[] {
    return this.db.prepare('SELECT * FROM books ORDER BY id').all() as BookRow[];
  }
  insertCheck(c: Omit<CheckRow, 'id'>): number {
    const r = this.db.prepare(`INSERT INTO checks (book_id,run_at,error_count,warning_count,info_count)
      VALUES (@book_id,@run_at,@error_count,@warning_count,@info_count)`).run(c);
    return Number(r.lastInsertRowid);
  }
  insertIssues(checkId: number, issues: Array<Omit<IssueRow, 'id' | 'check_id'>>): void {
    const stmt = this.db.prepare(`INSERT INTO issues (check_id,severity,code,message,file_path,ref_value)
      VALUES (?,?,?,?,?,?)`);
    const tx = this.db.transaction(() => {
      for (const i of issues) stmt.run(checkId, i.severity, i.code, i.message, i.file_path, i.ref_value);
    });
    tx();
  }
  checksForBook(bookId: number): CheckRow[] {
    return this.db.prepare('SELECT * FROM checks WHERE book_id=? ORDER BY id DESC').all(bookId) as CheckRow[];
  }
  checkById(id: number): CheckRow | undefined {
    return this.db.prepare('SELECT * FROM checks WHERE id=?').get(id) as CheckRow | undefined;
  }
  issuesForCheck(checkId: number, severity?: string, code?: string): IssueRow[] {
    let sql = 'SELECT * FROM issues WHERE check_id=?';
    const params: unknown[] = [checkId];
    if (severity) { sql += ' AND severity=?'; params.push(severity); }
    if (code) { sql += ' AND code=?'; params.push(code); }
    sql += ' ORDER BY id';
    return this.db.prepare(sql).all(...params) as IssueRow[];
  }
  close(): void { this.db.close(); }
}
