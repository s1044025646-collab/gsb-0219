import path from 'node:path';
import fs from 'node:fs';
import { Db } from './db';
import { Service } from './service';
import { startServer } from './server';
import { toErrorPayload } from './errors';

const DATA_DIR = process.env.EPUB_CHECK_DATA ?? path.resolve(process.cwd(), 'data');

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function fail(err: unknown): never {
  const e = toErrorPayload(err);
  console.error(`错误 [${e.code}] ${e.message}`);
  process.exit(1);
}

function renderNav(nodes: { label: string; href: string | null; children: unknown[] }[], indent = ''): void {
  for (const n of nodes) {
    console.log(`${indent}- ${n.label}${n.href ? `  (${n.href})` : ''}`);
    renderNav(n.children as typeof nodes, indent + '  ');
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const service = new Service(new Db(DATA_DIR), DATA_DIR);

  switch (cmd) {
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail(new Error(`非法端口: ${args[portIdx + 1]}`));
      const { port: actual } = await startServer(service, port);
      console.log(`EPUB 检查服务已启动: http://127.0.0.1:${actual}  (数据目录: ${DATA_DIR})`);
      return;
    }
    case 'import': {
      if (!args[0]) fail(new Error('用法: cli import <epub路径>'));
      printJson(await service.importBook(args[0]));
      break;
    }
    case 'list':
      printJson(service.listBooks());
      break;
    case 'chapters': {
      const rows = service.getChapters(Number(args[0]));
      for (const r of rows) console.log(`${r.position}. [${r.idref}] ${r.href ?? '(缺失)'}`);
      break;
    }
    case 'nav':
      renderNav(service.getNav(Number(args[0])) as never);
      break;
    case 'check':
      printJson(await service.runCheck(Number(args[0])));
      break;
    case 'issues': {
      const sevIdx = args.indexOf('--severity');
      const codeIdx = args.indexOf('--code');
      printJson(service.listIssues(Number(args[0]), sevIdx >= 0 ? args[sevIdx + 1] : undefined, codeIdx >= 0 ? args[codeIdx + 1] : undefined));
      break;
    }
    case 'report': {
      const report = service.getReport(Number(args[0]));
      const outIdx = args.indexOf('--out');
      if (outIdx >= 0 && args[outIdx + 1]) {
        fs.writeFileSync(args[outIdx + 1], JSON.stringify(report, null, 2), 'utf8');
        console.log(`报告已导出: ${args[outIdx + 1]}`);
      } else {
        printJson(report);
      }
      break;
    }
    default:
      console.log(`用法:
  serve [--port N]     启动 API 服务（默认自动选择空闲端口）
  import <file.epub>   导入电子书
  list                 列出已导入书籍
  chapters <bookId>    查看章节阅读顺序
  nav <bookId>         查看导航目录树
  check <bookId>       运行一致性检查
  issues <checkId> [--severity error|warning|info] [--code CODE]
  report <checkId> [--out report.json]`);
  }
  service.db.close();
}

main().catch(fail);
