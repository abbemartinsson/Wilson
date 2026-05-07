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

async function getProjectCost(projectKey, options = {}) {
	const yearRange = getYearRangeInStockholm(options.year);
	const report = await analyticsRepository.getProjectCostReport(projectKey, yearRange ? {
		startDate: yearRange.startDateUtc,
		endDate: yearRange.endDateUtc,
	} : {});

	if (!report) {
		return null;
	}

	const result = {
		projectId: report.projectId,
		projectKey: report.projectKey,
		projectName: report.projectName,
		totalSeconds: report.totalSeconds,
		totalHours: roundToTwoDecimals(report.totalSeconds / 3600),
		totalCost: roundToTwoDecimals(report.totalCost),
		participantCount: report.totalParticipants,
		participants: report.participants.map((participant) => ({
			userId: participant.userId,
			name: participant.name,
			email: participant.email,
			totalSeconds: participant.totalSeconds,
			totalHours: roundToTwoDecimals(participant.totalHours),
			costPerHour: participant.costPerHour,
			totalCost: participant.totalCost,
		})),
		missingCostUsers: report.missingCostUsers.map((user) => ({
			userId: user.userId,
			name: user.name,
			email: user.email,
			totalSeconds: user.totalSeconds,
			totalHours: roundToTwoDecimals(user.totalHours),
		})),
		missingCostCount: report.missingCostCount,
		period: yearRange ? {
			timeZone: 'Europe/Stockholm',
			startDate: yearRange.startDate,
			endDate: yearRange.endDate,
			label: String(yearRange.year),
		} : undefined,
	};

	// If no year filter, include the previous_years from the report which already has costs
	if (!yearRange && report.previous_years) {
		result.previous_years = report.previous_years;
	}

	return result;
}

// If no year filter was provided, enrich with yearly breakdown
async function getProjectCostWithYears(projectKey, options = {}) {
	const base = await getProjectCost(projectKey, options);
	if (!base) return null;
	const yearRange = getYearRangeInStockholm(options.year);
	if (!yearRange) {
		await attachYearlyBreakdownToProjectCost(base, projectKey);
	}
	return base;
}

// Add yearly breakdown computed from same worklogs so sums match
async function attachYearlyBreakdownToProjectCost(reportObj, projectKey) {
	if (!reportObj || typeof reportObj !== 'object') return reportObj;

	try {
		const worklogs = await analyticsRepository.getAllWorklogsForForecast({ projectKey });
		const yearsMap = new Map();
		const userSets = new Map();
		const yearlyUserHoursMap = new Map(); // Track hours per user per year

		for (const wl of worklogs) {
			if (!wl || !wl.started_at) continue;
			if (!wl.user_id) continue; // match getProjectCostReport: ignore worklogs without user_id
			const started = new Date(wl.started_at);
			const parts = getDatePartsInTimeZone(started, 'Europe/Stockholm');
			const year = parts.year;
			const prev = yearsMap.get(year) || 0;
			yearsMap.set(year, prev + (wl.time_spent_seconds || 0));

			const set = userSets.get(year) || new Set();
			if (wl.user_id !== undefined && wl.user_id !== null) {
				set.add(wl.user_id);
			}
			userSets.set(year, set);

			// Track hours per user per year
			const yearKey = `${year}`;
			const userYearKey = `${wl.user_id}`;
			if (!yearlyUserHoursMap.has(yearKey)) {
				yearlyUserHoursMap.set(yearKey, new Map());
			}
			const userHoursInYear = yearlyUserHoursMap.get(yearKey);
			userHoursInYear.set(userYearKey, (userHoursInYear.get(userYearKey) || 0) + (wl.time_spent_seconds || 0));
		}

		// Get user details for cost calculations
		const userIds = Array.from(reportObj.participants || []).map(p => p.userId);
		const userDetailsMap = new Map();
		for (const participant of reportObj.participants || []) {
			userDetailsMap.set(participant.userId, participant);
		}

		const previous_years = Array.from(yearsMap.entries())
			.sort((a, b) => b[0] - a[0])
			.map(([year, totalSeconds]) => {
				const yearKey = `${year}`;
				const userHoursInYear = yearlyUserHoursMap.get(yearKey) || new Map();
				let yearCost = 0;

				// Calculate cost for this year based on user hours and their cost per hour
				for (const [userIdStr, secondsWorked] of userHoursInYear.entries()) {
					const userId = userIdStr;
					const hoursWorked = secondsWorked / 3600;
					const userDetails = userDetailsMap.get(userId);
					const costPerHour = userDetails?.costPerHour;

					if (Number.isFinite(costPerHour)) {
						yearCost += hoursWorked * costPerHour;
					}
				}

				return {
					year,
					total_hours: roundToTwoDecimals(totalSeconds / 3600),
					total_cost: roundToTwoDecimals(yearCost),
					active_users: (userSets.get(year) || new Set()).size,
				};
			});

		reportObj.previous_years = previous_years;
	} catch (err) {
		// non-fatal
		console.warn('Failed to compute yearly breakdown for project cost:', err && err.message);
	}

	return reportObj;
}

function roundToTwoDecimals(value) {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getYearRangeInStockholm(yearInput) {
	if (yearInput === undefined || yearInput === null || String(yearInput).trim() === '') {
		return null;
	}

	const year = Number.parseInt(yearInput, 10);
	if (!Number.isInteger(year) || year < 1900 || year > 2100) {
		throw new Error(`Invalid year: ${yearInput}`);
	}

	const startParts = { year, month: 1, day: 1 };
	const endParts = { year, month: 12, day: 31 };

	return {
		year,
		startDate: `${year}-01-01`,
		endDate: `${year}-12-31`,
		startDateUtc: zonedTimeToUtc(startParts, 0, 0, 0, 'Europe/Stockholm'),
		endDateUtc: zonedTimeToUtc(endParts, 23, 59, 59, 'Europe/Stockholm'),
	};
}

async function searchProjects(query) {
	const projects = await analyticsRepository.searchProjects(query);

	return projects.map(p => ({
		projectId: p.id,
		projectKey: p.jira_project_key,
		projectName: p.name,
	}));
}

async function getAllProjects() {
	const projects = await analyticsRepository.getAllProjects();

	return projects.map(p => ({
		projectId: p.id,
		projectKey: p.jira_project_key,
		projectName: p.name,
		startDate: p.start_date,
	}));
}

async function getProjectLastWeekHours(input) {
	const normalizedInput = String(input || '').trim();

	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const project = await analyticsRepository.getProjectInfo(normalizedInput);
	if (!project) {
		return null;
	}

	const weekRange = getPreviousWeekRangeInStockholm();
	const worklogs = await analyticsRepository.getAllWorklogsForForecast({
		projectKey: normalizedInput,
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
			label: `${weekRange.startDate} to ${weekRange.endDate}`,
		},
		totalSeconds,
		totalHours: roundToTwoDecimals(totalSeconds / 3600),
		hours: duration.hours,
		minutes: duration.minutes,
		formattedDuration: `${duration.hours} hours ${duration.minutes} minutes`,
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

function formatDatePartsForReport(parts) {
	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const month = monthNames[parts.month - 1];
	const day = String(parts.day).padStart(2, '0');
	const year = String(parts.year).slice(-2);
	return `${day}/${month}/${year}`;
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
 * Get full historical monthly workload across all available data.
 * Returns monthly hours and active contributors for each month with data.
 *
 * @returns {Promise<Object>} Full historical monthly report
 */
async function getFullHistoricalWorkload() {
	try {
		const worklogs = await analyticsRepository.getAllWorklogsForForecast();

		if (!Array.isArray(worklogs) || worklogs.length === 0) {
			return {
				monthly_periods: [],
				summary: {
					months_with_data: 0,
					total_hours: 0,
					total_worklogs: 0,
					unique_contributors: 0,
					first_period: null,
					last_period: null,
				},
			};
		}

		const monthlyMap = new Map();
		const globalContributors = new Set();

		for (const worklog of worklogs) {
			if (!worklog?.started_at) {
				continue;
			}

			const startedAt = new Date(worklog.started_at);
			const dateParts = getDatePartsInTimeZone(startedAt, 'Europe/Stockholm');
			const period = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}`;

			if (!monthlyMap.has(period)) {
				monthlyMap.set(period, {
					totalSeconds: 0,
					activeUsers: new Set(),
					worklogCount: 0,
				});
			}

			const monthEntry = monthlyMap.get(period);
			monthEntry.totalSeconds += worklog.time_spent_seconds || 0;
			monthEntry.worklogCount += 1;
			if (worklog.user_id !== undefined && worklog.user_id !== null) {
				monthEntry.activeUsers.add(worklog.user_id);
				globalContributors.add(worklog.user_id);
			}
		}

		const monthlyPeriods = Array.from(monthlyMap.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([period, values]) => ({
				period,
				total_hours: roundToTwoDecimals(values.totalSeconds / 3600),
				active_users: values.activeUsers.size,
				worklog_count: values.worklogCount,
			}));

		const totalHours = monthlyPeriods.reduce((sum, item) => sum + (item.total_hours || 0), 0);
		const totalWorklogs = monthlyPeriods.reduce((sum, item) => sum + (item.worklog_count || 0), 0);

		return {
			monthly_periods: monthlyPeriods,
			summary: {
				months_with_data: monthlyPeriods.length,
				total_hours: roundToTwoDecimals(totalHours),
				total_worklogs: totalWorklogs,
				unique_contributors: globalContributors.size,
				first_period: monthlyPeriods.length > 0 ? monthlyPeriods[0].period : null,
				last_period: monthlyPeriods.length > 0 ? monthlyPeriods[monthlyPeriods.length - 1].period : null,
			},
		};
	} catch (error) {
		console.error('Error in getFullHistoricalWorkload:', error);
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
 * Get all participants in a project.
 * 
 * @param {string} projectKey - The Jira project key
 * @returns {Promise<Object>} Project participants report
 */
async function getProjectParticipants(projectKey) {
	try {
		const report = await analyticsRepository.getProjectParticipants(projectKey);

		if (!report) {
			return null;
		}

		return {
			projectId: report.projectId,
			projectKey: report.projectKey,
			projectName: report.projectName,
			totalParticipants: report.totalParticipants,
			participants: report.participants.map(p => ({
				userId: p.userId,
				name: p.name,
				email: p.email,
				totalSeconds: p.totalSeconds,
				totalHours: roundToTwoDecimals(p.totalSeconds / 3600),
			})),
		};
	} catch (error) {
		console.error('Error in getProjectParticipants:', error);
		throw error;
	}
}

async function getProjectWeeklyReport(projectKey, period = 'week', monthNumber = null) {
	const normalizedInput = String(projectKey || '').trim();
	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const normalizedPeriod = String(period || '').trim().toLowerCase();
	if (normalizedPeriod !== 'week' && normalizedPeriod !== 'month') {
		throw new Error('Period must be either "week" or "month"');
	}

	let range;
	if (normalizedPeriod === 'month' && monthNumber) {
		const month = Number.parseInt(String(monthNumber || '').trim(), 10);
		if (Number.isNaN(month) || month < 1 || month > 12) {
			throw new Error('Invalid month number');
		}
		const now = new Date();
		const year = now.getUTCFullYear();
		range = getMonthRangeInStockholm(year, month);
	} else {
		range = getRecentPeriodRangeInStockholm(normalizedPeriod);
	}

	const report = await analyticsRepository.getProjectTaskWorklogReport(normalizedInput, {
		startDate: range.startDateUtc,
		endDate: range.endDateUtc,
	});

	if (!report) {
		return null;
	}

	const tasks = Array.isArray(report.tasks) ? report.tasks : [];
	const totalSeconds = tasks.reduce((sum, task) => sum + (task.totalSeconds || 0), 0);
	const totalWorklogs = tasks.reduce((sum, task) => sum + (task.worklogCount || 0), 0);

	return {
		projectId: report.projectId,
		projectKey: report.projectKey,
		projectName: report.projectName,
		period: {
			type: normalizedPeriod,
			timeZone: 'Europe/Stockholm',
			startDate: range.startDate,
			endDate: range.endDate,
			label: `${range.startDateFormatted} - ${range.endDateFormatted}`,
		},
		totalSeconds,
		totalHours: roundToTwoDecimals(totalSeconds / 3600),
		totalWorklogs: totalWorklogs,
		uniqueTaskCount: tasks.length,
		tasks: tasks.map((task) => ({
			issueId: task.issueId,
			issueKey: task.issueKey,
			title: task.title,
			totalSeconds: task.totalSeconds,
			totalHours: roundToTwoDecimals(task.totalSeconds / 3600),
			worklogCount: task.worklogCount,
		})),
	};
}

async function getProjectTeamWeeklyReport(projectKey, period = 'week', monthNumber = null) {
	const normalizedInput = String(projectKey || '').trim();
	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const normalizedPeriod = String(period || '').trim().toLowerCase();
	if (normalizedPeriod !== 'week' && normalizedPeriod !== 'month') {
		throw new Error('Period must be either "week" or "month"');
	}

	let range;
	if (normalizedPeriod === 'month' && monthNumber) {
		const month = Number.parseInt(String(monthNumber || '').trim(), 10);
		if (Number.isNaN(month) || month < 1 || month > 12) {
			throw new Error('Invalid month number');
		}
		const now = new Date();
		const year = now.getUTCFullYear();
		range = getMonthRangeInStockholm(year, month);
	} else {
		range = getRecentPeriodRangeInStockholm(normalizedPeriod);
	}

	const report = await analyticsRepository.getProjectUserWorklogReport(normalizedInput, {
		startDate: range.startDateUtc,
		endDate: range.endDateUtc,
	});

	if (!report) {
		return null;
	}

	const entries = Array.isArray(report.entries) ? report.entries : [];
	const totalSeconds = entries.reduce((sum, entry) => sum + (entry.timeSpentSeconds || 0), 0);

	const participantsMap = new Map();
	for (const entry of entries) {
		if (!entry.userId) {
			continue;
		}

		if (!participantsMap.has(entry.userId)) {
			participantsMap.set(entry.userId, {
				userId: entry.userId,
				name: entry.userName || `User ${entry.userId}`,
				email: entry.userEmail || '',
				totalSeconds: 0,
				worklogCount: 0,
				issueKeys: new Set(),
			});
		}

		const participant = participantsMap.get(entry.userId);
		participant.totalSeconds += entry.timeSpentSeconds || 0;
		participant.worklogCount += 1;
		if (entry.issueKey) {
			participant.issueKeys.add(entry.issueKey);
		}
	}

	const participants = Array.from(participantsMap.values())
		.map((participant) => ({
			userId: participant.userId,
			name: participant.name,
			email: participant.email,
			totalSeconds: participant.totalSeconds,
			totalHours: roundToTwoDecimals(participant.totalSeconds / 3600),
			worklogCount: participant.worklogCount,
			issueCount: participant.issueKeys.size,
		}))
		.sort((left, right) => right.totalSeconds - left.totalSeconds);

	return {
		projectId: report.projectId,
		projectKey: report.projectKey,
		projectName: report.projectName,
		period: {
			type: normalizedPeriod,
			timeZone: 'Europe/Stockholm',
			startDate: range.startDate,
			endDate: range.endDate,
			label: `${range.startDateFormatted} - ${range.endDateFormatted}`,
		},
		totalSeconds,
		totalHours: roundToTwoDecimals(totalSeconds / 3600),
		totalWorklogs: entries.length,
		participantCount: participants.length,
		participants,
	};
}

function getRecentPeriodRangeInStockholm(period, referenceDate = new Date()) {
	const stockholmToday = getDatePartsInTimeZone(referenceDate, 'Europe/Stockholm');
	const stockholmTodayDate = new Date(Date.UTC(stockholmToday.year, stockholmToday.month - 1, stockholmToday.day));

	if (period === 'month') {
		// For monthly reports, use previous calendar month
		let year = stockholmToday.year;
		let month = stockholmToday.month - 1;

		if (month < 1) {
			month = 12;
			year -= 1;
		}

		return getMonthRangeInStockholm(year, month);
	}

	// For weekly reports
	const dayOfWeek = stockholmTodayDate.getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;

	const mondayThisWeek = addUtcDays(stockholmTodayDate, -daysSinceMonday);
	const sundayLastWeek = addUtcDays(mondayThisWeek, -1);

	const startDateUtcDay = addUtcDays(sundayLastWeek, -6); // Last full Monday-Sunday week

	const startParts = {
		year: startDateUtcDay.getUTCFullYear(),
		month: startDateUtcDay.getUTCMonth() + 1,
		day: startDateUtcDay.getUTCDate(),
	};

	const endParts = {
		year: sundayLastWeek.getUTCFullYear(),
		month: sundayLastWeek.getUTCMonth() + 1,
		day: sundayLastWeek.getUTCDate(),
	};

	return {
		startDate: formatDateParts(startParts),
		endDate: formatDateParts(endParts),
		startDateFormatted: formatDatePartsForReport(startParts),
		endDateFormatted: formatDatePartsForReport(endParts),
		startDateUtc: zonedTimeToUtc(startParts, 0, 0, 0, 'Europe/Stockholm'),
		endDateUtc: zonedTimeToUtc(endParts, 23, 59, 59, 'Europe/Stockholm'),
	};
}

function getMonthRangeInStockholm(year, month) {
	// Get the first and last day of the month
	const startDate = new Date(Date.UTC(year, month - 1, 1));
	const endDate = new Date(Date.UTC(year, month, 0)); // Last day of the month

	const startParts = {
		year: startDate.getUTCFullYear(),
		month: startDate.getUTCMonth() + 1,
		day: startDate.getUTCDate(),
	};

	const endParts = {
		year: endDate.getUTCFullYear(),
		month: endDate.getUTCMonth() + 1,
		day: endDate.getUTCDate(),
	};

	return {
		startDate: formatDateParts(startParts),
		endDate: formatDateParts(endParts),
		startDateFormatted: formatDatePartsForReport(startParts),
		endDateFormatted: formatDatePartsForReport(endParts),
		startDateUtc: zonedTimeToUtc(startParts, 0, 0, 0, 'Europe/Stockholm'),
		endDateUtc: zonedTimeToUtc(endParts, 23, 59, 59, 'Europe/Stockholm'),
	};
}

module.exports = {
	getProjectInfo,
	getProjectCost,
	getProjectCostWithYears,
	searchProjects,
	getAllProjects,
	getProjectLastWeekHours,
	getWorkloadForecast,
	getHistoricalWorkloadComparison,
	getFullHistoricalWorkload,
	getWorkloadAnalytics,
	getProjectParticipants,
	getProjectWeeklyReport,
	getProjectTeamWeeklyReport,
};
