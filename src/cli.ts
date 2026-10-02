import { Service } from './service';
import { Db } from './db';
import { AppError } from './errors';
import { makeSamples } from './samples';
import { startServer } from './api';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(process.env.EPUBCHECK_DATA_DIR ?? path.join(process.cwd(), 'data'));

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(obj: unknown): void { console.log(JSON.stringify(obj, null, 2)); }

function fail(e: unknown): never {
  if (e instanceof AppError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    process.exit(e.code === 'BOOK_NOT_FOUND' || e.code === 'CHECK_NOT_FOUND' || e.code === 'FILE_NOT_FOUND' ? 4 : 2);
  }
  console.error(`内部错误: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const USAGE = `epubchk - EPUB 结构与资源一致性检查工具

用法:
  epubchk import <file.epub>            导入电子书（重复内容返回已有记录）
  epubchk list                          列出已导入书籍
  epubchk chapters <bookId>             查看章节阅读顺序（spine）
  epubchk nav <bookId>                  查看导航目录树
  epubchk check <bookId>                运行一致性检查
  epubchk issues <bookId> [--severity error|warning|info] [--code CODE]
  epubchk report <bookId> [--out file]  导出最近一次检查的 JSON 报告
  epubchk checks <bookId>               列出历史检查记录
  epubchk serve [--port N]              启动 HTTP API（默认自动选择空闲端口）
  epubchk make-samples [dir]            生成演示样例（合法 + 4 个损坏变体）

全局参数: --data-dir <dir>  数据目录（默认 ./data，可用 EPUBCHECK_DATA_DIR 覆盖）
`;

export async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];
  const dataDir = argValue(args, '--data-dir') ?? DEFAULT_DATA_DIR;
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'make-samples') {
    const dir = args[1] && !args[1].startsWith('--') ? path.resolve(args[1]) : path.resolve('samples');
    const files = makeSamples(dir);
    console.log('已生成样例:');
    for (const f of files) console.log('  ' + f);
    return;
  }
  if (cmd === 'serve') {
    const portArg = argValue(args, '--port');
    const port = portArg !== undefined ? Number(portArg) : 0;
    if (portArg !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new AppError('INVALID_PARAM', `无效端口: ${portArg}`);
    }
    const svc = new Service(new Db(dataDir));
    await startServer(svc, port);
    return;
  }

  const svc = new Service(new Db(dataDir));
  try {
    switch (cmd) {
      case 'import': {
        const file = args[1];
        if (!file) throw new AppError('INVALID_PARAM', '用法: epubchk import <file.epub>');
        print(svc.importBook(file));
        break;
      }
      case 'list': {
        print(svc.db.listBooks().map((b) => ({
          id: b.id, title: b.title, creator: b.creator, language: b.language,
          sha256: b.sha256, importedAt: b.imported_at, fileSize: b.file_size,
        })));
        break;
      }
      case 'chapters': print(svc.chapters(requireId(args))); break;
      case 'nav': print(svc.navTree(requireId(args))); break;
      case 'check': print(svc.runCheck(requireId(args))); break;
      case 'checks': print(svc.db.checksForBook(requireId(args))); break;
      case 'issues': {
        print(svc.listIssues(requireId(args), argValue(args, '--severity'), argValue(args, '--code')));
        break;
      }
      case 'report': {
        const report = svc.latestReport(requireId(args));
        const out = argValue(args, '--out');
        if (out) {
          const fs = await import('node:fs');
          fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2), 'utf8');
          console.log(`报告已导出: ${path.resolve(out)}`);
        } else {
          print(report);
        }
        break;
      }
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(USAGE);
        process.exit(2);
    }
  } finally {
    if (cmd !== 'serve') svc.db.close();
  }
}

function requireId(args: string[]): number {
  const raw = args[1];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new AppError('INVALID_PARAM', `缺少或非法的 bookId: ${raw ?? '(空)'}`);
  }
  return id;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch(fail);
}
