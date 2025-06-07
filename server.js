const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
require("dotenv").config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const parkingData = new Map(); // deviceId -> current parking data
const slotHistory = []; // Array to store slot change history

// Helper functions
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null)
  );
}

function logSlotChange(
  deviceId,
  slotId,
  previousState,
  newState,
  ipAddress = null
) {
  const log = {
    deviceId,
    slotId,
    previousState, // true = occupied, false = available
    newState,
    timestamp: new Date(),
    ipAddress,
    duration: null, // will be calculated when slot becomes available
  };

  // If slot becomes available, calculate how long it was occupied
  if (previousState === true && newState === false) {
    // Find the last time this slot was occupied
    const lastOccupied = slotHistory
      .slice()
      .reverse()
      .find(
        (h) =>
          h.deviceId === deviceId && h.slotId === slotId && h.newState === true
      );

    if (lastOccupied) {
      log.duration = new Date() - lastOccupied.timestamp;
    }
  }

  slotHistory.push(log);
  console.log(
    `Slot ${slotId} on device ${deviceId}: ${
      previousState ? "occupied" : "available"
    } -> ${newState ? "occupied" : "available"}`
  );

  // Keep only last 10000 logs to prevent memory overflow
  if (slotHistory.length > 10000) {
    slotHistory.shift();
  }
}

// Health Check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    connectedDevices: parkingData.size,
    totalHistoryLogs: slotHistory.length,
  });
});

// Parking Status Update from Arduino
app.post("/api/parking-status", (req, res) => {
  const { deviceId, timestamp, wifiStatus, slots } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required" });
  }

  let availableSlots = 0;
  let totalSlots = 0;
  let processedSlots = [];

  if (slots && Array.isArray(slots)) {
    totalSlots = slots.length;

    // Get previous slot states for comparison
    const previousData = parkingData.get(deviceId);
    const previousSlots = previousData ? previousData.slots : [];

    if (slots.length > 0) {
      if (typeof slots[0] === "object" && slots[0].hasOwnProperty("occupied")) {
        availableSlots = slots.filter((slot) => !slot.occupied).length;
        processedSlots = slots.map((slot, index) => {
          const slotData = {
            id: slot.id || index + 1,
            occupied: slot.occupied,
            lastUpdate: slot.lastUpdate || Date.now(),
          };

          // Check if slot state changed
          const previousSlot = previousSlots.find((p) => p.id === slotData.id);
          if (previousSlot && previousSlot.occupied !== slotData.occupied) {
            logSlotChange(
              deviceId,
              slotData.id,
              previousSlot.occupied,
              slotData.occupied,
              getClientIP(req)
            );
          }

          return slotData;
        });
      } else {
        // Handle simple array format [0, 1, 0, 1] where 0 = available, 1 = occupied
        availableSlots = slots.filter((slot) => slot === 0).length;
        processedSlots = slots.map((occupied, index) => {
          const slotData = {
            id: index + 1,
            occupied: occupied === 1,
            lastUpdate: Date.now(),
          };

          // Check if slot state changed
          const previousSlot = previousSlots.find((p) => p.id === slotData.id);
          if (previousSlot && previousSlot.occupied !== slotData.occupied) {
            logSlotChange(
              deviceId,
              slotData.id,
              previousSlot.occupied,
              slotData.occupied,
              getClientIP(req)
            );
          }

          return slotData;
        });
      }
    }
  }

  // Store parking data in memory
  parkingData.set(deviceId, {
    deviceId,
    timestamp,
    wifiStatus,
    slots: processedSlots,
    availableSlots,
    totalSlots,
    lastUpdate: new Date(),
  });

  console.log(
    `Parking status updated for device: ${deviceId} - ${availableSlots}/${totalSlots} available`
  );

  res.json({
    success: true,
    message: "Parking status updated successfully",
    data: {
      deviceId,
      availableSlots,
      totalSlots,
      timestamp: new Date().toISOString(),
    },
  });
});

// Get Parking Status
app.get("/api/parking-status", (req, res) => {
  const { deviceId } = req.query;

  try {
    if (deviceId) {
      // Get specific device status
      if (parkingData.has(deviceId)) {
        const deviceData = parkingData.get(deviceId);
        res.json({
          success: true,
          data: deviceData,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.status(404).json({
          success: false,
          error: "Device not found",
          deviceId: deviceId,
        });
      }
    } else {
      // Get all devices status
      const allStatus = Array.from(parkingData.values());
      res.json({
        success: true,
        data: allStatus,
        totalDevices: allStatus.length,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("Error fetching parking status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch parking status",
    });
  }
});

// Admin Dashboard - Single endpoint with comprehensive parking analytics
app.get("/api/admin/dashboard", (req, res) => {
  try {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Current parking status summary
    const currentStatus = Array.from(parkingData.values()).map((data) => ({
      deviceId: data.deviceId,
      totalSlots: data.totalSlots,
      availableSlots: data.availableSlots,
      occupiedSlots: data.totalSlots - data.availableSlots,
      occupancyRate:
        data.totalSlots > 0
          ? (
              ((data.totalSlots - data.availableSlots) / data.totalSlots) *
              100
            ).toFixed(1)
          : 0,
      lastUpdate: data.lastUpdate,
      wifiStatus: data.wifiStatus,
      slots: data.slots.map((slot) => ({
        id: slot.id,
        occupied: slot.occupied,
        lastUpdate: new Date(slot.lastUpdate),
      })),
    }));

    // Slot usage analytics - which slots are most frequently occupied
    const slotUsageStats = {};

    // Initialize slot stats for each device
    currentStatus.forEach((device) => {
      if (!slotUsageStats[device.deviceId]) {
        slotUsageStats[device.deviceId] = {};
      }

      device.slots.forEach((slot) => {
        if (!slotUsageStats[device.deviceId][slot.id]) {
          slotUsageStats[device.deviceId][slot.id] = {
            slotId: slot.id,
            totalOccupations: 0,
            totalDuration: 0,
            averageDuration: 0,
            currentlyOccupied: slot.occupied,
            last24hOccupations: 0,
            last7dOccupations: 0,
          };
        }
      });
    });

    // Analyze historical data
    slotHistory.forEach((log) => {
      if (!slotUsageStats[log.deviceId]) return;
      if (!slotUsageStats[log.deviceId][log.slotId]) return;

      const slotStats = slotUsageStats[log.deviceId][log.slotId];

      // Count occupations (when slot becomes occupied)
      if (log.newState === true) {
        slotStats.totalOccupations++;

        // Count recent occupations
        if (log.timestamp >= last24Hours) {
          slotStats.last24hOccupations++;
        }
        if (log.timestamp >= last7Days) {
          slotStats.last7dOccupations++;
        }
      }

      // Add duration when slot becomes available
      if (log.newState === false && log.duration) {
        slotStats.totalDuration += log.duration;
      }
    });

    // Calculate average durations
    Object.keys(slotUsageStats).forEach((deviceId) => {
      Object.keys(slotUsageStats[deviceId]).forEach((slotId) => {
        const stats = slotUsageStats[deviceId][slotId];
        if (stats.totalOccupations > 0) {
          stats.averageDuration = Math.round(
            stats.totalDuration / stats.totalOccupations
          );
        }
      });
    });

    // Recent slot changes (last 50 changes)
    const recentChanges = slotHistory
      .slice(-50)
      .reverse()
      .map((log) => ({
        deviceId: log.deviceId,
        slotId: log.slotId,
        change: log.newState ? "occupied" : "available",
        previousState: log.previousState ? "occupied" : "available",
        timestamp: log.timestamp,
        duration: log.duration ? Math.round(log.duration / 1000 / 60) : null, // in minutes
      }));

    // Hourly occupancy pattern (last 24 hours)
    const hourlyPattern = {};
    for (let i = 0; i < 24; i++) {
      const hour = new Date(now.getTime() - i * 60 * 60 * 1000).getHours();
      hourlyPattern[hour] = {
        hour: hour,
        occupations: 0,
        releases: 0,
      };
    }

    slotHistory
      .filter((log) => log.timestamp >= last24Hours)
      .forEach((log) => {
        const hour = log.timestamp.getHours();
        if (log.newState === true) {
          hourlyPattern[hour].occupations++;
        } else {
          hourlyPattern[hour].releases++;
        }
      });

    // System statistics
    const systemStats = {
      totalDevices: parkingData.size,
      totalSlots: currentStatus.reduce(
        (sum, device) => sum + device.totalSlots,
        0
      ),
      totalOccupied: currentStatus.reduce(
        (sum, device) => sum + device.occupiedSlots,
        0
      ),
      totalAvailable: currentStatus.reduce(
        (sum, device) => sum + device.availableSlots,
        0
      ),
      overallOccupancyRate: 0,
      totalHistoryRecords: slotHistory.length,
      last24hChanges: slotHistory.filter((log) => log.timestamp >= last24Hours)
        .length,
      last7dChanges: slotHistory.filter((log) => log.timestamp >= last7Days)
        .length,
    };

    const totalSlots = systemStats.totalSlots;
    if (totalSlots > 0) {
      systemStats.overallOccupancyRate = (
        (systemStats.totalOccupied / totalSlots) *
        100
      ).toFixed(1);
    }

    const dashboardData = {
      systemStats,
      currentStatus,
      slotUsageStats,
      recentChanges,
      hourlyPattern: Object.values(hourlyPattern).sort(
        (a, b) => a.hour - b.hour
      ),
      lastUpdated: now.toISOString(),
    };

    res.json({
      success: true,
      data: dashboardData,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch dashboard data",
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
    message: "The requested endpoint does not exist",
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Simplified Parking Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("Available endpoints:");
  console.log("- POST /api/parking-status (Arduino updates)");
  console.log("- GET /api/parking-status (Get current status)");
  console.log("- GET /api/admin/dashboard (Admin analytics)");
  console.log("- GET /api/health (Health check)");
});

// Periodic health check log (every 5 minutes)
setInterval(() => {
  const totalSlots = Array.from(parkingData.values()).reduce(
    (sum, data) => sum + data.totalSlots,
    0
  );
  const occupiedSlots = Array.from(parkingData.values()).reduce(
    (sum, data) => sum + (data.totalSlots - data.availableSlots),
    0
  );

  console.log("=== Parking System Health ===");
  console.log(`Connected devices: ${parkingData.size}`);
  console.log(`Total parking slots: ${totalSlots}`);
  console.log(`Currently occupied: ${occupiedSlots}`);
  console.log(`History records: ${slotHistory.length}`);
  console.log(`Server uptime: ${Math.floor(process.uptime())} seconds`);
  console.log("============================");
}, 5 * 60 * 1000);
