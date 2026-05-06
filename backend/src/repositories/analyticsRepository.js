const { createClient } = require('@supabase/supabase-js');
const config = require('../config').supabase;

const supabase = createClient(config.url, config.serviceRoleKey);

const PROJECTS_TABLE = 'PROJECTS';
const ISSUES_TABLE = 'ISSUES';
const WORKLOGS_TABLE = 'WORKLOGS';

function roundToTwoDecimals(value) {
	return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function getProjectInfo(input) {
	const normalizedInput = String(input || '').trim();

	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const project = await findProjectByKeyOrName(normalizedInput);
	if (!project) {
		return null;
	}

	const issueIds = await getIssueIdsForProject(project.id);
	if (issueIds.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			startDate: project.start_date,
			lastLoggedIssue: project.last_logged_issue,
			totalSeconds: 0,
			contributorsCount: 0,
		};
	}

	const stats = await getProjectWorklogStats(issueIds);

	return {
		projectId: project.id,
		projectKey: project.jira_project_key,
		projectName: project.name,
		startDate: project.start_date,
		lastLoggedIssue: project.last_logged_issue,
		totalSeconds: stats.totalSeconds,
		contributorsCount: stats.contributorsCount,
	};
}

async function findProjectByKeyOrName(input) {
	const normalizedInput = String(input || '').trim().toUpperCase();

	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	// First try to find by project key
	const { data: byKey, error: keyError } = await supabase
		.from(PROJECTS_TABLE)
		.select('id, jira_project_key, name, start_date, last_logged_issue')
		.eq('jira_project_key', normalizedInput)
		.limit(1)
		.maybeSingle();

	if (keyError) {
		throw keyError;
	}

	if (byKey) {
		return byKey;
	}

	// If not found by key, try to find by name (case-insensitive)
	const { data: byName, error: nameError } = await supabase
		.from(PROJECTS_TABLE)
		.select('id, jira_project_key, name, start_date, last_logged_issue')
		.ilike('name', `%${input}%`)
		.order('name', { ascending: true })
		.limit(1)
		.maybeSingle();

	if (nameError) {
		throw nameError;
	}

	return byName || null;
}

async function findProjectByKey(projectKey) {
	const { data, error } = await supabase
		.from(PROJECTS_TABLE)
		.select('id, jira_project_key, name, start_date, last_logged_issue')
		.eq('jira_project_key', projectKey)
		.limit(1)
		.maybeSingle();

	if (error) {
		throw error;
	}

	return data || null;
}

async function getIssueIdsForProject(projectId) {
	const pageSize = 1000;
	const issueIds = [];
	let from = 0;
	let hasMore = true;

	while (hasMore) {
		const to = from + pageSize - 1;
		const { data, error } = await supabase
			.from(ISSUES_TABLE)
			.select('id')
			.eq('project_id', projectId)
			.order('id', { ascending: true })
			.range(from, to);

		if (error) {
			throw error;
		}

		const batch = data || [];
		for (const issue of batch) {
			issueIds.push(issue.id);
		}

		hasMore = batch.length === pageSize;
		from += pageSize;
	}

	return issueIds;
}

async function getProjectWorklogStats(issueIds) {
	const issueIdChunks = chunkArray(issueIds, 200);
	let totalSeconds = 0;
	const contributorIds = new Set();
	const seenWorklogIds = new Set();

	for (const chunk of issueIdChunks) {
		const chunkRows = await fetchAllWorklogsForIssueChunk(chunk);
		for (const row of chunkRows) {
			if (seenWorklogIds.has(row.id)) {
				continue;
			}

			seenWorklogIds.add(row.id);
			totalSeconds += row.time_spent_seconds || 0;
			if (row.user_id) {
				contributorIds.add(row.user_id);
			}
		}
	}

	return {
		totalSeconds,
		contributorsCount: contributorIds.size,
	};
}

async function fetchAllWorklogsForIssueChunk(issueIdChunk) {
	const pageSize = 1000;
	const rows = [];
	let from = 0;
	let hasMore = true;

	while (hasMore) {
		const to = from + pageSize - 1;
		const { data, error } = await supabase
			.from(WORKLOGS_TABLE)
			.select('id, time_spent_seconds, user_id')
			.in('issue_id', issueIdChunk)
			.order('id', { ascending: true })
			.range(from, to);

		if (error) {
			throw error;
		}

		const batch = data || [];
		rows.push(...batch);
		hasMore = batch.length === pageSize;
		from += pageSize;
	}

	return rows;
}

function chunkArray(values, chunkSize) {
	const chunks = [];
	for (let i = 0; i < values.length; i += chunkSize) {
		chunks.push(values.slice(i, i + chunkSize));
	}
	return chunks;
}

async function searchProjects(query) {
	const searchPattern = `%${query}%`;

	const { data, error } = await supabase
		.from(PROJECTS_TABLE)
		.select('id, jira_project_key, name')
		.or(`name.ilike.${searchPattern},jira_project_key.ilike.${searchPattern}`)
		.order('name', { ascending: true })
		.limit(50);

	if (error) {
		throw error;
	}

	return data || [];
}

/**
 * Get all projects.
 * 
 * @returns {Promise<Array>} Array of all projects
 */
async function getAllProjects() {
	const cutoffDate = new Date();
	cutoffDate.setMonth(cutoffDate.getMonth() - 2);
	const cutoffIso = cutoffDate.toISOString();

	const pageSize = 1000;
	const projects = [];
	let from = 0;
	let hasMore = true;

	while (hasMore) {
		const to = from + pageSize - 1;
		const { data, error } = await supabase
			.from(PROJECTS_TABLE)
			.select('id, jira_project_key, name, start_date, last_logged_issue')
			.not('last_logged_issue', 'is', null)
			.gte('last_logged_issue', cutoffIso)
			.order('name', { ascending: true })
			.range(from, to);

		if (error) {
			throw error;
		}

		const batch = data || [];
		projects.push(...batch);
		hasMore = batch.length === pageSize;
		from += pageSize;
	}

	return projects;
}

/**
 * Get all worklogs with user information for forecasting and historical analysis.
 * Optionally filter by date range.
 * 
 * @param {Object} options - Filter options
 * @param {Date} options.startDate - Optional start date filter
 * @param {Date} options.endDate - Optional end date filter
 * @param {string} options.projectKey - Optional project key filter
 * @param {string|number} options.userId - Optional user filter
 * @returns {Promise<Array>} Array of worklogs with time_spent_seconds, started_at, user_id
 */
async function getAllWorklogsForForecast(options = {}) {
	const { startDate, endDate, projectKey, userId } = options;

	let query = supabase
		.from(WORKLOGS_TABLE)
		.select('id, time_spent_seconds, started_at, user_id, issue_id');

	if (startDate) {
		query = query.gte('started_at', startDate.toISOString());
	}

	if (endDate) {
		query = query.lte('started_at', endDate.toISOString());
	}

	// If filtering by project, need to join through issues
	if (projectKey) {
		// First get the project (by key or name)
		const project = await findProjectByKeyOrName(projectKey);
		if (!project) {
			return [];
		}

		// Get issue IDs for this project
		const issueIds = await getIssueIdsForProject(project.id);
		if (issueIds.length === 0) {
			return [];
		}

		// Filter worklogs by these issues
		query = query.in('issue_id', issueIds);
	}

	if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
		query = query.eq('user_id', userId);
	}

	query = query.order('started_at', { ascending: true });

	// Fetch all data (pagination if needed)
	const allWorklogs = [];
	const pageSize = 1000;
	let from = 0;
	let hasMore = true;

	while (hasMore) {
		const to = from + pageSize - 1;
		const { data, error } = await query.range(from, to);

		if (error) {
			throw error;
		}

		const batch = data || [];
		allWorklogs.push(...batch);
		hasMore = batch.length === pageSize;
		from += pageSize;
	}

	return allWorklogs;
}

/**
 * Get workload summary grouped by time period (week/month).
 * 
 * @param {Object} options - Query options
 * @param {Date} options.startDate - Start date
 * @param {Date} options.endDate - End date
 * @param {string} options.groupBy - 'week' or 'month'
 * @returns {Promise<Array>} Array of aggregated workload data
 */
async function getWorkloadByPeriod(options = {}) {
	const { startDate, endDate, groupBy = 'week' } = options;

	// Use raw SQL for better date grouping
	const truncFunction = groupBy === 'month' ? 'month' : 'week';

	let query = `
		SELECT 
			date_trunc('${truncFunction}', started_at) as period_start,
			SUM(time_spent_seconds) as total_seconds,
			COUNT(DISTINCT user_id) as active_users,
			COUNT(*) as worklog_count
		FROM ${WORKLOGS_TABLE}
	`;

	const conditions = [];
	if (startDate) {
		conditions.push(`started_at >= '${startDate.toISOString()}'`);
	}
	if (endDate) {
		conditions.push(`started_at <= '${endDate.toISOString()}'`);
	}

	if (conditions.length > 0) {
		query += ' WHERE ' + conditions.join(' AND ');
	}

	query += `
		GROUP BY date_trunc('${truncFunction}', started_at)
		ORDER BY period_start ASC
	`;

	const { data, error } = await supabase.rpc('exec_sql', { query });

	if (error) {
		// If RPC doesn't exist, fall back to fetching all and grouping in JS
		return getWorkloadByPeriodFallback(options);
	}

	return data || [];
}

/**
 * Fallback method to group worklogs by period in JavaScript.
 */
async function getWorkloadByPeriodFallback(options = {}) {
	const { startDate, endDate, groupBy = 'week' } = options;

	const worklogs = await getAllWorklogsForForecast({ startDate, endDate });

	// Group in JavaScript
	const grouped = {};

	for (const worklog of worklogs) {
		const date = new Date(worklog.started_at);
		let periodKey;

		if (groupBy === 'month') {
			periodKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		} else {
			// Week grouping - get Monday of the week
			const day = date.getDay();
			const diff = date.getDate() - day + (day === 0 ? -6 : 1);
			const monday = new Date(date.setDate(diff));
			periodKey = monday.toISOString().split('T')[0];
		}

		if (!grouped[periodKey]) {
			grouped[periodKey] = {
				period_start: periodKey,
				total_seconds: 0,
				active_users: new Set(),
				worklog_count: 0
			};
		}

		grouped[periodKey].total_seconds += worklog.time_spent_seconds || 0;
		grouped[periodKey].active_users.add(worklog.user_id);
		grouped[periodKey].worklog_count += 1;
	}

	// Convert to array and format
	return Object.values(grouped).map(item => ({
		period_start: item.period_start,
		total_seconds: item.total_seconds,
		active_users: item.active_users.size,
		worklog_count: item.worklog_count
	})).sort((a, b) => a.period_start.localeCompare(b.period_start));
}

/**
 * Get historical comparison for same month in previous years.
 * 
 * @param {number} month - Month number (1-12)
 * @param {number} currentYear - Current year
 * @param {number} yearsBack - How many years to look back (default 3)
 * @returns {Promise<Array>} Historical data for each year
 */
async function getHistoricalComparisonByMonth(month, currentYear, yearsBack = 3) {
	const comparisons = [];

	for (let i = 1; i <= yearsBack; i++) {
		const year = currentYear - i;

		// Get start and end of month
		const startDate = new Date(year, month - 1, 1);
		const endDate = new Date(year, month, 0, 23, 59, 59);

		const worklogs = await getAllWorklogsForForecast({ startDate, endDate });

		if (worklogs.length > 0) {
			const totalSeconds = worklogs.reduce((sum, w) => sum + (w.time_spent_seconds || 0), 0);
			const uniqueUsers = new Set(worklogs.map(w => w.user_id)).size;

			comparisons.push({
				year,
				month,
				period: `${year}-${String(month).padStart(2, '0')}`,
				total_hours: Math.round(totalSeconds / 3600 * 100) / 100,
				total_seconds: totalSeconds,
				active_users: uniqueUsers,
				worklog_count: worklogs.length
			});
		}
	}

	return comparisons;
}

/**
 * Get all participants (users) who have worked on a project.
 * 
 * @param {string} projectKey - The Jira project key
 * @returns {Promise<Array>} Array of participants with hours spent
 */
async function getProjectParticipants(input) {
	const normalizedInput = String(input || '').trim();

	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	// Find the project (by key or name)
	const project = await findProjectByKeyOrName(normalizedInput);
	if (!project) {
		return null;
	}

	// Get all issue IDs for this project
	const issueIds = await getIssueIdsForProject(project.id);
	if (issueIds.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			participants: [],
			totalParticipants: 0,
		};
	}

	// Get all unique users who have logged time on these issues
	const issueIdChunks = chunkArray(issueIds, 200);
	const participantsMap = new Map(); // user_id -> {user_id, name, email, totalSeconds}

	const USERS_TABLE = 'USERS';

	for (const chunk of issueIdChunks) {
		const { data, error } = await supabase
			.from(WORKLOGS_TABLE)
			.select('user_id, time_spent_seconds')
			.in('issue_id', chunk);

		if (error) {
			throw error;
		}

		const rows = data || [];
		for (const row of rows) {
			if (row.user_id) {
				if (!participantsMap.has(row.user_id)) {
					participantsMap.set(row.user_id, {
						user_id: row.user_id,
						totalSeconds: 0,
					});
				}

				const participant = participantsMap.get(row.user_id);
				participant.totalSeconds += row.time_spent_seconds || 0;
			}
		}
	}

	// Get user details for all participants
	const userIds = Array.from(participantsMap.keys());
	if (userIds.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			participants: [],
			totalParticipants: 0,
		};
	}

	// Fetch user details in chunks (Supabase max IN clause size)
	const userChunks = chunkArray(userIds, 200);
	const userDetailsMap = new Map();

	for (const chunk of userChunks) {
		const { data, error } = await supabase
			.from(USERS_TABLE)
			.select('id, name, email')
			.in('id', chunk);

		if (error) {
			throw error;
		}

		const rows = data || [];
		for (const row of rows) {
			userDetailsMap.set(row.id, row);
		}
	}

	// Combine data
	const participants = [];
	for (const [userId, participant] of participantsMap.entries()) {
		const userDetails = userDetailsMap.get(userId);
		participants.push({
			userId: userId,
			name: userDetails?.name || `User ${userId}`,
			email: userDetails?.email || '',
			totalSeconds: participant.totalSeconds,
		});
	}

	// Sort by hours spent (descending)
	participants.sort((a, b) => b.totalSeconds - a.totalSeconds);

	return {
		projectId: project.id,
		projectKey: project.jira_project_key,
		projectName: project.name,
		participants: participants,
		totalParticipants: participants.length,
	};
}

async function getProjectCostReport(input, options = {}) {
	const normalizedInput = String(input || '').trim();

	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const { startDate, endDate } = options;

	const project = await findProjectByKeyOrName(normalizedInput);
	if (!project) {
		return null;
	}

	const issueIds = await getIssueIdsForProject(project.id);
	if (issueIds.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			totalSeconds: 0,
			totalCost: 0,
			participants: [],
			totalParticipants: 0,
			missingCostUsers: [],
			missingCostCount: 0,
		};
	}

	const issueIdChunks = chunkArray(issueIds, 200);
	const participantsMap = new Map();

	// Prepare yearly accumulation (bucket by Europe/Stockholm year)
	const yearsMap = new Map();
	const yearUserSets = new Map();
	const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });

	for (const chunk of issueIdChunks) {
		let query = supabase
			.from(WORKLOGS_TABLE)
			.select('user_id, time_spent_seconds, started_at')
			.in('issue_id', chunk);

		if (startDate) {
			query = query.gte('started_at', startDate.toISOString());
		}

		if (endDate) {
			query = query.lte('started_at', endDate.toISOString());
		}

		const { data, error } = await query;

		if (error) {
			throw error;
		}

		const rows = data || [];
		for (const row of rows) {
			if (!row.user_id) {
				continue;
			}

			// Yearly accumulation based on Stockholm local date
			try {
				const parts = dateFormatter.formatToParts(new Date(row.started_at));
				let y = null;
				for (const p of parts) {
					if (p.type === 'year') {
						y = Number.parseInt(p.value, 10);
						break;
					}
				}
				if (!y) {
					y = new Date(row.started_at).getUTCFullYear();
				}
				yearsMap.set(y, (yearsMap.get(y) || 0) + (row.time_spent_seconds || 0));
				const set = yearUserSets.get(y) || new Set();
				if (row.user_id !== undefined && row.user_id !== null) set.add(row.user_id);
				yearUserSets.set(y, set);
			} catch (err) {
				// ignore year grouping errors
			}

			if (!participantsMap.has(row.user_id)) {
				participantsMap.set(row.user_id, {
					userId: row.user_id,
					totalSeconds: 0,
				});
			}

			const participant = participantsMap.get(row.user_id);
			participant.totalSeconds += row.time_spent_seconds || 0;
		}
	}

	const userIds = Array.from(participantsMap.keys());
	const userDetailsMap = new Map();

	for (const chunk of chunkArray(userIds, 200)) {
		if (chunk.length === 0) {
			continue;
		}

		const { data, error } = await supabase
			.from('USERS')
			.select('id, name, email, cost')
			.in('id', chunk);

		if (error) {
			throw error;
		}

		const rows = data || [];
		for (const row of rows) {
			userDetailsMap.set(row.id, row);
		}
	}

	const participants = [];
	const missingCostUsers = [];
	let totalSeconds = 0;
	let totalCost = 0;

	for (const [userId, participant] of participantsMap.entries()) {
		const userDetails = userDetailsMap.get(userId);
		const hours = participant.totalSeconds / 3600;
		const rawCostPerHour = userDetails?.cost;
		const costPerHour = rawCostPerHour === null || rawCostPerHour === undefined || rawCostPerHour === ''
			? null
			: Number(rawCostPerHour);
		const hasCost = Number.isFinite(costPerHour);
		const userTotalCost = hasCost ? hours * costPerHour : null;

		totalSeconds += participant.totalSeconds;
		if (hasCost) {
			totalCost += userTotalCost;
		} else {
			missingCostUsers.push({
				userId,
				name: userDetails?.name || `User ${userId}`,
				email: userDetails?.email || '',
				totalSeconds: participant.totalSeconds,
				totalHours: roundToTwoDecimals(hours),
			});
		}

		participants.push({
			userId,
			name: userDetails?.name || `User ${userId}`,
			email: userDetails?.email || '',
			totalSeconds: participant.totalSeconds,
			totalHours: roundToTwoDecimals(hours),
			costPerHour: hasCost ? roundToTwoDecimals(costPerHour) : null,
			totalCost: hasCost ? roundToTwoDecimals(userTotalCost) : null,
		});
	}

	participants.sort((left, right) => {
		const leftCost = Number.isFinite(left.totalCost) ? left.totalCost : -1;
		const rightCost = Number.isFinite(right.totalCost) ? right.totalCost : -1;
		return rightCost - leftCost;
	});

	// Build previous_years from yearsMap
	const previous_years = Array.from(yearsMap.entries())
		.sort((a, b) => b[0] - a[0])
		.map(([year, totalSeconds]) => ({
			year,
			total_hours: Math.round((totalSeconds / 3600 + Number.EPSILON) * 100) / 100,
			active_users: (yearUserSets.get(year) || new Set()).size,
		}));

	return {
		projectId: project.id,
		projectKey: project.jira_project_key,
		projectName: project.name,
		totalSeconds,
		totalHours: roundToTwoDecimals(totalSeconds / 3600),
		totalCost: roundToTwoDecimals(totalCost),
		participants,
		totalParticipants: participants.length,
		missingCostUsers,
		missingCostCount: missingCostUsers.length,
		previous_years,
	};
}

async function getProjectTaskWorklogReport(input, options = {}) {
	const normalizedInput = String(input || '').trim();
	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const { startDate, endDate } = options;

	const project = await findProjectByKeyOrName(normalizedInput);
	if (!project) {
		return null;
	}

	const issueIds = await getIssueIdsForProject(project.id);
	if (issueIds.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			totalSeconds: 0,
			totalWorklogs: 0,
			uniqueTaskCount: 0,
			tasks: [],
		};
	}

	const worklogs = await getAllWorklogsForForecast({
		startDate,
		endDate,
		projectKey: normalizedInput,
	});

	if (worklogs.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			totalSeconds: 0,
			totalWorklogs: 0,
			uniqueTaskCount: 0,
			tasks: [],
		};
	}

	const issueDetailsMap = await getIssueDetailsMapByIds(issueIds);
	const tasksMap = new Map();
	let totalSeconds = 0;

	for (const worklog of worklogs) {
		totalSeconds += worklog.time_spent_seconds || 0;
		const issueId = worklog.issue_id;
		if (!issueId) {
			continue;
		}

		if (!tasksMap.has(issueId)) {
			const issue = issueDetailsMap.get(issueId);
			tasksMap.set(issueId, {
				issueId,
				issueKey: issue?.jira_issue_key || `ISSUE-${issueId}`,
				title: issue?.title || 'Unknown task',
				totalSeconds: 0,
				worklogCount: 0,
			});
		}

		const task = tasksMap.get(issueId);
		task.totalSeconds += worklog.time_spent_seconds || 0;
		task.worklogCount += 1;
	}

	const tasks = Array.from(tasksMap.values()).sort((left, right) => right.totalSeconds - left.totalSeconds);

	return {
		projectId: project.id,
		projectKey: project.jira_project_key,
		projectName: project.name,
		totalSeconds,
		totalWorklogs: worklogs.length,
		uniqueTaskCount: tasks.length,
		tasks,
	};
}

async function getProjectUserWorklogReport(input, options = {}) {
	const normalizedInput = String(input || '').trim();
	if (!normalizedInput) {
		throw new Error('Project key or name is required');
	}

	const { startDate, endDate } = options;

	const project = await findProjectByKeyOrName(normalizedInput);
	if (!project) {
		return null;
	}

	const worklogs = await getAllWorklogsForForecast({
		startDate,
		endDate,
		projectKey: normalizedInput,
	});

	if (worklogs.length === 0) {
		return {
			projectId: project.id,
			projectKey: project.jira_project_key,
			projectName: project.name,
			totalWorklogs: 0,
			entries: [],
		};
	}

	const issueIds = Array.from(new Set(worklogs.map((worklog) => worklog.issue_id).filter(Boolean)));
	const userIds = Array.from(new Set(worklogs.map((worklog) => worklog.user_id).filter(Boolean)));

	const issueDetailsMap = await getIssueDetailsMapByIds(issueIds);
	const userDetailsMap = await getUserDetailsMapByIds(userIds);

	const entries = worklogs.map((worklog) => {
		const issue = issueDetailsMap.get(worklog.issue_id);
		const user = userDetailsMap.get(worklog.user_id);

		return {
			issueId: worklog.issue_id,
			issueKey: issue?.jira_issue_key || `ISSUE-${worklog.issue_id || ''}`,
			title: issue?.title || 'Unknown task',
			userId: worklog.user_id,
			userName: user?.name || `User ${worklog.user_id}`,
			userEmail: user?.email || '',
			timeSpentSeconds: worklog.time_spent_seconds || 0,
		};
	});

	return {
		projectId: project.id,
		projectKey: project.jira_project_key,
		projectName: project.name,
		totalWorklogs: worklogs.length,
		entries,
	};
}

async function getIssueDetailsMapByIds(issueIds) {
	const map = new Map();

	for (const chunk of chunkArray(issueIds, 200)) {
		if (chunk.length === 0) {
			continue;
		}

		const { data, error } = await supabase
			.from(ISSUES_TABLE)
			.select('id, jira_issue_key, title')
			.in('id', chunk);

		if (error) {
			throw error;
		}

		for (const row of data || []) {
			map.set(row.id, row);
		}
	}

	return map;
}

async function getUserDetailsMapByIds(userIds) {
	const map = new Map();

	for (const chunk of chunkArray(userIds, 200)) {
		if (chunk.length === 0) {
			continue;
		}

		const { data, error } = await supabase
			.from('USERS')
			.select('id, name, email')
			.in('id', chunk);

		if (error) {
			throw error;
		}

		for (const row of data || []) {
			map.set(row.id, row);
		}
	}

	return map;
}

module.exports = {
	getProjectInfo,
	searchProjects,
	getAllProjects,
	getAllWorklogsForForecast,
	getWorkloadByPeriod,
	getHistoricalComparisonByMonth,
	getProjectParticipants,
	getProjectCostReport,
	getProjectTaskWorklogReport,
	getProjectUserWorklogReport,
};
