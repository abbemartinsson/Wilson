const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

class ChartGeneratorService {
    constructor() {
        this.width = 800;
        this.height = 400;
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({
            width: this.width,
            height: this.height,
            chartCallback: (ChartJS) => {
                // Enable plugins if needed
            },
        });
    }

    /**
     * Generate historical comparison chart
     * @param {Object} data - Report data from getHistoricalWorkloadComparison
     * @returns {Promise<Buffer>} PNG image buffer
     */
    async generateHistoricalComparisonChart(data) {
        if (!data) {
            throw new Error('Data is required');
        }

        const years = [];
        const hoursData = [];
        const contributorsData = [];

        // Add current year first if available
        if (data.current_period) {
            years.push(data.current_period.year);
            hoursData.push(data.current_period.total_hours);
            contributorsData.push(data.current_period.active_users);
        }

        // Add previous years
        if (Array.isArray(data.previous_years)) {
            for (const year of data.previous_years) {
                years.unshift(year.year); // Add at beginning to keep chronological order
                hoursData.unshift(year.total_hours);
                contributorsData.unshift(year.active_users);
            }
        }

        const configuration = {
            type: 'bar',
            data: {
                labels: years.map(String),
                datasets: [
                    {
                        label: 'Hours',
                        data: hoursData,
                        backgroundColor: 'rgba(54, 162, 235, 0.7)',
                        borderColor: 'rgba(54, 162, 235, 1)',
                        borderWidth: 2,
                        yAxisID: 'y',
                    },
                    {
                        label: 'Contributors',
                        data: contributorsData,
                        type: 'line',
                        borderColor: 'rgba(255, 99, 132, 1)',
                        borderWidth: 2,
                        fill: false,
                        pointRadius: 5,
                        pointBackgroundColor: 'rgba(255, 99, 132, 1)',
                        yAxisID: 'y1',
                    },
                ],
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            font: {
                                size: 12,
                            },
                        },
                    },
                    title: {
                        display: true,
                        text: 'Historical Workload Comparison',
                        font: {
                            size: 14,
                        },
                    },
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Hours',
                        },
                        min: 0,
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Contributors',
                        },
                        min: 0,
                        grid: {
                            drawOnChartArea: false,
                        },
                    },
                },
            },
        };

        return this.chartJSNodeCanvas.renderToBuffer(configuration, 'image/png');
    }

    /**
     * Generate forecast chart (forecast line + confidence band)
     * @param {Object} data - { forecast: [{ month: '2026-06', forecast: 123, min: 50, max: 200 }, ...] }
     * @returns {Promise<Buffer>} PNG image buffer
     */
    async generateForecastChart(data) {
        // Accept multiple possible shapes from reporting service:
        // - { forecast: [ { month, forecast, min, max } ] }
        // - { forecast: { monthly_forecast: [ { month, predicted_hours, lower_bound, upper_bound } ] } }
        // - { monthly_forecast: [ ... ] }
        let rawEntries = [];
        if (Array.isArray(data.forecast)) {
            rawEntries = data.forecast;
        } else if (data && data.forecast && Array.isArray(data.forecast.monthly_forecast)) {
            rawEntries = data.forecast.monthly_forecast;
        } else if (Array.isArray(data.monthly_forecast)) {
            rawEntries = data.monthly_forecast;
        }

        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
            throw new Error('Data with forecast array is required');
        }

        const forecastEntries = rawEntries.map((it) => ({
            month: it.month || it.period || it.date || '',
            forecast: Number(it.forecast ?? it.predicted_hours ?? it.predicted ?? it.value ?? 0),
            min: Number(it.min ?? it.lower_bound ?? it.min_pred ?? 0),
            max: Number(it.max ?? it.upper_bound ?? it.max_pred ?? 0),
        }));

        const monthShortNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        const labels = forecastEntries.map((it) => {
            const period = String(it.month || it.period || '') || '';
            // expect YYYY-MM or YYYY-MM-DD
            const parts = period.split('-');
            if (parts.length >= 2) {
                const year = parts[0];
                const month = Number(parts[1]);
                const short = monthShortNames[(month - 1) % 12] || parts[1];
                return `${short} ${year}`;
            }
            return period;
        });

        const forecastData = forecastEntries.map((it) => Number(it.forecast || 0));
        const minData = forecastEntries.map((it) => Number(it.min || 0));
        const maxData = forecastEntries.map((it) => Number(it.max || 0));

        // Calculate Y-axis bounds based on forecast data range with padding
        const dataMin = Math.min(...forecastData);
        const dataMax = Math.max(...forecastData);
        const dataRange = dataMax - dataMin;
        const padding = Math.max(dataRange * 0.1, 10); // 10% padding or minimum 10 hours
        const yAxisMin = Math.max(0, dataMin - padding);
        const yAxisMax = dataMax + padding;

        const configuration = {
            type: 'line',
            data: {
                labels,
                datasets: [
                    // forecast line only (no range band)
                    {
                        label: 'Forecast',
                        data: forecastData,
                        borderColor: 'rgba(54, 162, 235, 1)',
                        backgroundColor: 'rgba(54, 162, 235, 0.05)',
                        borderWidth: 2,
                        tension: 0.36,
                        pointRadius: 3,
                        pointBackgroundColor: 'rgba(54,162,235,1)',
                        fill: false,
                    },
                ],
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true,
                        text: 'Forecast',
                        font: { size: 14 },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            maxRotation: 45,
                            minRotation: 45,
                            font: { size: 10 },
                        },
                        grid: { display: false },
                    },
                    y: {
                        min: yAxisMin,
                        max: yAxisMax,
                        grid: { color: 'rgba(0,0,0,0.06)' },
                        title: { display: true, text: 'Hours' },
                    },
                },
            },
        };

        return this.chartJSNodeCanvas.renderToBuffer(configuration, 'image/png');
    }

    /**
     * Generate chart for full monthly historical workload.
     * @param {Object} data - Report data from getFullHistoricalWorkload
     * @returns {Promise<Buffer>} PNG image buffer
     */
    async generateFullHistoryChart(data) {
        if (!data || !Array.isArray(data.monthly_periods)) {
            throw new Error('Data with monthly_periods is required');
        }

        const monthlyPeriods = data.monthly_periods;
        const labels = monthlyPeriods.map((item) => String(item.period || 'unknown'));
        const hoursData = monthlyPeriods.map((item) => Number(item.total_hours || 0));
        const contributorsData = monthlyPeriods.map((item) => Number(item.active_users || 0));

        const monthShortNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        const configuration = {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Hours',
                        data: hoursData,
                        backgroundColor: 'rgba(54, 162, 235, 0.7)',
                        borderColor: 'rgba(54, 162, 235, 1)',
                        borderWidth: 1,
                        yAxisID: 'y',
                    },
                    {
                        label: 'Contributors',
                        data: contributorsData,
                        type: 'line',
                        borderColor: 'rgba(255, 99, 132, 1)',
                        borderWidth: 2,
                        fill: false,
                        pointRadius: 2,
                        pointBackgroundColor: 'rgba(255, 99, 132, 1)',
                        yAxisID: 'y1',
                    },
                ],
            },
            options: {
                responsive: false,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Full Monthly Worklog History',
                        font: {
                            size: 14,
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            autoSkip: false,
                            maxRotation: 45,
                            minRotation: 45,
                            align: 'end',
                            padding: 6,
                            font: {
                                size: 10,
                            },
                            callback: function (value, index, values) {
                                try {
                                    const label = this.getLabelForValue ? this.getLabelForValue(value) : labels[value] || labels[index] || String(value);
                                    const parts = String(label).split('-');
                                    if (parts.length === 2) {
                                        const y = parts[0];
                                        const m = Number(parts[1]);
                                        const monthName = monthShortNames[(m - 1) % 12];
                                        return `${monthName} ${y}`;
                                    }
                                    return label;
                                } catch (e) {
                                    return labels[index] || String(value);
                                }
                            },
                        },
                        grid: {
                            display: false,
                        },
                        ticksAutoSkip: false,
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Hours',
                        },
                        min: 0,
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Contributors',
                        },
                        min: 0,
                        grid: {
                            drawOnChartArea: false,
                        },
                    },
                },
            },
        };

        return this.chartJSNodeCanvas.renderToBuffer(configuration, 'image/png');
    }
}

module.exports = new ChartGeneratorService();
