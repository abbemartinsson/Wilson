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
