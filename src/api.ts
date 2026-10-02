import http from 'node:http';
import { Service } from './service';
import { AppError } from './errors';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new AppError('INVALID_PARAM', '请求体过大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppError('INVALID_PARAM', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function parseId(raw: string | undefined, name = 'id'): number {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new AppError('INVALID_PARAM', `非法的 ${name}: ${raw}`);
  return id;
}

export function createHandler(svc: Service) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/books') {
        const body = await readBody(req);
        if (typeof body?.path !== 'string' || !body.path) {
          throw new AppError('INVALID_PARAM', '请求体需包含 path 字段（EPUB 文件路径）');
        }
        return sendJson(res, 201, svc.importBook(body.path));
      }
      if (method === 'GET' && url.pathname === '/books') {
        return sendJson(res, 200, svc.db.listBooks().map((b) => ({
          id: b.id, title: b.title, creator: b.creator, language: b.language,
          sha256: b.sha256, importedAt: b.imported_at, fileSize: b.file_size,
        })));
      }
      if (parts[0] === 'books' && parts.length >= 2) {
        const bookId = parseId(parts[1], 'bookId');
        const sub = parts[2];
        if (method === 'GET' && !sub) {
          const b = svc.getBook(bookId);
          return sendJson(res, 200, { id: b.id, title: b.title, creator: b.creator, language: b.language, sha256: b.sha256, opfPath: b.opf_path, importedAt: b.imported_at });
        }
        if (method === 'GET' && sub === 'chapters') return sendJson(res, 200, svc.chapters(bookId));
        if (method === 'GET' && sub === 'nav') return sendJson(res, 200, svc.navTree(bookId));
        if (method === 'POST' && sub === 'checks') return sendJson(res, 201, svc.runCheck(bookId));
        if (method === 'GET' && sub === 'checks') return sendJson(res, 200, svc.db.checksForBook(bookId));
        if (method === 'GET' && sub === 'issues') {
          return sendJson(res, 200, svc.listIssues(bookId, url.searchParams.get('severity') ?? undefined, url.searchParams.get('code') ?? undefined));
        }
        if (method === 'GET' && sub === 'report') return sendJson(res, 200, svc.latestReport(bookId));
      }
      throw new AppError('INVALID_PARAM', `未匹配的路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof AppError) {
        sendJson(res, e.httpStatus, { error: { code: e.code, message: e.message } });
      } else {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
      }
    }
  };
}

export function startServer(svc: Service, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      createHandler(svc)(req, res).catch((e) => {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: String(e?.message ?? e) } });
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`EPUB 检查服务已启动: http://127.0.0.1:${actual}`);
      resolve(server);
    });
  });
}
