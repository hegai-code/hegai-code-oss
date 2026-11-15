// Отчёт для снимка `ReportViewer` без прод-хаба: отдаёт один HTML как
// /api/reports/<id>/content и его название как /api/reports/<id>.
// CC_FIXTURE_PORT (18795), REPORT_FILE (обязателен), REPORT_ID, REPORT_TITLE.
// Сокета /ui нет — приложение покажет «Соединение…», отчёту это не мешает.
const http = require('http');
const fs = require('fs');
const port = Number(process.env.CC_FIXTURE_PORT || 18795);
const id = process.env.REPORT_ID || '7ea11d6ed8544d4c860bdc068148b007';
const title = process.env.REPORT_TITLE || 'Отчёт';
const html = fs.readFileSync(process.env.REPORT_FILE);
http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === `/api/reports/${id}/content`) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (path === `/api/reports/${id}`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, title, updatedAt: Date.now() }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"report not found"}');
}).listen(port, '127.0.0.1', () => console.log(`report fixture on :${port}`));
