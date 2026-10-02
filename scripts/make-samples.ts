import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

export type Variant = 'valid' | 'missing-resource' | 'bad-spine' | 'bad-relative-path' | 'missing-anchor';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function opf(variant: Variant): string {
  const spineRef = variant === 'bad-spine' ? '<itemref idref="ch-ghost"/>' : '<itemref idref="ch2"/>';
  const extraItem = variant === 'missing-resource' ? '<item id="img1" href="images/cover.png" media-type="image/png"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:sample-0001</dc:identifier>
    <dc:title>样例：山间小记</dc:title>
    <dc:creator>王小山</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    ${extraItem}
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    ${spineRef}
  </spine>
</package>`;
}

function nav(variant: Variant): string {
  const ch1Href = variant === 'bad-relative-path' ? 'chapter1.xhtml' : 'text/chapter1.xhtml';
  const ch2Anchor = variant === 'missing-anchor' ? 'sec-nope' : 'sec-2-1';
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><title>目录</title></head>
<body>
<nav epub:type="toc">
  <h1>目录</h1>
  <ol>
    <li><a href="${ch1Href}">第一章 出发</a>
      <ol>
        <li><a href="text/chapter1.xhtml#sec-1-1">第一节 清晨</a></li>
        <li><a href="text/chapter1.xhtml#sec-1-2">第二节 山路</a></li>
      </ol>
    </li>
    <li><a href="text/chapter2.xhtml">第二章 山顶</a>
      <ol>
        <li><a href="text/chapter2.xhtml#${ch2Anchor}">第一节 云海</a></li>
      </ol>
    </li>
    <li><a href="https://example.com/notes">外部参考（远程，不访问）</a></li>
  </ol>
</nav>
</body>
</html>`;
}

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>第一章 出发</title></head>
<body>
<h1 id="sec-1-1">第一节 清晨</h1><p>清晨出发。</p>
<h1 id="sec-1-2">第二节 山路</h1><p>山路蜿蜒。</p>
</body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><title>第二章 山顶</title></head>
<body>
<h1 id="sec-2-1">第一节 云海</h1><p>云海翻腾。</p>
</body>
</html>`;

export async function buildSample(variant: Variant, outPath: string): Promise<string> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/content.opf', opf(variant));
  zip.file('OEBPS/nav.xhtml', nav(variant));
  zip.file('OEBPS/text/chapter1.xhtml', CH1);
  zip.file('OEBPS/text/chapter2.xhtml', CH2);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

export const VARIANTS: Variant[] = ['valid', 'missing-resource', 'bad-spine', 'bad-relative-path', 'missing-anchor'];

async function main(): Promise<void> {
  const dir = path.resolve(process.cwd(), 'samples');
  for (const v of VARIANTS) {
    const p = await buildSample(v, path.join(dir, `${v}.epub`));
    console.log(`已生成: ${p}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
