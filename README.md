# Docker Container Stats Viewer

A simple web-based tool to visualize Docker container statistics in real-time without requiring Docker Desktop.

## Features

- Real-time monitoring of Docker container statistics
- Interactive charts showing CPU usage, memory usage, and network I/O
- Web-based interface accessible via browser
- Lightweight and self-contained

## Prerequisites

- Node.js (v14 or higher)
- Docker installed and accessible via command line
- Docker containers running locally

## Installation

1. Navigate to the docker-viewer directory:
   ```bash
   cd utilities/docker-viewer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

1. Start the application:
   ```bash
   npm start
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

3. The application will automatically detect running containers and display their statistics in real-time charts.

## API Endpoints

- `GET /` - Main dashboard
- `GET /api/containers` - Get list of running containers
- `GET /api/stats/:containerId` - Get real-time stats for a specific container
- `GET /api/stats` - Get stats for all running containers

## Stopping the Application

Press `Ctrl+C` in the terminal to stop the server.
