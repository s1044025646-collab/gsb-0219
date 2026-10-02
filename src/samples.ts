import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

const MIMETYPE = 'application/epub+zip';
const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(opts: { spineExtra?: string; manifestExtra?: string; omitCss?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:sample-0001</dc:identifier>
    <dc:title>样例：山间小站</dc:title>
    <dc:creator>王小川</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="css/style.css" media-type="text/css"/>
    ${opts.manifestExtra ?? ''}
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    ${opts.spineExtra ?? ''}
  </spine>
</package>`;
}

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
<nav epub:type="toc">
  <h1>目录</h1>
  <ol>
    <li><a href="text/ch1.xhtml">第一章 出发</a>
      <ol>
        <li><a href="text/ch1.xhtml#s1">第一节 清晨</a></li>
        <li><a href="text/ch1.xhtml#s2">第二节 站台</a></li>
      </ol>
    </li>
    <li><a href="text/ch2.xhtml">第二章 山间</a></li>
    <li><a href="text/ch3.xhtml">第三章 抵达</a>
      <ol>
        <li><a href="text/ch3.xhtml#s1">第一节 灯火</a></li>
      </ol>
    </li>
  </ol>
</nav>
</body>
</html>`;

function chapter(title: string, sections: Array<[string, string]>): string {
  const body = sections.map(([id, text]) => `<section id="${id}"><h2>${text}</h2><p>正文内容。</p></section>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><meta charset="utf-8"/><title>${title}</title><link rel="stylesheet" href="../css/style.css"/></head>
<body><h1>${title}</h1>
${body}
</body></html>`;
}

const CSS = 'body { font-family: serif; }';

function baseFiles(): Record<string, string> {
  return {
    'mimetype': MIMETYPE,
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf(),
    'OEBPS/nav.xhtml': NAV,
    'OEBPS/text/ch1.xhtml': chapter('第一章 出发', [['s1', '第一节 清晨'], ['s2', '第二节 站台']]),
    'OEBPS/text/ch2.xhtml': chapter('第二章 山间', [['s1', '第一节 云雾']]),
    'OEBPS/text/ch3.xhtml': chapter('第三章 抵达', [['s1', '第一节 灯火']]),
    'OEBPS/css/style.css': CSS,
  };
}

function writeEpub(filePath: string, files: Record<string, string>): void {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf8'));
  zip.writeZip(filePath);
}

export function makeSamples(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const write = (name: string, mutate: (f: Record<string, string>) => void) => {
    const files = baseFiles();
    mutate(files);
    const p = path.join(dir, name);
    writeEpub(p, files);
    out.push(p);
  };

  write('valid-sample.epub', () => {});
  write('broken-missing-resource.epub', (f) => { delete f['OEBPS/css/style.css']; });
  write('broken-spine-ref.epub', (f) => {
    f['OEBPS/content.opf'] = opf({ spineExtra: '<itemref idref="ch99"/>' });
  });
  write('broken-wrong-path.epub', (f) => {
    f['OEBPS/nav.xhtml'] = NAV.replace('text/ch2.xhtml', 'text/chapter2.xhtml');
  });
  write('broken-missing-anchor.epub', (f) => {
    f['OEBPS/nav.xhtml'] = NAV.replace('ch3.xhtml#s1', 'ch3.xhtml#s99');
  });
  return out;
}
