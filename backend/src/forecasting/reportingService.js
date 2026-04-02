const analyticsRepository = require('../repositories/analyticsRepository');
const analyticsService = require('./analyticsService');
const forecastService = require('./forecastSerive');

async function getProjectInfo(projectKey) {
	const report = await analyticsRepository.getProjectInfo(projectKey);

	if (!report) {
		return null;
	}

	const hours = report.totalSeconds / 3600;

	return {
		projectId: report.projectId,
		projectKey: report.projectKey,
		projectName: report.projectName,
		startDate: report.startDate,
		lastLoggedIssue: report.lastLoggedIssue,
		totalSeconds: report.totalSeconds,
		totalHours: roundToTwoDecimals(hours),
		contributorsCount: report.contributorsCount,
	};
}

function roundToTwoDecimals(value) {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function searchProjects(query) {
  const projects = await analyticsRepository.searchProjects(query);

  return projects.map(p => ({
    projectId: p.id,
    projectKey: p.jira_project_key,
    projectName: p.name,
  }));
}

async function getProjectLastWeekHours(projectKey) {
	const normalizedProjectKey = String(projectKey || '').trim().toUpperCase();

	if (!normalizedProjectKey) {
		throw new Error('projectKey is required');
	}

	const project = await analyticsRepository.getProjectInfo(normalizedProjectKey);
	if (!project) {
		return null;
	}

	const weekRange = getPreviousWeekRangeInStockholm();
	const worklogs = await analyticsRepository.getAllWorklogsForForecast({
		projectKey: normalizedProjectKey,
		startDate: weekRange.startDateUtc,
		endDate: weekRange.endDateUtc,
	});

	const totalSeconds = worklogs.reduce((sum, worklog) => sum + (worklog.time_spent_seconds || 0), 0);
	const duration = secondsToHoursAndMinutes(totalSeconds);

	return {
		projectId: project.projectId,
		projectKey: project.projectKey,
		projectName: project.projectName,
		period: {
			timeZone: 'Europe/Stockholm',
			startDate: weekRange.startDate,
			endDate: weekRange.endDate,
			label: `${weekRange.startDate} till ${weekRange.endDate}`,
		},
		totalSeconds,
		totalHours: roundToTwoDecimals(totalSeconds / 3600),
		hours: duration.hours,
		minutes: duration.minutes,
		formattedDuration: `${duration.hours} timmar ${duration.minutes} minuter`,
	};
}

function getPreviousWeekRangeInStockholm(referenceDate = new Date()) {
	const stockholmToday = getDatePartsInTimeZone(referenceDate, 'Europe/Stockholm');
	const stockholmTodayDate = new Date(Date.UTC(stockholmToday.year, stockholmToday.month - 1, stockholmToday.day));

	const dayOfWeek = stockholmTodayDate.getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;

	const mondayThisWeek = addUtcDays(stockholmTodayDate, -daysSinceMonday);
	const mondayLastWeek = addUtcDays(mondayThisWeek, -7);
	const sundayLastWeek = addUtcDays(mondayLastWeek, 6);

	const mondayParts = {
		year: mondayLastWeek.getUTCFullYear(),
		month: mondayLastWeek.getUTCMonth() + 1,
		day: mondayLastWeek.getUTCDate(),
	};
	const sundayParts = {
		year: sundayLastWeek.getUTCFullYear(),
		month: sundayLastWeek.getUTCMonth() + 1,
		day: sundayLastWeek.getUTCDate(),
	};

	return {
		startDate: formatDateParts(mondayParts),
		endDate: formatDateParts(sundayParts),
		startDateUtc: zonedTimeToUtc(mondayParts, 0, 0, 0, 'Europe/Stockholm'),
		endDateUtc: zonedTimeToUtc(sundayParts, 23, 59, 59, 'Europe/Stockholm'),
	};
}

function secondsToHoursAndMinutes(totalSeconds) {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
	return {
		hours: Math.floor(safeSeconds / 3600),
		minutes: Math.floor((safeSeconds % 3600) / 60),
	};
}

function addUtcDays(date, days) {
	const result = new Date(date.getTime());
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

function formatDateParts(parts) {
	const month = String(parts.month).padStart(2, '0');
	const day = String(parts.day).padStart(2, '0');
	return `${parts.year}-${month}-${day}`;
}

function getDatePartsInTimeZone(date, timeZone) {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});

	const parts = formatter.formatToParts(date);
	const mapped = {};
	for (const part of parts) {
		if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
			mapped[part.type] = Number.parseInt(part.value, 10);
		}
	}

	return {
		year: mapped.year,
		month: mapped.month,
		day: mapped.day,
	};
}

function getTimeZoneOffset(date, timeZone) {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	const parts = formatter.formatToParts(date);
	const values = {};
	for (const part of parts) {
		if (part.type !== 'literal') {
			values[part.type] = part.value;
		}
	}

	const asUtc = Date.UTC(
		Number.parseInt(values.year, 10),
		Number.parseInt(values.month, 10) - 1,
		Number.parseInt(values.day, 10),
		Number.parseInt(values.hour, 10),
		Number.parseInt(values.minute, 10),
		Number.parseInt(values.second, 10),
	);

	return asUtc - date.getTime();
}

function zonedTimeToUtc(dateParts, hour, minute, second, timeZone) {
	const utcGuess = new Date(
		Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, second)
	);
	const offset = getTimeZoneOffset(utcGuess, timeZone);
	return new Date(utcGuess.getTime() - offset);
}

/**
 * Get workload forecast with historical comparison.
 * 
 * @param {number} forecastMonths - Number of months to forecast (default 3)
 * @returns {Promise<Object>} Forecast report
 */
async function getWorkloadForecast(forecastMonths = 3) {
	try {
		const forecast = await forecastService.getComprehensiveWorkloadForecast({
			forecastMonths
		});
		
		return {
			forecast: forecast.forecast,
			historical: forecast.historical,
			current_state: forecast.current_state,
			data_info: forecast.data_info,
			generated_at: forecast.generated_at
		};
	} catch (error) {
		console.error('Error in getWorkloadForecast:', error);
		throw error;
	}
}

/**
 * Get historical comparison for current month vs previous years.
 * Shows workload and team size for same period in history.
 * 
 * @param {Object} options - Comparison options
 * @param {number} options.month - Month to compare (default current)
 * @param {number} options.year - Year to compare (default current)
 * @param {number} options.yearsBack - Years to look back (default 3)
 * @returns {Promise<Object>} Historical comparison report
 */
async function getHistoricalWorkloadComparison(options = {}) {
	try {
		const comparison = await analyticsService.getHistoricalComparison(options);
		
		return {
			current_period: {
				year: comparison.current_period.year,
				month: comparison.current_period.month,
				total_hours: comparison.current_period.total_hours,
				active_users: comparison.current_period.active_users,
				worklog_count: comparison.current_period.worklog_count
			},
			previous_years: comparison.historical_periods.map(p => ({
				year: p.year,
				total_hours: p.total_hours,
				active_users: p.active_users,
				worklog_count: p.worklog_count,
				compared_to_current: {
					hours_difference: roundToTwoDecimals(
						comparison.current_period.total_hours - p.total_hours
					),
					hours_change_percent: roundToTwoDecimals(
						((comparison.current_period.total_hours - p.total_hours) / p.total_hours) * 100
					),
					users_difference: comparison.current_period.active_users - p.active_users
				}
			})),
			summary: {
				trend: comparison.comparison.trend,
				average_hours_across_years: comparison.comparison.average_hours_across_years,
				max_hours: comparison.comparison.max_hours,
				min_hours: comparison.comparison.min_hours,
				years_analyzed: comparison.comparison.total_years_analyzed
			}
		};
	} catch (error) {
		console.error('Error in getHistoricalWorkloadComparison:', error);
		throw error;
	}
}

/**
 * Get workload analytics for a specific time period.
 * 
 * @param {Object} options - Analytics options
 * @param {Date} options.startDate - Start date
 * @param {Date} options.endDate - End date
 * @returns {Promise<Object>} Workload analytics report
 */
async function getWorkloadAnalytics(options = {}) {
	try {
		const analytics = await analyticsService.getWorkloadAnalytics(options);
		
		return {
			summary: {
				total_hours: analytics.total_hours,
				total_worklogs: analytics.total_worklogs,
				unique_users: analytics.unique_users,
				average_weekly_hours: analytics.averages.weekly_hours,
				average_hours_per_user: analytics.averages.hours_per_user
			},
			date_range: analytics.date_range,
			weekly_breakdown: analytics.weekly_data,
			monthly_breakdown: analytics.monthly_data
		};
	} catch (error) {
		console.error('Error in getWorkloadAnalytics:', error);
		throw error;
	}
}

/**
 * Get simple forecast summary for quick reporting.
 * 
 * @param {number} forecastMonths - Number of months to forecast
 * @returns {Promise<Object>} Simplified forecast summary
 */
async function getWorkloadForecastSummary(forecastMonths = 3) {
	try {
		return await forecastService.getWorkloadForecastSummary(forecastMonths);
	} catch (error) {
		console.error('Error in getWorkloadForecastSummary:', error);
		throw error;
	}
}

module.exports = {
	getProjectInfo,
	searchProjects,
	getProjectLastWeekHours,
	getWorkloadForecast,
	getHistoricalWorkloadComparison,
	getWorkloadAnalytics,
	getWorkloadForecastSummary
};
