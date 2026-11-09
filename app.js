// require("dotenv").config();
const cors = require("cors");
const http = require("http");
const morgan = require("morgan");
const express = require("express");
const path = require("path");

const cron = require("./src/core/services/crons/cron.service.js");
const SocketIOService = require("./src/core/socket/socket.js");
const { AppError } = require("./src/core/common/exceptions.js");
const {
  routeAdder,
  makeDirectories,
} = require("./src/core/common/helpers/index.js");
const { sendError } = require("./src/core/common/response.formatter.js");
const queueService = require("./src/core/queues/queue.service.js");
const workerLoader = require("./src/core/queues/worker.loader.js");
const cronService = require("./src/core/services/crons/cron.service.js");

makeDirectories();

const app = express();
const server = http.createServer(app);

const corsOptions = {
  credentials: true,
  origin: "*",
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/webhook")) {
    return next();
  }
  express.json({ limit: "500mb" })(req, res, next);
});

app.use("/uploads", express.static(`uploads`));

app.use((req, res, next) => {
  req.requestTime = new Date().toISOString();
  next();
});

app.get("/", (req, res) => {
  res.send("Hello from RideShare!");
});

app.use(morgan("dev"));

const routePath = path.join(__dirname, "src", "feature");
routeAdder(app, routePath);

app.all("*", (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on the Server`, 404));
});

app.use(sendError);

// Instantiate the SocketIOService with the server
const socketService = new SocketIOService(server);
app.set("io", socketService.io);
socketService.initialize();

queueService
  .initialize()
  .then(() => {
    console.log("Queue service initialized");
    workerLoader.loadWorkersFromFeatures(path.join(__dirname, "./src/feature"));
    console.log("Workers loaded from features");
    cronService.loadCrons(path.join(__dirname, "./src/feature"));
    console.log("Crons loaded from features");
  })
  .catch((err) => {
    console.error("Error initializing queue service:", err.message);
  });

module.exports = { server, socketService };
