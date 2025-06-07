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
// Fungsi helper untuk mendapatkan waktu WIB
function getWIBTime(date = new Date()) {
  // WIB = UTC + 7 jam
  const wibOffset = 7 * 60; // 7 jam dalam menit
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const wibTime = new Date(utc + wibOffset * 60000);
  return wibTime;
}

function getWIBHour(date) {
  return getWIBTime(date).getHours();
}

function getWIBDateString(date) {
  return getWIBTime(date).toISOString().split("T")[0]; // Format: YYYY-MM-DD
}

// Update bagian hourly pattern dalam endpoint /api/admin/dashboard
app.get("/api/admin/dashboard", (req, res) => {
  try {
    const now = new Date();
    const nowWIB = getWIBTime(now);
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // ... kode sebelumnya tetap sama ...

    // Hourly occupancy pattern (last 24 hours) dengan WIB timezone
    const hourlyPattern = {};
    const dailyPattern = {}; // Tambahan untuk pola harian

    // Inisialisasi pattern untuk 24 jam terakhir (WIB)
    for (let i = 0; i < 24; i++) {
      const pastTime = new Date(now.getTime() - i * 60 * 60 * 1000);
      const wibHour = getWIBHour(pastTime);
      const wibDate = getWIBDateString(pastTime);

      if (!hourlyPattern[wibHour]) {
        hourlyPattern[wibHour] = {
          hour: wibHour,
          hourDisplay: `${wibHour.toString().padStart(2, "0")}:00 WIB`,
          occupations: 0,
          releases: 0,
          netChange: 0,
        };
      }

      if (!dailyPattern[wibDate]) {
        dailyPattern[wibDate] = {
          date: wibDate,
          dateDisplay: getWIBTime(pastTime).toLocaleDateString("id-ID", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          totalOccupations: 0,
          totalReleases: 0,
          peakHour: null,
          peakOccupancy: 0,
        };
      }
    }

    // Analisis data historis berdasarkan WIB
    slotHistory
      .filter((log) => log.timestamp >= last24Hours)
      .forEach((log) => {
        const wibHour = getWIBHour(log.timestamp);
        const wibDate = getWIBDateString(log.timestamp);

        // Update hourly pattern
        if (hourlyPattern[wibHour]) {
          if (log.newState === true) {
            hourlyPattern[wibHour].occupations++;
            hourlyPattern[wibHour].netChange++;
          } else {
            hourlyPattern[wibHour].releases++;
            hourlyPattern[wibHour].netChange--;
          }
        }

        // Update daily pattern
        if (dailyPattern[wibDate]) {
          if (log.newState === true) {
            dailyPattern[wibDate].totalOccupations++;
          } else {
            dailyPattern[wibDate].totalReleases++;
          }
        }
      });

    // Hitung peak hour untuk setiap hari
    Object.keys(dailyPattern).forEach((date) => {
      const dayHours = Object.values(hourlyPattern).filter((h) => {
        // Filter jam untuk tanggal ini (simplified logic)
        return true; // Anda bisa memperbaiki logic ini sesuai kebutuhan
      });

      const peakHourData = dayHours.reduce(
        (peak, current) => {
          return current.occupations > peak.occupations ? current : peak;
        },
        { occupations: 0, hour: 0 }
      );

      dailyPattern[date].peakHour = peakHourData.hour;
      dailyPattern[date].peakOccupancy = peakHourData.occupations;
    });

    // Urutkan hourly pattern berdasarkan jam
    const sortedHourlyPattern = Object.values(hourlyPattern).sort(
      (a, b) => a.hour - b.hour
    );

    // Tambahkan informasi WIB ke system stats
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
      currentTimeWIB: nowWIB.toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      timezone: "WIB (GMT+7)",
    };

    const totalSlots = systemStats.totalSlots;
    if (totalSlots > 0) {
      systemStats.overallOccupancyRate = (
        (systemStats.totalOccupied / totalSlots) *
        100
      ).toFixed(1);
    }

    // Update recent changes dengan WIB
    const recentChanges = slotHistory
      .slice(-50)
      .reverse()
      .map((log) => ({
        deviceId: log.deviceId,
        slotId: log.slotId,
        change: log.newState ? "occupied" : "available",
        previousState: log.previousState ? "occupied" : "available",
        timestamp: log.timestamp,
        timestampWIB: getWIBTime(log.timestamp).toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        duration: log.duration ? Math.round(log.duration / 1000 / 60) : null, // dalam menit
      }));

    const dashboardData = {
      systemStats,
      currentStatus,
      slotUsageStats,
      recentChanges,
      hourlyPattern: sortedHourlyPattern,
      dailyPattern: Object.values(dailyPattern).sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      ),
      lastUpdated: now.toISOString(),
      lastUpdatedWIB: nowWIB.toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };

    res.json({
      success: true,
      data: dashboardData,
      timestamp: now.toISOString(),
      timestampWIB: systemStats.currentTimeWIB,
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
