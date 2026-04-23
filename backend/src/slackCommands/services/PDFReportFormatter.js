const PDFDocument = require('pdfkit');
const { Readable } = require('stream');

class PDFReportFormatter {
  constructor() {
    this.pageWidth = 595; // A4
    this.pageHeight = 842;
    this.margin = 50;
    this.lineHeight = 14;
    this.smallLineHeight = 12;
  }

  formatNumber(value, decimals = 2) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      return String(value);
    }

    if (Number.isInteger(numericValue)) {
      return String(numericValue);
    }

    return numericValue.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }

  formatHours(hours) {
    const totalHours = Number(hours) || 0;
    const wholeHours = Math.floor(totalHours);
    const minutes = Math.round((totalHours - wholeHours) * 60);
    return `${wholeHours}h ${minutes}m`;
  }

  getMaxRows(startY, rowHeight, footerReserve = 70) {
    const usableHeight = this.pageHeight - footerReserve - startY;
    return Math.max(0, Math.floor(usableHeight / rowHeight));
  }

  addPageFooter(doc, pageNumber, totalPages) {
    const footerY = this.pageHeight - 30;
    doc.fontSize(9).font('Helvetica').text(new Date().toISOString().split('T')[0], this.margin, footerY, { align: 'left' });
    doc.fontSize(9).font('Helvetica').text(`Page ${pageNumber} of ${totalPages}`, this.pageWidth - this.margin - 50, footerY, { align: 'right' });
  }

  generateWeeklyReportPDF(report) {
    const doc = new PDFDocument({
      size: 'A4',
      margin: this.margin,
    });

    // Header section
    const period = report.period?.label || 'Okänd period';
    const totalHours = this.formatNumber(report.totalHours ?? 0);
    const projectName = report.projectName || 'Okänt projekt';
    const projectKey = report.projectKey || 'UNKNOWN';

    doc.fontSize(11).font('Helvetica').text(`Period: ${period}`);
    doc.fontSize(11).font('Helvetica-Bold').text(`Total Billable: ${totalHours}`, { align: 'right' });
    doc.moveDown(0.2);

    // Separator line
    doc.moveTo(this.margin, doc.y).lineTo(this.pageWidth - this.margin, doc.y).stroke();
    doc.moveDown(0.3);

    // Table header
    const col1X = this.margin;
    const col2X = this.pageWidth - this.margin - 60;

    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('Project / Issue', col1X, doc.y);
    doc.text('Billable', col2X, doc.y, { align: 'right' });
    doc.moveDown(0.2);

    // Separator line
    doc.moveTo(this.margin, doc.y).lineTo(this.pageWidth - this.margin, doc.y).stroke();
    doc.moveDown(0.3);

    doc.fontSize(10).font('Helvetica');
    let yPosition = doc.y;

    // Project header
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(`${projectName} (${projectKey})`, col1X, yPosition, { width: col2X - col1X - 10 });
    doc.text(totalHours, col2X, yPosition, { align: 'right' });
    yPosition += this.lineHeight;

    // Tasks under project (indented)
    doc.fontSize(9).font('Helvetica');
    if (Array.isArray(report.tasks) && report.tasks.length > 0) {
      const maxTaskRows = this.getMaxRows(yPosition, this.smallLineHeight);
      const visibleTasks = report.tasks.slice(0, maxTaskRows);

      for (const task of visibleTasks) {
        const issueKey = task.issueKey || `ISSUE-${task.issueId || ''}`;
        const title = (task.title || '').substring(0, 70);
        const issueText = `${issueKey} - ${title}`;
        const taskHours = this.formatNumber(task.totalHours ?? 0);

        doc.text(`  ${issueText}`, col1X, yPosition, { width: col2X - col1X - 10, ellipsis: true });
        doc.text(taskHours, col2X, yPosition, { align: 'right' });
        yPosition += this.smallLineHeight;
      }

      const hiddenTaskCount = report.tasks.length - visibleTasks.length;
      if (hiddenTaskCount > 0) {
        doc.fontSize(8).font('Helvetica-Oblique');
        doc.text(`... och ${hiddenTaskCount} fler issues (visas inte för att hålla rapporten till en sida).`, col1X, yPosition, {
          width: col2X - col1X - 10,
        });
      }
    }

    doc.end();
    return doc;
  }

  generateTeamReportPDF(report) {
    const doc = new PDFDocument({
      size: 'A4',
      margin: this.margin,
    });

    // Header section
    const period = report.period?.label || 'Okänd period';
    const totalHours = this.formatNumber(report.totalHours ?? 0);
    const projectName = report.projectName || 'Okänt projekt';
    const projectKey = report.projectKey || 'UNKNOWN';

    doc.fontSize(11).font('Helvetica').text(`Period: ${period}`);
    doc.fontSize(11).font('Helvetica-Bold').text(`Total: ${totalHours}h`, { align: 'right' });
    doc.moveDown(0.2);

    // Separator line
    doc.moveTo(this.margin, doc.y).lineTo(this.pageWidth - this.margin, doc.y).stroke();
    doc.moveDown(0.3);

    // Table header
    const col1X = this.margin;
    const col2Width = 80;
    const col2X = this.pageWidth - this.margin - col2Width;

    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('Person', col1X, doc.y, { width: col2X - col1X - 12 });
    doc.text('Timmar', col2X, doc.y, { width: col2Width, align: 'right' });
    doc.moveDown(0.2);

    // Separator line
    doc.moveTo(this.margin, doc.y).lineTo(this.pageWidth - this.margin, doc.y).stroke();
    doc.moveDown(0.3);

    doc.fontSize(10).font('Helvetica');
    let yPosition = doc.y;

    // Team members
    if (Array.isArray(report.participants) && report.participants.length > 0) {
      const maxParticipantRows = this.getMaxRows(yPosition, this.lineHeight);
      const visibleParticipants = report.participants.slice(0, maxParticipantRows);

      for (const person of visibleParticipants) {
        const name = (person.name || `User ${person.userId || ''}`).substring(0, 40);
        const hours = this.formatNumber(person.totalHours ?? 0);

        doc.text(name, col1X, yPosition, { width: col2X - col1X - 12, ellipsis: true });
        doc.text(`${hours} h`, col2X, yPosition, { width: col2Width, align: 'right' });
        yPosition += this.lineHeight;
      }

      const hiddenParticipantCount = report.participants.length - visibleParticipants.length;
      if (hiddenParticipantCount > 0) {
        doc.fontSize(8).font('Helvetica-Oblique');
        doc.text(`... och ${hiddenParticipantCount} fler deltagare (visas inte för att hålla rapporten till en sida).`, col1X, yPosition, {
          width: col2X - col1X - 10,
        });
      }
    }

    doc.end();
    return doc;
  }
}

module.exports = PDFReportFormatter;

