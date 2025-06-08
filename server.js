const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const parkingData = new Map(); 
const slotHistory = []; 
const adminUsers = new Map(); 

const defaultAdmin = {
  username: "admin",
  password: bcrypt.hashSync("admin123", 10), 
  email: "admin@parkingsystem.com",
  role: "admin",
  createdAt: new Date(),
};
adminUsers.set("admin", defaultAdmin);

const JWT_SECRET =
  process.env.JWT_SECRET || "your-super-secret-key-change-this";

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null)
  );
}

function convertToWIB(date) {
  const wibDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return wibDate;
}

function getCurrentWIBTime() {
  return convertToWIB(new Date());
}

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
    timestamp: wibDate.getTime(),
  };
}

function authenticateAdmin(req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access denied. No token provided.",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = adminUsers.get(decoded.username);

    if (!user || user.role !== "admin") {
      return res.status(401).json({
        success: false,
        error: "Access denied. Invalid token.",
      });
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: "Invalid token.",
    });
  }
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
    previousState,
    newState,
    timestamp: new Date(), 
    timestampWIB: currentTime, 
    ipAddress,
    duration: null, 
  };

  if (previousState === true && newState === false) {
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

  if (slotHistory.length > 5000) {
    slotHistory.shift();
  }
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({
        success: false,
        error: "Username, password, and email are required",
      });
    }

    if (adminUsers.has(username)) {
      return res.status(400).json({
        success: false,
        error: "Username already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
      username,
      password: hashedPassword,
      email,
      role: "admin",
      createdAt: new Date(),
    };

    adminUsers.set(username, newUser);

    res.json({
      success: true,
      message: "Admin registered successfully",
      data: {
        username,
        email,
        role: "admin",
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

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: "Username and password are required",
      });
    }

    const user = adminUsers.get(username);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({
      success: true,
      message: "Login successful",
      data: {
        token,
        user: {
          username: user.username,
          email: user.email,
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
        availableSlots = slots.filter((slot) => slot === 0).length;
        processedSlots = slots.map((occupied, index) => {
          const slotData = {
            id: index + 1,
            occupied: occupied === 1,
            lastUpdate: Date.now(),
          };

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

app.get("/api/parking-status", (req, res) => {
  const { deviceId } = req.query;

  try {
    if (deviceId) {
      if (parkingData.has(deviceId)) {
        const deviceData = parkingData.get(deviceId);
        const wibTime = formatWIBDate(new Date());

        res.json({
          success: true,
          data: {
            deviceId: deviceData.deviceId,
            availableSlots: deviceData.availableSlots,
            totalSlots: deviceData.totalSlots,
            occupancyRate:
              deviceData.totalSlots > 0
                ? (
                    ((deviceData.totalSlots - deviceData.availableSlots) /
                      deviceData.totalSlots) *
                    100
                  ).toFixed(1)
                : 0,
            lastUpdate: deviceData.lastUpdate,
            lastUpdateWIB: formatWIBDate(deviceData.lastUpdate),
            wifiStatus: deviceData.wifiStatus,
            slots: deviceData.slots.map((slot) => ({
              id: slot.id,
              occupied: slot.occupied,
              lastUpdate: new Date(slot.lastUpdate),
            })),
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
      const allStatus = Array.from(parkingData.values()).map((device) => ({
        deviceId: device.deviceId,
        totalSlots: device.totalSlots,
        availableSlots: device.availableSlots,
        occupancyRate:
          device.totalSlots > 0
            ? (
                ((device.totalSlots - device.availableSlots) /
                  device.totalSlots) *
                100
              ).toFixed(1)
            : 0,
        lastUpdate: device.lastUpdate,
        lastUpdateWIB: formatWIBDate(device.lastUpdate),
        wifiStatus: device.wifiStatus,
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

app.get("/api/admin/dashboard", authenticateAdmin, (req, res) => {
  try {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

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
      wifiStatus: data.wifiStatus,
    }));

    const recentChanges = slotHistory
      .slice(-20)
      .reverse()
      .map((log) => ({
        deviceId: log.deviceId,
        slotId: log.slotId,
        change: log.newState ? "occupied" : "available",
        timestamp: log.timestamp,
        timestampWIB: formatWIBDate(log.timestamp),
        duration: log.duration ? Math.round(log.duration / 1000 / 60) : null, // in minutes
      }));

    const totalSlots = currentStatus.reduce(
      (sum, device) => sum + device.totalSlots,
      0
    );
    const totalOccupied = currentStatus.reduce(
      (sum, device) => sum + device.occupiedSlots,
      0
    );

    const systemStats = {
      totalDevices: parkingData.size,
      totalSlots,
      totalOccupied,
      totalAvailable: totalSlots - totalOccupied,
      overallOccupancyRate:
        totalSlots > 0 ? ((totalOccupied / totalSlots) * 100).toFixed(1) : 0,
      totalHistoryRecords: slotHistory.length,
      last24hChanges: slotHistory.filter((log) => log.timestamp >= last24Hours)
        .length,
      currentTimeWIB: formatWIBDate(now),
    };

    const dashboardData = {
      systemStats,
      currentStatus,
      recentChanges,
      timezone: {
        name: "WIB",
        offset: "+07:00",
        description: "Waktu Indonesia Barat (UTC+7)",
      },
      lastUpdated: now.toISOString(),
      lastUpdatedWIB: formatWIBDate(now),
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

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
    message: "The requested endpoint does not exist",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const wibTime = formatWIBDate(new Date());
  console.log(`Simplified Parking Server running on port ${PORT}`);
  console.log(`Server started at: ${wibTime.formatted} WIB`);
});

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
  console.log("\n=== Parking System Health ===");
  console.log(`Time: ${wibTime.formatted} WIB`);
  console.log(`Connected devices: ${parkingData.size}`);
  console.log(`Total parking slots: ${totalSlots}`);
  console.log(`Currently occupied: ${occupiedSlots}`);
  console.log(`History records: ${slotHistory.length}`);
  console.log(`Server uptime: ${Math.floor(process.uptime())} seconds`);
  console.log("============================\n");
}, 10 * 60 * 1000);
