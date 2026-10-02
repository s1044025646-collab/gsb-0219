import http from 'node:http';
import { Service } from './service';
import { toErrorPayload } from './errors';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/api/books') {
        const body = (await readBody(req)) as { path?: string };
        send(res, 201, await service.importBook(String(body.path ?? '')));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/books') {
        send(res, 200, service.listBooks());
        return;
      }
      if (parts[0] === 'api' && parts[1] === 'books' && parts[2] !== undefined) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) {
          send(res, 400, { error: { code: 'INVALID_ARGUMENT', message: '书籍 ID 必须为整数' } });
          return;
        }
        if (method === 'GET' && parts.length === 3) return send(res, 200, service.getBook(id));
        if (method === 'GET' && parts[3] === 'chapters') return send(res, 200, service.getChapters(id));
        if (method === 'GET' && parts[3] === 'nav') return send(res, 200, service.getNav(id));
        if (method === 'POST' && parts[3] === 'checks') return send(res, 201, await service.runCheck(id));
        if (method === 'GET' && parts[3] === 'checks') return send(res, 200, service.listChecks(id));
      }
      if (parts[0] === 'api' && parts[1] === 'checks' && parts[2] !== undefined) {
        const checkId = Number(parts[2]);
        if (!Number.isInteger(checkId)) {
          send(res, 400, { error: { code: 'INVALID_ARGUMENT', message: '检查 ID 必须为整数' } });
          return;
        }
        if (method === 'GET' && parts[3] === 'issues') {
          const severity = url.searchParams.get('severity') ?? undefined;
          const code = url.searchParams.get('code') ?? undefined;
          return send(res, 200, service.listIssues(checkId, severity, code));
        }
        if (method === 'GET' && parts[3] === 'report') {
          return send(res, 200, service.getReport(checkId));
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `未知路由: ${method} ${url.pathname}` } });
    } catch (err) {
      const e = toErrorPayload(err);
      send(res, e.httpStatus, { error: { code: e.code, message: e.message } });
    }
  });
}

export function startServer(service: Service, port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(service);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
