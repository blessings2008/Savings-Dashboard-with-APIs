import PDFDocument from 'pdfkit';

const fmtMoney = value => `MWK ${Number(value || 0).toLocaleString()}`;
const fmtDate = value => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-MW', { dateStyle: 'medium', timeStyle: 'short' });
};

function addHeader(doc, title, subtitle) {
  doc.rect(0, 0, 612, 92).fill('#111827');
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('PocketVault 🇲🇼', 42, 28);
  doc.fontSize(11).font('Helvetica').fillColor('#cbd5e1').text(subtitle, 42, 57);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text(title, 42, 120);
  doc.moveTo(42, 148).lineTo(570, 148).strokeColor('#e5e7eb').stroke();
  doc.y = 165;
}

function addFooter(doc) {
  const page = doc.page;
  doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
    .text(`PocketVault • Generated ${fmtDate(new Date())}`, 42, page.height - 36, { align: 'left' });
}

function addTable(doc, headers, rows, widths) {
  const x = 42;
  const rowHeight = 24;
  let y = doc.y;
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  const drawHeader = () => {
    doc.rect(x, y, totalWidth, rowHeight).fill('#f1f5f9');
    let cx = x;
    headers.forEach((header, i) => {
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(8).text(String(header), cx + 6, y + 8, { width: widths[i] - 12, ellipsis: true });
      cx += widths[i];
    });
    y += rowHeight;
  };

  drawHeader();
  rows.forEach((row, rowIndex) => {
    if (y > doc.page.height - 62) {
      doc.addPage();
      addFooter(doc);
      y = 48;
      drawHeader();
    }
    if (rowIndex % 2 === 1) doc.rect(x, y, totalWidth, rowHeight).fill('#fafafa');
    let cx = x;
    row.forEach((cell, i) => {
      doc.fillColor('#334155').font('Helvetica').fontSize(8).text(String(cell ?? '—'), cx + 6, y + 8, { width: widths[i] - 12, ellipsis: true });
      cx += widths[i];
    });
    y += rowHeight;
  });
  doc.y = y + 16;
}

export function buildTransactionHistoryPdf({ user, transactions = [], from, to }) {
  return buildPdf(doc => {
    addHeader(doc, 'Transaction History', `${user?.name || 'PocketVault user'} • ${user?.email || ''}`);
    doc.font('Helvetica').fontSize(10).fillColor('#64748b')
      .text(`${fmtDate(from)} → ${fmtDate(to)}`, 42, doc.y, { width: 528 });
    doc.moveDown(1.2);

    const completed = transactions.filter(t => String(t.status || '').toLowerCase() === 'completed');
    const total = completed.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(`Transactions: ${transactions.length}    •    Completed volume: ${fmtMoney(total)}`);
    doc.moveDown(1);

    addTable(doc,
      ['Date', 'Type', 'Amount', 'Status', 'Reference'],
      transactions.map(t => [fmtDate(t.timestamp), t.type || 'transaction', fmtMoney(t.amount), t.status || '—', t.reference || t.airtelRef || '—']),
      [112, 112, 92, 86, 126]
    );

    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text('This report is generated from the transaction records associated with your PocketVault account.');
  });
}

export function buildMonthlyAdminPdf({ monthLabel, metrics, transactions = [] }) {
  return buildPdf(doc => {
    addHeader(doc, `Monthly Platform Report — ${monthLabel}`, 'Confidential • PocketVault administration');

    const cards = [
      ['Users', metrics.users],
      ['New users', metrics.newUsers],
      ['Transactions', metrics.transactions],
      ['Transaction volume', fmtMoney(metrics.volume)],
      ['Savings volume', fmtMoney(metrics.savings)],
      ['Withdrawals', fmtMoney(metrics.withdrawals)],
      ['Revenue', fmtMoney(metrics.revenue)],
      ['Failed transactions', metrics.failed]
    ];

    let x = 42;
    let y = doc.y;
    cards.forEach(([label, value], i) => {
      if (i && i % 2 === 0) { x = 42; y += 68; }
      doc.roundedRect(x, y, 252, 54, 8).fill('#f8fafc').strokeColor('#e2e8f0').stroke();
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(label, x + 12, y + 10);
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(15).text(String(value), x + 12, y + 27);
      x += 276;
    });
    doc.y = y + 78;

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text('Plan distribution');
    doc.moveDown(.6);
    addTable(doc, ['Plan', 'Users', 'Share'], [
      ['Free', metrics.plans.free || 0, `${metrics.plans.freePct || 0}%`],
      ['Pro', metrics.plans.pro || 0, `${metrics.plans.proPct || 0}%`],
      ['Business', metrics.plans.business || 0, `${metrics.plans.businessPct || 0}%`]
    ], [180, 160, 188]);

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text('Transaction activity');
    doc.moveDown(.6);
    addTable(doc, ['Date', 'Type', 'Amount', 'Status', 'User'],
      transactions.slice(0, 100).map(t => [fmtDate(t.timestamp), t.type || 'transaction', fmtMoney(t.amount), t.status || '—', t.uid || '—']),
      [100, 105, 92, 86, 145]
    );
  });
}

function buildPdf(draw) {
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: 'PocketVault Report', Author: 'PocketVault' } });
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      addFooter(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
