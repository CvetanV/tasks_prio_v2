/* ==========================================================================
   PRIOTASK V2 - PREMIUM CLIENT-SIDE LOGIC & INTEGRATIONS
   ========================================================================== */

// 1. CONSTANTS & DEFAULT STATE
const PRIORITIZED_GROUPS = ["Home", "Work", "Work Client", "Personal", "Wife", "Son", "Parents", "Auto", "PComp"];
const PRIORITIZED_STATUSES = ["To Do", "In Progress", "Done", "Blocked", "Abandoned"];

// Current state
let tasks = [];
let activeTab = 'dashboard';
let charts = {};
let activeTimerInterval = null;

// Neon DB connection parameters
// Priority: 1. Build-time injection from GitHub Secrets (config.js)
//           2. Manual override saved in localStorage
let neonConnectionString = '';
let neonSourceMode = 'none'; // 'build', 'manual', or 'none'
let isNeonConnected = false;

// Resolve connection string source
function resolveNeonConnectionString() {
    // Check if user explicitly disconnected (manual fallback override)
    if (localStorage.getItem('neon_disconnected') === 'true') {
        neonConnectionString = '';
        neonSourceMode = 'none';
        return;
    }

    // Check build-time config first (injected by GitHub Actions from Secrets)
    if (window.__NEON_CONFIG__ && window.__NEON_CONFIG__.connectionString) {
        neonConnectionString = window.__NEON_CONFIG__.connectionString;
        neonSourceMode = 'build';
        return;
    }
    // Fall back to localStorage (manual Settings page input)
    const stored = localStorage.getItem('NEON_CONNECTION_STRING');
    if (stored) {
        neonConnectionString = stored;
        neonSourceMode = 'manual';
        return;
    }
    neonConnectionString = '';
    neonSourceMode = 'none';
}

// 2. DOM ELEMENTS
const dom = {
    navButtons: document.querySelectorAll('.nav-btn'),
    pageSections: document.querySelectorAll('.page-section'),
    pageTitle: document.getElementById('page-title'),
    pageSubtitle: document.getElementById('page-subtitle'),

    // Quick Add & Modals
    btnQuickAdd: document.getElementById('btn-quick-add'),
    taskModal: document.getElementById('task-modal'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCancelTask: document.getElementById('btn-cancel-task'),
    taskForm: document.getElementById('task-form'),

    // Form Inputs
    taskId: document.getElementById('task-id'),
    taskTitle: document.getElementById('task-title'),
    taskGroup: document.getElementById('task-group'),
    taskStatus: document.getElementById('task-status'),
    taskGrade: document.getElementById('task-grade'),
    taskDue: document.getElementById('task-due'),
    taskTime: document.getElementById('task-time'),
    taskImpact: document.getElementById('task-impact'),
    taskDeps: document.getElementById('task-deps'),
    taskNotes: document.getElementById('task-notes'),
    modalTitle: document.getElementById('modal-title'),

    // Metrics
    metricTotal: document.getElementById('metric-total'),
    metricDone: document.getElementById('metric-done'),
    metricProgress: document.getElementById('metric-progress'),
    metricBlocked: document.getElementById('metric-blocked'),

    // Kanban Filters
    filterGroup: document.getElementById('filter-group-select'),
    filterGrade: document.getElementById('filter-grade-select'),
    searchTasks: document.getElementById('search-tasks'),
    btnClearFilters: document.getElementById('btn-clear-filters'),
    kanbanContainer: document.getElementById('kanban-board-container'),

    // Timeline & Dependencies
    ganttContainer: document.getElementById('gantt-timeline-container'),
    canvas: document.getElementById('dependency-canvas'),
    showIsolatedTasks: document.getElementById('show-isolated-tasks'),

    // CSV / Sync
    csvDropZone: document.getElementById('csv-drop-zone'),
    csvFileInput: document.getElementById('csv-file-input'),
    importPreview: document.getElementById('import-preview-container'),
    previewFileName: document.getElementById('preview-file-name'),
    previewRowCount: document.getElementById('preview-row-count'),
    btnConfirmImport: document.getElementById('btn-confirm-import'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnExportJson: document.getElementById('btn-export-json'),

    // Settings
    neonForm: document.getElementById('neon-settings-form'),
    neonConnStringInput: document.getElementById('neon-conn-string'),
    btnTestNeon: document.getElementById('btn-test-neon'),
    btnSaveNeon: document.getElementById('btn-save-neon'),
    btnDisconnectNeon: document.getElementById('btn-disconnect-neon'),
    neonFeedback: document.getElementById('neon-conn-feedback'),
    dbIndicator: document.getElementById('db-status-indicator'),
    btnArchiveTasks: document.getElementById('btn-archive-tasks'),
    btnClearAll: document.getElementById('btn-clear-all-tasks'),
    buildConfigBanner: document.getElementById('build-config-banner')
};

// 3. NEON DB CLIENT LAYER
/**
 * Run a query directly on Neon DB using their serverless HTTP SQL endpoint.
 */
async function queryNeon(sql, params = []) {
    if (!neonConnectionString) throw new Error("No Neon connection string provided.");

    // Parse host from connection string
    const hostMatch = neonConnectionString.match(/@([^/\s?]+)/);
    if (!hostMatch) throw new Error("Invalid connection string format.");
    const dbHost = hostMatch[1];

    const url = `https://${dbHost}/sql`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Neon-Connection-String': neonConnectionString,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query: sql,
            params: params
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Database query failed.");
    }

    const data = await response.json();
    return data;
}

/**
 * Ensures schema exists in Neon DB and migrations are run.
 */
async function initializeNeonSchema() {
    try {
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS prioritized_tasks (
                id VARCHAR(36) PRIMARY KEY,
                title TEXT NOT NULL,
                group_name VARCHAR(32) NOT NULL,
                time_estimate TEXT,
                value_impact TEXT,
                priority_grade VARCHAR(32),
                notes TEXT,
                status VARCHAR(32) NOT NULL,
                depends_on TEXT,
                due_date DATE,
                actual_minutes INTEGER DEFAULT 0,
                is_running BOOLEAN DEFAULT FALSE,
                timer_start_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await queryNeon(createTableSql);
        return true;
    } catch (e) {
        console.error("Neon init error:", e);
        return false;
    }
}

/**
 * Loads tasks either from Neon DB or falls back to localStorage
 */
async function loadTasks() {
    if (neonConnectionString) {
        try {
            updateDbIndicator(true, "Connecting...");

            // Ensure schema tables exist on the database
            await initializeNeonSchema();

            const result = await queryNeon("SELECT * FROM prioritized_tasks ORDER BY created_at DESC;");

            // Map rows back to objects
            if (result && result.rows) {
                tasks = result.rows.map(row => ({
                    id: row.id,
                    title: row.title,
                    group_name: row.group_name,
                    time_estimate: row.time_estimate || '',
                    value_impact: row.value_impact || '',
                    priority_grade: row.priority_grade || '',
                    notes: row.notes || '',
                    status: row.status,
                    depends_on: row.depends_on || '',
                    due_date: row.due_date ? row.due_date.substring(0, 10) : null,
                    actual_minutes: parseInt(row.actual_minutes) || 0,
                    is_running: row.is_running === true || row.is_running === 1 || row.is_running === 'true',
                    timer_start_at: row.timer_start_at ? new Date(row.timer_start_at) : null,
                    created_at: new Date(row.created_at),
                    updated_at: new Date(row.updated_at)
                }));
            }

            isNeonConnected = true;
            updateDbIndicator(true, "Neon Connected");
            localStorage.setItem('local_tasks_backup', JSON.stringify(tasks)); // Keep local backup
        } catch (e) {
            console.error("Failed to load from Neon DB, falling back to local storage:", e);
            showFeedback("Neon connection failed. Showing local backup.", "error");
            isNeonConnected = false;
            updateDbIndicator(false, "Neon Offline (Fallback)");
            loadLocalTasks();
        }
    } else {
        isNeonConnected = false;
        updateDbIndicator(false, "Local Storage");
        loadLocalTasks();
    }

    // Global render trigger
    renderApp();
}

function loadLocalTasks() {
    const raw = localStorage.getItem('tasks');
    if (raw) {
        tasks = JSON.parse(raw).map(t => ({
            ...t,
            timer_start_at: t.timer_start_at ? new Date(t.timer_start_at) : null,
            created_at: new Date(t.created_at),
            updated_at: new Date(t.updated_at)
        }));
    } else {
        tasks = [];
    }
}

/**
 * Saves task database changes
 */
async function saveTask(task, isNew = false) {
    task.updated_at = new Date();

    if (isNeonConnected) {
        try {
            if (isNew) {
                const sql = `
                    INSERT INTO prioritized_tasks 
                    (id, title, group_name, time_estimate, value_impact, priority_grade, notes, status, depends_on, due_date, actual_minutes, is_running, timer_start_at, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);
                `;
                await queryNeon(sql, [
                    task.id, task.title, task.group_name, task.time_estimate, task.value_impact,
                    task.priority_grade, task.notes, task.status, task.depends_on, task.due_date,
                    task.actual_minutes, task.is_running, task.timer_start_at, task.created_at, task.updated_at
                ]);
            } else {
                const sql = `
                    UPDATE prioritized_tasks SET
                    title = $1, group_name = $2, time_estimate = $3, value_impact = $4, priority_grade = $5,
                    notes = $6, status = $7, depends_on = $8, due_date = $9, actual_minutes = $10,
                    is_running = $11, timer_start_at = $12, updated_at = $13
                    WHERE id = $14;
                `;
                await queryNeon(sql, [
                    task.title, task.group_name, task.time_estimate, task.value_impact, task.priority_grade,
                    task.notes, task.status, task.depends_on, task.due_date, task.actual_minutes,
                    task.is_running, task.timer_start_at, task.updated_at, task.id
                ]);
            }
        } catch (e) {
            console.error("Error saving to Neon, syncing locally:", e);
            showFeedback("Neon sync failed! Saved locally.", "error");
        }
    }

    // Always sync locally
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
        tasks[idx] = task;
    } else {
        tasks.push(task);
    }
    localStorage.setItem('tasks', JSON.stringify(tasks));

    renderApp();
}

/**
 * Deletes a task
 */
async function deleteTask(id) {
    if (isNeonConnected) {
        try {
            await queryNeon("DELETE FROM prioritized_tasks WHERE id = $1;", [id]);
        } catch (e) {
            console.error("Error deleting from Neon:", e);
            showFeedback("Neon delete failed!", "error");
        }
    }

    tasks = tasks.filter(t => t.id !== id);
    localStorage.setItem('tasks', JSON.stringify(tasks));
    renderApp();
}

function updateDbIndicator(neon, textVal) {
    dom.dbIndicator.className = `status-indicator ${neon ? 'neon' : 'local'}`;
    dom.dbIndicator.querySelector('.status-text').textContent = textVal;
    if (neon) {
        dom.btnDisconnectNeon.classList.remove('hidden');
    } else {
        dom.btnDisconnectNeon.classList.add('hidden');
    }
}

// 4. UI TAB NAVIGATION
function switchTab(tabId) {
    activeTab = tabId;

    dom.navButtons.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    dom.pageSections.forEach(section => {
        section.classList.toggle('active', section.id === `page-${tabId}`);
    });

    // Set titles
    const titles = {
        dashboard: ["Dashboard", "Visual overview of your task prioritization statistics"],
        kanban: ["Kanban Agile Board", "Drag and drop tasks between columns to manage progress"],
        timeline: ["Timeline View", "Project roadmap and deadline schedules"],
        dependencies: ["Dependency Map", "Visualize how tasks relate to each other"],
        sync: ["Import / Export Tasks", "Sync data with files and backup configurations"],
        settings: ["System Settings", "Configure databases, clean ups, and connection profiles"]
    };

    dom.pageTitle.textContent = titles[tabId][0];
    dom.pageSubtitle.textContent = titles[tabId][1];

    // Trigger tab-specific renders
    if (tabId === 'dashboard') {
        setTimeout(renderDashboardCharts, 50);
    } else if (tabId === 'kanban') {
        renderKanban();
    } else if (tabId === 'timeline') {
        renderTimeline();
    } else if (tabId === 'dependencies') {
        initDependencyCanvas();
    }
}

// 5. DASHBOARD CHARTS (APEXCHARTS)
function renderDashboardCharts() {
    if (tasks.length === 0) return;

    // Destroy previous chart instances
    Object.keys(charts).forEach(c => {
        if (charts[c] && typeof charts[c].destroy === 'function') charts[c].destroy();
    });

    // Chart 1: Tasks by Group
    const groupCounts = {};
    PRIORITIZED_GROUPS.forEach(g => groupCounts[g] = 0);
    tasks.forEach(t => {
        if (groupCounts[t.group_name] !== undefined) groupCounts[t.group_name]++;
    });

    const groupSeries = Object.values(groupCounts);
    const groupLabels = Object.keys(groupCounts);

    charts.group = new ApexCharts(document.querySelector("#chart-group"), {
        series: [{ data: groupSeries }],
        chart: { type: 'bar', height: 320, toolbar: { show: false } },
        colors: ['#6366f1'],
        plotOptions: { bar: { borderRadius: 4, horizontal: true } },
        xaxis: { categories: groupLabels, labels: { style: { colors: '#9ca3af' } } },
        yaxis: { labels: { style: { colors: '#9ca3af' } } },
        grid: { borderColor: 'rgba(255,255,255,0.05)' }
    });
    charts.group.render();

    // Chart 2: Tasks by Priority Grade
    const priorityCounts = { "A - Critical": 0, "B - Important": 0, "C - Medium": 0, "D - Low": 0 };
    tasks.forEach(t => {
        if (priorityCounts[t.priority_grade] !== undefined) priorityCounts[t.priority_grade]++;
    });

    charts.priority = new ApexCharts(document.querySelector("#chart-priority"), {
        series: Object.values(priorityCounts),
        chart: { type: 'donut', height: 320 },
        labels: Object.keys(priorityCounts),
        colors: ['#ef4444', '#f59e0b', '#0ea5e9', '#9ca3af'],
        legend: { position: 'bottom', labels: { colors: '#9ca3af' } },
        stroke: { show: false }
    });
    charts.priority.render();

    // Chart 3: Stacked Status per Group
    const statusGroupData = {};
    PRIORITIZED_GROUPS.forEach(g => {
        statusGroupData[g] = {};
        PRIORITIZED_STATUSES.forEach(s => statusGroupData[g][s] = 0);
    });

    tasks.forEach(t => {
        if (statusGroupData[t.group_name] && statusGroupData[t.group_name][t.status] !== undefined) {
            statusGroupData[t.group_name][t.status]++;
        }
    });

    const stackedSeries = PRIORITIZED_STATUSES.map(status => {
        return {
            name: status,
            data: PRIORITIZED_GROUPS.map(g => statusGroupData[g][status])
        };
    });

    charts.statusGroup = new ApexCharts(document.querySelector("#chart-status-group"), {
        series: stackedSeries,
        chart: { type: 'bar', height: 320, stacked: true, toolbar: { show: false } },
        xaxis: { categories: PRIORITIZED_GROUPS, labels: { style: { colors: '#9ca3af' } } },
        yaxis: { labels: { style: { colors: '#9ca3af' } } },
        legend: { labels: { colors: '#9ca3af' } },
        colors: ['#6b7280', '#0ea5e9', '#10b981', '#ef4444', '#9ca3af'], // Grey, Sky, Emerald, Red, Slate
        grid: { borderColor: 'rgba(255,255,255,0.05)' }
    });
    charts.statusGroup.render();
}

// 6. GLOBAL METRICS RENDER
function renderMetrics() {
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'Done').length;
    const progress = tasks.filter(t => t.status === 'In Progress').length;
    const blocked = tasks.filter(t => t.status === 'Blocked').length;

    dom.metricTotal.textContent = total;
    dom.metricDone.textContent = done;
    dom.metricProgress.textContent = progress;
    dom.metricBlocked.textContent = blocked;
}

// 7. KANBAN BOARD SYSTEM
function renderKanban() {
    dom.kanbanContainer.innerHTML = '';

    // Filters logic
    const selectedGroups = Array.from(dom.filterGroup.selectedOptions).map(o => o.value);
    const selectedGrades = Array.from(dom.filterGrade.selectedOptions).map(o => o.value);
    const searchQuery = dom.searchTasks.value.toLowerCase().trim();

    let filtered = tasks;
    if (selectedGroups.length > 0) {
        filtered = filtered.filter(t => selectedGroups.includes(t.group_name));
    }
    if (selectedGrades.length > 0) {
        filtered = filtered.filter(t => selectedGrades.includes(t.priority_grade));
    }
    if (searchQuery) {
        filtered = filtered.filter(t =>
            t.title.toLowerCase().includes(searchQuery) ||
            t.notes.toLowerCase().includes(searchQuery)
        );
    }

    // Draw columns
    PRIORITIZED_STATUSES.forEach(status => {
        const columnTasks = filtered.filter(t => t.status === status);

        const colEl = document.createElement('div');
        colEl.className = 'kanban-column';
        colEl.innerHTML = `
            <div class="column-header">
                <h4>${status}</h4>
                <span class="task-count">${columnTasks.length}</span>
            </div>
            <div class="column-cards-container" data-status="${status}"></div>
        `;

        const cardsContainer = colEl.querySelector('.column-cards-container');

        // Populate tasks
        columnTasks.forEach(task => {
            const card = document.createElement('div');
            card.className = `task-card ${task.is_running ? 'running' : ''}`;
            card.draggable = true;
            card.dataset.id = task.id;

            // Format priority grade tags
            let gradeClass = '';
            if (task.priority_grade.startsWith("A")) gradeClass = 'grade-a';
            else if (task.priority_grade.startsWith("B")) gradeClass = 'grade-b';
            else if (task.priority_grade.startsWith("C")) gradeClass = 'grade-c';
            else if (task.priority_grade.startsWith("D")) gradeClass = 'grade-d';

            const timerStateIcon = task.is_running ? 'square' : 'play';
            const timerBtnClass = task.is_running ? 'timer-btn active' : 'timer-btn';

            card.innerHTML = `
                <div class="card-tags">
                    <span class="card-tag group">${task.group_name}</span>
                    ${task.priority_grade ? `<span class="card-tag ${gradeClass}">${task.priority_grade.split(' ')[0]}</span>` : ''}
                </div>
                <h5>${escapeHTML(task.title)}</h5>
                <div class="card-details">
                    ${task.due_date ? `<div class="card-detail-item"><i data-lucide="calendar"></i><span>${task.due_date}</span></div>` : ''}
                    ${task.time_estimate ? `<div class="card-detail-item"><i data-lucide="clock"></i><span>Est: ${task.time_estimate}</span></div>` : ''}
                </div>
                ${task.notes ? `<div class="card-notes-preview">${escapeHTML(task.notes)}</div>` : ''}
                <div class="card-footer">
                    <div class="timer-controls">
                        <button class="${timerBtnClass}" data-action="toggle-timer" title="Start Timer">
                            <i data-lucide="${timerStateIcon}"></i>
                        </button>
                        <span class="timer-display">${task.actual_minutes}m</span>
                    </div>
                    <div class="card-actions">
                        <button class="card-action-btn edit" data-action="edit-task" title="Edit Card">
                            <i data-lucide="edit-3"></i>
                        </button>
                        <button class="card-action-btn delete" data-action="delete-task" title="Delete Card">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </div>
            `;

            // Event Listeners for actions
            card.querySelector('[data-action="toggle-timer"]').addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTaskTimer(task.id);
            });
            card.querySelector('.card-action-btn.edit').addEventListener('click', (e) => {
                e.stopPropagation();
                openTaskModal(task.id);
            });
            card.querySelector('.card-action-btn.delete').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Delete "${task.title}"?`)) {
                    deleteTask(task.id);
                }
            });

            // Drag-and-drop triggers
            card.addEventListener('dragstart', () => card.classList.add('dragging'));
            card.addEventListener('dragend', () => card.classList.remove('dragging'));

            cardsContainer.appendChild(card);
        });

        // Column drag over listener
        cardsContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingCard = document.querySelector('.dragging');
            if (draggingCard) {
                cardsContainer.appendChild(draggingCard);
            }
        });

        cardsContainer.addEventListener('drop', async () => {
            const draggingCard = document.querySelector('.dragging');
            if (draggingCard) {
                const taskId = draggingCard.dataset.id;
                const newStatus = cardsContainer.dataset.status;
                const task = tasks.find(t => t.id === taskId);

                if (task && task.status !== newStatus) {
                    task.status = newStatus;
                    await saveTask(task);
                    renderMetrics();
                }
            }
        });

        dom.kanbanContainer.appendChild(colEl);
    });

    lucide.createIcons();
}

// Helper to escape HTML characters
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

// 8. STOPWATCH/TIMER FUNCTIONALITY
async function toggleTaskTimer(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    const now = new Date();

    if (task.is_running) {
        // Stop the timer
        const elapsedMs = now - new Date(task.timer_start_at);
        const elapsedMins = Math.max(1, Math.round(elapsedMs / 1000 / 60));
        task.actual_minutes = (task.actual_minutes || 0) + elapsedMins;
        task.is_running = false;
        task.timer_start_at = null;
    } else {
        // Start the timer (first ensure no other task is running)
        tasks.forEach(t => {
            if (t.is_running && t.id !== id) {
                // stop it
                const elMs = now - new Date(t.timer_start_at);
                const elMins = Math.max(1, Math.round(elMs / 1000 / 60));
                t.actual_minutes = (t.actual_minutes || 0) + elMins;
                t.is_running = false;
                t.timer_start_at = null;
                saveTask(t);
            }
        });

        task.is_running = true;
        task.timer_start_at = now;
    }

    await saveTask(task);
}

function startTimerPolling() {
    if (activeTimerInterval) clearInterval(activeTimerInterval);

    activeTimerInterval = setInterval(() => {
        // Find if any task is running
        const runningTask = tasks.find(t => t.is_running);
        if (runningTask && activeTab === 'kanban') {
            const cardEl = document.querySelector(`.task-card.running[data-id="${runningTask.id}"]`);
            if (cardEl) {
                const now = new Date();
                const diffMs = now - new Date(runningTask.timer_start_at);
                const currentSessionMins = Math.floor(diffMs / 1000 / 60);
                const totalMins = (runningTask.actual_minutes || 0) + currentSessionMins;
                cardEl.querySelector('.timer-display').textContent = `${totalMins}m`;
            }
        }
    }, 10000); // Poll every 10 seconds
}

// 9. TIMELINE VIEW (GANTT CHART VIA SVG)
function renderTimeline() {
    dom.ganttContainer.innerHTML = '';

    const datetasks = tasks.filter(t => t.due_date);
    if (datetasks.length === 0) {
        dom.ganttContainer.innerHTML = `<div class="info-text">No tasks with due dates found. Add due dates to visualize your project schedule.</div>`;
        return;
    }

    // Sort tasks by due date
    datetasks.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    // Calculate dates range
    const dates = datetasks.map(t => new Date(t.due_date));
    const minDate = new Date(Math.min(...dates));
    minDate.setDate(minDate.getDate() - 5); // Pad start
    const maxDate = new Date(Math.max(...dates));
    maxDate.setDate(maxDate.getDate() + 10); // Pad end

    const daySpan = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24));

    // Dimensions
    const rowHeight = 44;
    const headerHeight = 50;
    const dayWidth = 40;
    const taskColWidth = 180;
    const chartWidth = taskColWidth + (daySpan * dayWidth);
    const chartHeight = headerHeight + (datetasks.length * rowHeight);

    let svgHtml = `<svg width="${chartWidth}" height="${chartHeight}" class="gantt-svg">`;

    // Header Grid Lines & Labels
    let curDate = new Date(minDate);
    for (let i = 0; i <= daySpan; i++) {
        const x = taskColWidth + (i * dayWidth);
        const isToday = curDate.toDateString() === new Date().toDateString();

        // vertical grid lines
        svgHtml += `<line class="gantt-grid-line ${isToday ? 'gantt-today-line' : ''}" x1="${x}" y1="0" x2="${x}" y2="${chartHeight}" />`;

        // headers
        if (i < daySpan) {
            const label = `${curDate.getDate()}/${curDate.getMonth() + 1}`;
            svgHtml += `<text class="gantt-text" x="${x + 6}" y="28" fill="#9ca3af" font-size="10">${label}</text>`;
        }

        curDate.setDate(curDate.getDate() + 1);
    }

    // Render row bounds
    svgHtml += `<line class="gantt-grid-line" x1="${taskColWidth}" y1="${headerHeight}" x2="${chartWidth}" y2="${headerHeight}" />`;

    // Render Tasks
    datetasks.forEach((task, index) => {
        const y = headerHeight + (index * rowHeight) + 8;
        const taskDue = new Date(task.due_date);

        // Calculate position relative to timeline
        const daysFromMin = Math.ceil((taskDue - minDate) / (1000 * 60 * 60 * 24));
        const barWidth = dayWidth * 3; // default length
        const x = taskColWidth + ((daysFromMin - 2) * dayWidth); // align ending to date

        // Status color mapping
        const statusColors = {
            "Done": "#10b981",
            "In Progress": "#0ea5e9",
            "To Do": "#6b7280",
            "Blocked": "#ef4444",
            "Abandoned": "#4b5563"
        };
        const barColor = statusColors[task.status] || '#6366f1';

        // Task Title left text
        svgHtml += `<text class="gantt-text" x="16" y="${y + 18}" fill="#f3f4f6" font-weight="600" font-family="'Outfit'">${escapeHTML(task.title.length > 20 ? task.title.substring(0, 18) + '...' : task.title)}</text>`;

        // Horizontal line separator
        svgHtml += `<line class="gantt-grid-line" x1="0" y1="${y + 30}" x2="${chartWidth}" y2="${y + 30}" />`;

        // Gantt Bar
        svgHtml += `<rect class="gantt-task-bar" x="${x}" y="${y}" width="${barWidth}" height="24" fill="${barColor}" rx="4" ry="4" onclick="window.openTaskModal('${task.id}')" />`;
        svgHtml += `<text class="gantt-text" x="${x + 8}" y="${y + 16}" fill="#ffffff" font-size="10" pointer-events="none">${task.priority_grade ? task.priority_grade.split(' ')[0] : ''}</text>`;
    });

    // Left boundary line
    svgHtml += `<line class="gantt-grid-line" x1="${taskColWidth}" y1="0" x2="${taskColWidth}" y2="${chartHeight}" />`;
    svgHtml += `</svg>`;

    dom.ganttContainer.innerHTML = svgHtml;
}

// 10. INTERACTIVE DEPENDENCY VISUALIZATION (CANVAS SPRING LAYOUT)
let nodes = [];
let links = [];
let draggingNode = null;
let hoverNode = null;
let transform = { x: 0, y: 0, scale: 1 };
let dragStartPos = { x: 0, y: 0 };
let isPanning = false;

function initDependencyCanvas() {
    const canvas = dom.canvas;
    const ctx = canvas.getContext('2d');

    // Set internal size
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = 550;

    const showAll = dom.showIsolatedTasks.checked;

    // Parse tasks into nodes & links
    nodes = [];
    links = [];

    const hasDeps = t => t.depends_on && t.depends_on.trim().length > 0;
    const depIds = new Set();

    tasks.forEach(t => {
        if (hasDeps(t)) {
            depIds.add(t.id);
            t.depends_on.split(',').forEach(id => depIds.add(id.trim()));
        }
    });

    // Filter tasks
    const relevantTasks = showAll ? tasks : tasks.filter(t => depIds.has(t.id));

    // Setup nodes
    relevantTasks.forEach((t, i) => {
        // Random layout positions
        nodes.push({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority_grade || '',
            x: canvas.width / 2 + (Math.random() - 0.5) * 400,
            y: canvas.height / 2 + (Math.random() - 0.5) * 300,
            vx: 0,
            vy: 0,
            radius: 20
        });
    });

    // Setup links
    relevantTasks.forEach(t => {
        if (hasDeps(t)) {
            t.depends_on.split(',').forEach(depId => {
                const source = depId.trim();
                const target = t.id;

                if (nodes.find(n => n.id === source) && nodes.find(n => n.id === target)) {
                    links.push({ source, target });
                }
            });
        }
    });

    // Event listeners for Canvas
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseup', onCanvasMouseUp);
    canvas.addEventListener('wheel', onCanvasWheel);

    // Start animation loop
    requestAnimationFrame(updateDependencyGraph);
}

function updateDependencyGraph() {
    if (activeTab !== 'dependencies') return;

    const canvas = dom.canvas;
    const ctx = canvas.getContext('2d');

    // Physics Simulation (Basic Spring Force Layout)
    const k = 0.05; // spring constant
    const repel = 800; // charge force
    const damping = 0.85;

    // 1. Repel forces between all nodes
    for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
            const n2 = nodes[j];
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;

            if (dist < 280) {
                const force = repel / (dist * dist);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;

                if (n1 !== draggingNode) { n1.vx -= fx; n1.vy -= fy; }
                if (n2 !== draggingNode) { n2.vx += fx; n2.vy += fy; }
            }
        }

        // Pull force towards center (keep cluster compact)
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const dx = cx - n1.x;
        const dy = cy - n1.y;
        n1.vx += dx * 0.001;
        n1.vy += dy * 0.001;
    }

    // 2. Spring forces along links
    links.forEach(link => {
        const source = nodes.find(n => n.id === link.source);
        const target = nodes.find(n => n.id === link.target);
        if (!source || !target) return;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const restLen = 120;
        const force = (dist - restLen) * k;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (source !== draggingNode) { source.vx += fx; source.vy += fy; }
        if (target !== draggingNode) { target.vx -= fx; target.vy -= fy; }
    });

    // Apply velocities
    nodes.forEach(node => {
        if (node !== draggingNode) {
            node.x += node.vx;
            node.y += node.vy;
            node.vx *= damping;
            node.vy *= damping;
        }
    });

    // Draw Graph
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    // Draw links
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 2;
    links.forEach(link => {
        const source = nodes.find(n => n.id === link.source);
        const target = nodes.find(n => n.id === link.target);
        if (!source || !target) return;

        // draw line
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();

        // draw arrow
        const angle = Math.atan2(target.y - source.y, target.x - source.x);
        const arrowSize = 8;
        const targetBorderX = target.x - Math.cos(angle) * target.radius;
        const targetBorderY = target.y - Math.sin(angle) * target.radius;

        ctx.fillStyle = '#6366f1';
        ctx.beginPath();
        ctx.moveTo(targetBorderX, targetBorderY);
        ctx.lineTo(targetBorderX - arrowSize * Math.cos(angle - Math.PI / 6), targetBorderY - arrowSize * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(targetBorderX - arrowSize * Math.cos(angle + Math.PI / 6), targetBorderY - arrowSize * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
    });

    // Draw nodes
    const colors = {
        "Done": "#10b981",
        "In Progress": "#0ea5e9",
        "To Do": "#6b7280",
        "Blocked": "#ef4444",
        "Abandoned": "#9ca3af"
    };

    nodes.forEach(node => {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
        ctx.fillStyle = colors[node.status] || '#6366f1';
        ctx.fill();
        ctx.strokeStyle = node === hoverNode ? '#ffffff' : 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = node === hoverNode ? 3 : 1.5;
        ctx.stroke();

        // Text label
        ctx.fillStyle = '#ffffff';
        ctx.font = "bold 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const shortTitle = node.title.length > 8 ? node.title.substring(0, 7) + '..' : node.title;
        ctx.fillText(shortTitle, node.x, node.y);
    });

    ctx.restore();

    // Render hover tooltip overlay
    if (hoverNode) {
        ctx.fillStyle = 'rgba(22, 28, 45, 0.95)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;

        const tooltipX = 16;
        const tooltipY = 16;

        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, 260, 90, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = "bold 13px Outfit, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(hoverNode.title.substring(0, 30) + (hoverNode.title.length > 30 ? '...' : ''), tooltipX + 12, tooltipY + 22);

        ctx.fillStyle = '#9ca3af';
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(`Status: ${hoverNode.status}`, tooltipX + 12, tooltipY + 45);
        ctx.fillText(`Priority: ${hoverNode.priority || 'N/A'}`, tooltipX + 12, tooltipY + 62);
        ctx.fillText("Double-click node to edit card details", tooltipX + 12, tooltipY + 78);
    }

    requestAnimationFrame(updateDependencyGraph);
}

function onCanvasMouseDown(e) {
    const pos = getMousePos(e);

    // Check if clicked node
    const clickedNode = nodes.find(node => {
        const dx = node.x - pos.x;
        const dy = node.y - pos.y;
        return Math.sqrt(dx * dx + dy * dy) < node.radius;
    });

    if (clickedNode) {
        draggingNode = clickedNode;
        draggingNode.x = pos.x;
        draggingNode.y = pos.y;
    } else {
        isPanning = true;
        dragStartPos = { x: e.clientX - transform.x, y: e.clientY - transform.y };
    }
}

function onCanvasMouseMove(e) {
    const pos = getMousePos(e);

    if (draggingNode) {
        draggingNode.x = pos.x;
        draggingNode.y = pos.y;
        draggingNode.vx = 0;
        draggingNode.vy = 0;
    } else if (isPanning) {
        transform.x = e.clientX - dragStartPos.x;
        transform.y = e.clientY - dragStartPos.y;
    } else {
        // Hover test
        hoverNode = nodes.find(node => {
            const dx = node.x - pos.x;
            const dy = node.y - pos.y;
            return Math.sqrt(dx * dx + dy * dy) < node.radius;
        }) || null;
    }
}

function onCanvasMouseUp(e) {
    if (draggingNode && e.detail === 2) {
        // Double click => edit task details
        openTaskModal(draggingNode.id);
    }
    draggingNode = null;
    isPanning = false;
}

function onCanvasWheel(e) {
    e.preventDefault();
    const zoomIntensity = 0.05;
    const mousePos = getMousePos(e);
    const zoom = e.deltaY < 0 ? (1 + zoomIntensity) : (1 - zoomIntensity);

    // Zoom around mouse
    transform.x = mousePos.x * (1 - zoom) + transform.x;
    transform.y = mousePos.y * (1 - zoom) + transform.y;
    transform.scale = Math.max(0.4, Math.min(2.5, transform.scale * zoom));
}

function getMousePos(e) {
    const rect = dom.canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Transform coordinates back to original scale/pan
    return {
        x: (clientX - transform.x) / transform.scale,
        y: (clientY - transform.y) / transform.scale
    };
}

// 11. MODAL TASK ACTIONS (NEW / EDIT)
function openTaskModal(id = null) {
    // Populate form dropdown choices
    dom.taskGroup.innerHTML = PRIORITIZED_GROUPS.map(g => `<option value="${g}">${g}</option>`).join('');
    dom.taskStatus.innerHTML = PRIORITIZED_STATUSES.map(s => `<option value="${s}">${s}</option>`).join('');

    // Populate depends_on multiselect
    const depOptions = tasks.filter(t => t.id !== id);
    dom.taskDeps.innerHTML = depOptions.map(t => `<option value="${t.id}">${escapeHTML(t.title)} (ID: ${t.id.substring(0, 8)})</option>`).join('');

    if (id) {
        // Edit Mode
        const task = tasks.find(t => t.id === id);
        if (!task) return;

        dom.modalTitle.textContent = "Edit Task";
        dom.taskId.value = task.id;
        dom.taskTitle.value = task.title;
        dom.taskGroup.value = task.group_name;
        dom.taskStatus.value = task.status;
        dom.taskGrade.value = task.priority_grade || "B - Important";
        dom.taskDue.value = task.due_date || '';
        dom.taskTime.value = task.time_estimate || '';
        dom.taskImpact.value = task.value_impact || '';
        dom.taskNotes.value = task.notes || '';

        // Select dependencies
        if (task.depends_on) {
            const deps = task.depends_on.split(',').map(d => d.trim());
            Array.from(dom.taskDeps.options).forEach(opt => {
                opt.selected = deps.includes(opt.value);
            });
        }
    } else {
        // Add Mode
        dom.modalTitle.textContent = "Create New Task";
        dom.taskId.value = '';
        dom.taskForm.reset();
        dom.taskStatus.value = "To Do"; // Default
    }

    dom.taskModal.classList.remove('hidden');
    lucide.createIcons();
}

function closeTaskModal() {
    dom.taskModal.classList.add('hidden');
    dom.taskForm.reset();
}

// 12. CSV IMPORT & EXPORT LOGIC
function setupCSVHandlers() {
    // Drop Zone events
    ['dragenter', 'dragover'].forEach(eventName => {
        dom.csvDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dom.csvDropZone.style.borderColor = 'var(--color-primary)';
            dom.csvDropZone.style.background = 'rgba(99, 102, 241, 0.05)';
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dom.csvDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dom.csvDropZone.style.borderColor = 'rgba(255, 255, 255, 0.15)';
            dom.csvDropZone.style.background = 'rgba(0, 0, 0, 0.1)';
        }, false);
    });

    dom.csvDropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (file) handleCSVFile(file);
    });

    dom.csvDropZone.addEventListener('click', () => dom.csvFileInput.click());
    dom.csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleCSVFile(file);
    });

    // Export actions
    dom.btnExportCsv.addEventListener('click', exportCSV);
    dom.btnExportJson.addEventListener('click', exportJSON);
}

let parsedCSVTasks = [];

function handleCSVFile(file) {
    if (!file.name.endsWith('.csv')) {
        alert("Please load a valid CSV file.");
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const text = e.target.result;
        try {
            parsedCSVTasks = parseCSV(text);

            dom.previewFileName.textContent = file.name;
            dom.previewRowCount.textContent = `${parsedCSVTasks.length} tasks parsed successfully!`;
            dom.importPreview.classList.remove('hidden');
        } catch (err) {
            alert(`Error parsing CSV: ${err.message}`);
        }
    };
    reader.readAsText(file);
}

function parseCSV(text) {
    const lines = [];
    let row = [""];
    let inQuotes = false;

    // Standard CSV parser (handles commas within quotes)
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (c === '"') {
            if (inQuotes && next === '"') { row[row.length - 1] += '"'; i++; } // Escaped Quote
            else { inQuotes = !inQuotes; }
        } else if (c === ',' && !inQuotes) {
            row.push('');
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
            if (c === '\r' && next === '\n') { i++; }
            lines.push(row);
            row = [''];
        } else {
            row[row.length - 1] += c;
        }
    }
    if (row.length > 1 || row[0] !== '') lines.push(row);
    if (lines.length < 2) throw new Error("Empty CSV or invalid headers.");

    const headers = lines[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

    // Column Index Mapping
    const mappings = {
        title: headers.findIndex(h => h === 'title' || h === 'task'),
        group_name: headers.findIndex(h => h === 'group_name' || h === 'group'),
        time_estimate: headers.findIndex(h => h === 'time_estimate' || h === 'time' || h === 'time_est'),
        value_impact: headers.findIndex(h => h === 'value_impact' || h === 'value'),
        priority_grade: headers.findIndex(h => h === 'priority_grade' || h === 'grade' || h === 'priority'),
        notes: headers.findIndex(h => h === 'notes'),
        status: headers.findIndex(h => h === 'status'),
        depends_on: headers.findIndex(h => h === 'depends_on'),
        due_date: headers.findIndex(h => h === 'due_date' || h === 'due')
    };

    if (mappings.title === -1) throw new Error("Missing 'Title' (or 'Task') column header.");
    if (mappings.group_name === -1) throw new Error("Missing 'Group_Name' (or 'Group') column header.");
    if (mappings.status === -1) throw new Error("Missing 'Status' column header.");

    const output = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length <= 1 && line[0] === '') continue; // Skip empty rows

        const getVal = (idx) => (idx !== -1 && line[idx] !== undefined) ? line[idx].trim() : '';

        const title = getVal(mappings.title);
        const rawGroup = getVal(mappings.group_name);
        const rawStatus = getVal(mappings.status);

        if (!title || !rawGroup || !rawStatus) continue; // Basic validation

        // Normalize values
        const group_name = PRIORITIZED_GROUPS.includes(rawGroup) ? rawGroup : PRIORITIZED_GROUPS[0];
        const status = PRIORITIZED_STATUSES.includes(rawStatus) ? rawStatus : PRIORITIZED_STATUSES[0];

        // Normalize priority grade
        let priority_grade = '';
        const rawGrade = getVal(mappings.priority_grade).toUpperCase();
        if (rawGrade.startsWith("A")) priority_grade = "A - Critical";
        else if (rawGrade.startsWith("B")) priority_grade = "B - Important";
        else if (rawGrade.startsWith("C")) priority_grade = "C - Medium";
        else if (rawGrade.startsWith("D")) priority_grade = "D - Low";
        else priority_grade = "B - Important";

        output.push({
            id: crypto.randomUUID(),
            title,
            group_name,
            status,
            priority_grade,
            time_estimate: getVal(mappings.time_estimate),
            value_impact: getVal(mappings.value_impact),
            notes: getVal(mappings.notes),
            depends_on: getVal(mappings.depends_on),
            due_date: getVal(mappings.due_date) || null,
            actual_minutes: 0,
            is_running: false,
            timer_start_at: null,
            created_at: new Date(),
            updated_at: new Date()
        });
    }

    return output;
}

async function confirmCSVImport() {
    if (parsedCSVTasks.length === 0) return;

    let imported = 0;
    for (const task of parsedCSVTasks) {
        await saveTask(task, true);
        imported++;
    }

    showFeedback(`Successfully imported ${imported} tasks!`, "success");
    dom.importPreview.classList.add('hidden');
    parsedCSVTasks = [];
    switchTab('kanban');
}

function exportCSV() {
    if (tasks.length === 0) {
        alert("No tasks available to export.");
        return;
    }

    const headers = [
        "id", "title", "group_name", "time_estimate", "value_impact",
        "priority_grade", "notes", "status", "depends_on", "due_date",
        "actual_minutes", "is_running", "timer_start_at", "created_at", "updated_at"
    ];

    let csvContent = headers.join(",") + "\n";

    tasks.forEach(t => {
        const row = headers.map(header => {
            let val = t[header];
            if (val === null || val === undefined) return '""';
            if (val instanceof Date) val = val.toISOString();

            // Escape double quotes & wraps
            let str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        });
        csvContent += row.join(",") + "\n";
    });

    triggerDownload(csvContent, "prioritized_tasks.csv", "text/csv");
}

function exportJSON() {
    if (tasks.length === 0) {
        alert("No tasks available to export.");
        return;
    }
    const jsonStr = JSON.stringify(tasks, null, 2);
    triggerDownload(jsonStr, "tasks_backup.json", "application/json");
}

function triggerDownload(content, fileName, contentType) {
    const a = document.createElement("a");
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
}

// 13. SETTINGS & CONFLICT RESOLUTION
function setupSettingsHandlers() {
    // Show/hide build-time config banner based on source mode
    if (neonSourceMode === 'build') {
        dom.buildConfigBanner.classList.remove('hidden');
        dom.neonConnStringInput.placeholder = "Auto-configured via GitHub Secrets (Active)";
        dom.neonConnStringInput.value = ''; // Let placeholder show
    } else {
        dom.buildConfigBanner.classList.add('hidden');
        dom.neonConnStringInput.placeholder = "postgres://user:password@ep-xxxx.neon.tech/neondb?sslmode=require";
        dom.neonConnStringInput.value = neonConnectionString;
    }

    dom.neonForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const connStr = dom.neonConnStringInput.value.trim();

        if (!connStr) {
            alert("Please input a connection string.");
            return;
        }

        dom.neonFeedback.textContent = "Connecting to Neon DB & creating schemas...";
        dom.neonFeedback.className = "conn-feedback";
        dom.neonFeedback.classList.remove('hidden');

        localStorage.removeItem('neon_disconnected'); // Clear any explicit disconnect override
        neonConnectionString = connStr;
        localStorage.setItem('NEON_CONNECTION_STRING', connStr);
        neonSourceMode = 'manual';

        const ok = await initializeNeonSchema();
        if (ok) {
            dom.neonFeedback.textContent = "Sync successful! Connected to Neon DB.";
            dom.neonFeedback.className = "conn-feedback success";
            await loadTasks();
        } else {
            dom.neonFeedback.textContent = "Connection failed. Please inspect your connection string parameters.";
            dom.neonFeedback.className = "conn-feedback error";
            neonConnectionString = '';
            localStorage.removeItem('NEON_CONNECTION_STRING');
            neonSourceMode = 'none';
            isNeonConnected = false;
        }
    });

    dom.btnTestNeon.addEventListener('click', async () => {
        const connStr = dom.neonConnStringInput.value.trim() || (neonSourceMode === 'build' ? neonConnectionString : '');
        if (!connStr) return alert("Connection URI is empty");

        dom.neonFeedback.textContent = "Testing direct TCP/HTTP tunnel...";
        dom.neonFeedback.className = "conn-feedback";
        dom.neonFeedback.classList.remove('hidden');

        const tempConn = neonConnectionString;
        neonConnectionString = connStr;
        try {
            await queryNeon("SELECT 1;");
            dom.neonFeedback.textContent = "Connection testing passed successfully!";
            dom.neonFeedback.className = "conn-feedback success";
        } catch (err) {
            dom.neonFeedback.textContent = `Test connection failed: ${err.message}`;
            dom.neonFeedback.className = "conn-feedback error";
        } finally {
            neonConnectionString = tempConn;
        }
    });



    dom.btnDisconnectNeon.addEventListener('click', () => {
        if (confirm("Disconnect database? Your local storage tasks will remain in the browser.")) {
            localStorage.setItem('neon_disconnected', 'true'); // Persist local override to stop auto-config
            neonConnectionString = '';
            localStorage.removeItem('NEON_CONNECTION_STRING');
            dom.neonConnStringInput.value = '';
            dom.neonConnStringInput.placeholder = "postgres://user:password@ep-xxxx.neon.tech/neondb?sslmode=require";
            isNeonConnected = false;
            neonSourceMode = 'none';
            dom.neonFeedback.classList.add('hidden');
            dom.buildConfigBanner.classList.add('hidden');
            loadTasks();
        }
    });

    dom.btnArchiveTasks.addEventListener('click', async () => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 14);

        const toArchive = tasks.filter(t =>
            (t.status === 'Done' || t.status === 'Abandoned') &&
            new Date(t.updated_at) < cutoff
        );

        if (toArchive.length === 0) {
            alert("No completed/abandoned tasks older than 14 days were found to archive.");
            return;
        }

        if (confirm(`Archive ${toArchive.length} tasks?`)) {
            let archived = 0;
            for (const t of toArchive) {
                await deleteTask(t.id);
                archived++;
            }
            alert(`Archived ${archived} tasks successfully.`);
            loadTasks();
        }
    });

    dom.btnClearAll.addEventListener('click', async () => {
        if (confirm("🚨 WARNING: Are you sure you want to delete ALL tasks permanently? This action is non-reversible!")) {
            if (isNeonConnected) {
                try {
                    await queryNeon("DELETE FROM prioritized_tasks;");
                } catch (e) {
                    console.error("Purging Neon failed:", e);
                }
            }
            tasks = [];
            localStorage.removeItem('tasks');
            alert("All task data purged.");
            loadTasks();
        }
    });
}

function showFeedback(text, type) {
    alert(text); // Simple for static build, can style custom toast later
}

// 14. GLOBAL INITIALIZATION
function setupGlobalEvents() {
    // Sidebar Tabs
    dom.navButtons.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });

    // Modal controls
    dom.btnQuickAdd.addEventListener('click', () => openTaskModal());
    dom.btnCloseModal.addEventListener('click', closeTaskModal);
    dom.btnCancelTask.addEventListener('click', closeTaskModal);

    // Multi-select for Filters
    dom.filterGroup.innerHTML = PRIORITIZED_GROUPS.map(g => `<option value="${g}">${g}</option>`).join('');

    // Filters triggers
    dom.filterGroup.addEventListener('change', renderKanban);
    dom.filterGrade.addEventListener('change', renderKanban);
    dom.searchTasks.addEventListener('input', renderKanban);
    dom.btnClearFilters.addEventListener('click', () => {
        dom.filterGroup.selectedIndex = -1;
        dom.filterGrade.selectedIndex = -1;
        dom.searchTasks.value = '';
        renderKanban();
    });

    // Task modal submit
    dom.taskForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const id = dom.taskId.value || crypto.randomUUID();
        const isNew = !dom.taskId.value;

        // Handle dependencies multiselect
        const selectedDeps = Array.from(dom.taskDeps.selectedOptions).map(o => o.value).join(',');

        const taskData = {
            id,
            title: dom.taskTitle.value.trim(),
            group_name: dom.taskGroup.value,
            status: dom.taskStatus.value,
            priority_grade: dom.taskGrade.value,
            due_date: dom.taskDue.value || null,
            time_estimate: dom.taskTime.value.trim(),
            value_impact: dom.taskImpact.value.trim(),
            depends_on: selectedDeps,
            notes: dom.taskNotes.value.trim(),
            actual_minutes: isNew ? 0 : (tasks.find(t => t.id === id)?.actual_minutes || 0),
            is_running: isNew ? false : (tasks.find(t => t.id === id)?.is_running || false),
            timer_start_at: isNew ? null : (tasks.find(t => t.id === id)?.timer_start_at || null),
            created_at: isNew ? new Date() : (tasks.find(t => t.id === id)?.created_at || new Date())
        };

        await saveTask(taskData, isNew);
        closeTaskModal();
    });

    // Canvas dependency setting toggle
    dom.showIsolatedTasks.addEventListener('change', initDependencyCanvas);

    // Confirm CSV Import
    dom.btnConfirmImport.addEventListener('click', confirmCSVImport);

    // Expose openTaskModal globally for timeline clicks
    window.openTaskModal = openTaskModal;
}

function renderApp() {
    renderMetrics();
    if (activeTab === 'dashboard') renderDashboardCharts();
    else if (activeTab === 'kanban') renderKanban();
    else if (activeTab === 'timeline') renderTimeline();
    else if (activeTab === 'dependencies') initDependencyCanvas();
}

async function init() {
    // Resolve Neon database credentials
    resolveNeonConnectionString();

    setupGlobalEvents();
    setupCSVHandlers();
    setupSettingsHandlers();

    // Start stopwatch live display poll
    startTimerPolling();

    // Load initial tasks (Neon or LocalStorage)
    await loadTasks();

    // Switch to default page
    switchTab('dashboard');
}

// Launch application
window.addEventListener('DOMContentLoaded', init);
