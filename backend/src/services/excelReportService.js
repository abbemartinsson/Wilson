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
  const periodLabel = formatText(reportList[0]?.period?.label, 'All projects');

  summarySheet.addRows([
    { metric: 'Period', value: periodLabel },
    { metric: 'Projects', value: reportList.length },
    { metric: 'Total hours', value: totalHours },
    { metric: 'Total cost', value: totalCost },
    { metric: 'Total participants', value: totalParticipants },
    { metric: 'Missing cost users', value: totalMissingCost },
  ]);

  applyNumberFormat(summarySheet.getCell('B4'));
  applyCurrencyFormat(summarySheet.getCell('B5'));
  applyNumberFormat(summarySheet.getCell('B6'));
  applyNumberFormat(summarySheet.getCell('B7'));
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
      period: formatText(report?.period?.label, periodLabel),
    });

    applyCurrencyFormat(row.getCell('totalCost'));
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

module.exports = {
  buildProjectCostTotalWorkbook,
};
