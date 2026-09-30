import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve('dist');
const port = Number(process.env.PORT || 4173);
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

if (!existsSync(resolve(root, 'index.html'))) {
  console.error('Build non trovata. Esegui prima: npm run build');
  process.exit(1);
}

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = resolve(root, requested);

  if (!file.startsWith(root + sep) && file !== resolve(root, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(file) || statSync(file).isDirectory()) file = resolve(root, 'index.html');
  const stat = statSync(file);
  const headers = {
    'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  };

  if (extname(file).toLowerCase() === '.mp4' && request.headers.range) {
    const [startText, endText] = request.headers.range.replace('bytes=', '').split('-');
    const start = Number(startText);
    const end = endText ? Number(endText) : stat.size - 1;
    response.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`W Motion è pronto: ${url}`);
  console.log('Per chiudere il sito, chiudi questa finestra.');
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});
