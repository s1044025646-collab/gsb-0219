import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cli = ['src/cli.ts'];
const tsx = process.execPath;

function run(args: string[]): void {
  console.log(`\n$ ${args.join(' ')}`);
  try {
    const out = execFileSync(tsx, ['node_modules/tsx/dist/cli.mjs', ...cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(out);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    process.stdout.write((err.stdout ?? '') + (err.stderr ?? ''));
  }
}

fs.rmSync(path.resolve('data'), { recursive: true, force: true });

run(['import', 'samples/valid.epub']);
run(['import', 'samples/valid.epub']); // 重复导入
run(['list']);
run(['chapters', '1']);
run(['nav', '1']);
run(['check', '1']);

const broken: [string, number][] = [
  ['samples/missing-resource.epub', 2],
  ['samples/bad-spine.epub', 3],
  ['samples/bad-relative-path.epub', 4],
  ['samples/missing-anchor.epub', 5],
];
for (const [file, id] of broken) {
  run(['import', file]);
  run(['check', String(id)]);
}
run(['issues', '2', '--severity', 'error']);
run(['report', '2', '--out', 'report-demo.json']);
console.log('\n演示完成，报告已导出到 report-demo.json');
