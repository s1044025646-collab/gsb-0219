import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseEpub, resolvePackagePath } from '../src/epub';

test('resolvePackagePath 相对解析与越界拒绝', () => {
  assert.equal(resolvePackagePath('OEBPS', 'text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolvePackagePath('OEBPS/text', '../nav.xhtml'), 'OEBPS/nav.xhtml');
  assert.equal(resolvePackagePath('OEBPS', '../evil.xhtml'), 'evil.xhtml');
  assert.equal(resolvePackagePath('OEBPS', '../../evil.xhtml'), null);
  assert.equal(resolvePackagePath('', 'a/../../b'), null);
});

test('manifest 路径越界被标记为 PATH_TRAVERSAL 且不读取', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="u">x</dc:identifier><dc:title>t</dc:title><dc:language>zh</dc:language>
  </metadata>
  <manifest><item id="evil" href="../../outside.txt" media-type="text/plain"/></manifest>
  <spine/>
</package>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const s = await parseEpub(buf);
  const issue = s.issues.find((i) => i.code === 'PATH_TRAVERSAL');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
});

test('manifest 重复 ID 被标记为 DUPLICATE_ITEM_ID', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="u">x</dc:identifier><dc:title>t</dc:title><dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
    <item id="a" href="b.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="a"/></spine>
</package>`);
  zip.file('a.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
  zip.file('b.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const s = await parseEpub(buf);
  assert.ok(s.issues.some((i) => i.code === 'DUPLICATE_ITEM_ID' && i.ref === 'a'));
});

