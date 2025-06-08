const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);
app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.options("*", cors());

// In-memory storage
const parkingData = new Map(); // deviceId -> current parking data
const slotHistory = []; // Array to store slot change history
const adminUsers = new Map(); // email -> user data

// JWT Secret (use environment variable in production)
const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-this-in-production";

// Default admin user (remove this in production and use proper registration)
const defaultAdmin = {
  email: "admin@parking.com",
  password: "$2a$10$881xLk38aaxjYNMBkhm9BOAwk3q5mmk89VSUWAkpBzj1IxyVMXlPW",
  name: "Admin",
  role: "admin",
  createdAt: new Date(),
};
adminUsers.set(defaultAdmin.email, defaultAdmin);

// Helper functions
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null)
  );
}

// Helper function to convert UTC to WIB (UTC+7)
function convertToWIB(date) {
  const wibDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return wibDate;
}

// Helper function to get current time in WIB
function getCurrentWIBTime() {
  return convertToWIB(new Date());
}

// Helper function to format date in WIB
function formatWIBDate(date) {
  const wibDate = convertToWIB(date);
  return {
    iso: wibDate.toISOString(),
    formatted: wibDate.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    date: wibDate.toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    time: wibDate.toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    hour: wibDate.getUTCHours(),
    timestamp: wibDate.getTime(),
  };
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        error: "Invalid or expired token",
      });
    }
    req.user = user;
    next();
  });
}

function logSlotChange(
  deviceId,
  slotId,
  previousState,
  newState,
  ipAddress = null
) {
  const currentTime = getCurrentWIBTime();
  const log = {
    deviceId,
    slotId,
    previousState, // true = occupied, false = available
    newState,
    timestamp: new Date(), // Store original UTC time
    timestampWIB: currentTime, // Store WIB time
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

  const wibTime = formatWIBDate(log.timestamp);
  console.log(
    `[${wibTime.formatted}] Slot ${slotId} on device ${deviceId}: ${
      previousState ? "occupied" : "available"
    } -> ${newState ? "occupied" : "available"}`
  );

  // Keep only last 5000 logs to prevent memory overflow
  if (slotHistory.length > 5000) {
    slotHistory.shift();
  }
}

// ===== PUBLIC ENDPOINTS (No authentication required) =====

// Health Check
app.get("/api/health", (req, res) => {
  const wibTime = formatWIBDate(new Date());
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    timestampWIB: wibTime,
    connectedDevices: parkingData.size,
    totalHistoryLogs: slotHistory.length,
  });
});

// Parking Status Update from Arduino (NO AUTH REQUIRED)
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

  const currentTime = getCurrentWIBTime();

  // Store parking data in memory
  parkingData.set(deviceId, {
    deviceId,
    timestamp,
    wifiStatus,
    slots: processedSlots,
    availableSlots,
    totalSlots,
    lastUpdate: new Date(),
    lastUpdateWIB: currentTime,
  });

  const wibTime = formatWIBDate(new Date());
  console.log(
    `[${wibTime.formatted}] Parking status updated for device: ${deviceId} - ${availableSlots}/${totalSlots} available`
  );

  res.json({
    success: true,
    message: "Parking status updated successfully",
    data: {
      deviceId,
      availableSlots,
      totalSlots,
      timestamp: new Date().toISOString(),
      timestampWIB: wibTime,
    },
  });
});

// Get Parking Status for Public (NO AUTH REQUIRED)
app.get("/api/parking-status", (req, res) => {
  const { deviceId } = req.query;

  try {
    if (deviceId) {
      // Get specific device status
      if (parkingData.has(deviceId)) {
        const deviceData = parkingData.get(deviceId);
        const wibTime = formatWIBDate(new Date());

        res.json({
          success: true,
          data: {
            ...deviceData,
            lastUpdateWIB: formatWIBDate(deviceData.lastUpdate),
          },
          timestamp: new Date().toISOString(),
          timestampWIB: wibTime,
        });
      } else {
        res.status(404).json({
          success: false,
          error: "Device not found",
          deviceId: deviceId,
        });
      }
    } else {
      // Get all devices status - simplified for public
      const allStatus = Array.from(parkingData.values()).map((device) => ({
        deviceId: device.deviceId,
        totalSlots: device.totalSlots,
        availableSlots: device.availableSlots,
        occupiedSlots: device.totalSlots - device.availableSlots,
        lastUpdate: device.lastUpdate,
        lastUpdateWIB: formatWIBDate(device.lastUpdate),
        slots: device.slots.map((slot) => ({
          id: slot.id,
          occupied: slot.occupied,
        })),
      }));

      const wibTime = formatWIBDate(new Date());
      res.json({
        success: true,
        data: allStatus,
        totalDevices: allStatus.length,
        timestamp: new Date().toISOString(),
        timestampWIB: wibTime,
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

// ===== AUTHENTICATION ENDPOINTS =====

// Admin Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const user = adminUsers.get(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        email: user.email,
        name: user.name,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    const wibTime = formatWIBDate(new Date());
    console.log(`[${wibTime.formatted}] Admin login: ${email}`);

    res.json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: {
          email: user.email,
          name: user.name,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: "Login failed",
    });
  }
});

// Admin Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: "Email, password, and name are required",
      });
    }

    if (adminUsers.has(email)) {
      return res.status(400).json({
        success: false,
        error: "User already exists",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      email,
      password: hashedPassword,
      name,
      role: "admin",
      createdAt: new Date(),
    };

    adminUsers.set(email, newUser);

    const wibTime = formatWIBDate(new Date());
    console.log(`[${wibTime.formatted}] New admin registered: ${email}`);

    res.json({
      success: true,
      message: "Registration successful",
      data: {
        user: {
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
        },
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      error: "Registration failed",
    });
  }
});

// ===== ADMIN ENDPOINTS (Authentication required) =====

// Simple Admin Dashboard
app.get("/api/admin/dashboard", authenticateToken, (req, res) => {
  try {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Current parking status
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
      lastUpdateWIB: formatWIBDate(data.lastUpdate),
      slots: data.slots,
    }));

    // Most popular slots analysis
    const slotPopularity = {};

    // Initialize slot popularity tracking
    currentStatus.forEach((device) => {
      if (!slotPopularity[device.deviceId]) {
        slotPopularity[device.deviceId] = {};
      }
      device.slots.forEach((slot) => {
        if (!slotPopularity[device.deviceId][slot.id]) {
          slotPopularity[device.deviceId][slot.id] = {
            slotId: slot.id,
            deviceId: device.deviceId,
            occupationCount: 0,
            totalDuration: 0,
            averageDuration: 0,
            currentlyOccupied: slot.occupied,
          };
        }
      });
    });

    // Count occupations from history
    slotHistory.forEach((log) => {
      if (
        slotPopularity[log.deviceId] &&
        slotPopularity[log.deviceId][log.slotId]
      ) {
        if (log.newState === true) {
          // When slot becomes occupied
          slotPopularity[log.deviceId][log.slotId].occupationCount++;
        }
        if (log.duration && log.newState === false) {
          // When slot becomes free
          slotPopularity[log.deviceId][log.slotId].totalDuration +=
            log.duration;
        }
      }
    });

    // Calculate average durations and create sorted list
    const popularSlots = [];
    Object.keys(slotPopularity).forEach((deviceId) => {
      Object.keys(slotPopularity[deviceId]).forEach((slotId) => {
        const slot = slotPopularity[deviceId][slotId];
        if (slot.occupationCount > 0) {
          slot.averageDuration = Math.round(
            slot.totalDuration / slot.occupationCount / 1000 / 60
          ); // in minutes
        }
        popularSlots.push(slot);
      });
    });

    // Sort by occupation count
    popularSlots.sort((a, b) => b.occupationCount - a.occupationCount);

    // Peak hours analysis (simplified)
    const hourlyActivity = {};
    for (let i = 0; i < 24; i++) {
      hourlyActivity[i] = {
        hour: i,
        hourFormatted: `${i.toString().padStart(2, "0")}:00`,
        activities: 0,
      };
    }

    // Count activities by hour (last 24 hours)
    slotHistory
      .filter((log) => log.timestamp >= last24Hours)
      .forEach((log) => {
        const logWIB = convertToWIB(log.timestamp);
        const hour = logWIB.getUTCHours();
        if (hourlyActivity[hour]) {
          hourlyActivity[hour].activities++;
        }
      });

    // Find peak hours
    const peakHours = Object.values(hourlyActivity)
      .sort((a, b) => b.activities - a.activities)
      .slice(0, 3);

    // Recent activities (last 20)
    const recentActivities = slotHistory
      .slice(-20)
      .reverse()
      .map((log) => ({
        deviceId: log.deviceId,
        slotId: log.slotId,
        action: log.newState ? "occupied" : "available",
        timestamp: formatWIBDate(log.timestamp),
        duration: log.duration ? Math.round(log.duration / 1000 / 60) : null, // in minutes
      }));

    // System summary
    const summary = {
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
      totalActivities: slotHistory.length,
      last24hActivities: slotHistory.filter(
        (log) => log.timestamp >= last24Hours
      ).length,
    };

    if (summary.totalSlots > 0) {
      summary.overallOccupancyRate = (
        (summary.totalOccupied / summary.totalSlots) *
        100
      ).toFixed(1);
    }

    const dashboardData = {
      summary,
      currentStatus,
      popularSlots: popularSlots.slice(0, 10), // Top 10 most popular slots
      peakHours,
      recentActivities,
      hourlyPattern: Object.values(hourlyActivity),
      lastUpdated: formatWIBDate(now),
    };

    res.json({
      success: true,
      data: dashboardData,
      timestamp: now.toISOString(),
      timestampWIB: formatWIBDate(now),
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
  const wibTime = formatWIBDate(new Date());
  console.log(`Parking Server with Auth running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Server started at: ${wibTime.formatted} WIB`);
  console.log("\n=== Available endpoints ===");
  console.log("PUBLIC (No auth required):");
  console.log("- POST /api/parking-status (Arduino updates)");
  console.log("- GET /api/parking-status (Public parking status)");
  console.log("- GET /api/health (Health check)");
  console.log("\nAUTHENTICATION:");
  console.log("- POST /api/auth/login (Admin login)");
  console.log("- POST /api/auth/register (Admin registration)");
  console.log("\nADMIN (Auth required):");
  console.log("- GET /api/admin/dashboard (Admin analytics)");
  console.log("\nDefault admin: admin@parking.com / admin123");
  console.log("===============================");
});

// Periodic health check log (every 10 minutes)
setInterval(() => {
  const totalSlots = Array.from(parkingData.values()).reduce(
    (sum, data) => sum + data.totalSlots,
    0
  );
  const occupiedSlots = Array.from(parkingData.values()).reduce(
    (sum, data) => sum + (data.totalSlots - data.availableSlots),
    0
  );

  const wibTime = formatWIBDate(new Date());
  console.log("\n=== System Status ===");
  console.log(`Time: ${wibTime.formatted} WIB`);
  console.log(
    `Devices: ${parkingData.size} | Slots: ${occupiedSlots}/${totalSlots} occupied`
  );
  console.log(
    `History: ${slotHistory.length} records | Uptime: ${Math.floor(
      process.uptime()
    )}s`
  );
  console.log("====================\n");
}, 10 * 60 * 1000);
