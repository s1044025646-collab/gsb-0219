import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface BookRow {
  id: number;
  sha256: string;
  title: string | null;
  author: string | null;
  language: string | null;
  file_path: string;
  opf_path: string;
  nav_json: string;
  manifest_json: string;
  spine_json: string;
  imported_at: string;
}

export class Db {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'books'), { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'app.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        title TEXT, author TEXT, language TEXT,
        file_path TEXT NOT NULL,
        opf_path TEXT NOT NULL,
        nav_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        spine_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id),
        run_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id INTEGER NOT NULL REFERENCES checks(id),
        code TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        file TEXT,
        ref TEXT
      );
    `);
  }

  findBookByHash(sha256: string): BookRow | undefined {
    return this.db.prepare('SELECT * FROM books WHERE sha256 = ?').get(sha256) as BookRow | undefined;
  }

  insertBook(b: Omit<BookRow, 'id' | 'imported_at'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO books (sha256, title, author, language, file_path, opf_path, nav_json, manifest_json, spine_json, imported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(b.sha256, b.title, b.author, b.language, b.file_path, b.opf_path, b.nav_json, b.manifest_json, b.spine_json, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  listBooks(): BookRow[] {
    return this.db.prepare('SELECT * FROM books ORDER BY id').all() as unknown as BookRow[];
  }

  getBook(id: number): BookRow | undefined {
    return this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined;
  }

  insertCheck(bookId: number, issues: { code: string; severity: string; message: string; file: string | null; ref: string | null }[]): number {
    const r = this.db.prepare('INSERT INTO checks (book_id, run_at) VALUES (?,?)').run(bookId, new Date().toISOString());
    const checkId = Number(r.lastInsertRowid);
    const stmt = this.db.prepare('INSERT INTO issues (check_id, code, severity, message, file, ref) VALUES (?,?,?,?,?,?)');
    for (const i of issues) stmt.run(checkId, i.code, i.severity, i.message, i.file, i.ref);
    return checkId;
  }

  getCheck(id: number): { id: number; book_id: number; run_at: string } | undefined {
    return this.db.prepare('SELECT * FROM checks WHERE id = ?').get(id) as { id: number; book_id: number; run_at: string } | undefined;
  }

  listChecks(bookId: number): unknown[] {
    return this.db.prepare('SELECT * FROM checks WHERE book_id = ? ORDER BY id').all(bookId) as unknown[];
  }

  listIssues(checkId: number, severity?: string, code?: string): unknown[] {
    let sql = 'SELECT * FROM issues WHERE check_id = ?';
    const params: (string | number)[] = [checkId];
    if (severity) { sql += ' AND severity = ?'; params.push(severity); }
    if (code) { sql += ' AND code = ?'; params.push(code); }
    sql += ' ORDER BY id';
    return this.db.prepare(sql).all(...params) as unknown[];
  }

  close(): void {
    this.db.close();
  }
}
