class DockerStatsViewer {
  constructor() {
    this.containers = new Map();
    this.charts = new Map();
    this.socket = null;
    this.statsData = new Map();
    this.containerCheckInterval = null;
    this.visibleContainers = new Set();
    this.filterDropdownOpen = false;
    this.refreshRate = 2000;
    this.containerStatuses = new Map(); // Track container statuses

    this.init();
  }

  async init() {
    try {
      await this.loadContainers();
      this.setupWebSocket();
      this.startContainerMonitoring();
      this.setupFilterEventListeners();
    } catch (error) {
      this.showError("Failed to initialize: " + error.message);
    }
  }

  setupFilterEventListeners() {
    document.addEventListener("click", (e) => {
      const dropdown = document.querySelector(".filter-dropdown");
      if (dropdown && !dropdown.contains(e.target)) {
        this.hideFilterDropdown();
      }
    });
  }

  createFilterControls() {
    const filterContainer = document.createElement("div");
    filterContainer.className = "container-filter";
    filterContainer.innerHTML = `
      <div class="filter-dropdown">
        <button class="filter-button" onclick="dockerViewer.toggleFilterDropdown()">
          📋 Filter Containers
        </button>
        <div class="filter-dropdown-content" id="filter-dropdown">
          <div class="filter-actions">
            <button class="filter-action-btn" onclick="dockerViewer.selectAllContainers()">Select All</button>
            <button class="filter-action-btn" onclick="dockerViewer.selectNoneContainers()">Select None</button>
          </div>
          <div id="filter-items"></div>
        </div>
      </div>
      <div class="refresh-rate-container">
        <label for="refresh-rate" class="refresh-rate-label">⚡ Refresh Rate:</label>
        <select id="refresh-rate" class="refresh-rate-select" onchange="dockerViewer.changeRefreshRate(this.value)">
          <option value="1000">1 second</option>
          <option value="2000" selected>2 seconds</option>
          <option value="5000">5 seconds</option>
          <option value="10000">10 seconds</option>
          <option value="30000">30 seconds</option>
        </select>
      </div>
      <div class="visible-count" id="visible-count"></div>
    `;

    return filterContainer;
  }

  changeRefreshRate(newRate) {
    this.refreshRate = parseInt(newRate);
    console.log(`Refresh rate changed to ${this.refreshRate}ms`);

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.containers.forEach((container, containerId) => {
        if (this.visibleContainers.has(containerId)) {
          this.socket.send(
            JSON.stringify({
              type: "unsubscribe",
              containerId: containerId,
            })
          );

          this.socket.send(
            JSON.stringify({
              type: "subscribe",
              containerId: containerId,
              refreshRate: this.refreshRate,
            })
          );
        }
      });
    }
  }

  updateFilterControls() {
    const filterItems = document.getElementById("filter-items");
    if (!filterItems) return;

    filterItems.innerHTML = "";

    this.containers.forEach((container, containerId) => {
      const isVisible = this.visibleContainers.has(containerId);
      const filterItem = document.createElement("div");
      filterItem.className = "filter-item";
      filterItem.innerHTML = `
        <input type="checkbox" class="filter-checkbox" id="filter-${containerId}"
               ${isVisible ? "checked" : ""}
               onchange="dockerViewer.toggleContainerVisibility('${containerId}')">
        <label class="filter-label" for="filter-${containerId}">${
        container.name
      }</label>
      `;
      filterItems.appendChild(filterItem);
    });

    this.updateVisibleCount();
  }

  toggleFilterDropdown() {
    const dropdown = document.getElementById("filter-dropdown");
    if (!dropdown) return;

    this.filterDropdownOpen = !this.filterDropdownOpen;
    dropdown.classList.toggle("show", this.filterDropdownOpen);
  }

  hideFilterDropdown() {
    const dropdown = document.getElementById("filter-dropdown");
    if (dropdown) {
      dropdown.classList.remove("show");
      this.filterDropdownOpen = false;
    }
  }

  toggleContainerVisibility(containerId) {
    const containerElement = document.getElementById(
      `container-${containerId}`
    );
    if (!containerElement) return;

    if (this.visibleContainers.has(containerId)) {
      this.visibleContainers.delete(containerId);
      containerElement.classList.add("hidden");

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: "unsubscribe",
            containerId: containerId,
          })
        );
      }
    } else {
      this.visibleContainers.add(containerId);
      containerElement.classList.remove("hidden");

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: "subscribe",
            containerId: containerId,
            refreshRate: this.refreshRate,
          })
        );
      }
    }

    this.updateVisibleCount();
  }

  selectAllContainers() {
    this.containers.forEach((container, containerId) => {
      const wasVisible = this.visibleContainers.has(containerId);
      this.visibleContainers.add(containerId);
      const containerElement = document.getElementById(
        `container-${containerId}`
      );
      const checkbox = document.getElementById(`filter-${containerId}`);

      if (containerElement) containerElement.classList.remove("hidden");
      if (checkbox) checkbox.checked = true;

      if (
        !wasVisible &&
        this.socket &&
        this.socket.readyState === WebSocket.OPEN
      ) {
        this.socket.send(
          JSON.stringify({
            type: "subscribe",
            containerId: containerId,
            refreshRate: this.refreshRate,
          })
        );
      }
    });

    this.updateVisibleCount();
  }

  selectNoneContainers() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.visibleContainers.forEach((containerId) => {
        this.socket.send(
          JSON.stringify({
            type: "unsubscribe",
            containerId: containerId,
          })
        );
      });
    }

    this.visibleContainers.clear();

    this.containers.forEach((container, containerId) => {
      const containerElement = document.getElementById(
        `container-${containerId}`
      );
      const checkbox = document.getElementById(`filter-${containerId}`);

      if (containerElement) containerElement.classList.add("hidden");
      if (checkbox) checkbox.checked = false;
    });

    this.updateVisibleCount();
  }

  updateVisibleCount() {
    const visibleCountElement = document.getElementById("visible-count");
    if (visibleCountElement) {
      const total = this.containers.size;
      const visible = this.visibleContainers.size;
      visibleCountElement.textContent = `Showing ${visible} of ${total} containers`;
    }
  }

  async loadContainers() {
    const response = await fetch("/api/containers");
    if (!response.ok) {
      throw new Error("Failed to fetch containers");
    }

    const containers = await response.json();
    document.getElementById("loading").style.display = "none";

    if (containers.length === 0) {
      this.showNoContainers();
      return;
    }

    this.renderContainers(containers);
  }

  startContainerMonitoring() {
    this.containerCheckInterval = setInterval(async () => {
      try {
        await this.checkForContainerChanges();
      } catch (error) {
        console.error("Error checking for container changes:", error);
      }
    }, 5000);
  }

  async checkForContainerChanges() {
    const response = await fetch("/api/containers");
    if (!response.ok) return;

    const currentContainers = await response.json();
    const currentContainerIds = new Set(currentContainers.map((c) => c.id));
    const existingContainerIds = new Set(this.containers.keys());

    const newContainers = currentContainers.filter(
      (c) => !existingContainerIds.has(c.id)
    );

    currentContainers.forEach((container) => {
      if (existingContainerIds.has(container.id)) {
        const existingContainer = this.containers.get(container.id);
        if (existingContainer.state !== container.state) {
          existingContainer.state = container.state;
          existingContainer.status = container.status;
          this.containers.set(container.id, existingContainer);
          this.updateContainerStatus(container.id, container.state);
        }
      }
    });

    if (newContainers.length > 0) {
      this.addNewContainers(newContainers);
    }

    if (this.containers.size === 0 && currentContainers.length > 0) {
      this.renderContainers(currentContainers);
    }
  }

  updateContainerStatus(containerId, status) {
    const containerElement = document.getElementById(
      `container-${containerId}`
    );
    if (!containerElement) return;

    const statusBadge = containerElement.querySelector(".status-badge");
    if (statusBadge) {
      statusBadge.textContent = status || "Unknown";
      statusBadge.className = `status-badge ${status.toLowerCase()}`;
    }

    if (status === "exited" || status === "created" || status === "paused") {
      containerElement.classList.add(status);
    } else {
      containerElement.classList.remove("exited", "created", "paused");
    }
  }

  addNewContainers(newContainers) {
    const containersDiv = document.getElementById("containers");

    const noContainersDiv = containersDiv.querySelector(".no-containers");
    if (noContainersDiv) {
      noContainersDiv.remove();
    }

    newContainers.forEach((container) => {
      this.containers.set(container.id, container);
      this.visibleContainers.add(container.id);

      const containerCard = this.createContainerCard(container);
      containersDiv.appendChild(containerCard);

      containerCard.style.opacity = "0";
      containerCard.style.transform = "translateY(20px)";

      setTimeout(() => {
        containerCard.style.transition =
          "opacity 0.3s ease, transform 0.3s ease";
        containerCard.style.opacity = "1";
        containerCard.style.transform = "translateY(0)";
      }, 100);

      this.initializeChart(container.id);

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: "subscribe",
            containerId: container.id,
            refreshRate: this.refreshRate,
          })
        );
      }
    });

    this.updateFilterControls();
  }

  showNoContainers() {
    document.getElementById("containers").innerHTML = `
            <div class="no-containers">
                <h3>No running containers found</h3>
                <p>Make sure Docker is running and you have containers started</p>
                <p>Run <code>docker ps</code> in your terminal to check running containers</p>
                <p><small>Checking for new containers automatically...</small></p>
                <button onclick="location.reload()">🔄 Refresh Now</button>
            </div>
        `;
  }

  renderContainers(containers) {
    const containersDiv = document.getElementById("containers");
    containersDiv.innerHTML = "";

    if (containers.length > 0) {
      const filterControls = this.createFilterControls();
      const header = document.querySelector(".header");

      const existingFilter = document.querySelector(".container-filter");
      if (existingFilter) {
        existingFilter.remove();
      }

      header.appendChild(filterControls);
    }

    this.containers.clear();
    this.visibleContainers.clear();
    containers.forEach((container) => {
      this.containers.set(container.id, container);
      this.visibleContainers.add(container.id);
    });

    containers.forEach((container) => {
      const containerCard = this.createContainerCard(container);
      containersDiv.appendChild(containerCard);
      this.initializeChart(container.id);
    });

    this.updateFilterControls();
  }

  createContainerCard(container) {
    const card = document.createElement("div");
    card.className = "container-card";
    card.id = `container-${container.id}`;

    card.innerHTML = `
            <div class="container-header">
                <div class="container-name">${container.name}</div>
                <div class="status-badge ${container.state.toLowerCase()}">${
      container.state || "Running"
    }</div>
            </div>
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value" id="cpu-${container.id}">0%</div>
                    <div class="stat-label">CPU Usage</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="mem-${container.id}">0%</div>
                    <div class="stat-label">Memory Usage</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="mem-size-${
                      container.id
                    }">0 B</div>
                    <div class="stat-label">Memory Size</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="net-${container.id}">0 B/s</div>
                    <div class="stat-label">Network I/O</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="pids-${container.id}">0</div>
                    <div class="stat-label">Processes</div>
                </div>
            </div>
            <div class="chart-container">
                <canvas id="chart-cpu-mem-${container.id}"></canvas>
            </div>
            <div class="chart-container">
                <canvas id="chart-mem-size-${container.id}"></canvas>
            </div>
        `;

    return card;
  }

  initializeChart(containerId) {
    const ctxCpuMem = document
      .getElementById(`chart-cpu-mem-${containerId}`)
      .getContext("2d");

    const chartCpuMem = new Chart(ctxCpuMem, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "CPU %",
            data: [],
            borderColor: "#00d4aa",
            backgroundColor: "rgba(0, 212, 170, 0.1)",
            tension: 0.3,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: "y",
          },
          {
            label: "Memory %",
            data: [],
            borderColor: "#ff6b6b",
            backgroundColor: "rgba(255, 107, 107, 0.1)",
            tension: 0.3,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: "y",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        scales: {
          x: {
            display: false,
            grid: {
              display: false,
            },
          },
          y: {
            type: "linear",
            position: "left",
            beginAtZero: true,
            max: 100,
            ticks: {
              color: "#b3b3b3",
            },
            grid: {
              color: "#404040",
            },
          },
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "#b3b3b3",
              usePointStyle: true,
              padding: 15,
            },
          },
        },
      },
    });

    const ctxMemSize = document
      .getElementById(`chart-mem-size-${containerId}`)
      .getContext("2d");

    const chartMemSize = new Chart(ctxMemSize, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Memory Used",
            data: [],
            borderColor: "#8b5cf6",
            backgroundColor: "rgba(139, 92, 246, 0.1)",
            tension: 0.3,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: "y",
          },
          {
            label: "Memory Total",
            data: [],
            borderColor: "#6b7280",
            backgroundColor: "rgba(107, 114, 128, 0.1)",
            tension: 0.3,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: "y",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        scales: {
          x: {
            display: false,
            grid: {
              display: false,
            },
          },
          y: {
            type: "linear",
            position: "left",
            beginAtZero: true,
            ticks: {
              color: "#b3b3b3",
              callback: function (value) {
                return this.formatBytes(value);
              }.bind(this),
            },
            grid: {
              color: "#404040",
            },
          },
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "#b3b3b3",
              usePointStyle: true,
              padding: 15,
            },
          },
        },
      },
    });

    this.charts.set(containerId, {
      cpuMem: chartCpuMem,
      memSize: chartMemSize,
    });
    this.statsData.set(containerId, {
      cpu: [],
      memory: [],
      memUsed: [],
      memTotal: [],
      timestamps: [],
    });
  }

  setupWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}`);

    this.socket.onopen = () => {
      console.log("WebSocket connected");
      this.containers.forEach((container, containerId) => {
        if (this.visibleContainers.has(containerId)) {
          this.socket.send(
            JSON.stringify({
              type: "subscribe",
              containerId: containerId,
              refreshRate: this.refreshRate,
            })
          );
        }
      });
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "stats") {
          this.updateStats(data.containerId, data.data);
        } else if (data.type === "status") {
          this.updateContainerStatus(data.containerId, data.status);
        }
      } catch (error) {
        console.error("Error parsing WebSocket data:", error);
      }
    };

    this.socket.onclose = () => {
      console.log("WebSocket disconnected, attempting to reconnect...");
      setTimeout(() => this.setupWebSocket(), 5000);
    };

    this.socket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  updateStats(containerId, stats) {
    const cpuElement = document.getElementById(`cpu-${containerId}`);
    const memElement = document.getElementById(`mem-${containerId}`);
    const memSizeElement = document.getElementById(`mem-size-${containerId}`);
    const netElement = document.getElementById(`net-${containerId}`);
    const pidsElement = document.getElementById(`pids-${containerId}`);

    if (cpuElement) cpuElement.textContent = `${stats.cpuPercent.toFixed(1)}%`;
    if (memElement) memElement.textContent = `${stats.memPercent.toFixed(1)}%`;
    if (memSizeElement)
      memSizeElement.textContent = `${this.formatBytes(stats.memUsed)}`;
    if (netElement)
      netElement.textContent = `${this.formatBytes(
        stats.netIn + stats.netOut
      )}/s`;
    if (pidsElement) pidsElement.textContent = stats.pids;

    const charts = this.charts.get(containerId);
    const data = this.statsData.get(containerId);

    if (charts && data) {
      const now = new Date().toLocaleTimeString();

      data.timestamps.push(now);
      data.cpu.push(stats.cpuPercent);
      data.memory.push(stats.memPercent);
      data.memUsed.push(stats.memUsed);
      data.memTotal.push(stats.memTotal);

      if (data.timestamps.length > 30) {
        data.timestamps.shift();
        data.cpu.shift();
        data.memory.shift();
        data.memUsed.shift();
        data.memTotal.shift();
      }

      charts.cpuMem.data.labels = data.timestamps;
      charts.cpuMem.data.datasets[0].data = data.cpu;
      charts.cpuMem.data.datasets[1].data = data.memory;
      charts.cpuMem.update("none");

      charts.memSize.data.labels = data.timestamps;
      charts.memSize.data.datasets[0].data = data.memUsed;
      charts.memSize.data.datasets[1].data = data.memTotal;
      charts.memSize.update("none");
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  showError(message) {
    document.getElementById("loading").style.display = "none";
    const errorDiv = document.getElementById("error");
    errorDiv.textContent = message;
    errorDiv.style.display = "block";

    if (this.containerCheckInterval) {
      clearInterval(this.containerCheckInterval);
    }
  }

  cleanup() {
    if (this.containerCheckInterval) {
      clearInterval(this.containerCheckInterval);
    }
    if (this.socket) {
      this.socket.close();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.dockerViewer = new DockerStatsViewer();

  window.addEventListener("beforeunload", () => {
    window.dockerViewer.cleanup();
  });
});
