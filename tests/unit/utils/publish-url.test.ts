import { describe, expect, it } from 'vitest';
import { isOpenablePublishUrl } from '$lib/utils/publish-url';

describe('[precision][regression] Publish shell URL validation', () => {
  it.each([
    'https://ghost.example/posts/第一章?preview=%E4%B8%AD#正文',
    'https://wordpress.com/post/42',
    'https://wp.example.test/?p=42',
    'https://localhost:8443/wp-admin/post.php?post=42',
    'https://192.168.1.20/post/42',
  ])('accepts an absolute credential-free HTTPS URL: %s', (value) => {
    expect(isOpenablePublishUrl(value, { allowHttp: false })).toBe(true);
  });

  it('allows HTTP only when the caller explicitly opts in', () => {
    const value = 'http://wordpress.local/wp-admin/post.php?post=42';

    expect(isOpenablePublishUrl(value, { allowHttp: false })).toBe(false);
    expect(isOpenablePublishUrl(value, { allowHttp: true })).toBe(true);
  });

  it.each([
    ['credentials', 'https://author:provider-secret@ghost.example/post/42'],
    ['password-only credentials', 'https://:provider-secret@ghost.example/post/42'],
    ['empty userinfo', 'https://@ghost.example/post/42'],
    ['leading whitespace', ' https://ghost.example/post/42'],
    ['trailing whitespace', 'https://ghost.example/post/42 '],
    ['embedded tab', 'https://ghost.example/post/\t42'],
    ['embedded newline', 'https://ghost.example/post/\n42'],
    ['NUL control', 'https://ghost.example/post/\u000042'],
    ['DEL control', 'https://ghost.example/post/\u007f42'],
    ['C1 control U+0080', 'https://ghost.example/post/\u008042'],
    ['C1 control U+009F', 'https://ghost.example/post/\u009f42'],
    ['file scheme', 'file:///tmp/provider-result.html'],
    ['JavaScript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,provider-result'],
    ['custom scheme', 'novelist://publish/post/42'],
    ['scheme-relative URL', '//ghost.example/post/42'],
    ['POSIX path', '/tmp/provider-result.html'],
    ['Windows path', 'C:\\Users\\author\\provider-result.html'],
    ['missing authority delimiter', 'https:ghost.example/post/42'],
    ['empty authority', 'https:///ghost.example/post/42'],
    ['empty hostname', 'https://'],
    ['malformed IPv6 host', 'https://[::1/post/42'],
    ['malformed percent escape', 'https://ghost.example/post/%ZZ'],
    ['backslash normalization', 'https://ghost.example\\@attacker.example/post/42'],
    ['raw quote', 'https://ghost.example/post/"%20--proxy-server=attacker.example'],
    ['raw angle bracket', 'https://ghost.example/post/<script>'],
    ['raw backtick', 'https://ghost.example/post/`command`'],
    ['raw brace', 'https://ghost.example/post/{value}'],
    ['dot-only host', 'https://./post/42'],
    ['parent-dot-only host', 'https://../post/42'],
    ['empty hostname label', 'https://ghost..example/post/42'],
    ['lone UTF-16 surrogate', `https://ghost.example/post/${String.fromCharCode(0xd800)}`],
  ])('rejects %s', (_label, value) => {
    expect(isOpenablePublishUrl(value, { allowHttp: true })).toBe(false);
  });
});
