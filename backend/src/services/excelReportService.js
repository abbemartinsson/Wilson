const ExcelJS = require('exceljs');

function formatNumber(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value);
  }

  return numericValue;
}

function formatText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = String(value).trim();
  return text || fallback;
}

function applyHeaderStyle(row) {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle' };
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEDEDED' },
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
  });
}

function applyCurrencyFormat(cell) {
  cell.numFmt = '#,##0.00';
}

function applyNumberFormat(cell) {
  cell.numFmt = '#,##0.00';
}

async function buildProjectCostTotalWorkbook(reports) {
  const reportList = Array.isArray(reports) ? reports : [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Wilson backend';
  workbook.created = new Date();
  workbook.modified = new Date();

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 22 },
  ];
  summarySheet.getRow(1).height = 20;
  applyHeaderStyle(summarySheet.getRow(1));

  const totalHours = reportList.reduce((sum, report) => sum + Number(report?.totalHours || 0), 0);
  const totalCost = reportList.reduce((sum, report) => sum + Number(report?.totalCost || 0), 0);
  const totalParticipants = reportList.reduce((sum, report) => sum + Number(report?.participantCount || 0), 0);
  const totalMissingCost = reportList.reduce((sum, report) => sum + Number(report?.missingCostCount || 0), 0);
  const totalInvoice = reportList.reduce((sum, report) => sum + Number(report?.invoiceTotal || 0), 0);
  const totalGrossMargin = reportList.reduce((sum, report) => sum + Number(report?.grossMarginAmount || 0), 0);
  const periodLabel = formatText(reportList[0]?.period?.label, 'All projects');

  const summaryRows = [
    { metric: 'Period', value: periodLabel },
    { metric: 'Projects', value: reportList.length },
    { metric: 'Total hours', value: totalHours },
    { metric: 'Total cost', value: totalCost },
    { metric: 'Total participants', value: totalParticipants },
    { metric: 'Missing cost users', value: totalMissingCost },
  ];

  // Add gross margin totals if any invoices matched
  if (totalInvoice > 0) {
    summaryRows.push({ metric: 'Total invoice (SEK)', value: totalInvoice });
    summaryRows.push({ metric: 'Total gross margin (SEK)', value: totalGrossMargin });
  }

  // Check if any conversions were done
  const hasConversions = reportList.some(r => r.invoiceCurrencyConversionApplied === true);
  if (hasConversions) {
    summaryRows.push({ metric: 'Note', value: 'Invoice amounts converted to SEK using exchange rates' });
  }

  summarySheet.addRows(summaryRows);

  applyNumberFormat(summarySheet.getCell('B4'));
  applyCurrencyFormat(summarySheet.getCell('B5'));
  applyNumberFormat(summarySheet.getCell('B6'));
  applyNumberFormat(summarySheet.getCell('B7'));

  // Apply currency format to invoice and margin totals if present
  let cellRowIndex = 8;
  if (totalInvoice > 0) {
    applyCurrencyFormat(summarySheet.getCell(`B${cellRowIndex}`));
    cellRowIndex++;
    applyCurrencyFormat(summarySheet.getCell(`B${cellRowIndex}`));
  }
  summarySheet.getColumn(1).alignment = { vertical: 'middle' };
  summarySheet.getColumn(2).alignment = { vertical: 'middle' };

  const projectsSheet = workbook.addWorksheet('Projects');
  projectsSheet.columns = [
    { header: 'Project name', key: 'projectName', width: 28 },
    { header: 'Project key', key: 'projectKey', width: 16 },
    { header: 'Total hours', key: 'totalHours', width: 14 },
    { header: 'Total cost', key: 'totalCost', width: 14 },
    { header: 'Participants', key: 'participantCount', width: 14 },
    { header: 'Missing cost users', key: 'missingCostCount', width: 18 },
    { header: 'Invoice total', key: 'invoiceTotal', width: 14 },
    { header: 'Gross margin', key: 'grossMarginAmount', width: 14 },
    { header: 'Margin %', key: 'grossMarginPercent', width: 12 },
    { header: 'Period', key: 'period', width: 18 },
  ];
  projectsSheet.getRow(1).height = 20;
  applyHeaderStyle(projectsSheet.getRow(1));
  projectsSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const report of reportList) {
    const row = projectsSheet.addRow({
      projectName: formatText(report?.projectName, 'Unknown project'),
      projectKey: formatText(report?.projectKey, 'Unknown'),
      totalHours: formatNumber(report?.totalHours),
      totalCost: formatNumber(report?.totalCost),
      participantCount: formatNumber(report?.participantCount),
      missingCostCount: formatNumber(report?.missingCostCount),
      invoiceTotal: formatNumber(report?.invoiceTotal),
      grossMarginAmount: formatNumber(report?.grossMarginAmount),
      grossMarginPercent: formatNumber(report?.grossMarginPercent),
      period: formatText(report?.period?.label, periodLabel),
    });

    applyCurrencyFormat(row.getCell('totalCost'));
    applyCurrencyFormat(row.getCell('invoiceTotal'));
    applyCurrencyFormat(row.getCell('grossMarginAmount'));
  }

  const reportHasYearBreakdown = reportList.some((report) => Array.isArray(report?.previous_years) && report.previous_years.length > 0);
  if (reportHasYearBreakdown) {
    const breakdownSheet = workbook.addWorksheet('Yearly breakdown');
    breakdownSheet.columns = [
      { header: 'Project key', key: 'projectKey', width: 16 },
      { header: 'Project name', key: 'projectName', width: 28 },
      { header: 'Year', key: 'year', width: 16 },
      { header: 'Total hours', key: 'totalHours', width: 14 },
      { header: 'Total cost', key: 'totalCost', width: 14 },
      { header: 'Active users', key: 'activeUsers', width: 14 },
    ];
    breakdownSheet.getRow(1).height = 20;
    applyHeaderStyle(breakdownSheet.getRow(1));
    breakdownSheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const report of reportList) {
      if (!Array.isArray(report?.previous_years)) {
        continue;
      }

      for (const yearReport of report.previous_years) {
        const row = breakdownSheet.addRow({
          projectKey: formatText(report?.projectKey, 'Unknown'),
          projectName: formatText(report?.projectName, 'Unknown project'),
          year: formatText(yearReport?.year, 'Unknown'),
          totalHours: formatNumber(yearReport?.total_hours),
          totalCost: formatNumber(yearReport?.total_cost),
          activeUsers: formatNumber(yearReport?.active_users),
        });

        applyCurrencyFormat(row.getCell('totalCost'));
      }
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildProjectCostWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Wilson backend';
  workbook.created = new Date();
  workbook.modified = new Date();

  const projectName = formatText(report?.projectName, 'Unknown project');
  const projectKey = formatText(report?.projectKey, 'Unknown');
  const periodLabel = formatText(report?.period?.label, 'All time');

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 28 },
  ];
  summarySheet.getRow(1).height = 20;
  applyHeaderStyle(summarySheet.getRow(1));

  const summaryRows = [
    { metric: 'Project', value: projectName },
    { metric: 'Project key', value: projectKey },
    { metric: 'Period', value: periodLabel },
    { metric: 'Total hours', value: formatNumber(report?.totalHours) },
    { metric: 'Total cost', value: formatNumber(report?.totalCost) },
    { metric: 'Participants', value: formatNumber(report?.participantCount) },
    { metric: 'Missing cost users', value: formatNumber(report?.missingCostCount) },
  ];

  // Add gross margin rows if invoice data is available
  if (report?.invoiceTotal !== undefined) {
    summaryRows.push({ metric: 'Invoice total (SEK)', value: formatNumber(report.invoiceTotal) });
  }
  if (report?.grossMarginAmount !== undefined) {
    summaryRows.push({ metric: 'Gross margin (SEK)', value: formatNumber(report.grossMarginAmount) });
  }
  if (report?.grossMarginPercent !== undefined) {
    summaryRows.push({ metric: 'Gross margin %', value: formatNumber(report.grossMarginPercent) });
  }
  if (report?.invoiceMatchedCount !== undefined) {
    summaryRows.push({ metric: 'Invoices matched', value: formatNumber(report.invoiceMatchedCount) });
  }
  
  // Add currency conversion note if applicable
  if (report?.invoiceCurrencyConversionApplied === true && Array.isArray(report?.invoiceCurrencyConversions) && report.invoiceCurrencyConversions.length > 0) {
    summaryRows.push({ metric: 'Currency conversions', value: `${report.invoiceCurrencyConversions.length} invoices converted to SEK` });
  }

  summarySheet.addRows(summaryRows);

  applyNumberFormat(summarySheet.getCell('B5'));
  applyCurrencyFormat(summarySheet.getCell('B6'));
  applyNumberFormat(summarySheet.getCell('B7'));
  applyNumberFormat(summarySheet.getCell('B8'));

  // Apply currency format to invoice total, gross margin amount
  let cellIndex = 9;
  if (report?.invoiceTotal !== undefined) {
    applyCurrencyFormat(summarySheet.getCell(`B${cellIndex}`));
    cellIndex++;
  }
  if (report?.grossMarginAmount !== undefined) {
    applyCurrencyFormat(summarySheet.getCell(`B${cellIndex}`));
    cellIndex++;
  }
  if (report?.grossMarginPercent !== undefined) {
    applyNumberFormat(summarySheet.getCell(`B${cellIndex}`));
    cellIndex++;
  }

  summarySheet.getColumn(1).alignment = { vertical: 'middle' };
  summarySheet.getColumn(2).alignment = { vertical: 'middle' };

  const participantsSheet = workbook.addWorksheet('Participants');
  participantsSheet.columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Hours', key: 'hours', width: 14 },
    { header: 'Cost per hour', key: 'costPerHour', width: 14 },
    { header: 'Total cost', key: 'totalCost', width: 14 },
  ];
  participantsSheet.getRow(1).height = 20;
  applyHeaderStyle(participantsSheet.getRow(1));
  participantsSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const participants = Array.isArray(report?.participants) ? report.participants : [];
  for (const participant of participants) {
    const row = participantsSheet.addRow({
      name: formatText(participant?.name, 'Unknown'),
      email: formatText(participant?.email, ''),
      hours: formatNumber(participant?.totalHours),
      costPerHour: formatNumber(participant?.costPerHour),
      totalCost: formatNumber(participant?.totalCost),
    });

    applyCurrencyFormat(row.getCell('costPerHour'));
    applyCurrencyFormat(row.getCell('totalCost'));
  }

  const missingCostUsers = Array.isArray(report?.missingCostUsers) ? report.missingCostUsers : [];
  if (missingCostUsers.length > 0) {
    const missingSheet = workbook.addWorksheet('Missing cost users');
    missingSheet.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Hours', key: 'hours', width: 14 },
    ];
    missingSheet.getRow(1).height = 20;
    applyHeaderStyle(missingSheet.getRow(1));
    missingSheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const user of missingCostUsers) {
      missingSheet.addRow({
        name: formatText(user?.name, 'Unknown'),
        email: formatText(user?.email, ''),
        hours: formatNumber(user?.totalHours),
      });
    }
  }

  if (Array.isArray(report?.previous_years) && report.previous_years.length > 0) {
    const breakdownSheet = workbook.addWorksheet('Yearly breakdown');
    breakdownSheet.columns = [
      { header: 'Year', key: 'year', width: 16 },
      { header: 'Total hours', key: 'totalHours', width: 14 },
      { header: 'Total cost', key: 'totalCost', width: 14 },
      { header: 'Active users', key: 'activeUsers', width: 14 },
    ];
    breakdownSheet.getRow(1).height = 20;
    applyHeaderStyle(breakdownSheet.getRow(1));
    breakdownSheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const yearReport of report.previous_years) {
      const row = breakdownSheet.addRow({
        year: formatText(yearReport?.year, 'Unknown'),
        totalHours: formatNumber(yearReport?.total_hours),
        totalCost: formatNumber(yearReport?.total_cost),
        activeUsers: formatNumber(yearReport?.active_users),
      });
      applyCurrencyFormat(row.getCell('totalCost'));
    }
  }

  // Add currency conversion details sheet if applicable
  if (report?.invoiceCurrencyConversionApplied === true && Array.isArray(report?.invoiceCurrencyConversions) && report.invoiceCurrencyConversions.length > 0) {
    const currencySheet = workbook.addWorksheet('Currency conversions');
    currencySheet.columns = [
      { header: 'Invoice #', key: 'documentNumber', width: 18 },
      { header: 'Original currency', key: 'originalCurrency', width: 18 },
      { header: 'Original amount', key: 'originalAmount', width: 16 },
      { header: 'Exchange rate', key: 'exchangeRate', width: 16 },
      { header: 'Amount in SEK', key: 'convertedAmount', width: 16 },
    ];
    currencySheet.getRow(1).height = 20;
    applyHeaderStyle(currencySheet.getRow(1));
    currencySheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const conversion of report.invoiceCurrencyConversions) {
      const row = currencySheet.addRow({
        documentNumber: formatText(conversion?.documentNumber, ''),
        originalCurrency: formatText(conversion?.originalCurrency, ''),
        originalAmount: formatNumber(conversion?.originalAmount),
        exchangeRate: formatNumber(conversion?.exchangeRate),
        convertedAmount: formatNumber(conversion?.convertedAmount),
      });
      applyCurrencyFormat(row.getCell('originalAmount'));
      applyCurrencyFormat(row.getCell('convertedAmount'));
      applyNumberFormat(row.getCell('exchangeRate'));
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  buildProjectCostWorkbook,
  buildProjectCostTotalWorkbook,
};
