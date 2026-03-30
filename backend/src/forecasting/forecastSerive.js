const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const analyticsService = require('./analyticsService');

function resolvePythonExecutable() {
	if (process.env.PYTHON_EXECUTABLE) {
		return process.env.PYTHON_EXECUTABLE;
	}

	const venvWindows = path.join(__dirname, '../../../.venv/Scripts/python.exe');
	const venvPosix = path.join(__dirname, '../../../.venv/bin/python');

	if (fs.existsSync(venvWindows)) {
		return venvWindows;
	}

	if (fs.existsSync(venvPosix)) {
		return venvPosix;
	}

	return 'python';
}

/**
 * Generate workload forecast using Python ML model.
 * 
 * @param {Object} options - Forecast options
 * @param {number} options.forecastMonths - Number of months to forecast (default 3)
 * @param {boolean} options.includeHistorical - Include historical comparison (default true)
 * @param {Date} options.startDate - Start date for historical data
 * @param {Date} options.endDate - End date for historical data
 * @param {string} options.projectKey - Optional project filter
 * @returns {Promise<Object>} Forecast results
 */
async function generateWorkloadForecast(options = {}) {
	try {
		const forecastMonths = options.forecastMonths || 3;
		const includeHistorical = options.includeHistorical !== false;
		
		// Get historical worklogs
		const worklogs = await analyticsService.getHistoricalWorklogs({
			startDate: options.startDate,
			endDate: options.endDate,
			projectKey: options.projectKey
		});
		
		if (worklogs.length === 0) {
			throw new Error('No worklog data available for forecasting');
		}
		
		// Prepare data for Python script
		const inputData = {
			worklogs: worklogs.map(w => ({
				time_spent_seconds: w.time_spent_seconds,
				started_at: w.started_at,
				user_id: w.user_id
			})),
			forecast_months: forecastMonths,
			include_historical: includeHistorical
		};
		
		// Run Python forecast script
		const forecastResult = await runPythonForecast(inputData);
		
		return forecastResult;
	} catch (error) {
		console.error('Error generating workload forecast:', error);
		throw error;
	}
}

/**
 * Run Python forecast script and return results.
 * 
 * @param {Object} inputData - Input data for Python script
 * @returns {Promise<Object>} Forecast results from Python
 */
function runPythonForecast(inputData) {
	return new Promise((resolve, reject) => {
		const pythonScriptPath = path.join(__dirname, '../../python/workload_forecast.py');
		const pythonExecutable = resolvePythonExecutable();
		
		// Spawn Python process
		const pythonProcess = spawn(pythonExecutable, [pythonScriptPath]);
		
		let outputData = '';
		let errorData = '';
		
		// Send input data to Python via stdin
		pythonProcess.stdin.write(JSON.stringify(inputData));
		pythonProcess.stdin.end();
		
		// Collect output
		pythonProcess.stdout.on('data', (data) => {
			outputData += data.toString();
		});
		
		pythonProcess.stderr.on('data', (data) => {
			errorData += data.toString();
		});
		
		// Handle process completion
		pythonProcess.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`Python forecast failed with code ${code}: ${errorData}`));
				return;
			}
			
			try {
				const result = JSON.parse(outputData);
				
				if (!result.success) {
					reject(new Error(`Forecast error: ${result.error}`));
					return;
				}
				
				resolve(result);
			} catch (parseError) {
				reject(new Error(`Failed to parse Python output: ${parseError.message}`));
			}
		});
		
		pythonProcess.on('error', (error) => {
			reject(new Error(`Failed to spawn Python process: ${error.message}`));
		});
	});
}

/**
 * Get comprehensive workload forecast with historical comparison.
 * Combines ML forecast with current analytics and historical data.
 * 
 * @param {Object} options - Forecast options
 * @param {number} options.forecastMonths - Number of months to forecast
 * @returns {Promise<Object>} Complete forecast report
 */
async function getComprehensiveWorkloadForecast(options = {}) {
	try {
		const forecastMonths = options.forecastMonths || 3;
		
		// Get ML forecast
		const mlForecast = await generateWorkloadForecast({
			forecastMonths,
			includeHistorical: true
		});
		
		// Get current period analytics
		const now = new Date();
		const currentMonth = now.getMonth() + 1;
		const currentYear = now.getFullYear();
		
		const historicalComparison = await analyticsService.getHistoricalComparison({
			month: currentMonth,
			year: currentYear,
			yearsBack: 3
		});
		
		// Get recent trends (last 6 months)
		const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
		const recentAnalytics = await analyticsService.getWorkloadAnalytics({
			startDate: sixMonthsAgo,
			endDate: now
		});
		
		return {
			forecast: mlForecast.forecast,
			historical: {
				ml_comparison: mlForecast.historical_comparison || [],
				yearly_comparison: historicalComparison
			},
			current_state: {
				stats: mlForecast.current_stats,
				recent_analytics: recentAnalytics
			},
			data_info: mlForecast.data_range,
			generated_at: new Date().toISOString()
		};
	} catch (error) {
		console.error('Error in getComprehensiveWorkloadForecast:', error);
		throw error;
	}
}

/**
 * Generate simple forecast summary for reporting.
 * 
 * @param {number} forecastMonths - Number of months to forecast
 * @returns {Promise<Object>} Simplified forecast summary
 */
async function getWorkloadForecastSummary(forecastMonths = 3) {
	try {
		const forecast = await generateWorkloadForecast({ forecastMonths });
		
		if (!forecast.success) {
			throw new Error('Forecast generation failed');
		}
		
		const monthlyForecasts = forecast.forecast.monthly_forecast || [];
		const currentStats = forecast.current_stats || {};
		
		return {
			summary: {
				forecast_period: `Next ${forecastMonths} months`,
				current_trend: currentStats.trend || 'unknown',
				last_4_weeks_hours: currentStats.last_4_weeks_hours || 0,
				current_active_users: currentStats.current_active_users || 0
			},
			monthly_predictions: monthlyForecasts.map(m => ({
				month: m.month,
				predicted_hours: Math.round(m.predicted_hours),
				range: `${Math.round(m.lower_bound)} - ${Math.round(m.upper_bound)} hours`,
				confidence: 'medium'
			})),
			data_quality: {
				weeks_of_data: forecast.data_range?.total_weeks || 0,
				data_start: forecast.data_range?.start_date,
				data_end: forecast.data_range?.end_date
			}
		};
	} catch (error) {
		console.error('Error in getWorkloadForecastSummary:', error);
		throw error;
	}
}

module.exports = {
	generateWorkloadForecast,
	getComprehensiveWorkloadForecast,
	getWorkloadForecastSummary
};
